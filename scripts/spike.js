// scripts/spike.js
// Confirms all runtime unknowns before we write validate.js
// Uses real World Cup fixture IDs from TxLINE schedule docs

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const axios = require("axios");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const config = require("../shared/config");

// Real World Cup fixture IDs from TxLINE schedule docs
// Using recently completed matches for score proof testing
const WC_FIXTURES = [
  { id: 17588310, home: "Tunisia", away: "Japan", date: "June 21" },
  { id: 17588232, home: "Spain", away: "Saudi Arabia", date: "June 21" },
  { id: 17588389, home: "Belgium", away: "Iran", date: "June 21" },
  { id: 17588242, home: "New Zealand", away: "Egypt", date: "June 22" },
  { id: 17588389, home: "Argentina", away: "Austria", date: "June 22" },
  { id: 18172489, home: "Brazil", away: "Japan", date: "June 29" },
  { id: 18185036, home: "Canada", away: "Morocco", date: "July 4" },
  { id: 18188721, home: "Paraguay", away: "France", date: "July 4" },
  { id: 18187298, home: "Brazil", away: "Norway", date: "July 5" },
  { id: 18192996, home: "Mexico", away: "England", date: "July 6" },
  { id: 18198205, home: "Portugal", away: "Spain", date: "July 6" },
  { id: 18193785, home: "USA", away: "Belgium", date: "July 7" },
  { id: 18202701, home: "Argentina", away: "Egypt", date: "July 7" },
  { id: 18209181, home: "France", away: "Morocco", date: "July 9" },
];

function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  const bytes = decoder.decode(raw);
  const kp = Keypair.fromSecretKey(bytes);
  console.log("Wallet:", kp.publicKey.toBase58());
  return kp;
}

function makeClient(jwt, apiToken) {
  return axios.create({
    baseURL: config.txline.host,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
      "X-Api-Token": apiToken,
    },
  });
}

async function main() {
  console.log("=== KACHING-SETTLE SPIKE ===");
  console.log("Network:", config.network);
  console.log("Host:", config.txline.host);

  loadWallet();

  // Step 1: Auth
  console.log("\n[1] Auth...");
  const authRes = await axios.post(`${config.txline.host}/auth/guest/start`);
  const jwt = authRes.data.token;
  const apiToken = process.env.TXLINE_API_TOKEN;
  console.log("    JWT: OK");
  console.log("    API Token:", apiToken ? apiToken.slice(0, 25) + "..." : "MISSING");
  if (!apiToken) { console.log("    Run subscribe.js first"); return; }

  const client = makeClient(jwt, apiToken);

  // Step 2: Fixtures snapshot (no filter — get everything)
  console.log("\n[2] Fetching all fixtures...");
  try {
    const res = await client.get("/api/fixtures/snapshot");
    const all = res.data || [];
    console.log("    Total fixtures:", all.length);
    const compIds = [...new Set(all.map(f => f.CompetitionId))];
    console.log("    Competition IDs:", compIds);
    if (all.length > 0) {
      console.log("    Sample:", JSON.stringify(all[0], null, 2).slice(0, 300));
    }
  } catch(e) {
    console.log("    Error:", e.response?.status, e.response?.data || e.message);
  }

  // Step 3: Score snapshot on known WC fixtures
  console.log("\n[3] Testing score snapshots on real World Cup fixtures...");
  let workingFixtureId = null;

  for (const f of WC_FIXTURES) {
    try {
      const res = await client.get(`/api/scores/snapshot/${f.id}`);
      const data = res.data || [];
      if (Array.isArray(data) && data.length > 0) {
        console.log(`    ${f.home} vs ${f.away} (${f.date}) -> ${data.length} score entries`);
        console.log("    Sample entry:", JSON.stringify(data[0], null, 2).slice(0, 300));
        workingFixtureId = f.id;
        break;
      } else {
        console.log(`    ${f.home} vs ${f.away} -> empty (not started yet)`);
      }
    } catch(e) {
      console.log(`    ${f.home} vs ${f.away} -> ${e.response?.status}: ${e.response?.data?.message || e.message}`);
    }
  }

  if (!workingFixtureId) {
    console.log("\n    No completed fixtures found yet.");
    console.log("    Using first fixture ID for stat-validation test anyway...");
    workingFixtureId = WC_FIXTURES[0].id;
  }

  // Step 4: Stat validation
  console.log("\n[4] Testing stat-validation on fixture:", workingFixtureId);
  const statKeys = [1, 2, 3, 4, 7, 8, 1001, 1002];
  for (const key of statKeys) {
    try {
      const res = await client.get("/api/scores/stat-validation", {
        params: { fixtureId: workingFixtureId, seq: 1, statKey: key },
      });
      console.log(`    statKey ${key} -> WORKS`);
      console.log("    Keys:", JSON.stringify(Object.keys(res.data)));
      console.log("    Data:", JSON.stringify(res.data, null, 2).slice(0, 500));
      break;
    } catch(e) {
      console.log(`    statKey ${key} -> ${e.response?.status}`);
    }
  }

  // Step 5: Live scores stream check
  console.log("\n[5] Testing scores updates...");
  try {
    const res = await client.get(`/api/scores/updates/${workingFixtureId}`);
    const data = res.data || [];
    console.log("    Updates:", data.length);
    if (data.length > 0) {
      console.log("    Sample:", JSON.stringify(data[0], null, 2).slice(0, 300));
    }
  } catch(e) {
    console.log("    Error:", e.response?.status, e.response?.data || e.message);
  }

  console.log("\n=== SPIKE COMPLETE ===");
}

main().catch(e => {
  console.error("Fatal:", e.response?.data || e.message);
  if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
});
