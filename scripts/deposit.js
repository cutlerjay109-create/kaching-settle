
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

const DISC = {
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
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

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(Math.floor(n)));
  return buf;
}

async function main() {
  // CONFIG — change these
  const FIXTURE_ID = 18143850;  // Vietnam vs Myanmar
  const SIDE = 0;               // 0 = YES, 1 = NO
  const AMOUNT_USDC = 2;        // $2

  console.log("=== DEPOSIT SCRIPT ===");
  console.log("Fixture:", FIXTURE_ID);
  console.log("Side:", SIDE === 0 ? "YES" : "NO");
  console.log("Amount: $" + AMOUNT_USDC);

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  console.log("Wallet:", wallet.publicKey.toBase58());

  const seedKey = constants.SIDE ? constants.SEEDS.YES_VAULT : constants.SEEDS.NO_VAULT;
  const vaultSeed = SIDE === 0 ? constants.SEEDS.YES_VAULT : constants.SEEDS.NO_VAULT;

  const [market] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.MARKET), fixtureIdBytes(FIXTURE_ID)],
    PROGRAM_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from(vaultSeed), fixtureIdBytes(FIXTURE_ID)],
    PROGRAM_ID
  );
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.POSITION), fixtureIdBytes(FIXTURE_ID), wallet.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  console.log("Market:", market.toBase58());
  console.log("Vault:", vault.toBase58());

  const amount = AMOUNT_USDC * 1_000_000;
  const data = Buffer.concat([
    DISC.deposit,
    Buffer.from([SIDE]),
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

  console.log("\nDeposited $" + AMOUNT_USDC + " on " + (SIDE === 0 ? "YES" : "NO"));
  console.log("Transaction:", sig);
  console.log("Explorer: https://solscan.io/tx/" + sig + "?cluster=devnet");
}

main().catch(e => {
  console.error("Error:", e.message);
  if (e.logs) e.logs.forEach(l => console.error(" ", l));
});
