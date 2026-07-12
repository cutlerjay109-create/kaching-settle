#!/usr/bin/env python3
import os

FILES = {}

FILES['backend/src/keeper/settle-trigger.js'] = r"""// backend/src/keeper/settle-trigger.js
// Watches for completed fixtures and settles markets ON-CHAIN.
// Flow per market: verify TxLINE proof -> lock (if open) -> settle(winning_side)
// -> broadcast. Voids markets where one side is empty.
//
// Key fixes in this version:
// 1. Settlement now actually lands on-chain (lock + settle txs were missing).
// 2. Markets are recovered from the chain at startup, so a Railway restart
//    or TxLINE removing a finished fixture can never orphan a market again.
// 3. Multi-keypair authority support: the keeper picks whichever configured
//    key matches market.authority. Add older wallets (e.g. Phantom) via
//    AUTHORITY_KEYPAIRS in .env (comma-separated base58 secret keys).
// 4. Authority-mismatch markets retry hourly with a clear actionable log
//    instead of erroring silently every 60s.

const {
  Connection, PublicKey, Transaction,
  TransactionInstruction, Keypair
} = require("@solana/web3.js");
const bs58 = require("bs58");
const config = require("../../shared/config");
const constants = require("../../shared/constants");
const { verifyStat } = require("../txline/validate");
const { getCompleted, getPastKickoff } = require("../txline/fixtures");
const { generateCommentary } = require("../ai/pundit");
const { generateVoice } = require("../ai/voice");

// Anchor discriminators — sha256("global:<name>")[0..8]
const DISC_LOCK   = Buffer.from([107, 8, 184, 91, 223, 13, 180, 38]);
const DISC_SETTLE = Buffer.from([175, 42, 185, 87, 144, 131, 102, 212]);
const DISC_VOID   = Buffer.from([243, 175, 46, 124, 95, 101, 39, 69]);
// sha256("account:Market")[0..8] — for getProgramAccounts filtering
const MARKET_ACCOUNT_DISC = Buffer.from([219, 190, 213, 55, 0, 227, 198, 154]);
const MARKET_ACCOUNT_LEN = 294;

const STATUS = constants.STATUS; // 0 open, 1 locked, 2 settled, 3 void

// ── Wallets ─────────────────────────────────────────────
let _keypairs = null;

function loadKeypairs() {
  if (_keypairs) return _keypairs;
  const decoder = bs58.default || bs58;
  const keys = [];
  const tryPush = (raw, label) => {
    if (!raw || !raw.trim()) return;
    try {
      keys.push(Keypair.fromSecretKey(decoder.decode(raw.trim())));
    } catch (e) {
      console.error(`[keeper] Could not decode ${label}:`, e.message);
    }
  };
  tryPush(process.env.WALLET_KEYPAIR, "WALLET_KEYPAIR");
  // Optional: extra authority keys for markets created by other wallets
  // (e.g. markets created earlier with the Phantom wallet).
  // AUTHORITY_KEYPAIRS=base58key1,base58key2
  if (process.env.AUTHORITY_KEYPAIRS) {
    process.env.AUTHORITY_KEYPAIRS.split(",").forEach((k, i) =>
      tryPush(k, `AUTHORITY_KEYPAIRS[${i}]`)
    );
  }
  if (!keys.length) throw new Error("No valid keypair in WALLET_KEYPAIR");
  _keypairs = keys;
  console.log("[keeper] Loaded signer(s):", keys.map(k => k.publicKey.toBase58().slice(0, 8) + "...").join(", "));
  return keys;
}

function walletForAuthority(authority) {
  return loadKeypairs().find(k => k.publicKey.equals(authority)) || null;
}

// ── PDA + account helpers ───────────────────────────────
function fixtureIdBytes(id) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return buf;
}

function getProgramId() {
  return new PublicKey(config.settleProgramId);
}

function getMarketPda(fixtureId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    getProgramId()
  )[0];
}

function getConnection() {
  return new Connection(config.rpc, "confirmed");
}

// Decode a raw Market account (matches program/src/state/market.rs)
function decodeMarket(d) {
  let o = 8; // skip discriminator
  const fixtureId = Number(d.readBigUInt64LE(o)); o += 8;
  const qLen = d.readUInt32LE(o); o += 4;
  const question = d.slice(o, o + qLen).toString("utf8"); o += qLen;
  const kickoffTs = Number(d.readBigInt64LE(o)); o += 8;
  const statKey = d.readUInt32LE(o); o += 4;
  const threshold = Number(d.readBigUInt64LE(o)); o += 8;
  const comparison = d.readUInt8(o); o += 1;
  const yesTotal = d.readBigUInt64LE(o); o += 8;
  const noTotal = d.readBigUInt64LE(o); o += 8;
  const status = d.readUInt8(o); o += 1;
  const winningSide = d.readUInt8(o); o += 1;
  const authority = new PublicKey(d.slice(o, o + 32)); o += 32;
  return {
    fixtureId, question, kickoffTs, statKey, threshold, comparison,
    yesTotal, noTotal, status, winningSide, authority,
  };
}

async function fetchMarketAccount(connection, fixtureId) {
  const info = await connection.getAccountInfo(getMarketPda(fixtureId));
  if (!info) return null;
  return decodeMarket(info.data);
}

// ── On-chain transactions ───────────────────────────────
async function sendAuthorityIx(connection, wallet, data, fixtureId) {
  const ix = new TransactionInstruction({
    programId: getProgramId(),
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: getMarketPda(fixtureId), isSigner: false, isWritable: true },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

class AuthorityMismatchError extends Error {
  constructor(authority) {
    super(`No configured keypair matches market authority ${authority.toBase58()}`);
    this.name = "AuthorityMismatchError";
    this.authority = authority;
  }
}

// Lock (if open) then settle. Returns { settleSig, alreadyDone }.
async function settleMarketOnChain(fixtureId, winningSide) {
  const connection = getConnection();
  let market = await fetchMarketAccount(connection, fixtureId);
  if (!market) return { alreadyDone: true, reason: "no market account on-chain" };
  if (market.status === STATUS.SETTLED) return { alreadyDone: true, reason: "already settled" };
  if (market.status === STATUS.VOID) return { alreadyDone: true, reason: "already voided" };

  const wallet = walletForAuthority(market.authority);
  if (!wallet) throw new AuthorityMismatchError(market.authority);

  if (market.status === STATUS.OPEN) {
    const lockSig = await sendAuthorityIx(connection, wallet, DISC_LOCK, fixtureId);
    console.log(`[keeper] Locked market ${fixtureId}: ${lockSig.slice(0, 20)}...`);
  }

  const settleData = Buffer.concat([DISC_SETTLE, Buffer.from([winningSide])]);
  const settleSig = await sendAuthorityIx(connection, wallet, settleData, fixtureId);
  console.log(`[keeper] Settled market ${fixtureId} on-chain (side ${winningSide}): ${settleSig.slice(0, 20)}...`);
  return { settleSig };
}

// Lock (if open) then void.
async function voidMarketOnChain(fixtureId) {
  const connection = getConnection();
  const market = await fetchMarketAccount(connection, fixtureId);
  if (!market) return { alreadyDone: true };
  if (market.status === STATUS.SETTLED || market.status === STATUS.VOID) return { alreadyDone: true };

  const wallet = walletForAuthority(market.authority);
  if (!wallet) throw new AuthorityMismatchError(market.authority);

  if (market.status === STATUS.OPEN) {
    const lockSig = await sendAuthorityIx(connection, wallet, DISC_LOCK, fixtureId);
    console.log(`[keeper] Locked market ${fixtureId}: ${lockSig.slice(0, 20)}...`);
  }

  const sig = await sendAuthorityIx(connection, wallet, DISC_VOID, fixtureId);
  console.log(`[keeper] Voided market ${fixtureId}: ${sig.slice(0, 20)}...`);
  return { voidSig: sig };
}

// ── Watch list ──────────────────────────────────────────
// { fixtureId -> { marketId, question, statKey, threshold, comparison,
//                  status, kickoffMs, home, away, nextRetryAt } }
const activeMarkets = new Map();
let settleCallback = null;
let checkInterval = null;

function registerMarket(market) {
  const existing = activeMarkets.get(market.fixtureId);
  // Never resurrect a market we already finished processing
  if (existing && existing.status === "settled") return;
  activeMarkets.set(market.fixtureId, { ...existing, ...market });
  if (!existing) {
    console.log(`[keeper] Watching fixture ${market.fixtureId}: "${market.question}"`);
  }
}

function getWatchedMarkets() {
  return Array.from(activeMarkets.values()).map(m => ({
    fixtureId: m.fixtureId,
    question: m.question,
    home: m.home || null,
    away: m.away || null,
    status: m.status,
    kickoffMs: m.kickoffMs || null,
  }));
}

function onSettle(callback) {
  settleCallback = callback;
}

// Recover every unsettled market straight from the chain.
// This is the source of truth — survives restarts and TxLINE feed removal.
async function recoverMarketsFromChain() {
  try {
    const connection = getConnection();
    const decoder = bs58.default || bs58;
    const accounts = await connection.getProgramAccounts(getProgramId(), {
      filters: [
        { dataSize: MARKET_ACCOUNT_LEN },
        { memcmp: { offset: 0, bytes: decoder.encode(MARKET_ACCOUNT_DISC) } },
      ],
    });

    let recovered = 0;
    for (const { account } of accounts) {
      let m;
      try { m = decodeMarket(account.data); } catch (e) { continue; }
      if (m.status === STATUS.SETTLED || m.status === STATUS.VOID) continue;

      // Parse team names from the auto-generated question when possible
      let home = null, away = null;
      const match = m.question.match(/^Will (.+) score a goal against (.+)\?$/);
      if (match) { home = match[1]; away = match[2]; }

      registerMarket({
        fixtureId: m.fixtureId,
        marketId: m.fixtureId,
        question: m.question,
        statKey: m.statKey,
        threshold: m.threshold,
        comparison: m.comparison === 1 ? "lessThan" : "greaterThan",
        status: "active",
        kickoffMs: m.kickoffTs * 1000,
        home, away,
      });
      recovered++;
    }
    console.log(`[keeper] Recovered ${recovered} unsettled market(s) from chain (${accounts.length} total)`);
  } catch (e) {
    console.error("[keeper] Chain recovery failed:", e.message);
  }
}

// ── Main loop ───────────────────────────────────────────
async function checkAndSettle() {
  if (!activeMarkets.size) return;
  const now = Date.now();

  // Build fixture list from three sources:
  // 1. TxLINE completed fixtures
  // 2. Past-kickoff fixtures still in the feed
  // 3. Watched markets whose kickoff was >2.5h ago (TxLINE removes finished
  //    fixtures from the feed, so this is the one that usually matters)
  let completed = [];
  try {
    completed = await getCompleted();
    const pastKickoff = await getPastKickoff();
    const seen = new Set(completed.map(f => f.fixtureId));
    for (const f of pastKickoff) {
      if (!seen.has(f.fixtureId)) { completed.push(f); seen.add(f.fixtureId); }
    }
    for (const [fixtureId, market] of activeMarkets) {
      if (!seen.has(fixtureId) && market.kickoffMs &&
          now - market.kickoffMs > 2.5 * 60 * 60 * 1000) {
        completed.push({ fixtureId, ...market });
        seen.add(fixtureId);
      }
    }
  } catch (e) {
    console.error("[keeper] Fixture check failed:", e.message);
    return;
  }

  for (const fixture of completed) {
    const market = activeMarkets.get(fixture.fixtureId);
    if (!market || market.status === "settled") continue;
    if (market.nextRetryAt && now < market.nextRetryAt) continue;

    console.log(`[keeper] Fixture ${fixture.fixtureId} completed — processing...`);

    try {
      const connection = getConnection();
      const onChain = await fetchMarketAccount(connection, fixture.fixtureId);

      // No market account: nothing to settle — stop watching
      if (!onChain) {
        market.status = "settled";
        continue;
      }

      // Someone (or a previous run) already finished it — sync local state
      if (onChain.status === STATUS.SETTLED || onChain.status === STATUS.VOID) {
        market.status = "settled";
        continue;
      }

      // One side empty -> void so everyone can refund
      if (onChain.yesTotal === 0n || onChain.noTotal === 0n) {
        console.log(`[keeper] One side empty for ${fixture.fixtureId} — voiding on-chain`);
        await voidMarketOnChain(fixture.fixtureId);
        market.status = "settled";
        if (settleCallback) {
          settleCallback({
            fixtureId: fixture.fixtureId,
            marketId: market.marketId,
            question: market.question,
            result: null,
            winningSide: "VOID",
            proof: null,
            commentary: "This market has been voided — one side had no deposits. All funds are refundable now.",
            audioUrl: null,
            settledAt: Date.now(),
            voided: true,
          });
        }
        continue;
      }

      // Verify the result via TxLINE Merkle proof.
      // Use on-chain predicate as source of truth (registration data may drift).
      const { result, proof } = await verifyStat({
        fixtureId: fixture.fixtureId,
        statKey: onChain.statKey,
        threshold: onChain.threshold,
        comparison: onChain.comparison === 1 ? "lessThan" : "greaterThan",
      });

      const winningSideNum = result ? constants.SIDE.YES : constants.SIDE.NO;
      const winningSide = result ? "YES" : "NO";

      // THE critical step that was missing: settle on-chain
      const { settleSig, alreadyDone } = await settleMarketOnChain(
        fixture.fixtureId, winningSideNum
      );
      if (alreadyDone) {
        market.status = "settled";
        continue;
      }

      // AI commentary — failures here must never block settlement
      let text = `${winningSide} wins — result verified by TxLINE proof and settled on Solana.`;
      let audioUrl = null;
      try {
        text = await generateCommentary({
          fixture: {
            home: fixture.home || market.home || "Home",
            away: fixture.away || market.away || "Away",
          },
          question: market.question || onChain.question,
          result,
          winningSide,
          proof,
        });
        audioUrl = await generateVoice(text);
      } catch (e) {
        console.error("[keeper] Commentary failed (settlement unaffected):", e.message);
      }

      market.status = "settled";

      console.log(`[keeper] Settled ${fixture.fixtureId}: ${winningSide} wins — ${text}`);

      if (settleCallback) {
        settleCallback({
          fixtureId: fixture.fixtureId,
          marketId: market.marketId,
          question: market.question || onChain.question,
          result,
          winningSide,
          proof,
          commentary: text,
          audioUrl,
          settleTx: settleSig,
          settledAt: Date.now(),
        });
      }

    } catch (e) {
      if (e.name === "AuthorityMismatchError") {
        // Retry hourly, not every 60s, and tell the operator exactly what to do
        market.nextRetryAt = now + 60 * 60 * 1000;
        console.error(
          `[keeper] Cannot settle ${fixture.fixtureId}: market authority is ` +
          `${e.authority.toBase58()} but no configured key matches it.\n` +
          `         Fix: add that wallet's base58 secret key to AUTHORITY_KEYPAIRS ` +
          `in the backend .env (comma-separated), or run scripts/manual-settle.js ` +
          `with that wallet as WALLET_KEYPAIR.`
        );
      } else {
        // Transient (proof not ready yet, RPC hiccup) — retry next cycle
        console.error(`[keeper] Settle error for ${fixture.fixtureId}:`, e.message);
      }
    }
  }
}

function start(intervalMs = 60000) {
  console.log(`[keeper] Started — checking every ${intervalMs / 1000}s`);
  // Recover chain state first, then begin the loop
  recoverMarketsFromChain().finally(() => {
    checkAndSettle();
    checkInterval = setInterval(checkAndSettle, intervalMs);
  });
}

function stop() {
  if (checkInterval) clearInterval(checkInterval);
  console.log("[keeper] Stopped");
}

module.exports = {
  registerMarket,
  getWatchedMarkets,
  onSettle,
  start,
  stop,
  settleMarketOnChain,
  voidMarketOnChain,
  recoverMarketsFromChain,
};
"""

FILES['backend/src/keeper/auto-market.js'] = r"""// backend/src/keeper/auto-market.js
// Automatically creates on-chain markets for all fixtures
// that don't have a market yet. Runs at startup and every hour.

const {
  Connection, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, Keypair
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const config = require("../../shared/config");
const constants = require("../../shared/constants");
const { fetchFixtures } = require("../txline/fixtures");

const PROGRAM_ID = new PublicKey(config.settleProgramId);
const USDC_MINT = new PublicKey(config.usdcMint);

// Anchor discriminator for create_market
const DISC_CREATE = Buffer.from([103, 226, 97, 235, 200, 188, 251, 254]);

function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  return Keypair.fromSecretKey(decoder.decode(raw));
}

function fixtureIdBytes(id) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return buf;
}

function getMarketPda(fixtureId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

function getVaultPda(fixtureId, seed) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

async function marketExists(connection, fixtureId) {
  const pda = getMarketPda(fixtureId);
  const info = await connection.getAccountInfo(pda);
  return info !== null;
}

function encodeString(str) {
  const bytes = Buffer.from(str, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(Math.floor(n)));
  return buf;
}

async function createMarketForFixture(connection, wallet, fixture) {
  const { fixtureId, home, away, kickoffMs } = fixture;
  const question = `Will ${home} score a goal against ${away}?`;
  const kickoffTs = Math.floor(kickoffMs / 1000);

  const marketPda = getMarketPda(fixtureId);
  const yesVault = getVaultPda(fixtureId, constants.SEEDS.YES_VAULT);
  const noVault = getVaultPda(fixtureId, constants.SEEDS.NO_VAULT);

  // Encode instruction data manually
  const fixtureIdBuf = u64le(fixtureId);
  const questionBuf = encodeString(question);
  const kickoffBuf = (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(kickoffTs)); return b; })();
  const statKeyBuf = (() => { const b = Buffer.alloc(4); b.writeUInt32LE(1); return b; })(); // home goals
  const thresholdBuf = u64le(0);
  const comparisonBuf = Buffer.from([0]); // greaterThan

  const data = Buffer.concat([
    DISC_CREATE,
    fixtureIdBuf,
    questionBuf,
    kickoffBuf,
    statKeyBuf,
    thresholdBuf,
    comparisonBuf,
  ]);

  const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: marketPda, isSigner: false, isWritable: true },
      { pubkey: yesVault, isSigner: false, isWritable: true },
      { pubkey: noVault, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

let onMarketCreated = null;

function setMarketCreatedCallback(cb) {
  onMarketCreated = cb;
}

async function autoCreateMarkets() {
  if (!config.settleProgramId) return;

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const fixtures = await fetchFixtures();

  console.log("[auto-market] Checking", fixtures.length, "fixtures...");

  for (const fixture of fixtures) {
    try {
      const exists = await marketExists(connection, fixture.fixtureId);
      if (exists) {
        console.log(`[auto-market] Market exists: ${fixture.home} vs ${fixture.away}`);
        continue;
      }

      console.log(`[auto-market] Creating market: ${fixture.home} vs ${fixture.away}`);
      const sig = await createMarketForFixture(connection, wallet, fixture);
      console.log(`[auto-market] Created: ${sig}`);
      if (onMarketCreated) onMarketCreated(fixture);

      // Small delay between transactions
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`[auto-market] Error for fixture ${fixture.fixtureId}:`, e.message);
    }
  }

  console.log("[auto-market] Done checking fixtures");
}

const DISC_DEPOSIT = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);

// u64le and getVaultPda defined above

function getPositionPda(fixtureId, user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.POSITION), fixtureIdBytes(fixtureId), user.toBuffer()],
    PROGRAM_ID
  )[0];
}

async function seedMarketIfEmpty(connection, wallet, fixtureId) {
  const {
    Transaction, TransactionInstruction, SystemProgram
  } = require("@solana/web3.js");
  const {
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
  } = require("@solana/spl-token");

  const marketPda = getMarketPda(fixtureId);
  const info = await connection.getAccountInfo(marketPda);
  if (!info) return;

  // Read yes/no totals
  const d = info.data;
  let o = 8 + 8;
  const qLen = d.readUInt32LE(o); o += 4 + qLen;
  o += 8 + 4 + 8 + 1;
  const yesTotal = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
  const noTotal = Number(d.readBigUInt64LE(o)) / 1e6;
  const status = d.readUInt8(o + 8);

  // Only seed OPEN markets
  if (status !== 0) return;

  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  async function doDeposit(side, amount) {
    const vaultSeed = side === 0 ? constants.SEEDS.YES_VAULT : constants.SEEDS.NO_VAULT;
    const vault = getVaultPda(fixtureId, vaultSeed);
    const position = getPositionPda(fixtureId, wallet.publicKey);
    const data = Buffer.concat([
      DISC_DEPOSIT,
      Buffer.from([side]),
      u64le(amount * 1_000_000),
    ]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: marketPda, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: userToken, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(wallet);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  if (yesTotal < 1) {
    try {
      const sig = await doDeposit(0, 2);
      console.log("[auto-market] Seeded $2 YES for fixture", fixtureId, sig.slice(0,20) + "...");
    } catch(e) {
      console.log("[auto-market] YES seed failed:", e.message.slice(0,60));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (noTotal < 1) {
    try {
      const sig = await doDeposit(1, 1);
      console.log("[auto-market] Seeded $1 NO for fixture", fixtureId, sig.slice(0,20) + "...");
    } catch(e) {
      console.log("[auto-market] NO seed failed:", e.message.slice(0,60));
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function autoSeedMarkets() {
  if (!config.settleProgramId) return;
  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const fixtures = await fetchFixtures();
  const now = Date.now();

  for (const fixture of fixtures) {
    if (fixture.kickoffMs <= now) continue;
    try {
      await seedMarketIfEmpty(connection, wallet, fixture.fixtureId);
    } catch(e) {
      console.error("[auto-market] Seed error:", e.message);
    }
  }
}

module.exports = { autoCreateMarkets, autoSeedMarkets, setMarketCreatedCallback };
"""

FILES['backend/src/txline/normalize.js'] = r"""// backend/src/txline/normalize.js
// Cleans raw TxLINE SSE events into simple shapes.
//
// Fixes in this version:
// - Game phase is STICKY per fixture. Missing/unknown StatusId (common on
//   half-time payloads) no longer falls back to "Pre-Match".
// - Phase also detected from Action strings (half_time, match_end, etc.).
// - Once a match is live it can never regress to Pre-Match; once FT, stays FT.
// - Score can never silently reset to 0-0 mid-match (the HT reset artifact).
//   Legit VAR corrections still apply because those events carry goal Actions.
// - Minute is sticky too: a Clock reset to 0 at HT keeps showing 45'.

// Per-fixture state — the single source of truth for stickiness
const fixtureState = {};

function getState(fixtureId) {
  if (!fixtureState[fixtureId]) {
    fixtureState[fixtureId] = {
      homeGoals: 0, awayGoals: 0, minute: 0, period: 0, hasScore: false,
    };
  }
  return fixtureState[fixtureId];
}

// Real StatusId values confirmed from live stream:
// 1 = Pre-Match, 2 = 1st Half, 3 = Half Time, 4 = 2nd Half, 5 = Full Time
function phaseFromStatusId(statusId) {
  if (statusId === 5) return 5; // FT
  if (statusId === 4) return 2; // 2nd Half
  if (statusId === 3) return 3; // HT
  if (statusId === 2) return 1; // 1st Half
  if (statusId === 1) return 0; // Pre-Match
  return null; // unknown / missing
}

function phaseFromAction(action) {
  const a = (action || "").toLowerCase();
  if (!a) return null;
  if (a.includes("match_end") || a.includes("full_time")) return 5;
  if (a.includes("half_time") || a === "ht") return 3;
  if (a.includes("second_half")) return 2;
  return null;
}

function getGamePhase(data) {
  const st = getState(data.FixtureId);

  let phase = phaseFromStatusId(data.StatusId);
  if (phase === null) phase = phaseFromAction(data.Action);
  if (phase === null) phase = st.period; // sticky fallback

  // Never regress: live -> pre-match is always a feed artifact,
  // and full time is terminal.
  if (phase === 0 && st.period > 0) phase = st.period;
  if (st.period === 5) phase = 5;

  st.period = phase;
  return phase;
}

function getMinute(data, phase) {
  const st = getState(data.FixtureId);
  const seconds = data.Clock ? data.Clock.Seconds : undefined;

  let minute = (typeof seconds === "number") ? Math.floor(seconds / 60) : null;

  // Missing clock, or clock reset to 0 mid-match (HT artifact) -> keep last
  if (minute === null || (minute === 0 && st.minute > 0 && phase !== 0)) {
    minute = st.minute;
  }
  // During half time the clock should read 45', not 0'
  if (phase === 3 && minute < 45) minute = 45;
  // Full time: never show less than what we reached
  if (phase === 5 && minute < st.minute) minute = st.minute;

  st.minute = minute;
  return minute;
}

function extractGoals(data) {
  const st = getState(data.FixtureId);

  const hasStats = data.Stats &&
    (data.Stats["1"] !== undefined || data.Stats["2"] !== undefined);

  if (hasStats) {
    const h = data.Stats["1"] ?? 0;
    const a = data.Stats["2"] ?? 0;

    // Goals decreasing is only legitimate on VAR/goal-correction events.
    // Anything else (HT stat reset, feed hiccup) keeps the last known score.
    const isGoalCorrection = /possible|var|goal/i.test(data.Action || "");
    if (st.hasScore && (h < st.homeGoals || a < st.awayGoals) && !isGoalCorrection) {
      return { homeGoals: st.homeGoals, awayGoals: st.awayGoals };
    }

    st.homeGoals = h;
    st.awayGoals = a;
    st.hasScore = true;
    return { homeGoals: h, awayGoals: a };
  }

  // Stats missing entirely (typical HT/status payload) -> last known
  return { homeGoals: st.homeGoals, awayGoals: st.awayGoals };
}

function normalizeFixture(f) {
  const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
  const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
  const homeId = f.Participant1IsHome ? f.Participant1Id : f.Participant2Id;
  const awayId = f.Participant1IsHome ? f.Participant2Id : f.Participant1Id;

  return {
    fixtureId: f.FixtureId,
    competitionId: f.CompetitionId,
    competition: f.Competition,
    home,
    away,
    homeId,
    awayId,
    kickoffMs: f.StartTime,
    kickoffIso: new Date(f.StartTime).toISOString(),
    status: f.FixtureStatus || f.Status || "upcoming",
  };
}

function normalizeScore(data) {
  const fixtureId = data.FixtureId;
  const period = getGamePhase(data);
  const minute = getMinute(data, period);
  const { homeGoals, awayGoals } = extractGoals(data);

  return {
    fixtureId,
    homeGoals,
    awayGoals,
    period,
    minute,
    ts: data.Ts ?? Date.now(),
  };
}

function normalizeEvent(data) {
  const action = data.Action || "";

  // Only show meaningful events -- filter out possession noise
  const meaningfulActions = [
    "goal", "shot", "yellow_card", "red_card", "corner",
    "penalty", "free_kick", "possible", "var", "offside", "substitution"
  ];

  const isMeaningful = meaningfulActions.some(a =>
    action.toLowerCase().includes(a)
  );

  if (!isMeaningful) return null;

  // Detect possible goal
  let type = action;
  if (action === "possible" && data.Data?.Goal === true) {
    type = "possible_goal";
  }
  if (action === "possible" && data.Data?.Goal === false) {
    return null; // goal cancelled -- ignore
  }

  // Detect confirmed shot outcome
  if (action === "shot" && data.Confirmed && data.Data?.Outcome) {
    type = `shot_${data.Data.Outcome.toLowerCase()}`;
  }

  // Skip unconfirmed events
  if (data.Confirmed === false) return null;

  const period = getGamePhase(data);
  const minute = getMinute(data, period);

  return {
    fixtureId: data.FixtureId,
    type,
    team: data.Participant === 1 ? "home" : "away",
    minute,
    period,
    player: data.PlayerName || data.Data?.PlayerName || null,
    data: data.Data || {},
    ts: data.Ts ?? Date.now(),
  };
}

function isFinished(data) {
  return data.StatusId === 5 ||
    data.GameState === "finished" ||
    data.Action === "match_end";
}

module.exports = {
  normalizeFixture,
  normalizeScore,
  normalizeEvent,
  isFinished,
  getGamePhase,
  getMinute,
};
"""

FILES['backend/src/txline/stream.js'] = r"""// backend/src/txline/stream.js
// Connects to TxLINE live SSE stream.
//
// Fix: score updates now also emit on status-only payloads (StatusId present
// but Stats/Clock missing) — this is exactly what half-time events look like.
// normalize.js keeps the score and minute sticky, so the frontend gets a
// correct "HT, 45', 1-0" instead of "Pre-Match, 0', 0-0".

const EventSource = require("eventsource");
const { makeHeaders } = require("./auth");
const { normalizeScore, normalizeEvent, isFinished } = require("./normalize");
const config = require("../../shared/config");

let es = null;
let reconnectTimer = null;
let onScoreUpdate = null;
let onMatchEvent = null;
let onMatchFinished = null;
let onError = null;
let onSignificantEvent = null;

// Events that trigger AI commentary
const PUNDIT_TRIGGERS = new Set([
  "goal", "possible_goal", "penalty", "red_card", "var"
]);

// Score store — saves last known score for every fixture.
// TxLINE removes score data after match ends, so we keep our own copy.
const scoreStore = {};

function getLastScore(fixtureId) {
  return scoreStore[fixtureId] || null;
}

function connect(callbacks = {}) {
  onScoreUpdate = callbacks.onScoreUpdate || (() => {});
  onMatchEvent = callbacks.onMatchEvent || (() => {});
  onMatchFinished = callbacks.onMatchFinished || (() => {});
  onSignificantEvent = callbacks.onSignificantEvent || null;
  onError = callbacks.onError || console.error;
  _connect();
}

function _connect() {
  if (es) { es.close(); es = null; }

  const headers = makeHeaders();
  const url = `${config.txline.host}/api/scores/stream`;

  console.log("[stream] Connecting to SSE...");

  es = new EventSource(url, { headers });

  es.onopen = () => {
    console.log("[stream] Connected");
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!data || data.FixtureId === undefined) return;

      // Emit a score update on ANY payload that carries game state:
      // stats, clock, OR just a status change (half time / full time).
      const hasGameState =
        data.Stats !== undefined ||
        data.Clock !== undefined ||
        data.StatusId !== undefined;

      if (hasGameState) {
        const score = normalizeScore(data);
        scoreStore[data.FixtureId] = score;
        onScoreUpdate(score);
      }

      // Check for match finished
      if (isFinished(data)) {
        console.log("[stream] Match finished:", data.FixtureId);
        onMatchFinished(data.FixtureId);
      }

      // Emit meaningful match events
      const event_ = normalizeEvent(data);
      if (event_) {
        onMatchEvent(event_);
        // Trigger AI pundit on significant events
        if (onSignificantEvent && PUNDIT_TRIGGERS.has(event_.type)) {
          onSignificantEvent(event_);
        }
      }

    } catch (e) {
      // ignore parse errors
    }
  };

  es.onerror = () => {
    console.error("[stream] SSE error — reconnecting in 5s");
    if (es) { es.close(); es = null; }
    reconnectTimer = setTimeout(_connect, 5000);
  };
}

function disconnect() {
  if (es) { es.close(); es = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  console.log("[stream] Disconnected");
}

module.exports = { connect, disconnect, getLastScore };
"""

FILES['backend/src/txline/validate.js'] = r"""// backend/src/txline/validate.js
// Fetches TxLINE's cryptographic stat-validation proof for a fixture.
// Calls validateStat().view() on the Txoracle program — returns true/false.
//
// Fix: the daily scores root PDA is now derived from the PROOF's target
// timestamp, not from "today". Previously, any settlement retried after
// midnight UTC pointed at the wrong day's root and failed forever.
// (Falls back to today's root if the proof-day root account is missing.)

const axios = require("axios");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey } = require("@solana/web3.js");
const { makeHeaders } = require("./auth");
const config = require("../../shared/config");
const constants = require("../../shared/constants");
const fs = require("fs");
const path = require("path");

let _program = null;

// Load the Txoracle program once
async function getProgram() {
  if (_program) return _program;

  const connection = new Connection(config.rpc, "confirmed");
  const idlPath = path.join(__dirname, "../../idl/txoracle.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  // Read-only provider — no wallet needed for .view() calls
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: PublicKey.default, signTransaction: async t => t, signAllTransactions: async t => t },
    { commitment: "confirmed" }
  );

  _program = new anchor.Program(idl, provider);
  return _program;
}

// Fetch the validation proof from TxLINE API
async function fetchProof(fixtureId, statKey, seq = 1) {
  try {
    const res = await axios.get(`${config.txline.host}/api/scores/stat-validation`, {
      headers: makeHeaders(),
      params: { fixtureId, seq, statKey },
      timeout: 20000,
    });
    return res.data;
  } catch (e) {
    throw new Error(`fetchProof failed: ${e.response?.data?.message || e.message}`);
  }
}

// Helper: convert hex/base64/array/null to 32-byte Buffer
// TxLINE sometimes returns null or missing fields for empty proof nodes —
// treat those as 32 zero bytes rather than crashing.
function toBytes32(val) {
  if (val === null || val === undefined) return Buffer.alloc(32);
  if (Array.isArray(val)) return Buffer.from(val);
  if (typeof val === "string") {
    if (!val) return Buffer.alloc(32);
    if (val.startsWith("0x") || val.length === 64) return Buffer.from(val.replace("0x",""), "hex");
    return Buffer.from(val, "base64");
  }
  if (Buffer.isBuffer(val)) return val;
  return Buffer.from(val);
}

function dailyScoresRootPda(epochDay) {
  // Seed confirmed from IDL account name: "daily_scores_merkle_roots"
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_merkle_roots"), Buffer.from([epochDay & 0xff, (epochDay >> 8) & 0xff])],
    new PublicKey(config.txline.programId)
  )[0];
}

// Parse the boolean result from program logs.
// The Txoracle program emits "Program log: <true|false>" or
// "Program return: <base64>" depending on version.
// We check both patterns.
function parseResultFromLogs(logs) {
  if (!logs || !logs.length) return null;
  for (const line of logs) {
    // "Program log: true" / "Program log: false"
    if (/program log:\s*true/i.test(line)) return true;
    if (/program log:\s*false/i.test(line)) return false;
    // "Program return: <programId> <base64bool>"
    const m = line.match(/Program return:\S*\s+(\S+)/);
    if (m) {
      try {
        const buf = Buffer.from(m[1], "base64");
        return buf[0] !== 0;
      } catch(e) {}
    }
    // "Program data: <base64>"
    const d = line.match(/Program data:\s+(\S+)/);
    if (d) {
      try {
        const buf = Buffer.from(d[1], "base64");
        return buf[0] !== 0;
      } catch(e) {}
    }
  }
  return null;
}

// Epoch days to try, in order: the proof's day first, then today.
function candidateEpochDays(targetTs) {
  const days = [];
  if (targetTs) {
    // targetTs may arrive in ms or seconds — normalize to ms
    const tsMs = targetTs > 1e12 ? targetTs : targetTs * 1000;
    days.push(Math.floor(tsMs / constants.MS_PER_DAY));
  }
  const today = Math.floor(Date.now() / constants.MS_PER_DAY);
  if (!days.includes(today)) days.push(today);
  return days;
}

// Main: verify a stat on-chain using TxLINE's Merkle proof
// Returns { result: bool, proof: object } — proof is stored as receipt
async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId} statKey ${statKey}...`);

  const proof = await fetchProof(fixtureId, statKey);
  console.log("[validate] Proof fetched");

  const program = await getProgram();

  // Build the predicate — e.g. { greaterThan: {} } means "stat > threshold"
  const predicate = {
    threshold,
    comparison: comparison === "greaterThan" ? { greaterThan: {} } : { lessThan: {} },
  };

  // Build stat1 argument from proof
  // Safe node mapper — guards against null nodes or missing hash fields
  function mapProofNode(node) {
    if (!node) return { hash: Array.from(Buffer.alloc(32)), isRightSibling: false };
    return {
      hash: Array.from(toBytes32(node.hash)),
      isRightSibling: node.isRightSibling ?? false,
    };
  }

  const stat1 = {
    statToProve: proof.statToProve,
    eventStatRoot: toBytes32(proof.eventStatRoot),
    statProof: (proof.statProof || []).map(mapProofNode),
  };

  // Build fixtureSummary
  const summary = proof.summary || {};
  const updateStats = summary.updateStats || {};
  const fixtureSummary = {
    fixtureId: summary.fixtureId ?? proof.fixtureId,
    updateStats: {
      updateCount: updateStats.updateCount ?? 0,
      minTimestamp: new anchor.BN(updateStats.minTimestamp ?? 0),
      maxTimestamp: new anchor.BN(updateStats.maxTimestamp ?? 0),
    },
    eventsSubTreeRoot: toBytes32(summary.eventsSubTreeRoot),
  };

  // Fixture proof path
  const fixtureProof = (proof.subTreeProof || []).map(mapProofNode);

  // Main tree proof path
  const mainTreeProof = (proof.mainTreeProof || []).map(mapProofNode);

  let lastError = null;

  for (const epochDay of candidateEpochDays(proof.targetTs)) {
    const dailyScoresRoot = dailyScoresRootPda(epochDay);
    try {
      // .view() is not supported by this program — use .simulate() and
      // parse the boolean result from the transaction logs instead.
      const sim = await program.methods
        .validateStat(
          new anchor.BN(proof.targetTs),
          fixtureSummary,
          fixtureProof,
          mainTreeProof,
          predicate,
          stat1,
          null, // stat2 — not needed for single-stat markets
          null  // op
        )
        .accounts({ dailyScoresMerkleRoots: dailyScoresRoot })
        .simulate({ commitment: "confirmed" });

      const logs = sim?.raw || sim?.events || sim?.logs || [];
      console.log("[validate] Simulation logs:", logs.slice(0, 10));

      const result = parseResultFromLogs(logs);
      if (result === null) {
        throw new Error("Could not parse boolean result from simulation logs: " + JSON.stringify(logs.slice(0,5)));
      }

      console.log(`[validate] Result: ${result} (epochDay ${epochDay})`);
      return {
        result,
        proof: {
          fixtureId,
          statKey,
          threshold,
          comparison,
          targetTs: proof.targetTs,
          dailyScoresRoot: dailyScoresRoot.toBase58(),
        },
      };
    } catch (e) {
      lastError = e;
      console.error(`[validate] validateStat failed for epochDay ${epochDay}: ${e.message}`);
    }
  }

  throw new Error(`validateStat failed: ${lastError ? lastError.message : "unknown"}`);
}

module.exports = { verifyStat, fetchProof };
"""

FILES['backend/src/ai/pundit.js'] = r"""// backend/src/ai/pundit.js
// Generates AI match commentary using Groq.
//
// Fix: this now supports BOTH call styles used by the codebase:
//   generateCommentary({ prompt })                       <- live events (server.js)
//   generateCommentary({ fixture, question, result, winningSide, proof })
// Previously the { prompt } style crashed on fixture.home (undefined),
// which silently killed all live goal/red card/VAR commentary.

const Groq = require("groq-sdk");

// Lazy init — instantiating Groq at import time crashes the whole backend
// (including settlement) whenever GROQ_API_KEY is missing.
let _groq = null;
function getGroq() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) return null;
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

async function generateCommentary(opts = {}) {
  let prompt = opts.prompt;
  const home = opts.fixture?.home || "the home side";
  const away = opts.fixture?.away || "the away side";
  const winningSide = opts.winningSide || "";

  if (!prompt) {
    const { question, result, proof } = opts;
    prompt = `You are an energetic football pundit commentating on a match settlement.

Match: ${home} vs ${away}
Question: "${question}"
Outcome: The answer was ${result ? "YES" : "NO"} — ${winningSide} side wins.
Proof: Verified on-chain at timestamp ${proof?.targetTs ? new Date(proof.targetTs).toISOString() : "now"}.

Write 2 punchy sentences:
1. What happened in the match relevant to this question.
2. Confirm who gets paid and that it was settled trustlessly by cryptographic proof.

Keep it exciting, under 50 words total. No hashtags. No emojis.`;
  }

  try {
    const groq = getGroq();
    if (!groq) throw new Error("GROQ_API_KEY not set");
    const res = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.8,
    });

    return res.choices[0].message.content.trim();
  } catch (e) {
    console.error("[pundit] Groq error:", e.message);
    if (opts.prompt) return null; // live event — silence is fine
    return `${home} vs ${away} is settled. ${winningSide} backers win — verified by TxLINE proof on Solana.`;
  }
}

module.exports = { generateCommentary };
"""

FILES['backend/src/program/client.js'] = r"""// backend/src/program/client.js
// Connects to OUR vault program on Solana.
//
// CRITICAL FIX: PDA seeds. The program derives PDAs from the fixture id as
// u64 LITTLE-ENDIAN BYTES (`fixture_id.to_le_bytes()`). This file previously
// used `Buffer.from(fixtureId.toString())` (the ASCII string), so every PDA
// derived here pointed at a non-existent account.

const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair,
} = require("@solana/web3.js");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");
const config = require("../../shared/config");
const constants = require("../../shared/constants");

let _program = null;
let _wallet = null;

function loadWallet() {
  if (_wallet) return _wallet;
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  _wallet = Keypair.fromSecretKey(decoder.decode(raw));
  return _wallet;
}

async function getProgram() {
  if (_program) return _program;

  if (!config.settleProgramId) {
    throw new Error("settleProgramId not set in shared/config.js — deploy program first");
  }

  const connection = new Connection(config.rpc, "confirmed");
  const wallet = loadWallet();

  const idlPath = path.join(__dirname, "../../idl/kaching_settle.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  const provider = new anchor.AnchorProvider(
    connection,
    {
      publicKey: wallet.publicKey,
      signTransaction: async (tx) => { tx.sign(wallet); return tx; },
      signAllTransactions: async (txs) => { txs.forEach(t => t.sign(wallet)); return txs; },
    },
    { commitment: "confirmed" }
  );

  _program = new anchor.Program(idl, provider);
  return _program;
}

// fixture id -> u64 LE bytes, matching `fixture_id.to_le_bytes()` in Rust
function fixtureIdBytes(fixtureId) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(fixtureId));
  return buf;
}

// Derive market PDA
function getMarketPda(fixtureId, programId) {
  const pid = new PublicKey(programId || config.settleProgramId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    pid
  );
  return pda;
}

// Derive vault PDA for YES or NO side
function getVaultPda(fixtureId, side, programId) {
  const pid = new PublicKey(programId || config.settleProgramId);
  const seed = side === constants.SIDE.YES
    ? constants.SEEDS.YES_VAULT
    : constants.SEEDS.NO_VAULT;
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(seed), fixtureIdBytes(fixtureId)],
    pid
  );
  return pda;
}

// Derive position PDA for a specific user+market
function getPositionPda(fixtureId, userPubkey, programId) {
  const pid = new PublicKey(programId || config.settleProgramId);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(constants.SEEDS.POSITION),
      fixtureIdBytes(fixtureId),
      new PublicKey(userPubkey).toBuffer(),
    ],
    pid
  );
  return pda;
}

module.exports = {
  getProgram,
  getMarketPda,
  getVaultPda,
  getPositionPda,
  loadWallet,
  fixtureIdBytes,
};
"""

FILES['backend/src/server.js'] = r"""// backend/src/server.js
// Main entry point. Starts Express + Socket.IO server.
// Initializes TxLINE auth, stream, keeper, and AI.

require("dotenv").config({ path: __dirname + "/../../backend/.env" });

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const CORS_ORIGINS = [
  "http://localhost:5173",
  "https://kaching-settle-ten.vercel.app",
  /\.vercel\.app$/,
];

const auth = require("./txline/auth");
const stream = require("./txline/stream");
const { getLastScore } = require("./txline/stream");
const { fetchFixtures, getUpcoming } = require("./txline/fixtures");
const keeper = require("./keeper/settle-trigger");
const { autoCreateMarkets, autoSeedMarkets, setMarketCreatedCallback } = require("./keeper/auto-market");
const sockets = require("./sockets");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json());

// Map our normalized period back to TxLINE StatusId
// period: 0 pre, 1 1H, 3 HT, 2 2H, 5 FT
// StatusId: 1 pre, 2 1H, 3 HT, 4 2H, 5 FT
const PERIOD_TO_STATUS = { 0: 1, 1: 2, 3: 3, 2: 4, 5: 5 };

// ── Routes ─────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/fixtures", async (req, res) => {
  try {
    const fixtures = await fetchFixtures();
    res.json(fixtures);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/scores/snapshot/:fixtureId", async (req, res) => {
  try {
    const fixtureId = parseInt(req.params.fixtureId);

    // Prefer OUR score store first — it's built from the same SSE feed but
    // with sticky phase/score fixes applied, and it survives TxLINE clearing
    // finished matches.
    const stored = getLastScore(fixtureId);
    if (stored) {
      return res.json([{
        FixtureId: fixtureId,
        Participant1Goals: stored.homeGoals,
        Participant2Goals: stored.awayGoals,
        StatusId: PERIOD_TO_STATUS[stored.period] ?? 1,
        Clock: { Seconds: stored.minute * 60 },
        Stats: { "1": stored.homeGoals, "2": stored.awayGoals }
      }]);
    }

    // Nothing stored (e.g. backend restarted) — try TxLINE snapshot
    const axios = require("axios");
    const { makeHeaders } = require("./txline/auth");
    const config = require("../../shared/config");

    try {
      const r = await axios.get(
        config.txline.host + "/api/scores/snapshot/" + fixtureId,
        { headers: makeHeaders(), timeout: 5000 }
      );
      if (r.data && r.data.length > 0) {
        return res.json(r.data);
      }
    } catch(e) {
      // TxLINE snapshot failed or empty
    }

    res.json([]);
  } catch(e) {
    res.json([]);
  }
});

app.get("/api/fixtures/upcoming", async (req, res) => {
  try {
    const fixtures = await getUpcoming();
    res.json(fixtures);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All markets the keeper is (or was) watching — used by My Positions
// so the frontend never depends on a hardcoded list.
app.get("/api/markets", (req, res) => {
  try {
    res.json(keeper.getWatchedMarkets());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Register a market for keeper to watch
app.post("/api/markets/register", (req, res) => {
  const { fixtureId, marketId, question, statKey, threshold, comparison } = req.body;
  if (!fixtureId || !question || !statKey) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  keeper.registerMarket({ fixtureId, marketId, question, statKey, threshold, comparison, status: "active" });
  res.json({ registered: true });
});

// ── Start ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function start() {
  try {
    console.log("[server] Starting kaching-settle backend...");

    // Init TxLINE auth
    await auth.init();

    // Load fixtures
    await fetchFixtures();

    // Start live score stream
    const { generateCommentary } = require("./ai/pundit");
    const { generateVoice } = require("./ai/voice");

    stream.connect({
      onScoreUpdate: (score) => {
        sockets.broadcastScore(score.fixtureId, score);
      },
      onMatchEvent: (event) => {
        sockets.broadcastEvent(event.fixtureId, event);
      },
      onMatchFinished: (fixtureId) => {
        console.log("[stream] Match finished:", fixtureId);
      },
      onSignificantEvent: async (event) => {
        try {
          const allFixtures = await fetchFixtures();
          const fixture = allFixtures.find(f => f.fixtureId === event.fixtureId);
          if (!fixture) return;
          const teamName = event.team === "home" ? fixture.home : fixture.away;
          let prompt = "";
          if (event.type === "goal") {
            prompt = "GOAL for " + teamName + (event.minute ? " in the " + event.minute + "th minute" : "") + "! One sentence of excited football pundit commentary. Under 20 words.";
          } else if (event.type === "possible_goal") {
            prompt = "Possible goal for " + teamName + "! VAR is checking. One sentence of tense pundit commentary. Under 20 words.";
          } else if (event.type === "penalty") {
            prompt = "Penalty awarded to " + teamName + "! One sentence of dramatic pundit commentary. Under 20 words.";
          } else if (event.type === "red_card") {
            prompt = "Red card for " + teamName + "! One sentence of shocked pundit commentary. Under 20 words.";
          } else if (event.type === "var") {
            prompt = "VAR review for " + fixture.home + " vs " + fixture.away + ". One sentence of suspenseful commentary. Under 20 words.";
          }
          if (!prompt) return;
          console.log("[pundit] Live event:", event.type, teamName);
          const text = await generateCommentary({ prompt });
          if (!text) return;
          const audioUrl = await generateVoice(text);
          sockets.broadcastPundit(event.fixtureId, { text, audioUrl, event });
        } catch(e) {
          console.error("[pundit] Live error:", e.message);
        }
      },
    });

    // Init sockets
    sockets.init(io);

    // Wire auto-market to keeper so new markets are watched automatically
    setMarketCreatedCallback((fixture) => {
      keeper.registerMarket({
        fixtureId: fixture.fixtureId,
        marketId: fixture.fixtureId,
        question: `Will ${fixture.home} score a goal against ${fixture.away}?`,
        statKey: 1,
        threshold: 0,
        comparison: "greaterThan",
        status: "active",
        kickoffMs: fixture.kickoffMs,
        home: fixture.home,
        away: fixture.away,
      });
    });

    // Auto-create markets for all fixtures
    await autoCreateMarkets();
    // Auto-seeding disabled — SideMismatch prevents keeper from holding both sides
    // await autoSeedMarkets();

    // Register ALL fixtures with keeper so past-kickoff detection works.
    // (The keeper ALSO recovers unsettled markets straight from the chain at
    // start(), which covers fixtures TxLINE has already removed.)
    const allFixtures = await fetchFixtures();
    for (const fixture of allFixtures) {
      keeper.registerMarket({
        fixtureId: fixture.fixtureId,
        marketId: fixture.fixtureId,
        question: `Will ${fixture.home} score a goal against ${fixture.away}?`,
        statKey: 1,
        threshold: 0,
        comparison: "greaterThan",
        status: "active",
        kickoffMs: fixture.kickoffMs,
        home: fixture.home,
        away: fixture.away,
      });
    }
    console.log("[server] Registered", allFixtures.length, "fixtures with keeper");
    // Re-check every hour
    setInterval(async () => { await autoCreateMarkets(); }, 60 * 60 * 1000);

    // Start keeper — checks for completed fixtures every 60s
    keeper.onSettle((settlement) => {
      sockets.broadcastSettlement(settlement.fixtureId, settlement);
    });
    keeper.start(60000);

    server.listen(PORT, () => {
      console.log(`[server] Running on port ${PORT}`);
      console.log(`[server] Health: http://localhost:${PORT}/health`);
    });

  } catch (e) {
    console.error("[server] Startup failed:", e.message);
    process.exit(1);
  }
}

start();
"""

FILES['frontend/src/lib/solana.js'] = r"""import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Buffer } from "buffer";

const PROGRAM_ID = new PublicKey("9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const RPC = "https://api.devnet.solana.com";

// Anchor discriminators = sha256("global:<name>")[0..8]
const DISC = {
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  claim: Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]),
  void_market: Buffer.from([243, 175, 46, 124, 95, 101, 39, 69]),
  refund: Buffer.from([2, 96, 183, 251, 63, 208, 46, 46]),
};

const SEEDS = {
  MARKET: "market",
  YES_VAULT: "yes_vault",
  NO_VAULT: "no_vault",
  POSITION: "position",
};

export function getConnection() {
  return new Connection(RPC, "confirmed");
}

function fixtureIdBytes(id) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return buf;
}

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

export function getMarketPda(fixtureId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

export function getVaultPda(fixtureId, side) {
  const seed = side === 0 ? SEEDS.YES_VAULT : SEEDS.NO_VAULT;
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

export function getPositionPda(fixtureId, user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.POSITION), fixtureIdBytes(fixtureId), new PublicKey(user).toBuffer()],
    PROGRAM_ID
  )[0];
}

function acc(pubkey, isSigner, isWritable) {
  return { pubkey, isSigner, isWritable };
}

async function sendIx(wallet, ix) {
  const connection = getConnection();
  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function deposit(wallet, { fixtureId, side, amountUsdc }) {
  const market = getMarketPda(fixtureId);
  const vault = getVaultPda(fixtureId, side);
  const position = getPositionPda(fixtureId, wallet.publicKey);
  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  const amount = Math.floor(amountUsdc * 1_000_000);
  const data = Buffer.concat([
    DISC.deposit,
    Buffer.from([side]),
    u64le(amount),
  ]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      acc(wallet.publicKey, true, true),
      acc(market, false, true),
      acc(position, false, true),
      acc(vault, false, true),
      acc(userToken, false, true),
      acc(TOKEN_PROGRAM_ID, false, false),
      acc(SystemProgram.programId, false, false),
    ],
    data,
  });

  const tx = await sendIx(wallet, ix);
  return { tx };
}

export async function claim(wallet, { fixtureId, winningSide }) {
  const market = getMarketPda(fixtureId);
  const position = getPositionPda(fixtureId, wallet.publicKey);
  const winningVault = getVaultPda(fixtureId, winningSide);
  const losingVault = getVaultPda(fixtureId, winningSide === 0 ? 1 : 0);
  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      acc(wallet.publicKey, true, true),
      acc(market, false, false),
      acc(position, false, true),
      acc(winningVault, false, true),
      acc(losingVault, false, true),
      acc(userToken, false, true),
      acc(TOKEN_PROGRAM_ID, false, false),
    ],
    data: DISC.claim,
  });

  const tx = await sendIx(wallet, ix);
  return { tx };
}

// Manually decode Market account (no Anchor needed)
export async function voidMarket(wallet, { fixtureId }) {
  const market = getMarketPda(fixtureId);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      acc(wallet.publicKey, true, false),
      acc(market, false, true),
    ],
    data: DISC.void_market,
  });

  const tx = await sendIx(wallet, ix);
  return { tx };
}

export async function refund(wallet, { fixtureId, side }) {
  const market = getMarketPda(fixtureId);
  const position = getPositionPda(fixtureId, wallet.publicKey);
  const userVault = getVaultPda(fixtureId, side);
  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      acc(wallet.publicKey, true, true),
      acc(market, false, false),
      acc(position, false, true),
      acc(userVault, false, true),
      acc(userToken, false, true),
      acc(TOKEN_PROGRAM_ID, false, false),
    ],
    data: DISC.refund,
  });

  const tx = await sendIx(wallet, ix);
  return { tx };
}

export async function getMarket(fixtureId) {
  const connection = getConnection();
  const pda = getMarketPda(fixtureId);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;

  const d = info.data;
  let o = 8; // skip discriminator

  const fid = d.readBigUInt64LE(o); o += 8;
  const qLen = d.readUInt32LE(o); o += 4;
  const question = d.slice(o, o + qLen).toString("utf8"); o += qLen;
  const kickoffTs = d.readBigInt64LE(o); o += 8;
  o += 4;  // stat_key
  o += 8;  // threshold
  o += 1;  // comparison
  const yesTotal = d.readBigUInt64LE(o); o += 8;
  const noTotal = d.readBigUInt64LE(o); o += 8;
  const status = d.readUInt8(o); o += 1;
  const winningSide = d.readUInt8(o); o += 1;

  return {
    fixtureId: Number(fid),
    question,
    kickoffTs: Number(kickoffTs),
    yesTotal: Number(yesTotal) / 1_000_000,
    noTotal: Number(noTotal) / 1_000_000,
    status,
    winningSide,
  };
}

// Fetch and decode a user's Position account. Returns null if none.
export async function getPosition(fixtureId, user) {
  const connection = getConnection();
  const pda = getPositionPda(fixtureId, user);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;

  const d = info.data;
  let o = 8 + 8 + 32; // discriminator + fixture_id + user
  const side = d.readUInt8(o); o += 1;
  const amount = Number(d.readBigUInt64LE(o)) / 1_000_000; o += 8;
  const claimed = d.readUInt8(o) === 1;

  return { side, amount, claimed };
}
"""

FILES['frontend/src/pages/MyPositions.jsx'] = r"""import React, { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getMarketPda, refund } from "../lib/solana";
import WalletButton from "../components/WalletButton";

const BACKEND = "https://kaching-settle-production.up.railway.app";

// Fallback list — only used if the backend market list can't be fetched.
const KNOWN_MARKETS = [
  { fixtureId: 18209181, name: "France vs Morocco", question: "Will France score a goal against Morocco?" },
  { fixtureId: 18218149, name: "Spain vs Belgium", question: "Will Spain score a goal against Belgium?" },
  { fixtureId: 18213979, name: "Norway vs England", question: "Will Norway score a goal against England?" },
  { fixtureId: 18222446, name: "Argentina vs Switzerland", question: "Will Argentina score a goal against Switzerland?" },
  { fixtureId: 18143850, name: "Vietnam vs Myanmar", question: "Will Vietnam score a goal against Myanmar?" },
  { fixtureId: 18182808, name: "Australia vs Brazil", question: "Will Australia score a goal against Brazil?" },
  { fixtureId: 18182864, name: "Australia vs Brazil", question: "Will Australia score a goal against Brazil?" },
];

const STATUS = { 0: "Open", 1: "Locked", 2: "Settled", 3: "Voided" };
const SIDE = { 0: "YES", 1: "NO" };

// Merge the backend's live market list with the hardcoded fallback,
// deduped by fixtureId.
async function loadMarketList() {
  const byId = new Map();
  for (const m of KNOWN_MARKETS) byId.set(m.fixtureId, m);

  try {
    const res = await fetch(`${BACKEND}/api/markets`);
    const list = await res.json();
    if (Array.isArray(list)) {
      for (const m of list) {
        if (!m.fixtureId) continue;
        byId.set(m.fixtureId, {
          fixtureId: m.fixtureId,
          name: m.home && m.away ? `${m.home} vs ${m.away}` : (m.question || `Fixture ${m.fixtureId}`),
          question: m.question || "",
        });
      }
    }
  } catch (e) {
    // backend unreachable — fallback list still works
  }
  return Array.from(byId.values());
}

export default function MyPositions() {
  const { publicKey, connected } = useWallet();
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connected || !publicKey) return;
    loadPositions();
  }, [connected, publicKey]);

  async function loadPositions() {
    setLoading(true);
    const { getMarket, getPositionPda, getConnection } = await import("../lib/solana");
    const connection = getConnection();
    const markets = await loadMarketList();
    const found = [];

    for (const m of markets) {
      try {
        // Check if market exists and get its state
        const market = await getMarket(m.fixtureId);
        if (!market) continue;

        // Check if user has a position
        const positionPda = getPositionPda(m.fixtureId, publicKey.toBase58());
        const info = await connection.getAccountInfo(positionPda);
        if (!info) continue;

        // Decode position
        const d = info.data;
        let o = 8 + 8 + 32; // discriminator + fixture_id + user
        const side = d.readUInt8(o); o += 1;
        const amount = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
        const claimed = d.readUInt8(o) === 1;

        const won = market.status === 2 && market.winningSide === side;
        const canClaim = won && !claimed;
        const canRefund = market.status === 3 && !claimed;

        found.push({
          ...m,
          question: m.question || market.question,
          market,
          side,
          amount,
          claimed,
          won,
          canClaim,
          canRefund,
          status: market.status,
          winningSide: market.winningSide,
        });
      } catch(e) {
        // Position doesn't exist for this market
      }
    }

    setPositions(found);
    setLoading(false);
  }

  if (!connected) {
    return (
      <div className="my-positions">
        <h2>My Positions</h2>
        <div className="connect-prompt">
          <p>Connect your wallet to see your betting history</p>
          <WalletButton />
        </div>
      </div>
    );
  }

  if (loading) return <div className="loading">Loading your positions...</div>;

  return (
    <div className="my-positions">
      <h2>My Positions</h2>
      {positions.length === 0 && (
        <p className="empty">No positions found for this wallet.</p>
      )}
      {positions.map((p, i) => (
        <div key={i} className={"position-card " + (p.canClaim || p.canRefund ? "can-claim" : "")}>
          <div className="position-match">{p.name}</div>
          <div className="position-question">{p.question}</div>
          <div className="position-details">
            <span className={"position-side " + SIDE[p.side].toLowerCase()}>
              {SIDE[p.side]}
            </span>
            <span className="position-amount">${p.amount.toFixed(2)} USDC</span>
            <span className="position-status">{STATUS[p.status]}</span>
          </div>

          {p.status === 2 && (
            <div className="position-result">
              {p.won ? (
                p.claimed ? (
                  <span className="result-claimed">✅ Claimed</span>
                ) : (
                  <span className="result-win">🏆 You won — claim your winnings!</span>
                )
              ) : (
                <span className="result-loss">❌ {SIDE[p.winningSide]} won — better luck next time</span>
              )}
            </div>
          )}

          {p.status === 3 && (
            <div className="position-result">
              {p.claimed ? (
                <span className="result-claimed">↩️ Refunded</span>
              ) : (
                <span className="result-win">↩️ Market voided — your stake is refundable</span>
              )}
            </div>
          )}

          {p.canClaim && (
            <ClaimButton position={p} onClaimed={loadPositions} />
          )}

          {p.canRefund && (
            <RefundButton position={p} onRefunded={loadPositions} />
          )}

          <a
            href={"https://explorer.solana.com/address/" + getMarketAddress(p.fixtureId) + "?cluster=devnet"}
            target="_blank"
            rel="noopener noreferrer"
            className="explorer-link"
            style={{fontSize:"11px", display:"block", marginTop:"8px"}}
          >
            View on Solana Explorer →
          </a>
        </div>
      ))}
    </div>
  );
}

function ClaimButton({ position, onClaimed }) {
  const wallet = useWallet();
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);

  async function handleClaim() {
    setClaiming(true);
    setError(null);
    try {
      const { claim } = await import("../lib/solana");
      await claim(wallet, {
        fixtureId: position.fixtureId,
        winningSide: position.winningSide,
      });
      onClaimed();
    } catch(e) {
      setError(e.message.slice(0, 80));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div>
      <button className="deposit-btn" onClick={handleClaim} disabled={claiming}>
        {claiming ? "Claiming..." : "Claim Winnings"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function RefundButton({ position, onRefunded }) {
  const wallet = useWallet();
  const [refunding, setRefunding] = useState(false);
  const [error, setError] = useState(null);

  async function handleRefund() {
    setRefunding(true);
    setError(null);
    try {
      await refund(wallet, {
        fixtureId: position.fixtureId,
        side: position.side, // refund pulls from the vault the user paid into
      });
      onRefunded();
    } catch(e) {
      if (e.message.includes("AlreadyRefunded") || e.message.includes("0x177e")) {
        setError("Already refunded.");
      } else if (e.message.includes("MarketNotVoid") || e.message.includes("0x177d")) {
        setError("Market is not voided — refunds not available.");
      } else {
        setError(e.message.slice(0, 80));
      }
    } finally {
      setRefunding(false);
    }
  }

  return (
    <div>
      <button className="deposit-btn" onClick={handleRefund} disabled={refunding}>
        {refunding ? "Refunding..." : "Get Refund"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function getMarketAddress(fixtureId) {
  try {
    const pda = getMarketPda(fixtureId);
    return pda.toBase58();
  } catch(e) {
    return "9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B";
  }
}
"""

FILES['frontend/src/pages/MarketView.jsx'] = r"""import React, { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import WalletButton from "../components/WalletButton";
import LiveFeed from "../components/LiveFeed";
import DepositBox from "../components/DepositBox";
import PotMeter from "../components/PotMeter";
import VoicePlayer from "../components/VoicePlayer";
import Receipt from "../components/Receipt";
import { connectSocket } from "../lib/socket";
import { getMarket } from "../lib/solana";

const BACKEND = "https://kaching-settle-production.up.railway.app";

// Build a display fixture from the on-chain question when TxLINE has
// removed the fixture from its feed (happens right after full time).
function fixtureFromMarket(fixtureId, market) {
  let home = "Home", away = "Away";
  const m = (market.question || "").match(/^Will (.+) score a goal against (.+)\?$/);
  if (m) { home = m[1]; away = m[2]; }
  return {
    fixtureId,
    home,
    away,
    competition: "",
    kickoffMs: market.kickoffTs * 1000,
  };
}

export default function MarketView({ fixtureId, onBack }) {
  const { connected } = useWallet();
  const [fixture, setFixture] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [score, setScore] = useState(null);
  const [events, setEvents] = useState([]);
  const [yesPot, setYesPot] = useState(0);
  const [noPot, setNoPot] = useState(0);
  const [settlement, setSettlement] = useState(null);
  const [livePundit, setLivePundit] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);

  useEffect(() => {
    let punditTimer = null;

    fetch(`${BACKEND}/api/fixtures`)
      .then(r => r.json())
      .then(data => {
        const f = data.find(x => x.fixtureId === fixtureId);
        if (f) setFixture(f);
      })
      .catch(() => {});

    // Fetch last known score on page load
    fetch(`${BACKEND}/api/scores/snapshot/${fixtureId}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          const latest = data[data.length - 1];
          setScore({
            fixtureId,
            homeGoals: latest.Participant1Goals ?? latest.HomeGoals ?? 0,
            awayGoals: latest.Participant2Goals ?? latest.AwayGoals ?? 0,
            period: latest.StatusId === 5 ? 5 : latest.StatusId === 4 ? 2 : latest.StatusId === 3 ? 3 : latest.StatusId === 2 ? 1 : 0,
            minute: Math.floor((latest.Clock?.Seconds || 0) / 60),
          });
        }
      }).catch(() => {});

    // Load on-chain market state — works even after page refresh,
    // AND provides team names when TxLINE has dropped the fixture.
    getMarket(fixtureId).then(market => {
      if (!market) { setNotFound(true); return; }

      setYesPot(market.yesTotal);
      setNoPot(market.noTotal);

      // TxLINE removes finished fixtures — fall back to on-chain data
      setFixture(prev => prev || fixtureFromMarket(fixtureId, market));

      // If already settled — show settlement screen immediately
      if (market.status === 2) {
        setSettlement({
          fixtureId,
          question: market.question,
          winningSide: market.winningSide === 0 ? "YES" : "NO",
          result: market.winningSide === 0,
          proof: { dailyScoresRoot: "verify on Solana Explorer" },
          commentary: market.winningSide === 0
            ? "YES wins — the proof confirmed the result on Solana."
            : "NO wins — the proof confirmed the result on Solana.",
          audioUrl: null,
          settledAt: Date.now(),
        });
      }

      // If voided
      if (market.status === 3) {
        setSettlement({
          fixtureId,
          question: market.question,
          winningSide: "VOID",
          result: null,
          proof: null,
          commentary: "Market voided — one side had no deposits. Refunds available.",
          audioUrl: null,
          settledAt: Date.now(),
          voided: true,
        });
      }
    }).catch(() => {});

    const socket = connectSocket(BACKEND);
    socket.emit("subscribe-market", fixtureId);

    socket.on("score-update", (s) => {
      if (s.fixtureId === fixtureId) setScore(s);
    });

    socket.on("match-event", (e) => {
      if (e.fixtureId === fixtureId) {
        setEvents(prev => [e, ...prev].slice(0, 20));
      }
    });

    // Live pundit commentary is its own state — it must never overwrite
    // or corrupt the settlement object.
    socket.on("pundit", (data) => {
      if (data.fixtureId && data.fixtureId !== fixtureId) return;
      if (!data.text) return;
      setLivePundit({ text: data.text, audioUrl: data.audioUrl });
      if (punditTimer) clearTimeout(punditTimer);
      punditTimer = setTimeout(() => setLivePundit(null), 15000);
    });

    socket.on("settlement", (s) => {
      if (s.fixtureId === fixtureId) {
        setSettlement(s);
        if (s.audioUrl) setAudioUrl(s.audioUrl);
      }
    });

    return () => {
      if (punditTimer) clearTimeout(punditTimer);
      socket.disconnect();
    };
  }, [fixtureId]);

  if (!fixture) {
    return (
      <div className="market-view">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <div className="loading">
          {notFound ? "Market not found for this fixture." : "Loading market..."}
        </div>
      </div>
    );
  }

  return (
    <div className="market-view">
      <button className="back-btn" onClick={onBack}>← Back</button>

      <div className="match-header">
        <h2>{fixture.home} vs {fixture.away}</h2>
        {fixture.competition && <p className="competition">{fixture.competition}</p>}
        <p className="kickoff">{new Date(fixture.kickoffMs).toLocaleString()}</p>
      </div>

      <LiveFeed score={score} events={events} fixture={fixture} />

      {livePundit && !settlement && (
        <VoicePlayer audioUrl={livePundit.audioUrl} commentary={livePundit.text} />
      )}

      {settlement ? (
        <>
          <VoicePlayer
            audioUrl={audioUrl}
            commentary={settlement.commentary}
          />
          <Receipt settlement={settlement} />
        </>
      ) : (
        <>
          <PotMeter yesPot={yesPot} noPot={noPot} />
          {Date.now() > fixture?.kickoffMs ? (
            <div className="match-locked">
              <p>⚽ Match in progress — deposits closed</p>
              <p className="locked-sub">
                Total locked: ${(yesPot + noPot).toFixed(2)} USDC
                — settlement happens automatically when the match ends.
              </p>
            </div>
          ) : connected ? (
            <DepositBox
              fixtureId={fixtureId}
              fixture={fixture}
              onDeposit={(side, amount) => {
                if (side === "YES") setYesPot(p => p + amount);
                else setNoPot(p => p + amount);
                setTimeout(() => {
                  getMarket(fixtureId).then(m => {
                    if (m) { setYesPot(m.yesTotal); setNoPot(m.noTotal); }
                  }).catch(() => {});
                }, 2000);
              }}
            />
          ) : (
            <div className="connect-prompt">
              <p>Connect your wallet to participate</p>
              <WalletButton />
            </div>
          )}
        </>
      )}
    </div>
  );
}
"""

FILES['frontend/src/components/Receipt.jsx'] = r"""import React, { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { claim, refund, getPosition } from "../lib/solana";

export default function Receipt({ settlement }) {
  if (!settlement) return null;

  const { publicKey } = useWallet();
  const wallet = useWallet();
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [claimTx, setClaimTx] = useState(null);
  const [error, setError] = useState(null);

  const PROGRAM_ID = "9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B";
  const explorerUrl = `https://solscan.io/account/${PROGRAM_ID}?cluster=devnet`;

  async function handleClaim() {
    if (!publicKey) return setError("Connect your wallet first");
    setClaiming(true);
    setError(null);
    try {
      if (settlement.voided) {
        // Refund — look up which side the user was on, then pull
        // their stake back from that side's vault.
        const pos = await getPosition(settlement.fixtureId, publicKey);
        if (!pos) { setError("No position found for this wallet."); return; }
        if (pos.claimed) { setError("Already refunded."); return; }
        const { tx } = await refund(wallet, {
          fixtureId: settlement.fixtureId,
          side: pos.side,
        });
        setClaimTx(tx);
        setClaimed(true);
        return;
      }
      const winningSide = settlement.winningSide === "YES" ? 0 : 1;
      const { tx } = await claim(wallet, {
        fixtureId: settlement.fixtureId,
        winningSide,
      });
      setClaimTx(tx);
      setClaimed(true);
    } catch(e) {
      if (e.message.includes("WrongSide") || e.message.includes("0x1779")) {
        setError("You bet on the losing side — no claim available.");
      } else if (e.message.includes("AlreadyClaimed") || e.message.includes("0x1778")) {
        setError("Already claimed.");
      } else if (e.message.includes("NothingToClaim") || e.message.includes("0x177a")) {
        setError("No funds to claim — this market had no deposits.");
      } else if (e.message.includes("Simulation failed")) {
        setError("Claim failed — you may not have a position on the winning side.");
      } else {
        setError(e.message.slice(0, 100));
      }
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="receipt">
      <div className="receipt-header">
        <span className="receipt-icon">
          {settlement.voided ? "↩️" : "✅"}
        </span>
        <h3>{settlement.voided ? "Market Voided" : "Settled by Proof"}</h3>
      </div>

      <div className="receipt-result">
        {!settlement.voided && (
          <span className={"winner-side " + (settlement.winningSide || "").toLowerCase()}>
            {settlement.winningSide} wins
          </span>
        )}
        <p className="receipt-question">{settlement.question}</p>
      </div>

      {!settlement.voided && settlement.proof && (
        <div className="receipt-proof">
          <p className="proof-label">Verified by TxLINE Merkle proof</p>
          <p className="proof-detail">Fixture: <code>{settlement.fixtureId}</code></p>
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="explorer-link">
            Verify on Solana Explorer →
          </a>
        </div>
      )}

      {claimed && claimTx ? (
        <div className="claim-success">
          <p>✅ {settlement.voided ? "Refunded successfully!" : "Claimed successfully!"}</p>
          <a
            href={`https://explorer.solana.com/tx/${claimTx}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="explorer-link"
          >
            View claim transaction →
          </a>
        </div>
      ) : (
        <button
          className="deposit-btn"
          onClick={handleClaim}
          disabled={claiming || !publicKey}
          style={{ marginTop: "12px" }}
        >
          {claiming ? "Claiming..." : settlement.voided ? "Request Refund" : "Claim Winnings"}
        </button>
      )}

      {error && <p className="error" style={{marginTop:"8px"}}>{error}</p>}

      <p className="receipt-note">
        {settlement.voided
          ? "One side had no deposits — your stake will be returned."
          : "No company decided this. The proof did."}
      </p>
    </div>
  );
}
"""

FILES['scripts/manual-settle.js'] = r"""// scripts/manual-settle.js
// Manually lock + settle (or void) a market from the CLI.
//
// Usage:
//   node scripts/manual-settle.js <fixtureId> <YES|NO|VOID>
//
// The signer is WALLET_KEYPAIR from backend/.env. The script reads the
// market's on-chain authority first and tells you exactly which wallet
// must sign if there's a mismatch (e.g. markets created with Phantom).

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const {
  Connection, PublicKey, Transaction,
  TransactionInstruction, Keypair
} = require("@solana/web3.js");
const bs58 = require("bs58");
const config = require("../shared/config");
const constants = require("../shared/constants");

const PROGRAM_ID = new PublicKey(config.settleProgramId);

// Anchor discriminators
const DISC = {
  lock_market: Buffer.from([107, 8, 184, 91, 223, 13, 180, 38]),
  settle: Buffer.from([175, 42, 185, 87, 144, 131, 102, 212]),
  void_market: Buffer.from([243, 175, 46, 124, 95, 101, 39, 69]),
};

function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  return Keypair.fromSecretKey(decoder.decode(raw));
}

function fixtureIdBytes(id) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return buf;
}

function getMarketPda(fixtureId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

function decodeMarket(d) {
  let o = 8;
  const fixtureId = Number(d.readBigUInt64LE(o)); o += 8;
  const qLen = d.readUInt32LE(o); o += 4;
  const question = d.slice(o, o + qLen).toString("utf8"); o += qLen;
  const kickoffTs = Number(d.readBigInt64LE(o)); o += 8;
  o += 4 + 8 + 1; // stat_key, threshold, comparison
  const yesTotal = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
  const noTotal = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
  const status = d.readUInt8(o); o += 1;
  const winningSide = d.readUInt8(o); o += 1;
  const authority = new PublicKey(d.slice(o, o + 32));
  return { fixtureId, question, kickoffTs, yesTotal, noTotal, status, winningSide, authority };
}

async function sendIx(connection, wallet, marketPda, data) {
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: marketPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function main() {
  const fixtureId = parseInt(process.argv[2]);
  const outcome = (process.argv[3] || "").toUpperCase();

  if (!fixtureId || !["YES", "NO", "VOID"].includes(outcome)) {
    console.log("Usage: node scripts/manual-settle.js <fixtureId> <YES|NO|VOID>");
    process.exit(1);
  }

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const marketPda = getMarketPda(fixtureId);

  console.log("Signer:    ", wallet.publicKey.toBase58());
  console.log("Market PDA:", marketPda.toBase58());

  const info = await connection.getAccountInfo(marketPda);
  if (!info) { console.log("Market not found on-chain."); return; }

  const m = decodeMarket(info.data);
  console.log(`Question:   ${m.question}`);
  console.log(`YES pot: $${m.yesTotal}  NO pot: $${m.noTotal}  Status: ${m.status}`);
  console.log(`Authority:  ${m.authority.toBase58()}`);

  if (m.status === 2) { console.log("Already settled. Winning side:", m.winningSide === 0 ? "YES" : "NO"); return; }
  if (m.status === 3) { console.log("Already voided."); return; }

  if (!m.authority.equals(wallet.publicKey)) {
    console.log("\n❌ AUTHORITY MISMATCH");
    console.log("This market can only be settled by:", m.authority.toBase58());
    console.log("Set WALLET_KEYPAIR in backend/.env to THAT wallet's base58 secret key and rerun.");
    process.exit(1);
  }

  // Step 1: Lock if open
  if (m.status === 0) {
    console.log("Locking market...");
    const sig = await sendIx(connection, wallet, marketPda, DISC.lock_market);
    console.log("Locked:", sig);
  }

  // Step 2: Settle or void
  if (outcome === "VOID") {
    console.log("Voiding market...");
    const sig = await sendIx(connection, wallet, marketPda, DISC.void_market);
    console.log("Voided:", sig);
  } else {
    const side = outcome === "YES" ? 0 : 1;
    console.log(`Settling — ${outcome} wins...`);
    const data = Buffer.concat([DISC.settle, Buffer.from([side])]);
    const sig = await sendIx(connection, wallet, marketPda, data);
    console.log("Settled:", sig);
  }

  console.log("\n✅ Done. Positions page will now show the final state.");
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
"""


def main():
    if not os.path.isdir("backend"):
        print("ERROR: run from kaching-settle repo root"); return
    for path, content in FILES.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f: f.write(content)
        print("wrote", path, f"({len(content)} bytes)")
    print("\nDone.")
    print("Push: git add -A && git commit -m 'fix: correct account key dailyScoresMerkleRoots' && git push")

if __name__ == "__main__": main()
