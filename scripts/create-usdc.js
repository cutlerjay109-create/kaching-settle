// scripts/create-usdc.js
// Gets test USDC for your wallet on mainnet.
// Uses the Circle USDC faucet or explains how to get mainnet USDC.

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const {
  Connection, PublicKey, Keypair
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const bs58 = require("bs58");
const config = require("../shared/config");

function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  return Keypair.fromSecretKey(decoder.decode(raw));
}

async function main() {
  console.log("=== CHECK USDC BALANCE ===");

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const usdcMint = new PublicKey(config.usdcMint);

  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("USDC Mint:", config.usdcMint);

  const ata = getAssociatedTokenAddressSync(
    usdcMint, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );
  console.log("USDC ATA:", ata.toBase58());

  try {
    const account = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    const balance = Number(account.amount) / 1_000_000;
    console.log("\nUSDC Balance:", balance, "USDC");

    if (balance < 1) {
      console.log("\nNeed USDC for testing. Options:");
      console.log("1. Swap SOL for USDC on Jupiter: https://jup.ag");
      console.log("   - Even $1 worth is enough to test");
      console.log("2. Send USDC from another wallet to:", wallet.publicKey.toBase58());
    } else {
      console.log("\nYou have enough USDC to test the vault.");
    }
  } catch (e) {
    console.log("\nNo USDC account found.");
    console.log("Get USDC via Jupiter: https://jup.ag");
    console.log("Swap any amount of SOL for USDC, then re-run this script.");
  }
}

main().catch(console.error);
