
require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");
const config = require("../shared/config");
const constants = require("../shared/constants");

function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  return Keypair.fromSecretKey(decoder.decode(raw));
}

async function main() {
  console.log("=== CREATE MARKET ===");

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../backend/idl/kaching_settle.json")));
  const programId = new PublicKey(config.settleProgramId);
  const usdcMint = new PublicKey(config.usdcMint);

  const provider = new anchor.AnchorProvider(connection, {
    publicKey: wallet.publicKey,
    signTransaction: async (tx) => { tx.sign(wallet); return tx; },
    signAllTransactions: async (txs) => { txs.forEach(t => t.sign(wallet)); return txs; },
  }, { commitment: "confirmed" });

  const program = new anchor.Program(idl, provider);

  // France vs Morocco — July 9 2026
  const FIXTURE_ID = 18209181;
  const QUESTION = "Will France score a goal against Morocco?";
  const KICKOFF_TS = Math.floor(new Date("2026-07-09T20:00:00Z").getTime() / 1000);
  const STAT_KEY = 1;
  const THRESHOLD = 0;
  const COMPARISON = 0;

  // Seeds must match Rust: &fixture_id.to_le_bytes() = 8-byte little-endian u64
  function fixtureIdBytes(id) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(id));
    return buf;
  }

  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(FIXTURE_ID)],
    programId
  );

  const [yesVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.YES_VAULT), fixtureIdBytes(FIXTURE_ID)],
    programId
  );

  const [noVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.NO_VAULT), fixtureIdBytes(FIXTURE_ID)],
    programId
  );

  console.log("Market PDA:", marketPda.toBase58());
  console.log("YES Vault:", yesVaultPda.toBase58());
  console.log("NO Vault:", noVaultPda.toBase58());
  console.log("Kickoff:", new Date(KICKOFF_TS * 1000).toISOString());

  try {
    const tx = await program.methods
      .createMarket(
        new anchor.BN(FIXTURE_ID),
        QUESTION,
        new anchor.BN(KICKOFF_TS),
        STAT_KEY,
        new anchor.BN(THRESHOLD),
        COMPARISON
      )
      .accounts({
        authority: wallet.publicKey,
        market: marketPda,
        yesVault: yesVaultPda,
        noVault: noVaultPda,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("\nMarket created!");
    console.log("Transaction:", tx);
    console.log("Explorer: https://solscan.io/tx/" + tx);
  } catch(e) {
    console.error("Error:", e.message);
    if (e.logs) e.logs.forEach(l => console.error(" ", l));
  }
}

main().catch(console.error);
