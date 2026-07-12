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
    eventsSubTreeRoot: toU8Array32(summary.eventsSubTreeRoot ?? summary.events_sub_tree_root),
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

  // ── Strategy: derive a candidate address, simulate, extract correct address
  //    from error logs on ConstraintSeeds, retry once with the correct address.
  // ────────────────────────────────────────────────────────────────────────────

  // Candidate PDA — may not be right, but gives us the error log with the correct one
  const tsMs   = Number(proof.ts ?? proof.targetTs ?? Date.now());
  const today  = Math.floor(Date.now() / constants.MS_PER_DAY);
  const proofDay = Math.floor(tsMs / constants.MS_PER_DAY);
  const PROG_ID = new PublicKey(config.txline.programId);

  function tryDerivePda(seed, day) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(seed), Buffer.from([day & 0xff, (day >> 8) & 0xff])],
        PROG_ID
      );
      return pda.toBase58();
    } catch (e) { return null; }
  }

  // Try a few derivations; one might be right, and if not, error logs will fix it
  const candidates = [
    tryDerivePda("daily_scores_merkle_roots", proofDay),
    tryDerivePda("daily_scores_roots", proofDay),
    tryDerivePda("daily_scores_merkle_roots", today),
    tryDerivePda("daily_scores_roots", today),
  ].filter(Boolean);

  // Deduplicate
  const tried = new Set();

  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);

    try {
      console.log(`[validate] Trying address: ${candidate.slice(0,12)}...`);
      const sim = await simulateWithAddress(program, methodArgs, candidate);
      const logs = sim?.raw || [];

      const result = parseResultFromLogs(logs);
      if (result !== null) {
        console.log(`[validate] Result: ${result}`);
        return {
          result,
          proof: {
            fixtureId, statKey, threshold, comparison,
            targetTs: String(proof.ts ?? 0),
            dailyScoresMerkleRoots: candidate,
          },
        };
      }

      // Success but no parseable result — log and continue
      console.log("[validate] Sim logs:", JSON.stringify(logs.slice(0, 6)));
      throw new Error("Could not parse result from logs: " + JSON.stringify(logs.slice(0, 5)));

    } catch (simErr) {
      const simLogs = simErr?.simulationResponse?.logs || simErr?.logs || [];
      const correctAddr = extractCorrectAddressFromLogs(simLogs);

      if (correctAddr && !tried.has(correctAddr)) {
        console.log(`[validate] ConstraintSeeds — retrying with correct address: ${correctAddr.slice(0,12)}...`);
        tried.add(correctAddr);
        try {
          const sim2 = await simulateWithAddress(program, methodArgs, correctAddr);
          const logs2 = sim2?.raw || [];
          const result = parseResultFromLogs(logs2);
          if (result !== null) {
            console.log(`[validate] Result: ${result}`);
            return {
              result,
              proof: {
                fixtureId, statKey, threshold, comparison,
                targetTs: String(proof.ts ?? 0),
                dailyScoresMerkleRoots: correctAddr,
              },
            };
          }
          console.log("[validate] Sim2 logs:", JSON.stringify(logs2.slice(0, 6)));
          throw new Error("Could not parse result: " + JSON.stringify(logs2.slice(0, 5)));
        } catch (e2) {
          throw new Error(`validateStat retry failed: ${e2.message || JSON.stringify(e2)}`);
        }
      }

      // No correct address in logs — propagate
      const detail = simErr.message || JSON.stringify(simErr);
      throw new Error(`validateStat failed: ${detail}`);
    }
  }

  throw new Error("validateStat failed: no candidate addresses to try");
}

module.exports = { verifyStat, fetchProof };
