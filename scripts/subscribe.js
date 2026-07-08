// scripts/subscribe.js
// Run ONCE to subscribe and get your API token.
// Uses the exact flow from TxLINE quickstart docs.
// Free tier — no TxL tokens needed, just SOL for gas.

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const axios = require("axios");
const nacl = require("tweetnacl");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram
} = require("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");

const config = require("../shared/config");

// ── Load wallet ───────────────────────────────────────────
function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  const bytes = decoder.decode(raw);
  const kp = Keypair.fromSecretKey(bytes);
  console.log("Wallet:", kp.publicKey.toBase58());
  return kp;
}

async function main() {
  console.log("=== TXLINE SUBSCRIBE (FREE TIER) ===");
  console.log("Network:", config.network);
  console.log("Host:", config.txline.host);

  const wallet = loadWallet();

  // Check SOL balance
  const connection = new Connection(config.rpc, "confirmed");
  const balance = await connection.getBalance(wallet.publicKey);
  console.log("SOL balance:", balance / 1e9);
  if (balance < 10000000) {
    console.log("\nNeed at least 0.01 SOL for gas. Get devnet SOL:");
    console.log("solana airdrop 1 " + wallet.publicKey.toBase58() + " --url devnet");
    console.log("Or: https://faucet.solana.com");
    return;
  }

  // ── Step 1: Get guest JWT ────────────────────────────────
  console.log("\n[1] Getting guest JWT...");
  const authRes = await axios.post(`${config.txline.host}/auth/guest/start`);
  const jwt = authRes.data.token;
  console.log("    Done");

  // ── Step 2: Load IDL and set up Anchor program ───────────
  console.log("\n[2] Loading Txoracle IDL...");

  // Try to load IDL from backend/idl folder
  let idl;
  const idlPath = path.join(__dirname, "../backend/idl/txoracle.json");
  if (fs.existsSync(idlPath) && fs.statSync(idlPath).size > 10) {
    idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    console.log("    IDL loaded from file");
  } else {
    console.log("    IDL file empty — fetching from chain...");
    const programId = new PublicKey(config.txline.programId);
    idl = await anchor.Program.fetchIdl(programId, {
      connection,
    });
    if (!idl) throw new Error("Could not fetch IDL from chain");
    fs.writeFileSync(idlPath, JSON.stringify(idl, null, 2));
    console.log("    IDL fetched and saved to backend/idl/txoracle.json");
  }

  // ── Step 3: Derive PDAs ──────────────────────────────────
  console.log("\n[3] Deriving PDAs...");
  const programId = new PublicKey(config.txline.programId);
  const txlMint = new PublicKey(config.txline.txlMint);

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    programId
  );

  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    txlMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    programId
  );

  const userTokenAccount = getAssociatedTokenAddressSync(
    txlMint,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("    tokenTreasuryPda:", tokenTreasuryPda.toBase58());
  console.log("    pricingMatrixPda:", pricingMatrixPda.toBase58());

  // ── Step 4: Subscribe on-chain ────────────────────────────
  console.log("\n[4] Subscribing on-chain (free tier)...");

  const anchorWallet = {
    publicKey: wallet.publicKey,
    signTransaction: async (tx) => { tx.partialSign(wallet); return tx; },
    signAllTransactions: async (txs) => {
      txs.forEach(tx => tx.partialSign(wallet));
      return txs;
    },
    payer: wallet,
  };

  const provider = new anchor.AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new anchor.Program(idl, provider);

  const SERVICE_LEVEL_ID = config.txline.serviceLevelId; // 1 = free WC tier
  const DURATION_WEEKS = config.txline.durationWeeks;    // 4
  const SELECTED_LEAGUES = [];                            // empty = standard bundle

  try {
    const txSig = await program.methods
      .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
      .accounts({
        user: wallet.publicKey,
        pricingMatrix: pricingMatrixPda,
        tokenMint: txlMint,
        userTokenAccount,
        tokenTreasuryVault,
        tokenTreasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("    Subscribe tx:", txSig);
    console.log("    Confirmed on devnet");

    // ── Step 5: Activate API token ─────────────────────────
    console.log("\n[5] Activating API token...");

    const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
    const message = new TextEncoder().encode(messageString);
    const signatureBytes = nacl.sign.detached(message, wallet.secretKey);
    const walletSignature = Buffer.from(signatureBytes).toString("base64");

    const activateRes = await axios.post(
      `${config.txline.host}/api/token/activate`,
      {
        txSig,
        walletSignature,
        leagues: SELECTED_LEAGUES,
      },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );

    const apiToken = activateRes.data.token || activateRes.data;
    console.log("    API Token received:", String(apiToken).slice(0, 40) + "...");

    // Save token to .env
    let envContent = fs.readFileSync("backend/.env", "utf8");
    if (envContent.includes("TXLINE_API_TOKEN=")) {
      envContent = envContent.replace(/TXLINE_API_TOKEN=.*/,
        `TXLINE_API_TOKEN=${apiToken}`);
    } else {
      envContent += `\nTXLINE_API_TOKEN=${apiToken}`;
    }
    fs.writeFileSync("backend/.env", envContent);

    console.log("\n=== SUCCESS ===");
    console.log("API token saved to backend/.env as TXLINE_API_TOKEN");
    console.log("Now run: node scripts/spike.js");

  } catch(e) {
    console.error("\nSubscribe error:", e.message);
    if (e.logs) {
      console.error("Program logs:");
      e.logs.forEach(l => console.error("  ", l));
    }
    if (e.response?.data) {
      console.error("API error:", JSON.stringify(e.response.data, null, 2));
    }
  }
}

main().catch(e => {
  console.error("Fatal error:", e.message);
});
