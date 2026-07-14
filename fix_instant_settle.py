#!/usr/bin/env python3
import os

FILES = {}

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
        console.log("[stream] Match finished:", fixtureId, "— triggering keeper immediately");
        // Trigger settlement immediately instead of waiting for the 2.5h fallback
        keeper.checkAndSettle && keeper.checkAndSettle();
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
  checkAndSettle,
  settleMarketOnChain,
  voidMarketOnChain,
  recoverMarketsFromChain,
};
"""


def main():
    if not os.path.isdir("backend"):
        print("ERROR: run from kaching-settle repo root"); return
    for path, content in FILES.items():
        d = os.path.dirname(path)
        if d: os.makedirs(d, exist_ok=True)
        with open(path, "w") as f: f.write(content)
        print("wrote", path)
    print("Done.")
    print("Run: git add -A && git commit -m \'fix: trigger settlement instantly on FT from SSE stream\' && git push")


if __name__ == "__main__": main()
