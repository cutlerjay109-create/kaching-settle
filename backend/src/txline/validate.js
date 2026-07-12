// backend/src/txline/validate.js
// Verifies a TxLINE stat proof using the Txoracle on-chain program.
//
// ALL data comes from TxLINE — no hardcoded statKeys, no hardcoded scores.
//
// Flow:
// 1. GET /api/scores/updates/:fixtureId  → find the correct statKey for goals
//    by scanning the actual stat records TxLINE published for this fixture.
// 2. GET /api/scores/stat-validation     → fetch the Merkle proof for that statKey
//    at the last available seq (full-time snapshot).
// 3. Simulate validateStat on-chain with self-correcting PDA address.
// 4. StatNotZero = predicate is FALSE (goals=0, NO wins).
//    Clean true/false = predicate result (YES or NO wins).

const axios = require("axios");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const { makeHeaders } = require("./auth");
const config = require("../../shared/config");
const constants = require("../../shared/constants");
const fs = require("fs");
const path = require("path");

let _program = null;

async function getProgram() {
  if (_program) return _program;
  const connection = new Connection(config.rpc, "confirmed");
  const idlPath = path.join(__dirname, "../../idl/txoracle.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const decoder = bs58.default || bs58;
  const wallet = Keypair.fromSecretKey(decoder.decode(process.env.WALLET_KEYPAIR.trim()));
  const provider = new anchor.AnchorProvider(connection, {
    publicKey: wallet.publicKey,
    signTransaction: async (tx) => { tx.sign(wallet); return tx; },
    signAllTransactions: async (txs) => { txs.forEach(t => t.sign(wallet)); return txs; },
  }, { commitment: "confirmed" });
  _program = new anchor.Program(idl, provider);
  return _program;
}

// ── Step 1: Discover correct statKey from /api/scores/updates ─────────────
// Returns { statKey, lastSeq, totalGoals, homeGoals, awayGoals }
async function discoverStatKey(fixtureId) {
  console.log(`[validate] Fetching score updates for fixture ${fixtureId}...`);
  const res = await axios.get(
    `${config.txline.host}/api/scores/updates/${fixtureId}`,
    { headers: makeHeaders(), timeout: 20000 }
  );

  const updates = res.data;
  console.log(`[validate] Got ${Array.isArray(updates) ? updates.length : 'N/A'} updates`);
  console.log(`[validate] Sample update:`, JSON.stringify(
    Array.isArray(updates) ? updates[0] : updates, null, 2
  ).slice(0, 500));

  // The updates array contains stat records. Each record has:
  //   { statKey, value, period, seq, ts, ... } or similar
  // Find which statKey has the highest value (most goals = goals statKey)
  const statKeyValues = {};
  const seqCounts = {};

  const items = Array.isArray(updates) ? updates : (updates.updates || updates.data || []);

  for (const item of items) {
    // Handle both flat and nested structures
    const stats = item.stats || item.Stats || [item];
    for (const stat of (Array.isArray(stats) ? stats : [stat])) {
      const key = stat.statKey ?? stat.StatKey ?? stat.key ?? stat.Key;
      const val = stat.value ?? stat.Value ?? stat.v;
      const seq = stat.seq ?? stat.Seq ?? item.seq ?? item.Seq;
      if (key !== undefined && val !== undefined) {
        if (!statKeyValues[key] || val > statKeyValues[key].value) {
          statKeyValues[key] = { value: Number(val), seq: Number(seq ?? 0) };
        }
      }
    }
  }

  console.log(`[validate] StatKey max values:`, JSON.stringify(statKeyValues));

  // The goals statKey should have a value >= 0 and be consistent with
  // known football ranges (0-20 goals max in a match)
  // Pick the statKey with value > 0 that looks like a goals count
  // If multiple, we'll try each one when verifying

  return { statKeyValues, updates: items };
}

// ── Step 2: Fetch the best proof for a given statKey ─────────────────────
async function fetchProofRaw(fixtureId, statKey, seq) {
  const params = { fixtureId, statKey };
  if (seq !== undefined) params.seq = seq;
  const res = await axios.get(`${config.txline.host}/api/scores/stat-validation`, {
    headers: makeHeaders(), params, timeout: 20000,
  });
  return res.data;
}

async function fetchBestProof(fixtureId, statKey) {
  // Find last available seq
  let lastSeq = 0;
  for (let s = 0; s <= 30; s++) {
    try { await fetchProofRaw(fixtureId, statKey, s); lastSeq = s; }
    catch(e) { if (s > 0) break; }
  }
  const proof = await fetchProofRaw(fixtureId, statKey, lastSeq);
  const stp = proof.statToProve || proof.stat_to_prove || {};
  console.log(`[validate] Proof: statKey=${statKey} seq=${lastSeq} value=${stp.value} period=${stp.period}`);
  return proof;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function toU8Array32(val) {
  if (val === null || val === undefined) return Array(32).fill(0);
  let buf;
  if (Array.isArray(val)) buf = val;
  else if (typeof val === "string") {
    if (!val) return Array(32).fill(0);
    if (val.startsWith("0x") || val.length === 64) buf = Array.from(Buffer.from(val.replace("0x",""),"hex"));
    else buf = Array.from(Buffer.from(val, "base64"));
  } else if (Buffer.isBuffer(val) || val instanceof Uint8Array) buf = Array.from(val);
  else return Array(32).fill(0);
  if (buf.length < 32) return [...buf, ...Array(32-buf.length).fill(0)];
  if (buf.length > 32) return buf.slice(0, 32);
  return buf.map(Number);
}

function toBN(val) {
  if (val === null || val === undefined) return new anchor.BN(0);
  if (anchor.BN.isBN(val)) return val;
  if (typeof val === "bigint") return new anchor.BN(val.toString());
  return new anchor.BN(String(val));
}

function mapNode(node) {
  if (!node) return { hash: Array(32).fill(0), isRightSibling: false };
  return { hash: toU8Array32(node.hash), isRightSibling: node.isRightSibling ?? node.is_right_sibling ?? false };
}

function extractCorrectAddressFromLogs(logs) {
  if (!logs) return null;
  for (let i = 0; i < logs.length; i++) {
    if (/program log:\s*Right:/i.test(logs[i]) && logs[i+1]) {
      const addr = logs[i+1].replace(/^Program log:\s*/,"").trim();
      try { new PublicKey(addr); return addr; } catch(e) {}
    }
    const m = logs[i].match(/Right:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m) { try { new PublicKey(m[1]); return m[1]; } catch(e) {} }
  }
  return null;
}

function parseResultFromLogs(logs) {
  if (!logs || !logs.length) return null;
  for (const line of logs) {
    if (/program log:\s*true/i.test(line)) return true;
    if (/program log:\s*false/i.test(line)) return false;
    const m = line.match(/Program return:\S*\s+(\S+)/);
    if (m) { try { return Buffer.from(m[1],"base64")[0] !== 0; } catch(e) {} }
  }
  return null;
}

async function simulateWithAddress(program, args, addr, tsVal) {
  const { fixtureSummary, fixtureProof, mainTreeProof, predicate, statA } = args;
  const sim = await program.methods
    .validateStat(tsVal, fixtureSummary, fixtureProof, mainTreeProof, predicate, statA, null, null)
    .accounts({ dailyScoresMerkleRoots: new PublicKey(addr) })
    .simulate({ commitment: "confirmed" });
  return sim;
}

function buildArgs(proof, statKey, threshold, comparison) {
  const summary = proof.summary || {};
  const us = summary.updateStats || summary.update_stats || {};
  const eventsRoot = summary.eventStatsSubTreeRoot ?? summary.eventsSubTreeRoot
    ?? summary.events_sub_tree_root ?? summary.event_stats_sub_tree_root;

  const fixtureSummary = {
    fixtureId: toBN(summary.fixtureId ?? summary.fixture_id ?? 0),
    updateStats: {
      updateCount: Number(us.updateCount ?? us.update_count ?? 0),
      minTimestamp: toBN(us.minTimestamp ?? us.min_timestamp ?? 0),
      maxTimestamp: toBN(us.maxTimestamp ?? us.max_timestamp ?? 0),
    },
    eventsSubTreeRoot: toU8Array32(eventsRoot),
  };

  const stp = proof.statToProve || proof.stat_to_prove || {};
  const statA = {
    statToProve: {
      key:    Number(stp.key    ?? statKey ?? 0),
      value:  Number(stp.value  ?? 0),
      period: Number(stp.period ?? 0),
    },
    eventStatRoot: toU8Array32(proof.eventStatRoot ?? proof.event_stat_root),
    statProof: (proof.statProof || proof.stat_proof || []).map(mapNode),
  };

  const fixtureProof  = (proof.subTreeProof   || proof.sub_tree_proof   || []).map(mapNode);
  const mainTreeProof = (proof.mainTreeProof   || proof.main_tree_proof  || []).map(mapNode);

  const predicate = {
    threshold: Number(threshold) || 0,
    comparison: comparison === "lessThan" ? { lessThan: {} } : { greaterThan: {} },
  };

  return { fixtureSummary, fixtureProof, mainTreeProof, predicate, statA };
}

async function runSimulation(program, proof, statKey, threshold, comparison, fixtureId) {
  const args = buildArgs(proof, statKey, threshold, comparison);
  const us = (proof.summary || {}).updateStats || (proof.summary || {}).update_stats || {};
  const tsValues = [
    us.minTimestamp ?? us.min_timestamp,
    us.maxTimestamp ?? us.max_timestamp,
    proof.ts,
  ].filter(v => v != null).map(v => new anchor.BN(String(v)));
  const uniqueTs = [];
  const seenTs = new Set();
  for (const t of tsValues) {
    if (!seenTs.has(t.toString())) { seenTs.add(t.toString()); uniqueTs.push(t); }
  }

  const PROG_ID = new PublicKey(config.txline.programId);
  const dummyPda = PublicKey.findProgramAddressSync([Buffer.from("dummy")], PROG_ID)[0].toBase58();

  // Step 1: get correct address
  let correctAddr = null;
  try {
    const sim = await simulateWithAddress(program, args, dummyPda, uniqueTs[0]);
    const result = parseResultFromLogs(sim?.raw || []);
    if (result !== null) return { result, addr: dummyPda, ts: uniqueTs[0].toString() };
  } catch(e) {
    correctAddr = extractCorrectAddressFromLogs(e?.simulationResponse?.logs || []);
    if (!correctAddr) throw new Error("No address in logs: " + JSON.stringify((e?.simulationResponse?.logs || []).slice(0,3)));
    console.log(`[validate] Correct address: ${correctAddr.slice(0,12)}...`);
  }

  // Step 2: try each ts
  let lastErr = null;
  for (const tsVal of uniqueTs) {
    try {
      const sim = await simulateWithAddress(program, args, correctAddr, tsVal);
      const result = parseResultFromLogs(sim?.raw || []);
      if (result !== null) {
        console.log(`[validate] Result: ${result}`);
        return { result, addr: correctAddr, ts: tsVal.toString() };
      }
      lastErr = new Error("No parseable result in logs");
    } catch(e) {
      const simResp = e?.simulationResponse;
      const simLogs = simResp?.logs || [];
      const isStatNotZero = simResp?.err?.InstructionError?.[1]?.Custom === 6074 ||
        simLogs.some(l => l.includes("StatNotZero"));
      if (isStatNotZero) {
        console.log(`[validate] StatNotZero — predicate FALSE (result: false)`);
        return { result: false, addr: correctAddr, ts: tsVal.toString() };
      }
      const detail = simResp ? JSON.stringify({ err: simResp.err, logs: simLogs.slice(0,3) }) : e.message;
      console.error(`[validate] sim failed ts=${tsVal}: ${detail}`);
      lastErr = e;
    }
  }
  throw new Error(`Simulation failed: ${lastErr?.message || lastErr}`);
}

// ── Main entry point ──────────────────────────────────────────────────────
async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId} statKey ${statKey}...`);

  // Always discover the actual stat structure from TxLINE first
  let resolvedStatKey = statKey;
  try {
    const { statKeyValues } = await discoverStatKey(fixtureId);
    // Find the statKey with the highest value > 0 that makes sense as goals
    // (between 0-20). If none found, fall back to the market's statKey.
    const goalCandidates = Object.entries(statKeyValues)
      .map(([k, v]) => ({ key: Number(k), value: v.value, seq: v.seq }))
      .filter(e => e.value >= 0 && e.value <= 20)
      .sort((a, b) => b.seq - a.seq || b.value - a.value);

    if (goalCandidates.length > 0) {
      // Use the statKey from the market if it's among candidates,
      // otherwise use the one with the highest value at latest seq
      const marketKeyEntry = goalCandidates.find(e => e.key === statKey);
      resolvedStatKey = marketKeyEntry ? statKey : goalCandidates[0].key;
      console.log(`[validate] Using statKey=${resolvedStatKey} (market asked for ${statKey}, candidates: ${JSON.stringify(goalCandidates.slice(0,5))})`);
    }
  } catch(e) {
    console.error(`[validate] discoverStatKey failed (using original ${statKey}):`, e.message);
  }

  const proof = await fetchBestProof(fixtureId, resolvedStatKey);
  const program = await getProgram();
  const { result, addr, ts } = await runSimulation(program, proof, resolvedStatKey, threshold, comparison, fixtureId);

  return {
    result,
    proof: {
      fixtureId,
      statKey: resolvedStatKey,
      threshold,
      comparison,
      targetTs: ts,
      dailyScoresMerkleRoots: addr,
    },
  };
}

module.exports = { verifyStat, fetchProof: (fixtureId, statKey) => fetchBestProof(fixtureId, statKey) };
