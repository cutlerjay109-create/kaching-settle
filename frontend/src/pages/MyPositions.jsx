import React, { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMarketPda } from "../lib/solana";
import WalletButton from "../components/WalletButton";

// Known markets — add to this list as new fixtures are created
// In production this would be stored in a database
const KNOWN_MARKETS = [
  { fixtureId: 18209181, name: "France vs Morocco", question: "Will France score a goal against Morocco?" },
  { fixtureId: 18218149, name: "Spain vs Belgium", question: "Will Spain score a goal against Belgium?" },
  { fixtureId: 18213979, name: "Norway vs England", question: "Will Norway score a goal against England?" },
  { fixtureId: 18222446, name: "Argentina vs Switzerland", question: "Will Argentina score a goal against Switzerland?" },
  { fixtureId: 18143850, name: "Vietnam vs Myanmar", question: "Will Vietnam score a goal against Myanmar?" },
  { fixtureId: 18182808, name: "Australia vs Brazil", question: "Will Australia score a goal against Brazil?" },
  { fixtureId: 18182864, name: "Australia vs Brazil", question: "Will Australia score a goal against Brazil?" },
];

const STATUS = { 0: "Open", 1: "Locked", 2: "Settled", 3: "Voided" };
const SIDE = { 0: "YES", 1: "NO" };

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
    const { getMarket, getPositionPda, getConnection } = await import("../lib/solana");
    const connection = getConnection();
    const found = [];

    for (const m of KNOWN_MARKETS) {
      try {
        // Check if market exists and get its state
        const market = await getMarket(m.fixtureId);
        if (!market) continue;

        // Check if user has a position
        const positionPda = getPositionPda(m.fixtureId, publicKey.toBase58());
        const info = await connection.getAccountInfo(positionPda);
        if (!info) continue;

        // Decode position
        const d = info.data;
        let o = 8 + 8 + 32; // discriminator + fixture_id + user
        const side = d.readUInt8(o); o += 1;
        const amount = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
        const claimed = d.readUInt8(o) === 1;

        const won = market.status === 2 && market.winningSide === side;
        const canClaim = won && !claimed;

        found.push({
          ...m,
          market,
          side,
          amount,
          claimed,
          won,
          canClaim,
          status: market.status,
          winningSide: market.winningSide,
        });
      } catch(e) {
        // Position doesn't exist for this market
      }
    }

    setPositions(found);
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
        <div key={i} className={"position-card " + (p.canClaim ? "can-claim" : "")}>
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

          {p.canClaim && (
            <ClaimButton position={p} onClaimed={loadPositions} />
          )}

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
      await claim(wallet, {
        fixtureId: position.fixtureId,
        winningSide: position.winningSide,
      });
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

function getMarketAddress(fixtureId) {
  try {
    return getMarketPda(fixtureId).toBase58();
  } catch {
    return fixtureId;
  }
}
