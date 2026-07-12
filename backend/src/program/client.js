// backend/src/program/client.js
// Connects to OUR vault program on Solana.
//
// CRITICAL FIX: PDA seeds. The program derives PDAs from the fixture id as
// u64 LITTLE-ENDIAN BYTES (`fixture_id.to_le_bytes()`). This file previously
// used `Buffer.from(fixtureId.toString())` (the ASCII string), so every PDA
// derived here pointed at a non-existent account.

const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair,
} = require("@solana/web3.js");
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

// fixture id -> u64 LE bytes, matching `fixture_id.to_le_bytes()` in Rust
function fixtureIdBytes(fixtureId) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(fixtureId));
  return buf;
}

// Derive market PDA
function getMarketPda(fixtureId, programId) {
  const pid = new PublicKey(programId || config.settleProgramId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixtureId)],
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
    [Buffer.from(seed), fixtureIdBytes(fixtureId)],
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
      fixtureIdBytes(fixtureId),
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
  fixtureIdBytes,
};
