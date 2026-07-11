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
          <span className="minute">
            {score?.minute ? formatMinute(score.minute, score?.period) : ""}
          </span>
        </div>
        <div className="team away">
          <span className="goals">{score?.awayGoals ?? 0}</span>
          <span className="team-name">{fixture?.away}</span>
        </div>
      </div>

      <div className="events-feed">
        {events.filter(e => e && e.type).map((e, i) => (
          <div key={i} className={"event event-" + (e.type || "").toLowerCase()}>
            <span className="event-minute">{formatMinute(e.minute, e.period)}</span>
            <span className="event-type">
              {getEventIcon(e.type)} {getEventLabel(e.type, e.team, fixture)}
            </span>
            {e.player && <span className="event-player">{e.player}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function getPeriodLabel(period) {
  if (!period && period !== 0) return "Pre-Match";
  if (period === 0) return "Pre-Match";
  if (period === 1) return "1H";
  if (period === 2) return "2H";
  if (period === 3) return "HT";
  if (period === 4) return "ET";
  if (period === 5) return "FT";
  if (period === 6) return "AET";
  if (period === 7) return "Pen";
  return "Live";
}

function formatMinute(minute, period) {
  if (!minute) return "";
  // First half stoppage time
  if (period === 1 && minute > 45) return "45+" + (minute - 45) + "'";
  // Second half — always shows real minute (46, 47... 90)
  // Only shows stoppage format after 90
  if (period === 2 && minute > 90) return "90+" + (minute - 90) + "'";
  // Normal minute
  return minute + "'";
}

function getEventIcon(type) {
  if (!type) return "•";
  const t = type.toLowerCase();
  if (t === "goal") return "⚽";
  if (t === "possible_goal") return "🚨";
  if (t.includes("yellow")) return "🟨";
  if (t.includes("red")) return "🟥";
  if (t === "corner") return "🚩";
  if (t === "shot_ontarget") return "🎯";
  if (t === "shot_offtarget") return "↗";
  if (t === "shot_blocked") return "🛡";
  if (t === "penalty") return "⚡";
  if (t === "substitution") return "🔄";
  if (t === "free_kick") return "🦶";
  if (t === "var") return "📺";
  if (t === "offside") return "🚫";
  return "•";
}

function getEventLabel(type, team, fixture) {
  if (!type) return "";
  const teamName = team === "home" ? fixture?.home : fixture?.away;
  const t = type.toLowerCase();
  if (t === "goal") return "GOAL! — " + teamName;
  if (t === "possible_goal") return "Possible Goal — " + teamName;
  if (t === "shot_ontarget") return "Shot on Target — " + teamName;
  if (t === "shot_offtarget") return "Shot Off Target — " + teamName;
  if (t === "shot_blocked") return "Shot Blocked — " + teamName;
  if (t === "corner") return "Corner — " + teamName;
  if (t === "free_kick") return "Free Kick — " + teamName;
  if (t === "yellow_card") return "Yellow Card — " + teamName;
  if (t === "red_card") return "Red Card — " + teamName;
  if (t === "penalty") return "Penalty! — " + teamName;
  if (t === "substitution") return "Substitution — " + teamName;
  if (t === "var") return "VAR Review — " + teamName;
  if (t === "offside") return "Offside — " + teamName;
  return type + " — " + teamName;
}
