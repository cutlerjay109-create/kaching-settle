
require("module").globalPaths.push(__dirname + "/../backend/node_modules");
require("dotenv").config({ path: __dirname + "/../backend/.env" });

const {
  Connection, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, Keypair
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const bs58 = require("bs58");
const config = require("../shared/config");
const constants = require("../shared/constants");

const PROGRAM_ID = new PublicKey(config.settleProgramId);
const USDC_MINT = new PublicKey(config.usdcMint);
const DISC_DEPOSIT = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);

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

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(Math.floor(n)));
  return buf;
}

function getMarketPda(fixtureId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

function getVaultPda(fixtureId, side) {
  const seed = side === 0 ? constants.SEEDS.YES_VAULT : constants.SEEDS.NO_VAULT;
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

function getPositionPda(fixtureId, user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.POSITION), fixtureIdBytes(fixtureId), user.toBuffer()],
    PROGRAM_ID
  )[0];
}

async function deposit(connection, wallet, fixtureId, side, amountUsdc) {
  const market = getMarketPda(fixtureId);
  const vault = getVaultPda(fixtureId, side);
  const position = getPositionPda(fixtureId, wallet.publicKey);
  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  const amount = amountUsdc * 1_000_000;
  const data = Buffer.concat([
    DISC_DEPOSIT,
    Buffer.from([side]),
    u64le(amount),
  ]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
  console.log("=== AUTO SEED ALL UPCOMING MARKETS ===");

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const now = Date.now();

  // All fixtures with their kickoff times
  const fixtures = [
    { id: 18213979, name: "Norway vs England",       kickoffMs: new Date("2026-07-11T21:00:00Z").getTime() },
    { id: 18222446, name: "Argentina vs Switzerland", kickoffMs: new Date("2026-07-12T01:00:00Z").getTime() },
    { id: 18143850, name: "Vietnam vs Myanmar",       kickoffMs: new Date("2026-07-18T15:00:00Z").getTime() },
    { id: 18182808, name: "Australia vs Brazil",      kickoffMs: new Date("2026-09-25T15:00:00Z").getTime() },
    { id: 18182864, name: "Australia vs Brazil",      kickoffMs: new Date("2026-09-29T15:00:00Z").getTime() },
  ];

  // Only seed upcoming fixtures
  const upcoming = fixtures.filter(f => f.kickoffMs > now);
  console.log("Upcoming fixtures to seed:", upcoming.length);

  for (const f of upcoming) {
    console.log("\n--- " + f.name + " (ID: " + f.id + ") ---");

    // Check if market exists
    const marketPda = getMarketPda(f.id);
    const info = await connection.getAccountInfo(marketPda);
    if (!info) {
      console.log("  Market does not exist on-chain — skipping");
      continue;
    }

    // Read current pot sizes from market account
    const d = info.data;
    let o = 8 + 8;
    const qLen = d.readUInt32LE(o); o += 4 + qLen;
    o += 8 + 4 + 8 + 1;
    const yesTotal = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
    const noTotal = Number(d.readBigUInt64LE(o)) / 1e6;

    console.log("  Current YES: $" + yesTotal.toFixed(2));
    console.log("  Current NO:  $" + noTotal.toFixed(2));

    // Seed YES if empty
    if (yesTotal < 1) {
      try {
        const sig = await deposit(connection, wallet, f.id, 0, 2);
        console.log("  Deposited $2 on YES:", sig.slice(0, 20) + "...");
      } catch(e) {
        console.log("  YES deposit failed:", e.message.slice(0, 80));
      }
      await new Promise(r => setTimeout(r, 1000));
    } else {
      console.log("  YES already funded — skipping");
    }

    // Seed NO if empty
    if (noTotal < 1) {
      try {
        const sig = await deposit(connection, wallet, f.id, 1, 1);
        console.log("  Deposited $1 on NO:", sig.slice(0, 20) + "...");
      } catch(e) {
        console.log("  NO deposit failed:", e.message.slice(0, 80));
      }
      await new Promise(r => setTimeout(r, 1000));
    } else {
      console.log("  NO already funded — skipping");
    }
  }

  console.log("\n=== SEEDING COMPLETE ===");
}

main().catch(e => {
  console.error("Error:", e.message);
  if (e.logs) e.logs.forEach(l => console.error(" ", l));
});
