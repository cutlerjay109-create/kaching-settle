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
