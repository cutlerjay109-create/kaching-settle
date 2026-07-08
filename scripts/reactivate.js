// scripts/reactivate.js
// Re-activates your existing mainnet subscription.
// Uses the subscription tx from Kaching.

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const axios = require("axios");
const nacl = require("tweetnacl");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const fs = require("fs");

const config = require("../shared/config");

function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  const bytes = decoder.decode(raw);
  return Keypair.fromSecretKey(bytes);
}

async function main() {
  console.log("=== REACTIVATE TXLINE SUBSCRIPTION ===");
  console.log("Network:", config.network);
  console.log("Host:", config.txline.host);

  const wallet = loadWallet();
  console.log("Wallet:", wallet.publicKey.toBase58());

  // Your existing mainnet subscription tx
  const txSig = "2nVfBkAS5emXCBqPEgaTTjFdnVMH1f6Rz2DfxpDqSghZ3MyBnGeC4iiV6gwafpQ5MkxTxzquZs13FpNAZtRxJiii";
  const SELECTED_LEAGUES = []; // standard bundle

  // Step 1: Fresh JWT
  console.log("\n[1] Getting fresh JWT...");
  const authRes = await axios.post(`${config.txline.host}/auth/guest/start`);
  const jwt = authRes.data.token;
  console.log("    JWT OK");

  // Step 2: Sign exactly as docs say
  // messageString = txSig:leagues.join(","):jwt
  console.log("\n[2] Signing activation message...");
  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  console.log("    Message:", messageString.slice(0, 60) + "...");

  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, wallet.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  // Step 3: Activate
  console.log("\n[3] Activating...");
  try {
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
    console.log("    Token received:", String(apiToken).slice(0, 40) + "...");

    // Save to .env
    let envContent = fs.readFileSync("backend/.env", "utf8");
    // Remove old token lines
    envContent = envContent
      .split("\n")
      .filter(l => !l.startsWith("TXLINE_API_TOKEN") && !l.startsWith("# TXLINE_API_TOKEN"))
      .join("\n");
    envContent += `\nTXLINE_API_TOKEN=${apiToken}`;
    fs.writeFileSync("backend/.env", envContent);

    console.log("\n=== SUCCESS ===");
    console.log("Token saved to backend/.env");
    console.log("Now run: node scripts/spike.js");

  } catch(e) {
    console.log("    Error:", e.response?.status);
    console.log("    Data:", JSON.stringify(e.response?.data, null, 2));
  }
}

main().catch(console.error);
