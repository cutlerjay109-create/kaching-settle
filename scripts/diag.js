// scripts/diag.js
// Full diagnostic — catches every possible error and reports clearly.

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const axios = require("axios");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const config = require("../shared/config");

function log(...a) { console.log(...a); }

async function main() {
  log("=== DIAGNOSTIC ===");
  log("Network:", config.network);
  log("Host:", config.txline.host);
  log("Node:", process.version);

  try {
    const raw = process.env.WALLET_KEYPAIR.trim();
    const decoder = bs58.default || bs58;
    const kp = Keypair.fromSecretKey(decoder.decode(raw));
    log("Wallet OK:", kp.publicKey.toBase58());
  } catch (e) {
    log("WALLET ERROR:", e.message);
    return;
  }

  const apiToken = process.env.TXLINE_API_TOKEN;
  log("API Token present:", apiToken ? "yes (" + apiToken.slice(0,20) + "...)" : "NO");

  log("\n[TEST 1] Raw GET to host root...");
  try {
    const r = await axios.get(config.txline.host, { timeout: 15000, validateStatus: () => true });
    log("  Status:", r.status);
  } catch (e) {
    log("  NETWORK ERROR:", e.code || e.message);
  }

  log("\n[TEST 2] POST /auth/guest/start ...");
  try {
    const r = await axios.post(config.txline.host + "/auth/guest/start", {}, {
      timeout: 15000, validateStatus: () => true,
    });
    log("  Status:", r.status);
    log("  Body:", JSON.stringify(r.data).slice(0, 200));
    if (r.data && r.data.token) {
      global.JWT = r.data.token;
      log("  JWT extracted OK");
    }
  } catch (e) {
    log("  ERROR type:", e.constructor.name);
    log("  ERROR code:", e.code);
    log("  ERROR message:", e.message);
    if (e.response) {
      log("  Response status:", e.response.status);
      log("  Response data:", JSON.stringify(e.response.data).slice(0, 200));
    }
  }

  if (!global.JWT) {
    log("\nStopping — no JWT obtained.");
    return;
  }

  log("\n[TEST 3] GET /api/fixtures/snapshot ...");
  try {
    const r = await axios.get(config.txline.host + "/api/fixtures/snapshot", {
      timeout: 20000,
      validateStatus: () => true,
      headers: {
        "Authorization": "Bearer " + global.JWT,
        "X-Api-Token": apiToken,
      },
    });
    log("  Status:", r.status);
    const d = r.data;
    if (Array.isArray(d)) {
      log("  Fixtures returned:", d.length);
      const comps = [...new Set(d.map(f => f.CompetitionId))];
      log("  Competition IDs:", JSON.stringify(comps));
      if (d[0]) log("  First fixture keys:", JSON.stringify(Object.keys(d[0])));
      if (d[0]) log("  First fixture:", JSON.stringify(d[0]).slice(0, 300));
    } else {
      log("  Body:", JSON.stringify(d).slice(0, 300));
    }
  } catch (e) {
    log("  ERROR:", e.code, e.message);
    if (e.response) log("  Resp:", e.response.status, JSON.stringify(e.response.data).slice(0,200));
  }

  log("\n=== DIAGNOSTIC COMPLETE ===");
}

main().catch(e => {
  console.log("UNCAUGHT:", e.constructor.name, e.message);
  console.log(e.stack);
});
