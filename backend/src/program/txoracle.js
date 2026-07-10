// backend/src/program/txoracle.js
// Connects to TxLINE's Txoracle program.
// Used by validate.js for the validateStat.view() call.
// Kept separate so it can be updated independently if TxLINE deploys new versions.

const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const config = require("../../shared/config");

let _program = null;

async function getProgram() {
  if (_program) return _program;

  const connection = new Connection(config.rpc, "confirmed");
  const idlPath = path.join(__dirname, "../../idl/txoracle.json");

  if (!fs.existsSync(idlPath) || fs.statSync(idlPath).size < 10) {
    // Fetch IDL from chain if not cached
    console.log("[txoracle] Fetching IDL from chain...");
    const programId = new PublicKey(config.txline.programId);
    const idl = await anchor.Program.fetchIdl(programId, { connection });
    if (!idl) throw new Error("Could not fetch Txoracle IDL");
    fs.writeFileSync(idlPath, JSON.stringify(idl, null, 2));
    console.log("[txoracle] IDL saved");
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  // Read-only provider for .view() calls
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
  console.log("[txoracle] Program loaded:", config.txline.programId);
  return _program;
}

function getDailyScoresRootPda(epochDay) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("daily_scores_roots"),
      Buffer.from([epochDay & 0xff, (epochDay >> 8) & 0xff])
    ],
    new PublicKey(config.txline.programId)
  );
  return pda;
}

module.exports = { getProgram, getDailyScoresRootPda };
