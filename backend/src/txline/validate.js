// backend/src/txline/validate.js
// Verifies a TxLINE stat proof using the Txoracle on-chain program.
//
// Confirmed from live data (Argentina vs Switzerland, seq=200):
//   statKey=1 = Participant1 (home/first-listed team) goals
//   statKey=7 = Participant2 (away/second-listed team) goals
//
// A 90-minute match has ~200 sequences (~27s per seq).
// We must search up to seq=300 to get full-time data.
//
// Flow:
//   1. Find last available seq (binary-ish search, max 300)
//   2. Fetch proof at last seq for the market's statKey
//   3. Simulate validateStat on-chain:
//      - Use dummy PDA first to extract correct dailyScoresMerkleRoots from error logs
//      - Retry with correct address + minTimestamp
//      - StatNotZero (error 6074) = predicate is FALSE → result: false
//      - Clean true/false from logs = actual result

const axios = require("axios");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const { makeHeaders } = require("./auth");
const config = require("../../shared/config");
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

// Find the last available seq. Matches have ~200 seqs — step by 10 for speed,
// then walk back one-by-one to find the exact last.
async function findLastSeq(fixtureId, statKey) {
  let last = 0;
  for (let s = 0; s <= 300; s += 10) {
    try {
      await fetchProofRaw(fixtureId, statKey, s);
      last = s;
    } catch(e) {
      for (let s2 = s - 9; s2 < s; s2++) {
        try { await fetchProofRaw(fixtureId, statKey, s2); last = s2; }
        catch(e2) { break; }
      }
      break;
    }
  }
  console.log(`[validate] Last seq for fixture ${fixtureId} statKey ${statKey}: ${last}`);
  return last;
}

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
    if (val.startsWith("0x") || val.length === 64)
      buf = Array.from(Buffer.from(val.replace("0x", ""), "hex"));
    else
      buf = Array.from(Buffer.from(val, "base64"));
  } else if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    buf = Array.from(val);
  } else return Array(32).fill(0);
  if (buf.length < 32) return [...buf, ...Array(32 - buf.length).fill(0)];
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
  return {
    hash: toU8Array32(node.hash),
    isRightSibling: node.isRightSibling ?? node.is_right_sibling ?? false,
  };
}

function extractCorrectAddressFromLogs(logs) {
  if (!logs) return null;
  for (let i = 0; i < logs.length; i++) {
    if (/program log:\s*Right:/i.test(logs[i]) && logs[i + 1]) {
      const addr = logs[i + 1].replace(/^Program log:\s*/, "").trim();
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
    if (m) { try { return Buffer.from(m[1], "base64")[0] !== 0; } catch(e) {} }
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
  const eventsRoot = summary.eventStatsSubTreeRoot
    ?? summary.eventsSubTreeRoot
    ?? summary.events_sub_tree_root
    ?? summary.event_stats_sub_tree_root;

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
      key:    Number(stp.key   ?? statKey ?? 0),
      value:  Number(stp.value ?? 0),
      period: Number(stp.period ?? 0),
    },
    eventStatRoot: toU8Array32(proof.eventStatRoot ?? proof.event_stat_root),
    statProof: (proof.statProof || proof.stat_proof || []).map(mapNode),
  };

  const fixtureProof  = (proof.subTreeProof  || proof.sub_tree_proof  || []).map(mapNode);
  const mainTreeProof = (proof.mainTreeProof || proof.main_tree_proof || []).map(mapNode);

  const predicate = {
    threshold: Number(threshold) || 0,
    comparison: comparison === "lessThan" ? { lessThan: {} } : { greaterThan: {} },
  };

  return { fixtureSummary, fixtureProof, mainTreeProof, predicate, statA };
}

// ── On-chain simulation ───────────────────────────────────────────────────

async function runSimulation(program, proof, statKey, threshold, comparison) {
  const args = buildArgs(proof, statKey, threshold, comparison);

  const us = (proof.summary || {}).updateStats || (proof.summary || {}).update_stats || {};
  // minTimestamp is used for the account seed — try it first
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

  // Step 1: pass a dummy PDA to trigger ConstraintSeeds error,
  // which logs the correct dailyScoresMerkleRoots address.
  const PROG_ID = new PublicKey(config.txline.programId);
  const dummyPda = PublicKey.findProgramAddressSync(
    [Buffer.from("dummy")], PROG_ID
  )[0].toBase58();

  let correctAddr = null;
  try {
    const sim = await simulateWithAddress(program, args, dummyPda, uniqueTs[0]);
    const result = parseResultFromLogs(sim?.raw || []);
    if (result !== null) {
      console.log(`[validate] Result: ${result} (first try)`);
      return { result, addr: dummyPda, ts: uniqueTs[0].toString() };
    }
  } catch(e) {
    correctAddr = extractCorrectAddressFromLogs(e?.simulationResponse?.logs || []);
    if (!correctAddr) {
      const detail = e?.simulationResponse
        ? JSON.stringify({ err: e.simulationResponse.err, logs: e.simulationResponse.logs?.slice(0, 4) })
        : (e.message || String(e));
      throw new Error("Could not extract correct account address: " + detail);
    }
    console.log(`[validate] Correct address: ${correctAddr.slice(0, 12)}...`);
  }

  // Step 2: retry with correct address, trying each ts candidate
  let lastErr = null;
  for (const tsVal of uniqueTs) {
    try {
      const sim = await simulateWithAddress(program, args, correctAddr, tsVal);
      const result = parseResultFromLogs(sim?.raw || []);
      if (result !== null) {
        console.log(`[validate] Result: ${result}`);
        return { result, addr: correctAddr, ts: tsVal.toString() };
      }
      lastErr = new Error("No parseable result in simulation logs");
    } catch(e) {
      const simResp = e?.simulationResponse;
      const simLogs = simResp?.logs || [];

      // StatNotZero (6074) = proof verified, predicate evaluated to FALSE
      // e.g. goals=0, predicate "goals > 0" → false → NO wins
      const isStatNotZero = simResp?.err?.InstructionError?.[1]?.Custom === 6074 ||
        simLogs.some(l => l.includes("StatNotZero"));

      if (isStatNotZero) {
        console.log(`[validate] StatNotZero — predicate FALSE → result: false`);
        return { result: false, addr: correctAddr, ts: tsVal.toString() };
      }

      const detail = simResp
        ? JSON.stringify({ err: simResp.err, logs: simLogs.slice(0, 3) })
        : (e.message || String(e));
      console.error(`[validate] ts=${tsVal} failed: ${detail}`);
      lastErr = e;
    }
  }

  throw new Error(`Simulation failed: ${lastErr?.message || lastErr}`);
}

// ── Main entry point ──────────────────────────────────────────────────────

async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId} statKey ${statKey}...`);

  // Fetch the proof at the last available seq (full-time data)
  const proof = await fetchBestProof(fixtureId, statKey);

  const program = await getProgram();
  const { result, addr, ts } = await runSimulation(
    program, proof, statKey, threshold, comparison
  );

  console.log(`[validate] Final result: ${result}`);
  return {
    result,
    proof: {
      fixtureId,
      statKey,
      threshold,
      comparison,
      targetTs: ts,
      dailyScoresMerkleRoots: addr,
    },
  };
}

module.exports = {
  verifyStat,
  fetchProof: (fixtureId, statKey) => fetchBestProof(fixtureId, statKey),
};
