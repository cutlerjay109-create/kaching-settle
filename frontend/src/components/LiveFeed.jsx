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
            <span className="event-minute">{e.minute}'</span>
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
  if (period === 1 && minute > 45) return "45+" + (minute - 45) + "'";
  if (period === 2 && minute > 90) return "90+" + (minute - 90) + "'";
  return minute + "'";
}

function getEventIcon(type) {
  if (!type) return "•";
  const t = type.toLowerCase();
  if (t.includes("goal") || t === "possible_goal") return "⚽";
  if (t.includes("yellow")) return "🟨";
  if (t.includes("red")) return "🟥";
  if (t.includes("corner")) return "🚩";
  if (t.includes("shot_ontarget")) return "🎯";
  if (t.includes("shot_offtarget")) return "↗";
  if (t.includes("shot_blocked")) return "🛡";
  if (t.includes("penalty")) return "🎯";
  if (t.includes("sub")) return "🔄";
  if (t.includes("free_kick")) return "🦶";
  if (t.includes("throw_in")) return "↪";
  if (t.includes("goal_kick")) return "🥅";
  if (t.includes("offside")) return "🚫";
  if (t.includes("var")) return "📺";
  return "•";
}

function getEventLabel(type, team, fixture) {
  if (!type) return type;
  const teamName = team === "home" ? fixture?.home : fixture?.away;
  const t = type.toLowerCase();

  if (t === "possible_goal" || t === "possible") return "🚨 Possible Goal! — " + teamName;
  if (t.includes("shot_ontarget")) return "Shot on Target — " + teamName;
  if (t.includes("shot_offtarget")) return "Shot Off Target — " + teamName;
  if (t.includes("shot_blocked")) return "Shot Blocked — " + teamName;
  if (t === "corner") return "Corner — " + teamName;
  if (t === "free_kick") return "Free Kick — " + teamName;
  if (t === "throw_in") return "Throw In — " + teamName;
  if (t === "goal_kick") return "Goal Kick — " + teamName;
  if (t === "offside") return "Offside — " + teamName;
  if (t === "penalty") return "Penalty! — " + teamName;
  if (t === "yellow_card") return "Yellow Card — " + teamName;
  if (t === "red_card") return "Red Card — " + teamName;
  return type + " — " + teamName;
}
