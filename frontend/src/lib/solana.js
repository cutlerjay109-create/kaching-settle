import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import idl from "../../backend/idl/kaching_settle.json";

const PROGRAM_ID = new PublicKey("9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // mainnet USDC
const RPC = "https://api.mainnet-beta.solana.com";

const SEEDS = {
  MARKET: "market",
  YES_VAULT: "yes_vault",
  NO_VAULT: "no_vault",
  POSITION: "position",
};

export function getConnection() {
  return new Connection(RPC, "confirmed");
}

function getProgram(wallet) {
  const connection = getConnection();
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(idl, PROGRAM_ID, provider);
}

function getMarketPda(fixtureId) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.MARKET), Buffer.from(fixtureId.toString())],
    PROGRAM_ID
  );
  return pda;
}

function getVaultPda(fixtureId, side) {
  const seed = side === 0 ? SEEDS.YES_VAULT : SEEDS.NO_VAULT;
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(seed), Buffer.from(fixtureId.toString())],
    PROGRAM_ID
  );
  return pda;
}

function getPositionPda(fixtureId, userPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEEDS.POSITION),
      Buffer.from(fixtureId.toString()),
      new PublicKey(userPubkey).toBuffer(),
    ],
    PROGRAM_ID
  );
  return pda;
}

export async function createMarket(wallet, { fixtureId, question, kickoffTs, statKey, threshold, comparison }) {
  const program = getProgram(wallet);
  const marketPda = getMarketPda(fixtureId);
  const yesVaultPda = getVaultPda(fixtureId, 0);
  const noVaultPda = getVaultPda(fixtureId, 1);

  const tx = await program.methods
    .createMarket(
      new BN(fixtureId),
      question,
      new BN(kickoffTs),
      statKey,
      new BN(threshold),
      comparison
    )
    .accounts({
      authority: wallet.publicKey,
      market: marketPda,
      yesVault: yesVaultPda,
      noVault: noVaultPda,
      usdcMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  return { tx, marketPda: marketPda.toBase58() };
}

export async function deposit(wallet, { fixtureId, side, amountUsdc }) {
  const program = getProgram(wallet);
  const marketPda = getMarketPda(fixtureId);
  const vaultPda = getVaultPda(fixtureId, side);
  const positionPda = getPositionPda(fixtureId, wallet.publicKey);

  const userTokenAccount = getAssociatedTokenAddressSync(
    USDC_MINT,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  const amountLamports = new BN(Math.floor(amountUsdc * 1_000_000));

  const tx = await program.methods
    .deposit(side, amountLamports)
    .accounts({
      user: wallet.publicKey,
      market: marketPda,
      position: positionPda,
      vault: vaultPda,
      userTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { tx };
}

export async function claim(wallet, { fixtureId, winningSide }) {
  const program = getProgram(wallet);
  const marketPda = getMarketPda(fixtureId);
  const positionPda = getPositionPda(fixtureId, wallet.publicKey);
  const winningVault = getVaultPda(fixtureId, winningSide);
  const losingVault = getVaultPda(fixtureId, winningSide === 0 ? 1 : 0);

  const userTokenAccount = getAssociatedTokenAddressSync(
    USDC_MINT,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  const tx = await program.methods
    .claim()
    .accounts({
      user: wallet.publicKey,
      market: marketPda,
      position: positionPda,
      winningVault,
      losingVault,
      userTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return { tx };
}

export async function getMarket(fixtureId) {
  const connection = getConnection();
  const provider = new AnchorProvider(connection, {
    publicKey: PublicKey.default,
    signTransaction: async t => t,
    signAllTransactions: async t => t,
  }, { commitment: "confirmed" });
  const program = new Program(idl, PROGRAM_ID, provider);
  const marketPda = getMarketPda(fixtureId);

  try {
    const market = await program.account.market.fetch(marketPda);
    return {
      fixtureId: market.fixtureId.toNumber(),
      question: market.question,
      kickoffTs: market.kickoffTs.toNumber(),
      yesTotal: market.yesTotal.toNumber() / 1_000_000,
      noTotal: market.noTotal.toNumber() / 1_000_000,
      status: market.status,
      winningSide: market.winningSide,
    };
  } catch {
    return null;
  }
}
