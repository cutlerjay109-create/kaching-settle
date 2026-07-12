// scripts/manual-settle.js
// Manually lock + settle (or void) a market from the CLI.
//
// Usage:
//   node scripts/manual-settle.js <fixtureId> <YES|NO|VOID>
//
// The signer is WALLET_KEYPAIR from backend/.env. The script reads the
// market's on-chain authority first and tells you exactly which wallet
// must sign if there's a mismatch (e.g. markets created with Phantom).

require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const {
  Connection, PublicKey, Transaction,
  TransactionInstruction, Keypair
} = require("@solana/web3.js");
const bs58 = require("bs58");
const config = require("../shared/config");
const constants = require("../shared/constants");

const PROGRAM_ID = new PublicKey(config.settleProgramId);

// Anchor discriminators
const DISC = {
  lock_market: Buffer.from([107, 8, 184, 91, 223, 13, 180, 38]),
  settle: Buffer.from([175, 42, 185, 87, 144, 131, 102, 212]),
  void_market: Buffer.from([243, 175, 46, 124, 95, 101, 39, 69]),
};

function loadWallet() {
  const raw = process.env.WALLET_KEYPAIR.trim();
  const decoder = bs58.default || bs58;
  return Keypair.fromSecretKey(decoder.decode(raw));
}

function fixtureIdBytes(id) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return buf;
}

function getMarketPda(fixtureId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

function decodeMarket(d) {
  let o = 8;
  const fixtureId = Number(d.readBigUInt64LE(o)); o += 8;
  const qLen = d.readUInt32LE(o); o += 4;
  const question = d.slice(o, o + qLen).toString("utf8"); o += qLen;
  const kickoffTs = Number(d.readBigInt64LE(o)); o += 8;
  o += 4 + 8 + 1; // stat_key, threshold, comparison
  const yesTotal = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
  const noTotal = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
  const status = d.readUInt8(o); o += 1;
  const winningSide = d.readUInt8(o); o += 1;
  const authority = new PublicKey(d.slice(o, o + 32));
  return { fixtureId, question, kickoffTs, yesTotal, noTotal, status, winningSide, authority };
}

async function sendIx(connection, wallet, marketPda, data) {
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: marketPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function main() {
  const fixtureId = parseInt(process.argv[2]);
  const outcome = (process.argv[3] || "").toUpperCase();

  if (!fixtureId || !["YES", "NO", "VOID"].includes(outcome)) {
    console.log("Usage: node scripts/manual-settle.js <fixtureId> <YES|NO|VOID>");
    process.exit(1);
  }

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const marketPda = getMarketPda(fixtureId);

  console.log("Signer:    ", wallet.publicKey.toBase58());
  console.log("Market PDA:", marketPda.toBase58());

  const info = await connection.getAccountInfo(marketPda);
  if (!info) { console.log("Market not found on-chain."); return; }

  const m = decodeMarket(info.data);
  console.log(`Question:   ${m.question}`);
  console.log(`YES pot: $${m.yesTotal}  NO pot: $${m.noTotal}  Status: ${m.status}`);
  console.log(`Authority:  ${m.authority.toBase58()}`);

  if (m.status === 2) { console.log("Already settled. Winning side:", m.winningSide === 0 ? "YES" : "NO"); return; }
  if (m.status === 3) { console.log("Already voided."); return; }

  if (!m.authority.equals(wallet.publicKey)) {
    console.log("\n❌ AUTHORITY MISMATCH");
    console.log("This market can only be settled by:", m.authority.toBase58());
    console.log("Set WALLET_KEYPAIR in backend/.env to THAT wallet's base58 secret key and rerun.");
    process.exit(1);
  }

  // Step 1: Lock if open
  if (m.status === 0) {
    console.log("Locking market...");
    const sig = await sendIx(connection, wallet, marketPda, DISC.lock_market);
    console.log("Locked:", sig);
  }

  // Step 2: Settle or void
  if (outcome === "VOID") {
    console.log("Voiding market...");
    const sig = await sendIx(connection, wallet, marketPda, DISC.void_market);
    console.log("Voided:", sig);
  } else {
    const side = outcome === "YES" ? 0 : 1;
    console.log(`Settling — ${outcome} wins...`);
    const data = Buffer.concat([DISC.settle, Buffer.from([side])]);
    const sig = await sendIx(connection, wallet, marketPda, data);
    console.log("Settled:", sig);
  }

  console.log("\n✅ Done. Positions page will now show the final state.");
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
