#!/usr/bin/env python3
import os

FILES = {}

FILES['frontend/src/pages/MyPositions.jsx'] = r"""import React, { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getMarketPda, refund, getAllPositions, getMarket } from "../lib/solana";
import WalletButton from "../components/WalletButton";

const BACKEND = "https://kaching-settle-production.up.railway.app";

const STATUS = { 0: "Open", 1: "Locked", 2: "Settled", 3: "Voided" };
const SIDE = { 0: "YES", 1: "NO" };

// Get team names from market question or backend market list
async function getMarketName(fixtureId, question) {
  // Try to parse from question: "Will X score a goal against Y?"
  const m = (question || "").match(/^Will (.+) score a goal against (.+)\?$/);
  if (m) return `${m[1]} vs ${m[2]}`;
  return `Fixture ${fixtureId}`;
}

export default function MyPositions() {
  const { publicKey, connected } = useWallet();
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connected || !publicKey) return;
    loadPositions();
  }, [connected, publicKey]);

  async function loadPositions() {
    setLoading(true);
    try {
      // Scan ALL position accounts on-chain for this wallet
      // No hardcoded list — works for all past and future markets
      const onChainPositions = await getAllPositions(publicKey.toBase58());
      console.log("[MyPositions] Found", onChainPositions.length, "positions on-chain");

      const found = [];
      for (const pos of onChainPositions) {
        try {
          const market = await getMarket(pos.fixtureId);
          if (!market) continue;

          const won = market.status === 2 && market.winningSide === pos.side;
          const canClaim = won && !pos.claimed;
          const canRefund = market.status === 3 && !pos.claimed;
          const name = await getMarketName(pos.fixtureId, market.question);

          found.push({
            fixtureId: pos.fixtureId,
            name,
            question: market.question,
            market,
            side: pos.side,
            amount: pos.amount,
            claimed: pos.claimed,
            won,
            canClaim,
            canRefund,
            status: market.status,
            winningSide: market.winningSide,
          });
        } catch(e) {
          console.error("[MyPositions] Error loading fixture", pos.fixtureId, e.message);
        }
      }

      setPositions(found);
    } catch(e) {
      console.error("[MyPositions] Error:", e.message);
    }
    setLoading(false);
  }

  if (!connected) {
    return (
      <div className="my-positions">
        <h2>My Positions</h2>
        <div className="connect-prompt">
          <p>Connect your wallet to see your betting history</p>
          <WalletButton />
        </div>
      </div>
    );
  }

  if (loading) return <div className="loading">Loading your positions...</div>;

  return (
    <div className="my-positions">
      <h2>My Positions</h2>
      {positions.length === 0 && (
        <p className="empty">No positions found for this wallet.</p>
      )}
      {positions.map((p, i) => (
        <div key={i} className={"position-card " + (p.canClaim || p.canRefund ? "can-claim" : "")}>
          <div className="position-match">{p.name}</div>
          <div className="position-question">{p.question}</div>

          <div className="position-details">
            <span className={"position-side " + SIDE[p.side].toLowerCase()}>
              {SIDE[p.side]}
            </span>
            <span className="position-amount">${p.amount.toFixed(2)} USDC</span>
            <span className="position-status">{STATUS[p.status]}</span>
          </div>

          {p.status === 2 && (
            <div className="position-result">
              {p.won ? (
                p.claimed ? (
                  <span className="result-claimed">✅ Claimed</span>
                ) : (
                  <span className="result-win">🏆 You won — claim your winnings!</span>
                )
              ) : (
                <span className="result-loss">❌ {SIDE[p.winningSide]} won — better luck next time</span>
              )}
            </div>
          )}

          {p.status === 3 && (
            <div className="position-result">
              {p.claimed ? (
                <span className="result-claimed">↩️ Refunded</span>
              ) : (
                <span className="result-win">↩️ Market voided — your stake is refundable</span>
              )}
            </div>
          )}

          {p.canClaim && <ClaimButton position={p} onClaimed={loadPositions} />}
          {p.canRefund && <RefundButton position={p} onRefunded={loadPositions} />}

          <a
            href={"https://explorer.solana.com/address/" + getMarketAddress(p.fixtureId) + "?cluster=devnet"}
            target="_blank"
            rel="noopener noreferrer"
            className="explorer-link"
            style={{fontSize:"11px", display:"block", marginTop:"8px"}}
          >
            View on Solana Explorer →
          </a>
        </div>
      ))}
    </div>
  );
}

function ClaimButton({ position, onClaimed }) {
  const wallet = useWallet();
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);

  async function handleClaim() {
    setClaiming(true);
    setError(null);
    try {
      const { claim } = await import("../lib/solana");
      await claim(wallet, { fixtureId: position.fixtureId, winningSide: position.winningSide });
      onClaimed();
    } catch(e) {
      setError(e.message.slice(0, 80));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div>
      <button className="deposit-btn" onClick={handleClaim} disabled={claiming}>
        {claiming ? "Claiming..." : "Claim Winnings"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function RefundButton({ position, onRefunded }) {
  const wallet = useWallet();
  const [refunding, setRefunding] = useState(false);
  const [error, setError] = useState(null);

  async function handleRefund() {
    setRefunding(true);
    setError(null);
    try {
      await refund(wallet, { fixtureId: position.fixtureId, side: position.side });
      onRefunded();
    } catch(e) {
      if (e.message.includes("AlreadyRefunded") || e.message.includes("0x177e")) {
        setError("Already refunded.");
      } else if (e.message.includes("MarketNotVoid") || e.message.includes("0x177d")) {
        setError("Market is not voided — refunds not available.");
      } else {
        setError(e.message.slice(0, 80));
      }
    } finally {
      setRefunding(false);
    }
  }

  return (
    <div>
      <button className="deposit-btn" onClick={handleRefund} disabled={refunding}>
        {refunding ? "Refunding..." : "Get Refund"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function getMarketAddress(fixtureId) {
  try {
    const pda = getMarketPda(fixtureId);
    return pda.toBase58();
  } catch(e) {
    return "";
  }
}
"""

FILES['frontend/src/lib/solana.js'] = r"""import {
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

// Fetch and decode a user's Position account. Returns null if none.
export async function getPosition(fixtureId, user) {
  const connection = getConnection();
  const pda = getPositionPda(fixtureId, user);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;

  const d = info.data;
  let o = 8 + 8 + 32; // discriminator + fixture_id + user
  const side = d.readUInt8(o); o += 1;
  const amount = Number(d.readBigUInt64LE(o)) / 1_000_000; o += 8;
  const claimed = d.readUInt8(o) === 1;

  return { side, amount, claimed };
}

// Scan all Position accounts on-chain for a given wallet.
// This is the permanent solution — no hardcoded market list needed.
// Works for all past, present, and future markets automatically.
export async function getAllPositions(userPubkey) {
  const connection = getConnection();
  const programId = new PublicKey(IDL.address);

  // Position account discriminator: sha256("account:Position")[0..8]
  const POSITION_DISC = [170, 188, 143, 228, 122, 64, 247, 208];

  try {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { dataSize: 58 }, // 8 disc + 8 fixtureId + 32 user + 1 side + 8 amount + 1 claimed
        { memcmp: { offset: 0, bytes: Buffer.from(POSITION_DISC).toString("base64") } },
        { memcmp: { offset: 16, bytes: Buffer.from(new PublicKey(userPubkey).toBytes()).toString("base64") } },
      ],
      encoding: "base64",
    });

    const positions = [];
    for (const { account } of accounts) {
      try {
        const raw = account.data;
        const d = Buffer.isBuffer(raw) ? raw : Buffer.from(raw[0], "base64");
        let o = 8;
        const fixtureId = Number(d.readBigUInt64LE(o)); o += 8;
        o += 32; // skip user pubkey
        const side = d.readUInt8(o); o += 1;
        const amount = Number(d.readBigUInt64LE(o)) / 1_000_000; o += 8;
        const claimed = d.readUInt8(o) === 1;
        positions.push({ fixtureId, side, amount, claimed });
      } catch(e) {}
    }
    return positions;
  } catch(e) {
    console.error("[solana] getAllPositions failed:", e.message);
    return [];
  }
}
"""

FILES['backend/src/ai/voice.js'] = r"""// backend/src/ai/voice.js
// Converts pundit commentary text to audio using ElevenLabs.
// Returns a base64 audio string the frontend plays directly.

const axios = require("axios");

async function generateVoice(text) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

  if (!ELEVENLABS_API_KEY || !VOICE_ID) {
    console.warn("[voice] ElevenLabs keys missing — skipping audio");
    return null;
  }

  if (!text) return null;

  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.85,
          style: 0.65,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
        timeout: 30000,
      }
    );

    const base64 = Buffer.from(res.data).toString("base64");
    console.log("[voice] Audio generated —", base64.length, "chars");
    return `data:audio/mpeg;base64,${base64}`;
  } catch (e) {
    console.error("[voice] ElevenLabs error:", e.response?.status, e.message);
    return null;
  }
}

module.exports = { generateVoice };
"""


def main():
    if not os.path.isdir("frontend"):
        print("ERROR: run from kaching-settle repo root"); return
    for path, content in FILES.items():
        d = os.path.dirname(path)
        if d: os.makedirs(d, exist_ok=True)
        with open(path, "w") as f: f.write(content)
        print("wrote", path)
    print("Done.")
    print("Run: git add -A && git commit -m \'fix: MyPositions scans chain directly, no hardcoding\' && git push")


if __name__ == "__main__": main()
