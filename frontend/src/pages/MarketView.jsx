import React, { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import WalletButton from "../components/WalletButton";
import LiveFeed from "../components/LiveFeed";
import DepositBox from "../components/DepositBox";
import PotMeter from "../components/PotMeter";
import VoicePlayer from "../components/VoicePlayer";
import Receipt from "../components/Receipt";
import { connectSocket } from "../lib/socket";
import { getMarket } from "../lib/solana";

const BACKEND = "https://kaching-settle-production.up.railway.app";

export default function MarketView({ fixtureId, onBack }) {
  const { connected } = useWallet();
  const [fixture, setFixture] = useState(null);
  const [score, setScore] = useState(null);
  const [events, setEvents] = useState([]);
  const [yesPot, setYesPot] = useState(0);
  const [noPot, setNoPot] = useState(0);
  const [settlement, setSettlement] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/fixtures`)
      .then(r => r.json())
      .then(data => {
        const f = data.find(x => x.fixtureId === fixtureId);
        setFixture(f || null);
      });

    // Fetch last known score from TxLINE on page load
    fetch(`${BACKEND}/api/scores/snapshot/${fixtureId}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          const latest = data[data.length - 1];
          setScore({
            fixtureId,
            homeGoals: latest.Participant1Goals ?? latest.HomeGoals ?? 0,
            awayGoals: latest.Participant2Goals ?? latest.AwayGoals ?? 0,
            period: latest.StatusId === 5 ? 5 : latest.StatusId === 4 ? 2 : latest.StatusId === 3 ? 3 : latest.StatusId === 2 ? 1 : 0,
            minute: Math.floor((latest.Clock?.Seconds || 0) / 60),
          });
        }
      }).catch(() => {});

    // Load on-chain market state — works even after page refresh
    getMarket(fixtureId).then(market => {
      if (!market) return;
      setYesPot(market.yesTotal);
      setNoPot(market.noTotal);

      // If already settled — show settlement screen immediately
      if (market.status === 2) {
        setSettlement({
          fixtureId,
          question: market.question,
          winningSide: market.winningSide === 0 ? "YES" : "NO",
          result: market.winningSide === 0,
          proof: { dailyScoresRoot: "verify on Solana Explorer" },
          commentary: market.winningSide === 0
            ? "YES wins — the proof confirmed the result on Solana."
            : "NO wins — the proof confirmed the result on Solana.",
          audioUrl: null,
          settledAt: Date.now(),
        });
      }

      // If voided
      if (market.status === 3) {
        setSettlement({
          fixtureId,
          question: market.question,
          winningSide: "VOID",
          result: null,
          proof: null,
          commentary: "Market voided — one side had no deposits. Refunds available.",
          audioUrl: null,
          settledAt: Date.now(),
          voided: true,
        });
      }
    }).catch(() => {});

    const socket = connectSocket(BACKEND);
    socket.emit("subscribe-market", fixtureId);

    socket.on("score-update", (s) => {
      if (s.fixtureId === fixtureId) setScore(s);
    });

    socket.on("match-event", (e) => {
      if (e.fixtureId === fixtureId) {
        setEvents(prev => [e, ...prev].slice(0, 20));
      }
    });

    socket.on("pundit", (data) => {
      if (data.text) {
        setSettlement(prev => ({
          ...prev,
          liveCommentary: data.text,
          audioUrl: data.audioUrl,
          isLive: true,
        }));
        setTimeout(() => setSettlement(prev => prev && prev.isLive ? null : prev), 15000);
      }
    });
    socket.on("settlement", (s) => {
      if (s.fixtureId === fixtureId) {
        setSettlement(s);
        if (s.audioUrl) setAudioUrl(s.audioUrl);
      }
    });

    return () => socket.disconnect();
  }, [fixtureId]);

  if (!fixture) return <div className="loading">Loading market...</div>;

  return (
    <div className="market-view">
      <button className="back-btn" onClick={onBack}>← Back</button>

      <div className="match-header">
        <h2>{fixture.home} vs {fixture.away}</h2>
        <p className="competition">{fixture.competition}</p>
        <p className="kickoff">{new Date(fixture.kickoffMs).toLocaleString()}</p>
      </div>

      <LiveFeed score={score} events={events} fixture={fixture} />

      {settlement ? (
        <>
          <VoicePlayer audioUrl={audioUrl} commentary={settlement.commentary} />
          <Receipt settlement={settlement} />
        </>
      ) : (
        <>
          <PotMeter yesPot={yesPot} noPot={noPot} />
          {Date.now() > fixture?.kickoffMs ? (
            <div className="match-locked">
              <p>⚽ Match in progress — deposits closed</p>
              <p className="locked-sub">
                Total locked: ${(yesPot + noPot).toFixed(2)} USDC
                — settlement happens automatically when the match ends.
              </p>
            </div>
          ) : connected ? (
            <DepositBox
              fixtureId={fixtureId}
              fixture={fixture}
              onDeposit={(side, amount) => {
                if (side === "YES") setYesPot(p => p + amount);
                else setNoPot(p => p + amount);
                setTimeout(() => {
                  getMarket(fixtureId).then(m => {
                    if (m) { setYesPot(m.yesTotal); setNoPot(m.noTotal); }
                  }).catch(() => {});
                }, 2000);
              }}
            />
          ) : (
            <div className="connect-prompt">
              <p>Connect your wallet to participate</p>
              <WalletButton />
            </div>
          )}
        </>
      )}
    </div>
  );
}
