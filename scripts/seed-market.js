// scripts/seed-market.js
// Creates a demo market and funds both sides for the demo video.
// Run this after the program is deployed.
// Seeds YES and NO sides with test amounts so the demo looks real.

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
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
  console.log("=== SEED MARKET ===");
  console.log("Network:", config.network);

  if (!config.settleProgramId) {
    console.log("ERROR: settleProgramId not set in shared/config.js");
    console.log("Deploy the program first, then set the program ID.");
    return;
  }

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");

  console.log("Wallet:", wallet.publicKey.toBase58());

  const idlPath = path.join(__dirname, "../backend/idl/kaching_settle.json");
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

  const program = new anchor.Program(idl, provider);
  const programId = new PublicKey(config.settleProgramId);
  const usdcMint = new PublicKey(config.usdcMint);

  // Demo fixture: first available from fixtures endpoint
  // Using a friendly fixture for demo
  const FIXTURE_ID = 18143850; // Vietnam vs Myanmar
  const QUESTION = "Will Vietnam score a goal?";
  const KICKOFF_TS = Math.floor(Date.now() / 1000) + 300; // 5 min from now
  const STAT_KEY = 1; // home goals
  const THRESHOLD = 0; // goals > 0
  const COMPARISON = 0; // greaterThan

  // Derive PDAs
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), Buffer.from(FIXTURE_ID.toString())],
    programId
  );

  const [yesVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.YES_VAULT), Buffer.from(FIXTURE_ID.toString())],
    programId
  );

  const [noVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.NO_VAULT), Buffer.from(FIXTURE_ID.toString())],
    programId
  );

  console.log("\nMarket PDA:", marketPda.toBase58());
  console.log("YES Vault PDA:", yesVaultPda.toBase58());
  console.log("NO Vault PDA:", noVaultPda.toBase58());

  // Step 1: Create market
  console.log("\n[1] Creating market...");
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
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("    Created:", tx);
  } catch (e) {
    if (e.message.includes("already in use")) {
      console.log("    Market already exists — skipping");
    } else {
      throw e;
    }
  }

  // Step 2: Deposit on YES side
  console.log("\n[2] Depositing $5 on YES...");
  const userUsdcAccount = getAssociatedTokenAddressSync(
    usdcMint, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  const [positionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(constants.SEEDS.POSITION),
      Buffer.from(FIXTURE_ID.toString()),
      wallet.publicKey.toBuffer(),
    ],
    programId
  );

  try {
    const tx = await program.methods
      .deposit(constants.SIDE.YES, new anchor.BN(5_000_000)) // $5
      .accounts({
        user: wallet.publicKey,
        market: marketPda,
        position: positionPda,
        vault: yesVaultPda,
        userTokenAccount: userUsdcAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("    YES deposit:", tx);
  } catch (e) {
    console.log("    YES deposit error:", e.message);
  }

  console.log("\n=== SEED COMPLETE ===");
  console.log("Market:", marketPda.toBase58());
  console.log("Question:", QUESTION);
  console.log("Kickoff in 5 minutes");
  console.log("\nNext: deposit on NO side from a second wallet, then wait for settlement.");
}

main().catch(e => {
  console.error("Error:", e.message);
  if (e.logs) e.logs.forEach(l => console.error(" ", l));
});
