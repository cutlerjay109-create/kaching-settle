// backend/src/txline/validate.js
// Verifies a TxLINE stat proof using the Txoracle on-chain program.
//
// Discovers the correct statKey by scanning statKeys 1-7 in parallel
// at the last available seq, picking the one where statToProve.value > 0
// (goals were scored). Falls back to market's statKey if all return 0.

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

// ── Proof fetcher ─────────────────────────────────────────────────────────
async function fetchProofRaw(fixtureId, statKey, seq) {
  const params = { fixtureId, statKey };
  if (seq !== undefined) params.seq = seq;
  const res = await axios.get(`${config.txline.host}/api/scores/stat-validation`, {
    headers: makeHeaders(), params, timeout: 15000,
  });
  return res.data;
}

// Find the last available seq for a given statKey
async function findLastSeq(fixtureId, statKey) {
  let last = 0;
  for (let s = 0; s <= 30; s++) {
    try { await fetchProofRaw(fixtureId, statKey, s); last = s; }
    catch(e) { if (s > 2) break; }
  }
  return last;
}

// Scan statKeys 1-7 in parallel at the given seq to find which has goals
async function discoverGoalsStatKey(fixtureId, seq) {
  console.log(`[validate] Scanning statKeys 1-7 at seq=${seq} for fixture ${fixtureId}...`);
  const results = await Promise.allSettled(
    [1,2,3,4,5,6,7].map(async key => {
      try {
        const proof = await fetchProofRaw(fixtureId, key, seq);
        const stp = proof.statToProve || proof.stat_to_prove || {};
        return { key, value: Number(stp.value ?? 0), period: Number(stp.period ?? 0) };
      } catch(e) {
        return { key, value: -1, error: e.response?.status || e.message };
      }
    })
  );

  const scan = results.map(r => r.status === 'fulfilled' ? r.value : { key: '?', value: -1 });
  console.log(`[validate] StatKey scan:`, JSON.stringify(scan));

  // Pick the key with value > 0 that's in a reasonable goals range (1-20)
  // If multiple, prefer lower key numbers (more likely to be primary stat)
  const goalKeys = scan
    .filter(r => r.value > 0 && r.value <= 20)
    .sort((a, b) => a.key - b.key);

  if (goalKeys.length > 0) {
    console.log(`[validate] Goals statKey candidates:`, JSON.stringify(goalKeys));
    return goalKeys[0].key;
  }

  // All zero — either 0-0 match or statKey scan didn't find goals
  console.log(`[validate] No goals found in statKey scan — match may have ended 0-0`);
  return null; // null means no goals scored
}

// Fetch best proof for a statKey (at last available seq)
async function fetchBestProof(fixtureId, statKey) {
  const lastSeq = await findLastSeq(fixtureId, statKey);
  const proof = await fetchProofRaw(fixtureId, statKey, lastSeq);
  const stp = proof.statToProve || proof.stat_to_prove || {};
  console.log(`[validate] Proof: statKey=${statKey} seq=${lastSeq} value=${stp.value} period=${stp.period}`);
  return proof;
}

// ── Helpers ───────────────────────────────────────────────────────────────
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

async function runSimulation(program, proof, statKey, threshold, comparison) {
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

  let correctAddr = null;
  try {
    const sim = await simulateWithAddress(program, args, dummyPda, uniqueTs[0]);
    const result = parseResultFromLogs(sim?.raw || []);
    if (result !== null) return { result, addr: dummyPda, ts: uniqueTs[0].toString() };
  } catch(e) {
    correctAddr = extractCorrectAddressFromLogs(e?.simulationResponse?.logs || []);
    if (!correctAddr) throw new Error("No address in logs: " +
      JSON.stringify((e?.simulationResponse?.logs || []).slice(0,3)));
    console.log(`[validate] Correct address: ${correctAddr.slice(0,12)}...`);
  }

  let lastErr = null;
  for (const tsVal of uniqueTs) {
    try {
      const sim = await simulateWithAddress(program, args, correctAddr, tsVal);
      const result = parseResultFromLogs(sim?.raw || []);
      if (result !== null) {
        console.log(`[validate] Result: ${result}`);
        return { result, addr: correctAddr, ts: tsVal.toString() };
      }
      lastErr = new Error("No parseable result");
    } catch(e) {
      const simResp = e?.simulationResponse;
      const simLogs = simResp?.logs || [];
      const isStatNotZero = simResp?.err?.InstructionError?.[1]?.Custom === 6074 ||
        simLogs.some(l => l.includes("StatNotZero"));
      if (isStatNotZero) {
        console.log(`[validate] StatNotZero — result: false`);
        return { result: false, addr: correctAddr, ts: tsVal.toString() };
      }
      const detail = simResp ? JSON.stringify({ err: simResp.err, logs: simLogs.slice(0,3) }) : e.message;
      console.error(`[validate] ts=${tsVal} failed: ${detail}`);
      lastErr = e;
    }
  }
  throw new Error(`Simulation failed: ${lastErr?.message || lastErr}`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId}...`);

  // 1. Find last seq for the market's statKey
  const lastSeq = await findLastSeq(fixtureId, statKey);

  // 2. Scan all statKeys 1-7 at the last seq to find which one has goals
  const goalsStatKey = await discoverGoalsStatKey(fixtureId, lastSeq);

  // 3. Determine the actual result
  let result, proofMeta;

  if (goalsStatKey === null) {
    // No statKey returned value > 0 — match ended with 0 goals for the tracked team
    // This means NO wins (goals > 0 = false)
    console.log(`[validate] No goals found across all statKeys — result: false (NO wins)`);
    result = false;
    // Still need a valid proof for the on-chain call — use market's statKey
    const proof = await fetchBestProof(fixtureId, statKey);
    const program = await getProgram();
    const sim = await runSimulation(program, proof, statKey, threshold, comparison);
    result = sim.result;
    proofMeta = { fixtureId, statKey, threshold, comparison,
      targetTs: sim.ts, dailyScoresMerkleRoots: sim.addr };
  } else {
    // Goals were found — use the correct statKey for verification
    const proof = await fetchBestProof(fixtureId, goalsStatKey);
    const program = await getProgram();
    const sim = await runSimulation(program, proof, goalsStatKey, threshold, comparison);
    result = sim.result;
    proofMeta = { fixtureId, statKey: goalsStatKey, threshold, comparison,
      targetTs: sim.ts, dailyScoresMerkleRoots: sim.addr };
  }

  console.log(`[validate] Final result: ${result} (statKey=${proofMeta.statKey})`);
  return { result, proof: proofMeta };
}

module.exports = { verifyStat, fetchProof: (fixtureId, statKey) => fetchBestProof(fixtureId, statKey) };
