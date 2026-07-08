import React, { useEffect, useState } from "react";

const BACKEND = "http://localhost:3001";

export default function MarketList({ onSelect }) {
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND}/api/fixtures`)
      .then(r => r.json())
      .then(data => { setFixtures(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading matches...</div>;

  return (
    <div className="market-list">
      <h2>Open Markets</h2>
      {fixtures.length === 0 && (
        <p className="empty">No fixtures available right now.</p>
      )}
      {fixtures.map(f => (
        <div
          key={f.fixtureId}
          className="fixture-card"
          onClick={() => onSelect(f.fixtureId)}
        >
          <div className="fixture-teams">
            {f.home} <span className="vs">vs</span> {f.away}
          </div>
          <div className="fixture-meta">
            <span className="competition">{f.competition}</span>
            <span className="kickoff">
              {new Date(f.kickoffMs).toLocaleString()}
            </span>
          </div>
          <div className="fixture-cta">Bet trustlessly →</div>
        </div>
      ))}
    </div>
  );
}
