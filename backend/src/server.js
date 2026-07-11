// backend/src/server.js
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
const { fetchFixtures, getUpcoming } = require("./txline/fixtures");
const keeper = require("./keeper/settle-trigger");
const { autoCreateMarkets, autoSeedMarkets, setMarketCreatedCallback } = require("./keeper/auto-market");
const sockets = require("./sockets");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json());

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
    const axios = require("axios");
    const { makeHeaders } = require("./txline/auth");
    const config = require("../../shared/config");
    const r = await axios.get(
      config.txline.host + "/api/scores/snapshot/" + req.params.fixtureId,
      { headers: makeHeaders(), timeout: 10000 }
    );
    res.json(r.data);
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
    stream.connect({
      onScoreUpdate: (score) => {
        sockets.broadcastScore(score.fixtureId, score);
      },
      onMatchEvent: (event) => {
        sockets.broadcastEvent(event.fixtureId, event);
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
      });
    });

    // Auto-create and seed markets for all fixtures
    await autoCreateMarkets();
    await autoSeedMarkets();

    // Register ALL fixtures with keeper so past-kickoff detection works
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
      });
    }
    console.log("[server] Registered", allFixtures.length, "fixtures with keeper");
    // Re-check every hour
    setInterval(async () => { await autoCreateMarkets(); await autoSeedMarkets(); }, 60 * 60 * 1000);

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
