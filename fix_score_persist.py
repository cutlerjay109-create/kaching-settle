#!/usr/bin/env python3
import os

FILES = {}

FILES['backend/src/txline/stream.js'] = r"""// backend/src/txline/stream.js
// Connects to TxLINE live SSE stream.
//
// Scores are persisted to data/scores.json so they survive Railway restarts.
// This prevents finished matches from reverting to "Pre-Match 0-0" after a redeploy.

const EventSource = require("eventsource");
const fs = require("fs");
const path = require("path");
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

const PUNDIT_TRIGGERS = new Set([
  "goal", "possible_goal", "penalty", "red_card", "var"
]);

// ── Persistent score store ────────────────────────────────────────────────
// Scores are saved to disk so they survive Railway restarts.
// Finished match scores are preserved even after TxLINE removes the fixture.

const SCORES_PATH = path.join(__dirname, "../../../data/scores.json");

function loadPersistedScores() {
  try {
    if (fs.existsSync(SCORES_PATH)) {
      return JSON.parse(fs.readFileSync(SCORES_PATH, "utf8"));
    }
  } catch(e) {}
  return {};
}

function saveScore(fixtureId, score) {
  try {
    fs.mkdirSync(path.dirname(SCORES_PATH), { recursive: true });
    scoreStore[fixtureId] = score;
    fs.writeFileSync(SCORES_PATH, JSON.stringify(scoreStore, null, 2));
  } catch(e) {
    // Non-critical — in-memory store still works
  }
}

// Load persisted scores on startup
const scoreStore = loadPersistedScores();
console.log(`[stream] Loaded ${Object.keys(scoreStore).length} persisted scores`);

function getLastScore(fixtureId) {
  return scoreStore[fixtureId] || null;
}

// ── SSE connection ────────────────────────────────────────────────────────

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

      const hasGameState =
        data.Stats !== undefined ||
        data.Clock !== undefined ||
        data.StatusId !== undefined;

      if (hasGameState) {
        const score = normalizeScore(data);
        // Persist to disk so restarts don't lose the score
        saveScore(data.FixtureId, score);
        onScoreUpdate(score);
      }

      if (isFinished(data)) {
        console.log("[stream] Match finished:", data.FixtureId);
        onMatchFinished(data.FixtureId);
      }

      const event_ = normalizeEvent(data);
      if (event_) {
        onMatchEvent(event_);
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


def main():
    if not os.path.isdir("backend"):
        print("ERROR: run from kaching-settle repo root"); return
    for path, content in FILES.items():
        d = os.path.dirname(path)
        if d: os.makedirs(d, exist_ok=True)
        with open(path, "w") as f: f.write(content)
        print("wrote", path)
    print("Done.")
    print("Run: git add -A && git commit -m \'fix: persist scores to disk, survive Railway restarts\' && git push")


if __name__ == "__main__": main()
