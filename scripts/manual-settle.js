
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

async function main() {
  // France vs Morocco — France scored, YES wins
  const FIXTURE_ID = 18218149;
  const WINNING_SIDE = 0; // 0 = YES (Spain scored)

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const marketPda = getMarketPda(FIXTURE_ID);

  console.log("Market PDA:", marketPda.toBase58());

  // Read current status
  const info = await connection.getAccountInfo(marketPda);
  if (!info) { console.log("Market not found"); return; }

  const d = info.data;
  let o = 8 + 8;
  const qLen = d.readUInt32LE(o); o += 4 + qLen;
  o += 8 + 4 + 8 + 1;
  const yesTotal = Number(d.readBigUInt64LE(o))/1e6; o += 8;
  const noTotal = Number(d.readBigUInt64LE(o))/1e6; o += 8;
  const status = d.readUInt8(o);

  console.log("YES pot:", yesTotal, "NO pot:", noTotal, "Status:", status);

  // Step 1: Lock market if still open
  if (status === 0) {
    console.log("Locking market first...");
    const lockData = Buffer.concat([DISC.lock_market]);
    const lockIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: marketPda, isSigner: false, isWritable: true },
      ],
      data: lockData,
    });

    const lockTx = new Transaction().add(lockIx);
    lockTx.feePayer = wallet.publicKey;
    lockTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    lockTx.sign(wallet);
    const lockSig = await connection.sendRawTransaction(lockTx.serialize());
    await connection.confirmTransaction(lockSig, "confirmed");
    console.log("Locked:", lockSig.slice(0,20) + "...");
  }

  // Step 2: Settle
  if (status <= 1) {
    console.log("Settling — YES wins (Spain scored)...");
    const settleData = Buffer.concat([
      DISC.settle,
      Buffer.from([WINNING_SIDE]),
    ]);

    const settleIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: marketPda, isSigner: false, isWritable: true },
      ],
      data: settleData,
    });

    const settleTx = new Transaction().add(settleIx);
    settleTx.feePayer = wallet.publicKey;
    settleTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    settleTx.sign(wallet);
    const settleSig = await connection.sendRawTransaction(settleTx.serialize());
    await connection.confirmTransaction(settleSig, "confirmed");
    console.log("Settled! TX:", settleSig.slice(0,20) + "...");
    console.log("Explorer: https://solscan.io/tx/" + settleSig + "?cluster=devnet");
    console.log("YES backers can now claim! Spain 2-1 Belgium");
  } else {
    console.log("Market already settled, status:", status);
  }
}

main().catch(e => {
  console.error("Error:", e.message);
  if (e.logs) e.logs.forEach(l => console.error(" ", l));
});
