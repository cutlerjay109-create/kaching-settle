// backend/src/keeper/settle-trigger.js
// Watches for completed fixtures and triggers settlement.
// Fetches TxLINE proof, verifies it, then calls program settle.
// This is the robot that closes markets automatically.

const { verifyStat } = require("../txline/validate");
const {
  Connection, PublicKey, Transaction,
  TransactionInstruction, Keypair
} = require("@solana/web3.js");
const bs58 = require("bs58");

const DISC_VOID = Buffer.from([243, 175, 46, 124, 95, 101, 39, 69]);
const DISC_LOCK = Buffer.from([107, 8, 184, 91, 223, 13, 180, 38]);
const DISC_SETTLE = Buffer.from([175, 42, 185, 87, 144, 131, 102, 212]);

function loadKeeperWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  return Keypair.fromSecretKey(decoder.decode(raw));
}

function fixtureIdBytes(id) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return buf;
}

async function voidMarketOnChain(fixtureId) {
  const config = require("../../shared/config");
  const constants = require("../../shared/constants");
  const wallet = loadKeeperWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const programId = new PublicKey(config.settleProgramId);

  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    programId
  );

  // Lock first if needed
  const info = await connection.getAccountInfo(marketPda);
  if (!info) return;
  const status = info.data.readUInt8(8 + 8 + 4 + info.data.readUInt32LE(8 + 8) + 8 + 4 + 8 + 1 + 8 + 8);

  if (status === 0) {
    const lockIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: marketPda, isSigner: false, isWritable: true },
      ],
      data: DISC_LOCK,
    });
    const lockTx = new Transaction().add(lockIx);
    lockTx.feePayer = wallet.publicKey;
    lockTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    lockTx.sign(wallet);
    await connection.sendRawTransaction(lockTx.serialize());
    await new Promise(r => setTimeout(r, 2000));
  }

  const voidIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: marketPda, isSigner: false, isWritable: true },
    ],
    data: DISC_VOID,
  });

  const voidTx = new Transaction().add(voidIx);
  voidTx.feePayer = wallet.publicKey;
  voidTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  voidTx.sign(wallet);
  const sig = await connection.sendRawTransaction(voidTx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  console.log("[keeper] Market voided:", fixtureId, sig.slice(0,20) + "...");
  return sig;
}
const { getCompleted, getPastKickoff } = require("../txline/fixtures");
const { generateCommentary } = require("../ai/pundit");
const { generateVoice } = require("../ai/voice");

// In-memory map of active markets
// { fixtureId: { marketId, question, statKey, threshold, comparison, status } }
const activeMarkets = new Map();
let settleCallback = null;
let checkInterval = null;

function registerMarket(market) {
  activeMarkets.set(market.fixtureId, market);
  console.log(`[keeper] Watching fixture ${market.fixtureId}: "${market.question}"`);
}

function onSettle(callback) {
  settleCallback = callback;
}

async function checkAndSettle() {
  if (!activeMarkets.size) return;

  const now = Date.now();

  // Build fixture list from THREE sources:
  // 1. TxLINE completed fixtures
  // 2. Past-kickoff fixtures still in feed
  // 3. Active markets whose kickoff time has passed (most reliable)
  const completed = await getCompleted();
  const pastKickoff = await getPastKickoff();

  const seen = new Set(completed.map(f => f.fixtureId));
  for (const f of pastKickoff) {
    if (!seen.has(f.fixtureId)) {
      completed.push(f);
      seen.add(f.fixtureId);
    }
  }

  // Most importantly: check ALL active markets by their kickoff time
  // This catches matches TxLINE has removed from the feed entirely
  for (const [fixtureId, market] of activeMarkets) {
    if (!seen.has(fixtureId) && market.kickoffMs) {
      // If kickoff was more than 2.5 hours ago — match is almost certainly done
      if (now - market.kickoffMs > 2.5 * 60 * 60 * 1000) {
        completed.push({ fixtureId, ...market });
        seen.add(fixtureId);
        console.log(`[keeper] Adding past-kickoff market to check: ${fixtureId}`);
      }
    }
  }

  for (const fixture of completed) {
    const market = activeMarkets.get(fixture.fixtureId);
    if (!market || market.status === "settled") continue;

    console.log(`[keeper] Fixture ${fixture.fixtureId} completed — verifying...`);

    try {
      // Check on-chain market state first
      const { Connection, PublicKey } = require("@solana/web3.js");
      const config = require("../../shared/config");
      const constants = require("../../shared/constants");
      const { getProgram, getMarketPda } = require("../program/client");

      const connection = new Connection(config.rpc, "confirmed");
      const programId = new PublicKey(config.settleProgramId);

      function fixtureIdBytes(id) {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(BigInt(id));
        return buf;
      }

      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixture.fixtureId)],
        programId
      );

      const info = await connection.getAccountInfo(marketPda);
      if (info) {
        const d = info.data;
        let o = 8;
        o += 8;
        const qLen = d.readUInt32LE(o); o += 4 + qLen;
        o += 8 + 4 + 8 + 1;
        const yesTotal = d.readBigUInt64LE(o); o += 8;
        const noTotal = d.readBigUInt64LE(o);

        // If one side is empty — void the market on-chain
        if (yesTotal === 0n || noTotal === 0n) {
          console.log(`[keeper] One side empty for ${fixture.fixtureId} — voiding market on-chain`);
          try {
            await voidMarketOnChain(fixture.fixtureId);
          } catch(e) {
            console.error("[keeper] Void failed:", e.message);
          }
          // Mark as settled regardless to stop retrying
          market.status = "settled";
          activeMarkets.set(fixture.fixtureId, market);
          if (settleCallback) {
            settleCallback({
              fixtureId: fixture.fixtureId,
              marketId: market.marketId,
              question: market.question,
              result: null,
              winningSide: "VOID",
              proof: null,
              commentary: "This market has been voided — one side had no deposits. All funds will be refunded.",
              audioUrl: null,
              settledAt: Date.now(),
              voided: true,
            });
          }
          market.status = "settled";
          activeMarkets.set(fixture.fixtureId, market);
          continue;
        }
      }

      const { result, proof } = await verifyStat({
        fixtureId: fixture.fixtureId,
        statKey: market.statKey,
        threshold: market.threshold,
        comparison: market.comparison,
      });

      const winningSide = result ? "YES" : "NO";

      // Generate AI commentary
      const text = await generateCommentary({
        fixture,
        question: market.question,
        result,
        winningSide,
        proof,
      });

      const audioUrl = await generateVoice(text);

      const settlement = {
        fixtureId: fixture.fixtureId,
        marketId: market.marketId,
        question: market.question,
        result,
        winningSide,
        proof,
        commentary: text,
        audioUrl,
        settledAt: Date.now(),
      };

      market.status = "settled";
      activeMarkets.set(fixture.fixtureId, market);

      console.log(`[keeper] Settled: ${winningSide} wins — ${text}`);

      if (settleCallback) settleCallback(settlement);

    } catch (e) {
      console.error(`[keeper] Settle error for ${fixture.fixtureId}:`, e.message);
    }
  }
}

function start(intervalMs = 60000) {
  console.log(`[keeper] Started — checking every ${intervalMs / 1000}s`);
  checkInterval = setInterval(checkAndSettle, intervalMs);
  checkAndSettle(); // run immediately
}

function stop() {
  if (checkInterval) clearInterval(checkInterval);
  console.log("[keeper] Stopped");
}

module.exports = { registerMarket, onSettle, start, stop };
