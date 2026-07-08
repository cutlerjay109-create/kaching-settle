// backend/src/txline/stream.js
// Connects to TxLINE's live SSE score stream.
// Emits events to the rest of the app via a callback.

const EventSource = require("eventsource");
const { makeHeaders } = require("./auth");
const { normalizeScore, normalizeEvent } = require("./normalize");
const config = require("../../../shared/config");

let es = null;
let reconnectTimer = null;
let onScoreUpdate = null;
let onMatchEvent = null;
let onError = null;

function connect(callbacks = {}) {
  onScoreUpdate = callbacks.onScoreUpdate || (() => {});
  onMatchEvent = callbacks.onMatchEvent || (() => {});
  onError = callbacks.onError || console.error;

  _connect();
}

function _connect() {
  if (es) {
    es.close();
    es = null;
  }

  const headers = makeHeaders();
  const url = `${config.txline.host}/api/scores/stream`;

  console.log("[stream] Connecting to SSE...");

  es = new EventSource(url, { headers });

  es.onopen = () => {
    console.log("[stream] Connected");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Score update
      if (data.HomeGoals !== undefined || data.Participant1Goals !== undefined) {
        onScoreUpdate(normalizeScore(data));
        return;
      }

      // Match event (goal, card, etc.)
      if (data.EventType || data.Type) {
        onMatchEvent(normalizeEvent(data));
        return;
      }
    } catch (e) {
      // ignore parse errors
    }
  };

  es.onerror = (err) => {
    console.error("[stream] SSE error — reconnecting in 5s");
    es.close();
    es = null;
    reconnectTimer = setTimeout(_connect, 5000);
  };
}

function disconnect() {
  if (es) { es.close(); es = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  console.log("[stream] Disconnected");
}

module.exports = { connect, disconnect };
