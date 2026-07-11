// backend/src/txline/stream.js
// Connects to TxLINE live SSE stream.
// Every event contains full Stats + Clock + Action.

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

// Score store — saves last known score for every fixture
// TxLINE removes score data after match ends, so we keep our own copy
const scoreStore = {};

function getLastScore(fixtureId) {
  return scoreStore[fixtureId] || null;
}

function connect(callbacks = {}) {
  onScoreUpdate = callbacks.onScoreUpdate || (() => {});
  onMatchEvent = callbacks.onMatchEvent || (() => {});
  onMatchFinished = callbacks.onMatchFinished || (() => {});
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

      // Every event has Stats + Clock -- always emit score update
      if (data.Stats && data.Clock) {
        const score = normalizeScore(data);
        // Save to score store so we can serve it after TxLINE clears it
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
