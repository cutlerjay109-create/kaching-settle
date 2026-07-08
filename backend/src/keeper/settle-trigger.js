// backend/src/keeper/settle-trigger.js
// Watches for completed fixtures and triggers settlement.
// Fetches TxLINE proof, verifies it, then calls program settle.
// This is the robot that closes markets automatically.

const { verifyStat } = require("../txline/validate");
const { getCompleted } = require("../txline/fixtures");
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

  const completed = await getCompleted();

  for (const fixture of completed) {
    const market = activeMarkets.get(fixture.fixtureId);
    if (!market || market.status === "settled") continue;

    console.log(`[keeper] Fixture ${fixture.fixtureId} completed — verifying...`);

    try {
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
