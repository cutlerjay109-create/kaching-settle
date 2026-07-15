import React, { useEffect, useState } from "react";
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
