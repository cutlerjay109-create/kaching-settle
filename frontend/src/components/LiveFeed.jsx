import React from "react";

export default function LiveFeed({ score, events, fixture }) {
  return (
    <div className="live-feed">
      <div className="scoreboard">
        <div className="team home">
          <span className="team-name">{fixture?.home}</span>
          <span className="goals">{score?.homeGoals ?? 0}</span>
        </div>
        <div className="score-divider">
          <span className="period">{getPeriodLabel(score?.period)}</span>
          <span className="minute">{score?.minute ? `${score.minute}'` : ""}</span>
        </div>
        <div className="team away">
          <span className="goals">{score?.awayGoals ?? 0}</span>
          <span className="team-name">{fixture?.away}</span>
        </div>
      </div>

      <div className="events-feed">
        {events.map((e, i) => (
          <div key={i} className={`event event-${e.type?.toLowerCase()}`}>
            <span className="event-minute">{e.minute}'</span>
            <span className="event-type">{getEventIcon(e.type)} {e.type}</span>
            {e.player && <span className="event-player">{e.player}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function getPeriodLabel(period) {
  if (!period) return "Pre-Match";
  if (period === 1) return "1st Half";
  if (period === 2) return "2nd Half";
  if (period === 3) return "HT";
  if (period === 5) return "FT";
  return "Live";
}

function getEventIcon(type) {
  if (!type) return "";
  const t = type.toLowerCase();
  if (t.includes("goal")) return "⚽";
  if (t.includes("yellow")) return "🟨";
  if (t.includes("red")) return "🟥";
  if (t.includes("sub")) return "🔄";
  return "•";
}
