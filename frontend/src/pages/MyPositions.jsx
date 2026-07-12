import React, { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getMarketPda, refund } from "../lib/solana";
import WalletButton from "../components/WalletButton";

const BACKEND = "https://kaching-settle-production.up.railway.app";

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

async function loadMarketList() {
  const byId = new Map();
  for (const m of KNOWN_MARKETS) byId.set(m.fixtureId, m);
  try {
    const res = await fetch(`${BACKEND}/api/markets`);
    const list = await res.json();
    if (Array.isArray(list)) {
      for (const m of list) {
        if (!m.fixtureId) continue;
        byId.set(m.fixtureId, {
          fixtureId: m.fixtureId,
          name: m.home && m.away ? `${m.home} vs ${m.away}` : (m.question || `Fixture ${m.fixtureId}`),
          question: m.question || "",
        });
      }
    }
  } catch (e) {}
  return Array.from(byId.values());
}

// Fetch final score from backend snapshot
async function fetchScore(fixtureId) {
  try {
    const res = await fetch(`${BACKEND}/api/scores/snapshot/${fixtureId}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const s = data[data.length - 1];
      const home = s.Participant1Goals ?? s.HomeGoals ?? s.homeGoals ?? null;
      const away = s.Participant2Goals ?? s.AwayGoals ?? s.awayGoals ?? null;
      if (home !== null && away !== null) return `${home}-${away}`;
    }
  } catch (e) {}
  return null;
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
    const { getMarket, getPositionPda, getConnection } = await import("../lib/solana");
    const connection = getConnection();
    const markets = await loadMarketList();
    const found = [];

    for (const m of markets) {
      try {
        const market = await getMarket(m.fixtureId);
        if (!market) continue;

        const positionPda = getPositionPda(m.fixtureId, publicKey.toBase58());
        const info = await connection.getAccountInfo(positionPda);
        if (!info) continue;

        const d = info.data;
        let o = 8 + 8 + 32;
        const side = d.readUInt8(o); o += 1;
        const amount = Number(d.readBigUInt64LE(o)) / 1e6; o += 8;
        const claimed = d.readUInt8(o) === 1;

        const won = market.status === 2 && market.winningSide === side;
        const canClaim = won && !claimed;
        const canRefund = market.status === 3 && !claimed;

        // Fetch score for settled/locked markets
        let score = null;
        if (market.status === 2 || market.status === 1) {
          score = await fetchScore(m.fixtureId);
        }

        found.push({
          ...m,
          question: m.question || market.question,
          market,
          side,
          amount,
          claimed,
          won,
          canClaim,
          canRefund,
          status: market.status,
          winningSide: market.winningSide,
          score,
        });
      } catch(e) {}
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
        <div key={i} className={"position-card " + (p.canClaim || p.canRefund ? "can-claim" : "")}>

          {/* Match header with score */}
          <div className="position-match-header">
            <span className="position-match">{p.name}</span>
            {p.score && (
              <span className="position-score">{p.score}</span>
            )}
          </div>

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
    return "9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B";
  }
}
