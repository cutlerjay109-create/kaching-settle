// backend/src/txline/validate.js
// Fetches TxLINE's cryptographic stat-validation proof for a fixture.
// Calls validateStat().view() on the Txoracle program — returns true/false.
//
// Fix: the daily scores root PDA is now derived from the PROOF's target
// timestamp, not from "today". Previously, any settlement retried after
// midnight UTC pointed at the wrong day's root and failed forever.
// (Falls back to today's root if the proof-day root account is missing.)

const axios = require("axios");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey } = require("@solana/web3.js");
const { makeHeaders } = require("./auth");
const config = require("../../shared/config");
const constants = require("../../shared/constants");
const fs = require("fs");
const path = require("path");

let _program = null;

// Load the Txoracle program once
async function getProgram() {
  if (_program) return _program;

  const connection = new Connection(config.rpc, "confirmed");
  const idlPath = path.join(__dirname, "../../idl/txoracle.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  // Read-only provider — no wallet needed for .view() calls
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: PublicKey.default, signTransaction: async t => t, signAllTransactions: async t => t },
    { commitment: "confirmed" }
  );

  _program = new anchor.Program(idl, provider);
  return _program;
}

// Fetch the validation proof from TxLINE API
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

// Helper: convert hex/base64/array/null to 32-byte Buffer
// TxLINE sometimes returns null or missing fields for empty proof nodes —
// treat those as 32 zero bytes rather than crashing.
function toBytes32(val) {
  if (val === null || val === undefined) return Buffer.alloc(32);
  if (Array.isArray(val)) return Buffer.from(val);
  if (typeof val === "string") {
    if (!val) return Buffer.alloc(32);
    if (val.startsWith("0x") || val.length === 64) return Buffer.from(val.replace("0x",""), "hex");
    return Buffer.from(val, "base64");
  }
  if (Buffer.isBuffer(val)) return val;
  return Buffer.from(val);
}

function dailyScoresRootPda(epochDay) {
  // Seed confirmed from IDL account name: "daily_scores_merkle_roots"
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_merkle_roots"), Buffer.from([epochDay & 0xff, (epochDay >> 8) & 0xff])],
    new PublicKey(config.txline.programId)
  )[0];
}

// Parse the boolean result from program logs.
// The Txoracle program emits "Program log: <true|false>" or
// "Program return: <base64>" depending on version.
// We check both patterns.
function parseResultFromLogs(logs) {
  if (!logs || !logs.length) return null;
  for (const line of logs) {
    // "Program log: true" / "Program log: false"
    if (/program log:\s*true/i.test(line)) return true;
    if (/program log:\s*false/i.test(line)) return false;
    // "Program return: <programId> <base64bool>"
    const m = line.match(/Program return:\S*\s+(\S+)/);
    if (m) {
      try {
        const buf = Buffer.from(m[1], "base64");
        return buf[0] !== 0;
      } catch(e) {}
    }
    // "Program data: <base64>"
    const d = line.match(/Program data:\s+(\S+)/);
    if (d) {
      try {
        const buf = Buffer.from(d[1], "base64");
        return buf[0] !== 0;
      } catch(e) {}
    }
  }
  return null;
}

// Epoch days to try, in order: the proof's day first, then today.
function candidateEpochDays(targetTs) {
  const days = [];
  if (targetTs) {
    // targetTs may arrive in ms or seconds — normalize to ms
    const tsMs = targetTs > 1e12 ? targetTs : targetTs * 1000;
    days.push(Math.floor(tsMs / constants.MS_PER_DAY));
  }
  const today = Math.floor(Date.now() / constants.MS_PER_DAY);
  if (!days.includes(today)) days.push(today);
  return days;
}

// Main: verify a stat on-chain using TxLINE's Merkle proof
// Returns { result: bool, proof: object } — proof is stored as receipt
async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId} statKey ${statKey}...`);

  const proof = await fetchProof(fixtureId, statKey);
  console.log("[validate] Proof fetched");

  const program = await getProgram();

  // Build the predicate — e.g. { greaterThan: {} } means "stat > threshold"
  const predicate = {
    threshold,
    comparison: comparison === "greaterThan" ? { greaterThan: {} } : { lessThan: {} },
  };

  // Build stat1 argument from proof
  // Safe node mapper — guards against null nodes or missing hash fields
  function mapProofNode(node) {
    if (!node) return { hash: Array.from(Buffer.alloc(32)), isRightSibling: false };
    return {
      hash: Array.from(toBytes32(node.hash)),
      isRightSibling: node.isRightSibling ?? false,
    };
  }

  const stat1 = {
    statToProve: proof.statToProve,
    eventStatRoot: toBytes32(proof.eventStatRoot),
    statProof: (proof.statProof || []).map(mapProofNode),
  };

  // Build fixtureSummary
  const summary = proof.summary || {};
  const updateStats = summary.updateStats || {};
  const fixtureSummary = {
    fixtureId: summary.fixtureId ?? proof.fixtureId,
    updateStats: {
      updateCount: updateStats.updateCount ?? 0,
      minTimestamp: new anchor.BN(updateStats.minTimestamp ?? 0),
      maxTimestamp: new anchor.BN(updateStats.maxTimestamp ?? 0),
    },
    eventsSubTreeRoot: toBytes32(summary.eventsSubTreeRoot),
  };

  // Fixture proof path
  const fixtureProof = (proof.subTreeProof || []).map(mapProofNode);

  // Main tree proof path
  const mainTreeProof = (proof.mainTreeProof || []).map(mapProofNode);

  let lastError = null;

  for (const epochDay of candidateEpochDays(proof.targetTs)) {
    const dailyScoresRoot = dailyScoresRootPda(epochDay);
    try {
      // .view() is not supported by this program — use .simulate() and
      // parse the boolean result from the transaction logs instead.
      const sim = await program.methods
        .validateStat(
          new anchor.BN(proof.targetTs),
          fixtureSummary,
          fixtureProof,
          mainTreeProof,
          predicate,
          stat1,
          null, // stat2 — not needed for single-stat markets
          null  // op
        )
        .accounts({ dailyScoresRoot })
        .simulate({ commitment: "confirmed" });

      const logs = sim?.raw || sim?.events || sim?.logs || [];
      console.log("[validate] Simulation logs:", logs.slice(0, 10));

      const result = parseResultFromLogs(logs);
      if (result === null) {
        throw new Error("Could not parse boolean result from simulation logs: " + JSON.stringify(logs.slice(0,5)));
      }

      console.log(`[validate] Result: ${result} (epochDay ${epochDay})`);
      return {
        result,
        proof: {
          fixtureId,
          statKey,
          threshold,
          comparison,
          targetTs: proof.targetTs,
          dailyScoresRoot: dailyScoresRoot.toBase58(),
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
