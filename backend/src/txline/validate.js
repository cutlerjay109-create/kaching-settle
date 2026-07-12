// backend/src/txline/validate.js
// Verifies a TxLINE stat proof using the Txoracle on-chain program.
//
// KEY INSIGHT: The dailyScoresMerkleRoots account address cannot be derived
// off-chain (the program's seed logic is opaque). Instead we:
//   1. Try to simulate with our best-guess address.
//   2. If the sim returns ConstraintSeeds (error 2006), extract the CORRECT
//      address from the program logs ("Right: <address>") and retry once.
// This is robust regardless of whatever seed formula TxLINE uses.

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

  const provider = new anchor.AnchorProvider(
    connection,
    {
      publicKey: wallet.publicKey,
      signTransaction: async (tx) => { tx.sign(wallet); return tx; },
      signAllTransactions: async (txs) => { txs.forEach(t => t.sign(wallet)); return txs; },
    },
    { commitment: "confirmed" }
  );

  _program = new anchor.Program(idl, provider);
  return _program;
}

async function fetchProof(fixtureId, statKey, seq = 1) {
  try {
    const res = await axios.get(`${config.txline.host}/api/scores/stat-validation`, {
      headers: makeHeaders(),
      params: { fixtureId, seq, statKey },
      timeout: 20000,
    });
    return res.data;
  } catch (e) {
    throw new Error(`fetchProof failed: ${e.response?.data?.message || e.message}`);
  }
}

// Convert any hash representation to a plain number[] of length 32
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
  } else {
    return Array(32).fill(0);
  }
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

// Extract the correct account address from ConstraintSeeds error logs.
// The program prints:
//   "Program log: Left:\n  <passed>\nProgram log: Right:\n  <correct>"
function extractCorrectAddressFromLogs(logs) {
  if (!logs) return null;
  for (let i = 0; i < logs.length; i++) {
    if (/program log:\s*Right:/i.test(logs[i]) && logs[i + 1]) {
      const addr = logs[i + 1].replace(/^Program log:\s*/, "").trim();
      try { new PublicKey(addr); return addr; } catch (e) {}
    }
    // Sometimes "Right:" and the address are on the same line
    const m = logs[i].match(/Right:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m) { try { new PublicKey(m[1]); return m[1]; } catch(e) {} }
  }
  return null;
}

// Parse boolean result from simulation logs
function parseResultFromLogs(logs) {
  if (!logs || !logs.length) return null;
  for (const line of logs) {
    if (/program log:\s*true/i.test(line)) return true;
    if (/program log:\s*false/i.test(line)) return false;
    const m = line.match(/Program return:\S*\s+(\S+)/);
    if (m) { try { return Buffer.from(m[1], "base64")[0] !== 0; } catch(e) {} }
    const d = line.match(/Program data:\s+(\S+)/);
    if (d) { try { return Buffer.from(d[1], "base64")[0] !== 0; } catch(e) {} }
  }
  return null;
}

// Build the Anchor method call (args only — no account yet)
function buildMethodCall(program, proof, predicate, fixtureSummary, fixtureProof, mainTreeProof, statA, targetTs) {
  return program.methods.validateStat(
    targetTs,
    fixtureSummary,
    fixtureProof,
    mainTreeProof,
    predicate,
    statA,
    null,
    null
  );
}

async function simulateWithAddress(program, methodArgs, dailyScoresMerkleRoots) {
  const { targetTs, fixtureSummary, fixtureProof, mainTreeProof, predicate, statA } = methodArgs;
  const sim = await program.methods
    .validateStat(targetTs, fixtureSummary, fixtureProof, mainTreeProof, predicate, statA, null, null)
    .accounts({ dailyScoresMerkleRoots: new PublicKey(dailyScoresMerkleRoots) })
    .simulate({ commitment: "confirmed" });
  return sim;
}

async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId} statKey ${statKey}...`);

  const proof = await fetchProof(fixtureId, statKey);
  console.log("[validate] Proof fetched, ts:", proof.ts);
  console.log("[validate] summary keys:", Object.keys(proof.summary || {}));
  console.log("[validate] summary:", JSON.stringify({
    fixtureId: proof.summary?.fixtureId ?? proof.summary?.fixture_id,
    updateStats: proof.summary?.updateStats ?? proof.summary?.update_stats,
    eventsSubTreeRoot: "[bytes]",
  }));

  const program = await getProgram();

  // TraderPredicate — threshold is i32
  const predicate = {
    threshold: Number(threshold) || 0,
    comparison: comparison === "lessThan" ? { lessThan: {} } : { greaterThan: {} },
  };

  // ScoresBatchSummary
  const summary = proof.summary || {};
  const us = summary.updateStats || summary.update_stats || {};
  const fixtureSummary = {
    fixtureId: toBN(summary.fixtureId ?? summary.fixture_id ?? fixtureId),
    updateStats: {
      updateCount: Number(us.updateCount ?? us.update_count ?? 0),
      minTimestamp: toBN(us.minTimestamp ?? us.min_timestamp ?? 0),
      maxTimestamp: toBN(us.maxTimestamp ?? us.max_timestamp ?? 0),
    },
    eventsSubTreeRoot: toU8Array32(summary.eventStatsSubTreeRoot ?? summary.eventsSubTreeRoot ?? summary.events_sub_tree_root ?? summary.event_stats_sub_tree_root),
  };

  // StatTerm (statA)
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
  const targetTs      = toBN(proof.ts ?? proof.targetTs ?? proof.target_ts ?? 0);
  const methodArgs    = { targetTs, fixtureSummary, fixtureProof, mainTreeProof, predicate, statA };

  // ── Strategy:
  // 1. Use a dummy candidate address to trigger ConstraintSeeds error.
  //    The program logs the CORRECT address ("Right: <addr>").
  // 2. The correct address is seeded from the ts arg — but the ts arg must
  //    ALSO match what's in the snapshot. The program checks both.
  //    So we try all timestamps from the proof (ts, minTimestamp, maxTimestamp)
  //    combined with the correct address extracted from step 1.
  // ─────────────────────────────────────────────────────────────────────

  const usTs = proof.summary?.updateStats || proof.summary?.update_stats || {};
  // All candidate timestamps — the correct one seeds both the PDA and passes
  // the TimestampMismatch check inside the program.
  const tsValues = [
    proof.ts,
    usTs.maxTimestamp ?? usTs.max_timestamp,
    usTs.minTimestamp ?? usTs.min_timestamp,
  ].filter(v => v !== undefined && v !== null)
   .map(v => new anchor.BN(String(v)));

  // Remove duplicates by string value
  const uniqueTs = [];
  const seenTs = new Set();
  for (const t of tsValues) {
    const k = t.toString();
    if (!seenTs.has(k)) { seenTs.add(k); uniqueTs.push(t); }
  }

  // Step 1: get the correct account address using the first ts candidate.
  // We pass a garbage PDA — the only goal is to get the "Right:" address from logs.
  const PROG_ID = new PublicKey(config.txline.programId);
  const dummyPda = PublicKey.findProgramAddressSync(
    [Buffer.from("dummy")], PROG_ID
  )[0].toBase58();

  let correctAddr = null;
  try {
    const dummySim = await simulateWithAddress(
      program,
      { ...methodArgs, targetTs: uniqueTs[0] },
      dummyPda
    );
    // Unexpectedly succeeded — use it
    const logs = dummySim?.raw || [];
    const result = parseResultFromLogs(logs);
    if (result !== null) {
      console.log(`[validate] Result: ${result} (first try)`);
      return {
        result,
        proof: { fixtureId, statKey, threshold, comparison,
          targetTs: uniqueTs[0].toString(), dailyScoresMerkleRoots: dummyPda },
      };
    }
  } catch (e) {
    const simLogs = e?.simulationResponse?.logs || e?.logs || [];
    correctAddr = extractCorrectAddressFromLogs(simLogs);
    if (correctAddr) {
      console.log(`[validate] Extracted correct address: ${correctAddr.slice(0,12)}...`);
    } else {
      throw new Error("Could not extract account address from error: " + JSON.stringify(simLogs.slice(0,5)));
    }
  }

  if (!correctAddr) throw new Error("validateStat: no correct address found");

  // Step 2: try each ts value with the correct address until one succeeds.
  let lastErr = null;
  for (const tsVal of uniqueTs) {
    console.log(`[validate] Trying ts=${tsVal.toString()} with correct address...`);
    try {
      const sim = await simulateWithAddress(
        program,
        { ...methodArgs, targetTs: tsVal },
        correctAddr
      );
      const logs = sim?.raw || [];
      const result = parseResultFromLogs(logs);
      if (result !== null) {
        console.log(`[validate] Result: ${result} (ts=${tsVal.toString()})`);
        return {
          result,
          proof: { fixtureId, statKey, threshold, comparison,
            targetTs: tsVal.toString(), dailyScoresMerkleRoots: correctAddr },
        };
      }
      console.log("[validate] Logs:", JSON.stringify(logs.slice(0,5)));
      lastErr = new Error("Could not parse result: " + JSON.stringify(logs.slice(0,5)));
    } catch (e) {
      const simResp = e?.simulationResponse;
      const detail = simResp
        ? JSON.stringify({ err: simResp.err, logs: simResp.logs })
        : (e.message || String(e));
      console.error(`[validate] ts=${tsVal.toString()} failed: ${detail}`);
      lastErr = e;
    }
  }

  throw new Error(`validateStat failed after all ts candidates: ${lastErr?.message || lastErr}`);
}

module.exports = { verifyStat, fetchProof };
