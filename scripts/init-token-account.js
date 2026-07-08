// scripts/init-token-account.js
// Creates the TxL token account for your wallet.
// Run this ONCE before subscribe.js

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const {
  Connection, Keypair, SystemProgram, Transaction
} = require("@solana/web3.js");
const {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");

const config = require("../shared/config");

function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  const bytes = decoder.decode(raw);
  const kp = Keypair.fromSecretKey(bytes);
  console.log("Wallet:", kp.publicKey.toBase58());
  return kp;
}

async function main() {
  console.log("=== INIT TxL TOKEN ACCOUNT ===");

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const txlMint = new PublicKey(config.txline.txlMint);

  const ata = getAssociatedTokenAddressSync(
    txlMint,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("\nTxL ATA address:", ata.toBase58());

  // Check if already exists
  const info = await connection.getAccountInfo(ata);
  if (info) {
    console.log("Account already exists — no action needed.");
    console.log("Run: node scripts/subscribe.js");
    return;
  }

  console.log("Creating token account...");

  const ix = createAssociatedTokenAccountInstruction(
    wallet.publicKey,   // payer
    ata,               // associated token account
    wallet.publicKey,  // owner
    txlMint,           // mint
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet);

  const sig = await connection.sendRawTransaction(tx.serialize());
  console.log("Transaction sent:", sig);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("Confirmed!");
  console.log("\nNow run: node scripts/subscribe.js");
}

main().catch(e => {
  console.error("Error:", e.message);
  if (e.logs) e.logs.forEach(l => console.error(" ", l));
});
