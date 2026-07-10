// backend/src/program/client.js
// Connects to OUR vault program on Solana.
// Handles deposit, lock, settle, and claim instructions.
// Program ID set in shared/config.js after deploy.

const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair,
  SystemProgram, SYSVAR_CLOCK_PUBKEY
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");
const config = require("../../shared/config");
const constants = require("../../shared/constants");

let _program = null;
let _wallet = null;

function loadWallet() {
  if (_wallet) return _wallet;
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  _wallet = Keypair.fromSecretKey(decoder.decode(raw));
  return _wallet;
}

async function getProgram() {
  if (_program) return _program;

  if (!config.settleProgramId) {
    throw new Error("settleProgramId not set in shared/config.js — deploy program first");
  }

  const connection = new Connection(config.rpc, "confirmed");
  const wallet = loadWallet();

  const idlPath = path.join(__dirname, "../../idl/kaching_settle.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

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

// Derive market PDA
function getMarketPda(fixtureId, programId) {
  const pid = new PublicKey(programId || config.settleProgramId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), Buffer.from(fixtureId.toString())],
    pid
  );
  return pda;
}

// Derive vault PDA for YES or NO side
function getVaultPda(fixtureId, side, programId) {
  const pid = new PublicKey(programId || config.settleProgramId);
  const seed = side === constants.SIDE.YES
    ? constants.SEEDS.YES_VAULT
    : constants.SEEDS.NO_VAULT;
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(seed), Buffer.from(fixtureId.toString())],
    pid
  );
  return pda;
}

// Derive position PDA for a specific user+market
function getPositionPda(fixtureId, userPubkey, programId) {
  const pid = new PublicKey(programId || config.settleProgramId);
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(constants.SEEDS.POSITION),
      Buffer.from(fixtureId.toString()),
      new PublicKey(userPubkey).toBuffer(),
    ],
    pid
  );
  return pda;
}

module.exports = {
  getProgram,
  getMarketPda,
  getVaultPda,
  getPositionPda,
  loadWallet,
};
