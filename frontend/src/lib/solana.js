import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Buffer } from "buffer";

const PROGRAM_ID = new PublicKey("9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const RPC = "https://api.devnet.solana.com";

// Anchor discriminators = sha256("global:<name>")[0..8]
const DISC = {
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  claim: Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]),
  void_market: Buffer.from([243, 175, 46, 124, 95, 101, 39, 69]),
  refund: Buffer.from([2, 96, 183, 251, 63, 208, 46, 46]),
};

const SEEDS = {
  MARKET: "market",
  YES_VAULT: "yes_vault",
  NO_VAULT: "no_vault",
  POSITION: "position",
};

export function getConnection() {
  return new Connection(RPC, "confirmed");
}

function fixtureIdBytes(id) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return buf;
}

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

export function getMarketPda(fixtureId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.MARKET), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

export function getVaultPda(fixtureId, side) {
  const seed = side === 0 ? SEEDS.YES_VAULT : SEEDS.NO_VAULT;
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

export function getPositionPda(fixtureId, user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.POSITION), fixtureIdBytes(fixtureId), new PublicKey(user).toBuffer()],
    PROGRAM_ID
  )[0];
}

function acc(pubkey, isSigner, isWritable) {
  return { pubkey, isSigner, isWritable };
}

async function sendIx(wallet, ix) {
  const connection = getConnection();
  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function deposit(wallet, { fixtureId, side, amountUsdc }) {
  const market = getMarketPda(fixtureId);
  const vault = getVaultPda(fixtureId, side);
  const position = getPositionPda(fixtureId, wallet.publicKey);
  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  const amount = Math.floor(amountUsdc * 1_000_000);
  const data = Buffer.concat([
    DISC.deposit,
    Buffer.from([side]),
    u64le(amount),
  ]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      acc(wallet.publicKey, true, true),
      acc(market, false, true),
      acc(position, false, true),
      acc(vault, false, true),
      acc(userToken, false, true),
      acc(TOKEN_PROGRAM_ID, false, false),
      acc(SystemProgram.programId, false, false),
    ],
    data,
  });

  const tx = await sendIx(wallet, ix);
  return { tx };
}

export async function claim(wallet, { fixtureId, winningSide }) {
  const market = getMarketPda(fixtureId);
  const position = getPositionPda(fixtureId, wallet.publicKey);
  const winningVault = getVaultPda(fixtureId, winningSide);
  const losingVault = getVaultPda(fixtureId, winningSide === 0 ? 1 : 0);
  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      acc(wallet.publicKey, true, true),
      acc(market, false, false),
      acc(position, false, true),
      acc(winningVault, false, true),
      acc(losingVault, false, true),
      acc(userToken, false, true),
      acc(TOKEN_PROGRAM_ID, false, false),
    ],
    data: DISC.claim,
  });

  const tx = await sendIx(wallet, ix);
  return { tx };
}

// Manually decode Market account (no Anchor needed)
export async function voidMarket(wallet, { fixtureId }) {
  const market = getMarketPda(fixtureId);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      acc(wallet.publicKey, true, false),
      acc(market, false, true),
    ],
    data: DISC.void_market,
  });

  const tx = await sendIx(wallet, ix);
  return { tx };
}

export async function refund(wallet, { fixtureId, side }) {
  const market = getMarketPda(fixtureId);
  const position = getPositionPda(fixtureId, wallet.publicKey);
  const userVault = getVaultPda(fixtureId, side);
  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      acc(wallet.publicKey, true, true),
      acc(market, false, false),
      acc(position, false, true),
      acc(userVault, false, true),
      acc(userToken, false, true),
      acc(TOKEN_PROGRAM_ID, false, false),
    ],
    data: DISC.refund,
  });

  const tx = await sendIx(wallet, ix);
  return { tx };
}

export async function getMarket(fixtureId) {
  const connection = getConnection();
  const pda = getMarketPda(fixtureId);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;

  const d = info.data;
  let o = 8; // skip discriminator

  const fid = d.readBigUInt64LE(o); o += 8;
  const qLen = d.readUInt32LE(o); o += 4;
  const question = d.slice(o, o + qLen).toString("utf8"); o += qLen;
  const kickoffTs = d.readBigInt64LE(o); o += 8;
  o += 4;  // stat_key
  o += 8;  // threshold
  o += 1;  // comparison
  const yesTotal = d.readBigUInt64LE(o); o += 8;
  const noTotal = d.readBigUInt64LE(o); o += 8;
  const status = d.readUInt8(o); o += 1;
  const winningSide = d.readUInt8(o); o += 1;

  return {
    fixtureId: Number(fid),
    question,
    kickoffTs: Number(kickoffTs),
    yesTotal: Number(yesTotal) / 1_000_000,
    noTotal: Number(noTotal) / 1_000_000,
    status,
    winningSide,
  };
}
