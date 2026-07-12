// backend/src/txline/validate.js
// Verifies a TxLINE stat proof using the Txoracle on-chain program.
//
// DIAGNOSTIC VERSION — dumps full proof structure for every seq attempt
// so we can identify the correct seq, field names, and stat values in one pass.

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

// ── Raw proof fetcher ──────────────────────────────────────────────────────
async function fetchProofRaw(fixtureId, statKey, seq) {
  const params = { fixtureId, statKey };
  if (seq !== undefined) params.seq = seq;
  const res = await axios.get(`${config.txline.host}/api/scores/stat-validation`, {
    headers: makeHeaders(),
    params,
    timeout: 20000,
  });
  return res.data;
}

// Fetch all available seq values and return the one with the highest stat value.
// Logs every seq attempt so we can see the full picture in Railway.
async function fetchBestProof(fixtureId, statKey) {
  // Try without seq (API default), then seq 0 through 20
  const seqsToTry = [undefined, ...Array.from({length: 21}, (_, i) => i)];
  
  let bestProof = null;
  let bestValue = -1;
  let results = [];

  for (const seq of seqsToTry) {
    try {
      const proof = await fetchProofRaw(fixtureId, statKey, seq);
      const stp = proof.statToProve || proof.stat_to_prove || {};
      const val = Number(stp.value ?? 0);
      const ts = proof.ts;
      const updateCount = proof.summary?.updateStats?.updateCount ?? proof.summary?.update_stats?.update_count ?? '?';
      results.push({ seq: seq === undefined ? 'none' : seq, value: val, ts, updateCount });
      
      if (val > bestValue) {
        bestValue = val;
        bestProof = proof;
      }

      // Once we start getting the same value multiple times, we've hit the end
      // But keep going to find the maximum
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.status || e.message;
      results.push({ seq: seq === undefined ? 'none' : seq, error: msg });
      // If seq errors after finding some results, we've gone past the end
      if (seq !== undefined && seq > 0 && results.filter(r => !r.error).length > 0 && 
          results.filter(r => r.error).length >= 3) {
        break; // 3 consecutive errors = past end of available seqs
      }
    }
  }

  console.log(`[validate] Proof seq scan for fixture ${fixtureId} statKey ${statKey}:`);
  console.log(JSON.stringify(results, null, 2));
  console.log(`[validate] Best proof: seq with value=${bestValue}`);

  if (!bestProof) throw new Error("No valid proof found for any seq");
  return bestProof;
}

// ── Helpers ────────────────────────────────────────────────────────────────
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
      try { new PublicKey(addr); return addr; } catch (e) {}
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
    const d = line.match(/Program data:\s+(\S+)/);
    if (d) { try { return Buffer.from(d[1], "base64")[0] !== 0; } catch(e) {} }
  }
  return null;
}

async function simulateWithAddress(program, args, dailyScoresMerkleRoots, targetTs) {
  const { fixtureSummary, fixtureProof, mainTreeProof, predicate, statA } = args;
  const sim = await program.methods
    .validateStat(targetTs, fixtureSummary, fixtureProof, mainTreeProof, predicate, statA, null, null)
    .accounts({ dailyScoresMerkleRoots: new PublicKey(dailyScoresMerkleRoots) })
    .simulate({ commitment: "confirmed" });
  return sim;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function verifyStat({ fixtureId, statKey, threshold, comparison }) {
  console.log(`[validate] Verifying fixture ${fixtureId} statKey ${statKey}...`);

  const proof = await fetchBestProof(fixtureId, statKey);

  const program = await getProgram();

  // TraderPredicate
  const predicate = {
    threshold: Number(threshold) || 0,
    comparison: comparison === "lessThan" ? { lessThan: {} } : { greaterThan: {} },
  };

  // ScoresBatchSummary — handle all known field name variants
  const summary = proof.summary || {};
  const us = summary.updateStats || summary.update_stats || {};
  // eventStatsSubTreeRoot is the ACTUAL field name from the API (confirmed from logs)
  const eventsRoot = summary.eventStatsSubTreeRoot
    ?? summary.eventsSubTreeRoot
    ?? summary.events_sub_tree_root
    ?? summary.event_stats_sub_tree_root;

  const fixtureSummary = {
    fixtureId: toBN(summary.fixtureId ?? summary.fixture_id ?? fixtureId),
    updateStats: {
      updateCount: Number(us.updateCount ?? us.update_count ?? 0),
      minTimestamp: toBN(us.minTimestamp ?? us.min_timestamp ?? 0),
      maxTimestamp: toBN(us.maxTimestamp ?? us.max_timestamp ?? 0),
    },
    eventsSubTreeRoot: toU8Array32(eventsRoot),
  };

  // StatTerm
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

  // ts candidates — minTimestamp gets furthest through validation
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

  // Step 1: get correct account address via dummy PDA → ConstraintSeeds error
  const PROG_ID = new PublicKey(config.txline.programId);
  const dummyPda = PublicKey.findProgramAddressSync([Buffer.from("dummy")], PROG_ID)[0].toBase58();

  let correctAddr = null;
  try {
    const sim = await simulateWithAddress(program, args, dummyPda, uniqueTs[0]);
    const logs = sim?.raw || [];
    const result = parseResultFromLogs(logs);
    if (result !== null) {
      console.log(`[validate] Result: ${result} (first try)`);
      return { result, proof: { fixtureId, statKey, threshold, comparison,
        targetTs: uniqueTs[0].toString(), dailyScoresMerkleRoots: dummyPda } };
    }
  } catch (e) {
    const simLogs = e?.simulationResponse?.logs || [];
    correctAddr = extractCorrectAddressFromLogs(simLogs);
    if (correctAddr) {
      console.log(`[validate] Extracted correct address: ${correctAddr.slice(0,12)}...`);
    } else {
      const detail = e?.simulationResponse
        ? JSON.stringify({ err: e.simulationResponse.err, logs: e.simulationResponse.logs?.slice(0,5) })
        : (e.message || String(e));
      throw new Error("Could not extract account address: " + detail);
    }
  }

  // Step 2: try each ts with correct address
  let lastErr = null;
  for (const tsVal of uniqueTs) {
    try {
      const sim = await simulateWithAddress(program, args, correctAddr, tsVal);
      const logs = sim?.raw || [];
      const result = parseResultFromLogs(logs);
      if (result !== null) {
        console.log(`[validate] Result: ${result} (ts=${tsVal.toString()})`);
        return { result, proof: { fixtureId, statKey, threshold, comparison,
          targetTs: tsVal.toString(), dailyScoresMerkleRoots: correctAddr } };
      }
      lastErr = new Error("Could not parse result from logs: " + JSON.stringify(logs.slice(0,5)));
    } catch (e) {
      const simResp = e?.simulationResponse;
      const simLogs = simResp?.logs || [];

      // StatNotZero (6074) = proof verified, predicate evaluated to FALSE
      const isStatNotZero = simResp?.err?.InstructionError?.[1]?.Custom === 6074 ||
        simLogs.some(l => l.includes("StatNotZero"));
      if (isStatNotZero) {
        console.log(`[validate] StatNotZero — predicate FALSE (result: false, ts=${tsVal.toString()})`);
        return { result: false, proof: { fixtureId, statKey, threshold, comparison,
          targetTs: tsVal.toString(), dailyScoresMerkleRoots: correctAddr } };
      }

      const detail = simResp
        ? JSON.stringify({ err: simResp.err, logs: simLogs.slice(0,5) })
        : (e.message || String(e));
      console.error(`[validate] ts=${tsVal.toString()} failed: ${detail}`);
      lastErr = e;
    }
  }

  throw new Error(`validateStat failed: ${lastErr?.message || lastErr}`);
}

module.exports = { verifyStat, fetchProof: fetchBestProof };
