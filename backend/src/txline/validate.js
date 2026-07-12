// backend/src/txline/validate.js
// Verifies a TxLINE stat proof using the Txoracle on-chain program.
//
// DIAGNOSTIC v2 — scans statKeys 1-10 at seq 0 and the last known seq
// to identify which statKey corresponds to goals scored.

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

async function fetchProofRaw(fixtureId, statKey, seq) {
  const params = { fixtureId, statKey };
  if (seq !== undefined) params.seq = seq;
  const res = await axios.get(`${config.txline.host}/api/scores/stat-validation`, {
    headers: makeHeaders(), params, timeout: 20000,
  });
  return res.data;
}

// Scan statKeys 1-10 at the last available seq to find which key has goals
async function scanStatKeys(fixtureId) {
  // First find the last available seq for statKey=1
  let lastSeq = 0;
  for (let s = 0; s <= 30; s++) {
    try {
      await fetchProofRaw(fixtureId, 1, s);
      lastSeq = s;
    } catch(e) {
      if (s > 0) break;
    }
  }
  console.log(`[validate] Last seq for fixture ${fixtureId}: ${lastSeq}`);

  // Now scan all statKeys at the last seq
  const results = [];
  for (let key = 1; key <= 10; key++) {
    try {
      const proof = await fetchProofRaw(fixtureId, key, lastSeq);
      const stp = proof.statToProve || {};
      results.push({ statKey: key, value: stp.value, period: stp.period, seq: lastSeq });
    } catch(e) {
      results.push({ statKey: key, error: e.response?.status || e.message, seq: lastSeq });
    }
  }
  console.log(`[validate] StatKey scan for fixture ${fixtureId} at seq ${lastSeq}:`);
  console.log(JSON.stringify(results, null, 2));
  return { lastSeq, results };
}

async function fetchBestProof(fixtureId, statKey) {
  // Find last seq
  let lastSeq = 0;
  for (let s = 0; s <= 30; s++) {
    try { await fetchProofRaw(fixtureId, statKey, s); lastSeq = s; }
    catch(e) { if (s > 0) break; }
  }

  // Get proof at last seq (most complete data)
  const proof = await fetchProofRaw(fixtureId, statKey, lastSeq);
  const stp = proof.statToProve || {};
  console.log(`[validate] Best proof: statKey=${statKey} seq=${lastSeq} value=${stp.value} period=${stp.period}`);
  return proof;
}

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

async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId} statKey ${statKey}...`);

  // Run statKey diagnostic scan (logs which key has goals)
  await scanStatKeys(fixtureId);

  const proof = await fetchBestProof(fixtureId, statKey);
  const program = await getProgram();

  const predicate = {
    threshold: Number(threshold) || 0,
    comparison: comparison === "lessThan" ? { lessThan: {} } : { greaterThan: {} },
  };

  const summary = proof.summary || {};
  const us = summary.updateStats || summary.update_stats || {};
  const eventsRoot = summary.eventStatsSubTreeRoot ?? summary.eventsSubTreeRoot
    ?? summary.events_sub_tree_root ?? summary.event_stats_sub_tree_root;

  const fixtureSummary = {
    fixtureId: toBN(summary.fixtureId ?? summary.fixture_id ?? fixtureId),
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
  const args = { fixtureSummary, fixtureProof, mainTreeProof, predicate, statA };

  const usTs = us;
  const tsValues = [
    usTs.minTimestamp ?? usTs.min_timestamp,
    usTs.maxTimestamp ?? usTs.max_timestamp,
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
    const logs = sim?.raw || [];
    const result = parseResultFromLogs(logs);
    if (result !== null) {
      return { result, proof: { fixtureId, statKey, threshold, comparison,
        targetTs: uniqueTs[0].toString(), dailyScoresMerkleRoots: dummyPda } };
    }
  } catch(e) {
    const simLogs = e?.simulationResponse?.logs || [];
    correctAddr = extractCorrectAddressFromLogs(simLogs);
    if (!correctAddr) {
      const detail = e?.simulationResponse
        ? JSON.stringify({ err: e.simulationResponse.err, logs: simLogs.slice(0,5) })
        : (e.message || String(e));
      throw new Error("Could not extract account address: " + detail);
    }
    console.log(`[validate] Correct address: ${correctAddr.slice(0,12)}...`);
  }

  let lastErr = null;
  for (const tsVal of uniqueTs) {
    try {
      const sim = await simulateWithAddress(program, args, correctAddr, tsVal);
      const logs = sim?.raw || [];
      const result = parseResultFromLogs(logs);
      if (result !== null) {
        console.log(`[validate] Result: ${result}`);
        return { result, proof: { fixtureId, statKey, threshold, comparison,
          targetTs: tsVal.toString(), dailyScoresMerkleRoots: correctAddr } };
      }
      lastErr = new Error("Could not parse result: " + JSON.stringify(logs.slice(0,5)));
    } catch(e) {
      const simResp = e?.simulationResponse;
      const simLogs = simResp?.logs || [];
      const isStatNotZero = simResp?.err?.InstructionError?.[1]?.Custom === 6074 ||
        simLogs.some(l => l.includes("StatNotZero"));
      if (isStatNotZero) {
        console.log(`[validate] StatNotZero — predicate FALSE (result: false)`);
        return { result: false, proof: { fixtureId, statKey, threshold, comparison,
          targetTs: tsVal.toString(), dailyScoresMerkleRoots: correctAddr } };
      }
      const detail = simResp
        ? JSON.stringify({ err: simResp.err, logs: simLogs.slice(0,4) })
        : (e.message || String(e));
      console.error(`[validate] ts=${tsVal.toString()} failed: ${detail}`);
      lastErr = e;
    }
  }

  throw new Error(`validateStat failed: ${lastErr?.message || lastErr}`);
}

module.exports = { verifyStat, fetchProof: fetchBestProof };
