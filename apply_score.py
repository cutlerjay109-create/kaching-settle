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
const path = require("path");
const fs = require("fs");

// Persistent score store — survives Railway restarts
// Scores are written here by the SSE stream and manually seeded for past matches.
const SCORE_STORE_PATH = path.join(__dirname, "../../data/scores.json");

function loadPersistedScores() {
  try {
    if (fs.existsSync(SCORE_STORE_PATH)) {
      return JSON.parse(fs.readFileSync(SCORE_STORE_PATH, "utf8"));
    }
  } catch(e) {}
  return {};
}

function savePersistedScores(store) {
  try {
    fs.mkdirSync(path.dirname(SCORE_STORE_PATH), { recursive: true });
    fs.writeFileSync(SCORE_STORE_PATH, JSON.stringify(store, null, 2));
  } catch(e) {}
}

// Seed known final scores for completed matches
// Format: { fixtureId: { homeGoals, awayGoals, period: 5 } }
const KNOWN_SCORES = {
  18213979: { homeGoals: 1, awayGoals: 2, period: 5, minute: 90 }, // Norway 1-2 England
  18222446: { homeGoals: 1, awayGoals: 2, period: 5, minute: 90 }, // Argentina 1-2 Switzerland
};

const persistedScores = { ...KNOWN_SCORES, ...loadPersistedScores() };

// Persist score when SSE stream updates it
function persistScore(fixtureId, score) {
  persistedScores[fixtureId] = score;
  savePersistedScores(persistedScores);
}
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
    // Check persisted store first (survives restarts, has past matches)
    const persisted = persistedScores[fixtureId];
    if (persisted) {
      return res.json([{
        FixtureId: fixtureId,
        Participant1Goals: persisted.homeGoals,
        Participant2Goals: persisted.awayGoals,
        StatusId: PERIOD_TO_STATUS[persisted.period] ?? 5,
        Clock: { Seconds: (persisted.minute || 90) * 60 },
        Stats: { "1": persisted.homeGoals, "2": persisted.awayGoals }
      }]);
    }

    // Fall back to in-memory store (current match)
    const stored = getLastScore(fixtureId);
    if (stored) {
      // Persist for future restarts
      persistScore(fixtureId, stored);
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
        persistScore(score.fixtureId, score);
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

FILES['frontend/src/pages/MyPositions.jsx'] = r"""import React, { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getMarketPda, refund } from "../lib/solana";
import WalletButton from "../components/WalletButton";

const BACKEND = "https://kaching-settle-production.up.railway.app";

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
  } catch (e) {}
  return Array.from(byId.values());
}

// Fetch final score from backend snapshot
async function fetchScore(fixtureId) {
  try {
    const res = await fetch(`${BACKEND}/api/scores/snapshot/${fixtureId}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const s = data[data.length - 1];
      const home = s.Participant1Goals ?? s.HomeGoals ?? s.homeGoals ?? null;
      const away = s.Participant2Goals ?? s.AwayGoals ?? s.awayGoals ?? null;
      if (home !== null && away !== null) return `${home}-${away}`;
    }
  } catch (e) {}
  return null;
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
        const market = await getMarket(m.fixtureId);
        if (!market) continue;

        const positionPda = getPositionPda(m.fixtureId, publicKey.toBase58());
        const info = await connection.getAccountInfo(positionPda);
        if (!info) continue;

        const d = info.data;
        let o = 8 + 8 + 32;
        const side = d.readUInt8(o); o += 1;
        const amount = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
        const claimed = d.readUInt8(o) === 1;

        const won = market.status === 2 && market.winningSide === side;
        const canClaim = won && !claimed;
        const canRefund = market.status === 3 && !claimed;

        // Fetch score for settled/locked markets
        let score = null;
        if (market.status === 2 || market.status === 1) {
          score = await fetchScore(m.fixtureId);
        }

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
          score,
        });
      } catch(e) {}
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

          {/* Match header with score */}
          <div className="position-match-header">
            <span className="position-match">{p.name}</span>
            {p.score && (
              <span className="position-score">{p.score}</span>
            )}
          </div>

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

          {p.canClaim && <ClaimButton position={p} onClaimed={loadPositions} />}
          {p.canRefund && <RefundButton position={p} onRefunded={loadPositions} />}

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
      await claim(wallet, { fixtureId: position.fixtureId, winningSide: position.winningSide });
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
      await refund(wallet, { fixtureId: position.fixtureId, side: position.side });
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

FILES['frontend/src/styles/app.css'] = r"""/* Kaching Settle — Dark Match Theme */
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #0a0a0f;
  color: #e8e8f0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  min-height: 100vh;
}

.app { max-width: 600px; margin: 0 auto; padding: 0 16px 40px; }

/* Header */
.app-header {
  padding: 20px 0 16px;
  border-bottom: 1px solid #1e1e2e;
  margin-bottom: 24px;
}
.logo { display: flex; align-items: center; gap: 8px; }
.logo-icon { font-size: 24px; }
.logo-text { font-size: 22px; font-weight: 800; color: #fff; }
.logo-sub { font-size: 12px; color: #666; margin-top: 4px; }

/* Market List */
.market-list h2 { margin-bottom: 16px; font-size: 18px; }
.fixture-card {
  background: #12121e;
  border: 1px solid #1e1e2e;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: border-color 0.2s;
}
.fixture-card:hover { border-color: #4ade80; }
.fixture-teams { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
.vs { color: #666; margin: 0 8px; }
.fixture-meta { display: flex; gap: 12px; font-size: 12px; color: #888; margin-bottom: 8px; }
.fixture-cta { font-size: 12px; color: #4ade80; font-weight: 600; }

/* Back button */
.back-btn {
  background: none; border: none; color: #888;
  cursor: pointer; font-size: 14px; margin-bottom: 16px;
  padding: 0;
}
.back-btn:hover { color: #fff; }

/* Match header */
.match-header { text-align: center; margin-bottom: 20px; }
.match-header h2 { font-size: 20px; font-weight: 800; }
.match-header .competition { color: #888; font-size: 13px; margin-top: 4px; }
.match-header .kickoff { color: #666; font-size: 12px; margin-top: 2px; }

/* Scoreboard */
.live-feed { background: #12121e; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.scoreboard { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.team { display: flex; align-items: center; gap: 8px; }
.team.away { flex-direction: row-reverse; }
.team-name { font-size: 14px; font-weight: 600; }
.goals { font-size: 32px; font-weight: 900; color: #4ade80; }
.score-divider { text-align: center; }
.period { display: block; font-size: 11px; color: #888; }
.minute { display: block; font-size: 12px; color: #4ade80; font-weight: 600; }
.events-feed { max-height: 120px; overflow-y: auto; }
.event { display: flex; gap: 8px; font-size: 12px; padding: 4px 0; border-bottom: 1px solid #1e1e2e; }
.event-minute { color: #4ade80; font-weight: 600; min-width: 30px; }
.event-type { color: #ccc; }
.event-player { color: #888; }

/* Pot Meter */
.pot-meter { background: #12121e; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.pot-meter h3 { font-size: 14px; color: #888; margin-bottom: 12px; }
.pot-totals { display: flex; justify-content: space-between; margin-bottom: 12px; }
.pot-side { text-align: center; }
.pot-label { display: block; font-size: 11px; font-weight: 800; margin-bottom: 4px; }
.pot-side.yes .pot-label { color: #4ade80; }
.pot-side.no .pot-label { color: #f87171; }
.pot-amount { display: block; font-size: 20px; font-weight: 900; }
.pot-multiplier { display: block; font-size: 11px; color: #888; margin-top: 2px; }
.pot-bar { height: 8px; border-radius: 4px; background: #f87171; display: flex; overflow: hidden; margin-bottom: 8px; }
.pot-bar-yes { background: #4ade80; transition: width 0.4s; }
.pot-note { font-size: 12px; color: #666; text-align: center; }

/* Deposit Box */
.deposit-box { background: #12121e; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.deposit-box h3 { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
.deposit-question { font-size: 13px; color: #888; margin-bottom: 16px; }
.side-buttons { display: flex; gap: 8px; margin-bottom: 12px; }
.side-btn {
  flex: 1; padding: 12px; border-radius: 8px; border: 2px solid #1e1e2e;
  background: #0a0a0f; color: #888; font-size: 16px; font-weight: 800;
  cursor: pointer; transition: all 0.15s;
}
.side-btn.yes.active { border-color: #4ade80; color: #4ade80; background: #0d2015; }
.side-btn.no.active { border-color: #f87171; color: #f87171; background: #200d0d; }
.amount-input {
  width: 100%; padding: 12px; background: #0a0a0f;
  border: 1px solid #1e1e2e; border-radius: 8px;
  color: #fff; font-size: 15px; margin-bottom: 12px;
}
.amount-input:focus { outline: none; border-color: #4ade80; }
.deposit-btn {
  width: 100%; padding: 14px; border-radius: 8px; border: none;
  background: #4ade80; color: #0a0a0f; font-size: 15px; font-weight: 800;
  cursor: pointer; transition: opacity 0.15s;
}
.deposit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.deposit-note { font-size: 11px; color: #666; text-align: center; margin-top: 8px; }
.error { color: #f87171; font-size: 12px; margin-bottom: 8px; }
.deposit-done { background: #0d2015; border: 1px solid #4ade80; border-radius: 12px; padding: 16px; text-align: center; }
.deposit-done p { font-size: 13px; color: #888; margin-top: 8px; }

/* Voice Player */
.voice-player { background: #12121e; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.pundit-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.pundit-icon { font-size: 20px; }
.pundit-label { font-size: 13px; font-weight: 700; color: #888; }
.commentary { font-size: 15px; line-height: 1.5; margin-bottom: 12px; }
.audio-player { width: 100%; }

/* Receipt */
.receipt { background: #0d2015; border: 1px solid #4ade80; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.receipt-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.receipt-icon { font-size: 20px; }
.receipt-header h3 { font-size: 16px; font-weight: 700; }
.receipt-result { margin-bottom: 12px; }
.winner-side { font-size: 20px; font-weight: 900; }
.winner-side.yes { color: #4ade80; }
.winner-side.no { color: #f87171; }
.receipt-question { font-size: 13px; color: #888; margin-top: 4px; }
.receipt-proof { background: #0a0a0f; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.proof-label { font-size: 12px; color: #888; margin-bottom: 6px; }
.proof-detail { font-size: 11px; color: #666; margin-bottom: 4px; }
code { background: #1e1e2e; padding: 2px 4px; border-radius: 4px; font-size: 11px; }
.explorer-link { font-size: 12px; color: #4ade80; text-decoration: none; }
.explorer-link:hover { text-decoration: underline; }
.receipt-note { font-size: 12px; color: #666; text-align: center; }

/* Connect prompt */
.connect-prompt { text-align: center; padding: 24px; }
.connect-prompt p { color: #888; margin-bottom: 12px; }

/* Wallet button */
.wallet-btn { background: #4ade80 !important; color: #0a0a0f !important; font-weight: 700 !important; }

/* Loading / Empty */
.loading { text-align: center; padding: 40px; color: #666; }
.empty { color: #666; text-align: center; padding: 24px; }

/* Match locked state */
.match-locked {
  background: #12121e;
  border: 1px solid #1e1e2e;
  border-radius: 12px;
  padding: 20px;
  text-align: center;
  margin-bottom: 16px;
}
.match-locked p { color: #888; font-size: 15px; }
.match-locked p:first-child { color: #4ade80; font-weight: 700; font-size: 16px; margin-bottom: 8px; }
.locked-sub { font-size: 13px; color: #666; }

/* Nav tabs */
.nav-tabs { display: flex; gap: 8px; margin-top: 12px; }
.nav-tab {
  padding: 6px 16px; border-radius: 20px; border: 1px solid #1e1e2e;
  background: none; color: #888; font-size: 13px; cursor: pointer;
}
.nav-tab.active { background: #4ade80; color: #0a0a0f; border-color: #4ade80; font-weight: 700; }

/* My Positions */
.my-positions h2 { margin-bottom: 16px; font-size: 18px; }
.position-card {
  background: #12121e; border: 1px solid #1e1e2e;
  border-radius: 12px; padding: 16px; margin-bottom: 12px;
}
.position-card.can-claim { border-color: #4ade80; }
.position-match { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
.position-question { font-size: 13px; color: #888; margin-bottom: 10px; }
.position-details { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; }
.position-side { font-weight: 800; font-size: 14px; padding: 2px 8px; border-radius: 4px; }
.position-side.yes { color: #4ade80; background: #0d2015; }
.position-side.no { color: #f87171; background: #200d0d; }
.position-amount { font-size: 14px; font-weight: 600; }
.position-status { font-size: 12px; color: #666; margin-left: auto; }
.position-result { margin-bottom: 10px; font-size: 13px; }
.result-win { color: #4ade80; font-weight: 700; }
.result-loss { color: #f87171; }
.result-claimed { color: #888; }

/* Position card score display */
.position-match-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.position-score {
  background: #1a1a2e;
  color: #00ff88;
  font-size: 16px;
  font-weight: 700;
  font-family: monospace;
  padding: 2px 10px;
  border-radius: 6px;
  border: 1px solid #00ff8844;
  white-space: nowrap;
  letter-spacing: 2px;
}
"""


def main():
    if not os.path.isdir("backend"):
        print("ERROR: run from kaching-settle repo root"); return
    for path, content in FILES.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f: f.write(content)
        print("wrote", path)
    print("Done. Run: git add -A && git commit -m \'fix: persist scores, show final score in My Positions\' && git push")


if __name__ == "__main__": main()
