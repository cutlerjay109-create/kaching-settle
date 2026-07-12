// backend/src/txline/normalize.js
// Cleans raw TxLINE SSE events into simple shapes.
//
// Fixes in this version:
// - Game phase is STICKY per fixture. Missing/unknown StatusId (common on
//   half-time payloads) no longer falls back to "Pre-Match".
// - Phase also detected from Action strings (half_time, match_end, etc.).
// - Once a match is live it can never regress to Pre-Match; once FT, stays FT.
// - Score can never silently reset to 0-0 mid-match (the HT reset artifact).
//   Legit VAR corrections still apply because those events carry goal Actions.
// - Minute is sticky too: a Clock reset to 0 at HT keeps showing 45'.

// Per-fixture state — the single source of truth for stickiness
const fixtureState = {};

function getState(fixtureId) {
  if (!fixtureState[fixtureId]) {
    fixtureState[fixtureId] = {
      homeGoals: 0, awayGoals: 0, minute: 0, period: 0, hasScore: false,
    };
  }
  return fixtureState[fixtureId];
}

// Real StatusId values confirmed from live stream:
// 1 = Pre-Match, 2 = 1st Half, 3 = Half Time, 4 = 2nd Half, 5 = Full Time
function phaseFromStatusId(statusId) {
  if (statusId === 5) return 5; // FT
  if (statusId === 4) return 2; // 2nd Half
  if (statusId === 3) return 3; // HT
  if (statusId === 2) return 1; // 1st Half
  if (statusId === 1) return 0; // Pre-Match
  return null; // unknown / missing
}

function phaseFromAction(action) {
  const a = (action || "").toLowerCase();
  if (!a) return null;
  if (a.includes("match_end") || a.includes("full_time")) return 5;
  if (a.includes("half_time") || a === "ht") return 3;
  if (a.includes("second_half")) return 2;
  return null;
}

function getGamePhase(data) {
  const st = getState(data.FixtureId);

  let phase = phaseFromStatusId(data.StatusId);
  if (phase === null) phase = phaseFromAction(data.Action);
  if (phase === null) phase = st.period; // sticky fallback

  // Never regress: live -> pre-match is always a feed artifact,
  // and full time is terminal.
  if (phase === 0 && st.period > 0) phase = st.period;
  if (st.period === 5) phase = 5;

  st.period = phase;
  return phase;
}

function getMinute(data, phase) {
  const st = getState(data.FixtureId);
  const seconds = data.Clock ? data.Clock.Seconds : undefined;

  let minute = (typeof seconds === "number") ? Math.floor(seconds / 60) : null;

  // Missing clock, or clock reset to 0 mid-match (HT artifact) -> keep last
  if (minute === null || (minute === 0 && st.minute > 0 && phase !== 0)) {
    minute = st.minute;
  }
  // During half time the clock should read 45', not 0'
  if (phase === 3 && minute < 45) minute = 45;
  // Full time: never show less than what we reached
  if (phase === 5 && minute < st.minute) minute = st.minute;

  st.minute = minute;
  return minute;
}

function extractGoals(data) {
  const st = getState(data.FixtureId);

  const hasStats = data.Stats &&
    (data.Stats["1"] !== undefined || data.Stats["2"] !== undefined);

  if (hasStats) {
    const h = data.Stats["1"] ?? 0;
    const a = data.Stats["2"] ?? 0;

    // Goals decreasing is only legitimate on VAR/goal-correction events.
    // Anything else (HT stat reset, feed hiccup) keeps the last known score.
    const isGoalCorrection = /possible|var|goal/i.test(data.Action || "");
    if (st.hasScore && (h < st.homeGoals || a < st.awayGoals) && !isGoalCorrection) {
      return { homeGoals: st.homeGoals, awayGoals: st.awayGoals };
    }

    st.homeGoals = h;
    st.awayGoals = a;
    st.hasScore = true;
    return { homeGoals: h, awayGoals: a };
  }

  // Stats missing entirely (typical HT/status payload) -> last known
  return { homeGoals: st.homeGoals, awayGoals: st.awayGoals };
}

function normalizeFixture(f) {
  const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
  const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
  const homeId = f.Participant1IsHome ? f.Participant1Id : f.Participant2Id;
  const awayId = f.Participant1IsHome ? f.Participant2Id : f.Participant1Id;

  return {
    fixtureId: f.FixtureId,
    competitionId: f.CompetitionId,
    competition: f.Competition,
    home,
    away,
    homeId,
    awayId,
    kickoffMs: f.StartTime,
    kickoffIso: new Date(f.StartTime).toISOString(),
    status: f.FixtureStatus || f.Status || "upcoming",
  };
}

function normalizeScore(data) {
  const fixtureId = data.FixtureId;
  const period = getGamePhase(data);
  const minute = getMinute(data, period);
  const { homeGoals, awayGoals } = extractGoals(data);

  return {
    fixtureId,
    homeGoals,
    awayGoals,
    period,
    minute,
    ts: data.Ts ?? Date.now(),
  };
}

function normalizeEvent(data) {
  const action = data.Action || "";

  // Only show meaningful events -- filter out possession noise
  const meaningfulActions = [
    "goal", "shot", "yellow_card", "red_card", "corner",
    "penalty", "free_kick", "possible", "var", "offside", "substitution"
  ];

  const isMeaningful = meaningfulActions.some(a =>
    action.toLowerCase().includes(a)
  );

  if (!isMeaningful) return null;

  // Detect possible goal
  let type = action;
  if (action === "possible" && data.Data?.Goal === true) {
    type = "possible_goal";
  }
  if (action === "possible" && data.Data?.Goal === false) {
    return null; // goal cancelled -- ignore
  }

  // Detect confirmed shot outcome
  if (action === "shot" && data.Confirmed && data.Data?.Outcome) {
    type = `shot_${data.Data.Outcome.toLowerCase()}`;
  }

  // Skip unconfirmed events
  if (data.Confirmed === false) return null;

  const period = getGamePhase(data);
  const minute = getMinute(data, period);

  return {
    fixtureId: data.FixtureId,
    type,
    team: data.Participant === 1 ? "home" : "away",
    minute,
    period,
    player: data.PlayerName || data.Data?.PlayerName || null,
    data: data.Data || {},
    ts: data.Ts ?? Date.now(),
  };
}

function isFinished(data) {
  return data.StatusId === 5 ||
    data.GameState === "finished" ||
    data.Action === "match_end";
}

module.exports = {
  normalizeFixture,
  normalizeScore,
  normalizeEvent,
  isFinished,
  getGamePhase,
  getMinute,
};
