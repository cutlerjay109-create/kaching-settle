// backend/src/txline/validate.js
// Fetches TxLINE's cryptographic stat-validation proof for a fixture.
// Calls validateStat().view() on the Txoracle program — returns true/false.
// This is the trustless verification step that gates settlement.

const axios = require("axios");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, ComputeBudgetProgram, Transaction } = require("@solana/web3.js");
const { makeHeaders } = require("./auth");
const config = require("../../../shared/config");
const constants = require("../../../shared/constants");
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

// Helper: convert hex/base64/array to 32-byte Buffer
function toBytes32(val) {
  if (Array.isArray(val)) return Buffer.from(val);
  if (typeof val === "string") {
    if (val.startsWith("0x") || val.length === 64) return Buffer.from(val.replace("0x",""), "hex");
    return Buffer.from(val, "base64");
  }
  return Buffer.from(val);
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
  const stat1 = {
    statToProve: proof.statToProve,
    eventStatRoot: toBytes32(proof.eventStatRoot),
    statProof: proof.statProof.map(node => ({
      hash: Array.from(toBytes32(node.hash)),
      isRightSibling: node.isRightSibling,
    })),
  };

  // Build fixtureSummary
  const fixtureSummary = {
    fixtureId: proof.summary.fixtureId,
    updateStats: {
      updateCount: proof.summary.updateStats.updateCount,
      minTimestamp: new anchor.BN(proof.summary.updateStats.minTimestamp),
      maxTimestamp: new anchor.BN(proof.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: toBytes32(proof.summary.eventsSubTreeRoot),
  };

  // Fixture proof path
  const fixtureProof = proof.subTreeProof.map(node => ({
    hash: Array.from(toBytes32(node.hash)),
    isRightSibling: node.isRightSibling,
  }));

  // Main tree proof path
  const mainTreeProof = proof.mainTreeProof.map(node => ({
    hash: Array.from(toBytes32(node.hash)),
    isRightSibling: node.isRightSibling,
  }));

  // The daily scores root PDA
  const epochDay = Math.floor(Date.now() / constants.MS_PER_DAY);
  const [dailyScoresRoot] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), Buffer.from([epochDay & 0xff, (epochDay >> 8) & 0xff])],
    new PublicKey(config.txline.programId)
  );

  try {
    // .view() — read-only simulation, returns true/false
    const result = await program.methods
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
      .view({ commitment: "confirmed" });

    console.log(`[validate] Result: ${result}`);
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
    throw new Error(`validateStat failed: ${e.message}`);
  }
}

module.exports = { verifyStat, fetchProof };
