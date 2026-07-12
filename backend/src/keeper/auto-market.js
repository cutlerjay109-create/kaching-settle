// backend/src/keeper/auto-market.js
// Automatically creates on-chain markets for all fixtures
// that don't have a market yet. Runs at startup and every hour.

const {
  Connection, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, Keypair
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const config = require("../../shared/config");
const constants = require("../../shared/constants");
const { fetchFixtures } = require("../txline/fixtures");

const PROGRAM_ID = new PublicKey(config.settleProgramId);
const USDC_MINT = new PublicKey(config.usdcMint);

// Anchor discriminator for create_market
const DISC_CREATE = Buffer.from([103, 226, 97, 235, 200, 188, 251, 254]);

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

function getVaultPda(fixtureId, seed) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), fixtureIdBytes(fixtureId)],
    PROGRAM_ID
  )[0];
}

async function marketExists(connection, fixtureId) {
  const pda = getMarketPda(fixtureId);
  const info = await connection.getAccountInfo(pda);
  return info !== null;
}

function encodeString(str) {
  const bytes = Buffer.from(str, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(Math.floor(n)));
  return buf;
}

async function createMarketForFixture(connection, wallet, fixture) {
  const { fixtureId, home, away, kickoffMs } = fixture;
  const question = `Will ${home} score a goal against ${away}?`;
  const kickoffTs = Math.floor(kickoffMs / 1000);

  const marketPda = getMarketPda(fixtureId);
  const yesVault = getVaultPda(fixtureId, constants.SEEDS.YES_VAULT);
  const noVault = getVaultPda(fixtureId, constants.SEEDS.NO_VAULT);

  // Encode instruction data manually
  const fixtureIdBuf = u64le(fixtureId);
  const questionBuf = encodeString(question);
  const kickoffBuf = (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(kickoffTs)); return b; })();
  const statKeyBuf = (() => { const b = Buffer.alloc(4); b.writeUInt32LE(1); return b; })(); // home goals
  const thresholdBuf = u64le(0);
  const comparisonBuf = Buffer.from([0]); // greaterThan

  const data = Buffer.concat([
    DISC_CREATE,
    fixtureIdBuf,
    questionBuf,
    kickoffBuf,
    statKeyBuf,
    thresholdBuf,
    comparisonBuf,
  ]);

  const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: marketPda, isSigner: false, isWritable: true },
      { pubkey: yesVault, isSigner: false, isWritable: true },
      { pubkey: noVault, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
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

let onMarketCreated = null;

function setMarketCreatedCallback(cb) {
  onMarketCreated = cb;
}

async function autoCreateMarkets() {
  if (!config.settleProgramId) return;

  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const fixtures = await fetchFixtures();

  console.log("[auto-market] Checking", fixtures.length, "fixtures...");

  for (const fixture of fixtures) {
    try {
      const exists = await marketExists(connection, fixture.fixtureId);
      if (exists) {
        console.log(`[auto-market] Market exists: ${fixture.home} vs ${fixture.away}`);
        continue;
      }

      console.log(`[auto-market] Creating market: ${fixture.home} vs ${fixture.away}`);
      const sig = await createMarketForFixture(connection, wallet, fixture);
      console.log(`[auto-market] Created: ${sig}`);
      if (onMarketCreated) onMarketCreated(fixture);

      // Small delay between transactions
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`[auto-market] Error for fixture ${fixture.fixtureId}:`, e.message);
    }
  }

  console.log("[auto-market] Done checking fixtures");
}

const DISC_DEPOSIT = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);

// u64le and getVaultPda defined above

function getPositionPda(fixtureId, user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(constants.SEEDS.POSITION), fixtureIdBytes(fixtureId), user.toBuffer()],
    PROGRAM_ID
  )[0];
}

async function seedMarketIfEmpty(connection, wallet, fixtureId) {
  const {
    Transaction, TransactionInstruction, SystemProgram
  } = require("@solana/web3.js");
  const {
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
  } = require("@solana/spl-token");

  const marketPda = getMarketPda(fixtureId);
  const info = await connection.getAccountInfo(marketPda);
  if (!info) return;

  // Read yes/no totals
  const d = info.data;
  let o = 8 + 8;
  const qLen = d.readUInt32LE(o); o += 4 + qLen;
  o += 8 + 4 + 8 + 1;
  const yesTotal = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
  const noTotal = Number(d.readBigUInt64LE(o)) / 1e6;
  const status = d.readUInt8(o + 8);

  // Only seed OPEN markets
  if (status !== 0) return;

  const userToken = getAssociatedTokenAddressSync(
    USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID
  );

  async function doDeposit(side, amount) {
    const vaultSeed = side === 0 ? constants.SEEDS.YES_VAULT : constants.SEEDS.NO_VAULT;
    const vault = getVaultPda(fixtureId, vaultSeed);
    const position = getPositionPda(fixtureId, wallet.publicKey);
    const data = Buffer.concat([
      DISC_DEPOSIT,
      Buffer.from([side]),
      u64le(amount * 1_000_000),
    ]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: marketPda, isSigner: false, isWritable: true },
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

  if (yesTotal < 1) {
    try {
      const sig = await doDeposit(0, 2);
      console.log("[auto-market] Seeded $2 YES for fixture", fixtureId, sig.slice(0,20) + "...");
    } catch(e) {
      console.log("[auto-market] YES seed failed:", e.message.slice(0,60));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (noTotal < 1) {
    try {
      const sig = await doDeposit(1, 1);
      console.log("[auto-market] Seeded $1 NO for fixture", fixtureId, sig.slice(0,20) + "...");
    } catch(e) {
      console.log("[auto-market] NO seed failed:", e.message.slice(0,60));
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function autoSeedMarkets() {
  if (!config.settleProgramId) return;
  const wallet = loadWallet();
  const connection = new Connection(config.rpc, "confirmed");
  const fixtures = await fetchFixtures();
  const now = Date.now();

  for (const fixture of fixtures) {
    if (fixture.kickoffMs <= now) continue;
    try {
      await seedMarketIfEmpty(connection, wallet, fixture.fixtureId);
    } catch(e) {
      console.error("[auto-market] Seed error:", e.message);
    }
  }
}

module.exports = { autoCreateMarkets, autoSeedMarkets, setMarketCreatedCallback };
