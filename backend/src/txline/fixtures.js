// backend/src/txline/fixtures.js
// Fetches and caches the fixture list from TxLINE.
// Refreshes every 5 minutes in case new fixtures appear.

const axios = require("axios");
const { makeHeaders } = require("./auth");
const { normalizeFixture } = require("./normalize");
const config = require("../../shared/config");

let fixtureCache = [];
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchFixtures(force = false) {
  const now = Date.now();
  if (!force && fixtureCache.length && now - lastFetch < CACHE_TTL) {
    return fixtureCache;
  }

  try {
    const res = await axios.get(`${config.txline.host}/api/fixtures/snapshot`, {
      headers: makeHeaders(),
      timeout: 20000,
    });

    const raw = Array.isArray(res.data) ? res.data : [];
    fixtureCache = raw.map(normalizeFixture);
    lastFetch = now;
    console.log(`[fixtures] Loaded ${fixtureCache.length} fixtures`);
    return fixtureCache;
  } catch (e) {
    console.error("[fixtures] Fetch error:", e.response?.data || e.message);
    return fixtureCache; // return stale cache on error
  }
}

async function getFixture(fixtureId) {
  const fixtures = await fetchFixtures();
  return fixtures.find(f => f.fixtureId === fixtureId) || null;
}

async function getUpcoming() {
  const fixtures = await fetchFixtures();
  const now = Date.now();
  return fixtures.filter(f => f.kickoffMs > now);
}

async function getCompleted() {
  const fixtures = await fetchFixtures();
  return fixtures.filter(f =>
    f.status === "F" ||
    f.status === "FT" ||
    f.status === "finished" ||
    f.status === "complete" ||
    f.status === "completed"
  );
}

// Get fixtures that have passed their kickoff time
// Used by keeper to detect matches that may be complete
// even if TxLINE has removed them from the snapshot
async function getPastKickoff() {
  const fixtures = await fetchFixtures();
  const now = Date.now();
  // A match is likely complete 2.5 hours after kickoff
  return fixtures.filter(f => f.kickoffMs < now - (2.5 * 60 * 60 * 1000));
}

module.exports = { fetchFixtures, getFixture, getUpcoming, getCompleted, getPastKickoff };
