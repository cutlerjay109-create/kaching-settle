// backend/src/txline/validate.js
// Verifies a TxLINE stat proof using the Txoracle on-chain program.
// Uses .simulate() (not .view() — not supported) and reads the result
// from the transaction logs.
//
// All types are mapped exactly from backend/idl/txoracle.json:
//   validate_stat(ts: i64, fixture_summary: ScoresBatchSummary,
//     fixture_proof: Vec<ProofNode>, main_tree_proof: Vec<ProofNode>,
//     predicate: TraderPredicate, stat_a: StatTerm,
//     stat_b: Option<StatTerm>, op: Option<BinaryOp>)
//
//   ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats,
//                        events_sub_tree_root: [u8;32] }
//   ScoresUpdateStats  { update_count: i32, min_timestamp: i64, max_timestamp: i64 }
//   TraderPredicate    { threshold: i32, comparison: Comparison }
//   Comparison         enum { GreaterThan, LessThan, EqualTo }
//   StatTerm           { stat_to_prove: ScoreStat, event_stat_root: [u8;32],
//                        stat_proof: Vec<ProofNode> }
//   ScoreStat          { key: u32, value: i32, period: i32 }
//   ProofNode          { hash: [u8;32], is_right_sibling: bool }
//
//   account: daily_scores_merkle_roots  (camelCase: dailyScoresMerkleRoots)

const axios = require("axios");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey } = require("@solana/web3.js");
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

  const provider = new anchor.AnchorProvider(
    connection,
    {
      publicKey: PublicKey.default,
      signTransaction: async t => t,
      signAllTransactions: async t => t,
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
// (Anchor expects [u8;32] as a JS number array, NOT a Buffer or Uint8Array)
function toU8Array32(val) {
  if (val === null || val === undefined) return Array(32).fill(0);
  let buf;
  if (Array.isArray(val)) {
    buf = val;
  } else if (typeof val === "string") {
    if (!val) return Array(32).fill(0);
    if (val.startsWith("0x") || val.length === 64) {
      buf = Array.from(Buffer.from(val.replace("0x", ""), "hex"));
    } else {
      buf = Array.from(Buffer.from(val, "base64"));
    }
  } else if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    buf = Array.from(val);
  } else {
    buf = Array(32).fill(0);
  }
  // Pad or trim to exactly 32
  if (buf.length < 32) return [...buf, ...Array(32 - buf.length).fill(0)];
  if (buf.length > 32) return buf.slice(0, 32);
  return buf.map(Number);
}

// Safe BN: handles numbers, strings, existing BNs, undefined
function toBN(val) {
  if (val === null || val === undefined) return new anchor.BN(0);
  if (anchor.BN.isBN(val)) return val;
  if (typeof val === "bigint") return new anchor.BN(val.toString());
  return new anchor.BN(String(val));
}

// Map a ProofNode from the proof response
// IDL: { hash: [u8;32], is_right_sibling: bool }
function mapNode(node) {
  if (!node) return { hash: Array(32).fill(0), isRightSibling: false };
  return {
    hash: toU8Array32(node.hash),
    isRightSibling: node.isRightSibling ?? node.is_right_sibling ?? false,
  };
}

// PDA for the daily scores merkle roots account
function dailyScoresMerkleRootsPda(epochDay) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("daily_scores_merkle_roots"),
      Buffer.from([epochDay & 0xff, (epochDay >> 8) & 0xff]),
    ],
    new PublicKey(config.txline.programId)
  )[0];
}

// Epoch days to try: proof's day first, then today (handles midnight boundary)
function candidateEpochDays(targetTs) {
  const days = [];
  if (targetTs) {
    const tsMs = targetTs > 1e12 ? targetTs : targetTs * 1000;
    days.push(Math.floor(tsMs / constants.MS_PER_DAY));
  }
  const today = Math.floor(Date.now() / constants.MS_PER_DAY);
  if (!days.includes(today)) days.push(today);
  return days;
}

// Parse the boolean result from program simulation logs
function parseResultFromLogs(logs) {
  if (!logs || !logs.length) return null;
  for (const line of logs) {
    if (/program log:\s*true/i.test(line)) return true;
    if (/program log:\s*false/i.test(line)) return false;
    // "Program return: <programId> <base64>"
    const m = line.match(/Program return:\S*\s+(\S+)/);
    if (m) {
      try { return Buffer.from(m[1], "base64")[0] !== 0; } catch(e) {}
    }
    const d = line.match(/Program data:\s+(\S+)/);
    if (d) {
      try { return Buffer.from(d[1], "base64")[0] !== 0; } catch(e) {}
    }
  }
  return null;
}

async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId} statKey ${statKey}...`);

  const proof = await fetchProof(fixtureId, statKey);
  console.log("[validate] Proof fetched");

  const program = await getProgram();

  // ── TraderPredicate ─────────────────────────────────────
  // threshold is i32 in the IDL
  const predicate = {
    threshold: Number(threshold) || 0,
    comparison: comparison === "lessThan" ? { lessThan: {} } : { greaterThan: {} },
  };

  // ── ScoresBatchSummary ──────────────────────────────────
  const summary = proof.summary || {};
  const us = summary.updateStats || summary.update_stats || {};
  const fixtureSummary = {
    fixtureId: toBN(summary.fixtureId ?? summary.fixture_id ?? fixtureId),
    updateStats: {
      updateCount: Number(us.updateCount ?? us.update_count ?? 0),
      minTimestamp: toBN(us.minTimestamp ?? us.min_timestamp ?? 0),
      maxTimestamp: toBN(us.maxTimestamp ?? us.max_timestamp ?? 0),
    },
    eventsSubTreeRoot: toU8Array32(summary.eventsSubTreeRoot ?? summary.events_sub_tree_root),
  };

  // ── StatTerm (statA) ────────────────────────────────────
  // IDL field name: stat_a -> statA in camelCase
  // Inner ScoreStat: { key: u32, value: i32, period: i32 }
  const stp = proof.statToProve || proof.stat_to_prove || {};
  const statA = {
    statToProve: {
      key: Number(stp.key ?? statKey ?? 0),
      value: Number(stp.value ?? 0),
      period: Number(stp.period ?? 0),
    },
    eventStatRoot: toU8Array32(proof.eventStatRoot ?? proof.event_stat_root),
    statProof: (proof.statProof || proof.stat_proof || []).map(mapNode),
  };

  // ── Proof paths ─────────────────────────────────────────
  const fixtureProof = (proof.subTreeProof || proof.sub_tree_proof || []).map(mapNode);
  const mainTreeProof = (proof.mainTreeProof || proof.main_tree_proof || []).map(mapNode);

  // ── targetTs ────────────────────────────────────────────
  const targetTs = toBN(proof.targetTs ?? proof.target_ts ?? 0);

  let lastError = null;

  for (const epochDay of candidateEpochDays(proof.targetTs ?? proof.target_ts)) {
    const dailyScoresMerkleRoots = dailyScoresMerkleRootsPda(epochDay);

    try {
      const sim = await program.methods
        .validateStat(
          targetTs,
          fixtureSummary,
          fixtureProof,
          mainTreeProof,
          predicate,
          statA,
          null,  // stat_b — not needed
          null   // op — not needed
        )
        .accounts({ dailyScoresMerkleRoots })
        .simulate({ commitment: "confirmed" });

      const logs = sim?.raw || [];
      console.log("[validate] Sim logs:", JSON.stringify(logs.slice(0, 8)));

      const result = parseResultFromLogs(logs);
      if (result === null) {
        throw new Error(
          "Could not parse result from logs: " + JSON.stringify(logs.slice(0, 5))
        );
      }

      console.log(`[validate] Result: ${result} (epochDay ${epochDay})`);
      return {
        result,
        proof: {
          fixtureId,
          statKey,
          threshold,
          comparison,
          targetTs: String(proof.targetTs ?? proof.target_ts ?? 0),
          dailyScoresMerkleRoots: dailyScoresMerkleRoots.toBase58(),
        },
      };
    } catch (e) {
      lastError = e;
      console.error(`[validate] validateStat failed for epochDay ${epochDay}: ${e.message}`);
    }
  }

  throw new Error(`validateStat failed: ${lastError ? lastError.message : "unknown"}`);
}

module.exports = { verifyStat, fetchProof };
