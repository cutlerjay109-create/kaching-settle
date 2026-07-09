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
          <span className="minute">{score?.minute ? formatMinute(score.minute, score?.period) : ""}</span>
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
  if (period === 4) return "Extra Time";
  if (period === 5) return "FT";
  if (period === 6) return "AET";
  if (period === 7) return "Penalties";
  return "Live";
}

function formatMinute(minute, period) {
  if (!minute) return "";
  // Handle stoppage time in first half
  if (period === 1 && minute > 45) {
    return `45+${minute - 45}'`;
  }
  // Handle stoppage time in second half
  if (period === 2 && minute > 90) {
    return `90+${minute - 90}'`;
  }
  return `${minute}'`;
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
