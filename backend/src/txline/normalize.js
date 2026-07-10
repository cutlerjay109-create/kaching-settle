// backend/src/txline/normalize.js
// Cleans raw TxLINE SSE events into simple shapes.
// Based on real live match data analysis.

function getGamePhase(data) {
  // StatusId: 2 = live, 3 = halftime, 5 = finished
  // GameState: "scheduled" even during live play -- ignore it
  const statusId = data.StatusId;
  const seconds = data.Clock?.Seconds || 0;

  if (statusId === 5) return 5; // FT
  if (statusId === 3) return 3; // HT
  if (statusId === 2) {
    // Determine half from clock seconds
    // First half: 0-2700s (45 min), Second half: 2700s+
    if (seconds <= 2700) return 1; // 1st Half
    return 2; // 2nd Half
  }
  return 0; // Pre-Match
}

function getMinute(data) {
  const seconds = data.Clock?.Seconds || 0;
  if (!seconds) return 0;
  return Math.floor(seconds / 60);
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
  // Stats object: key "1" = home goals, key "2" = away goals
  const stats = data.Stats || {};
  const homeGoals = stats["1"] ?? 0;
  const awayGoals = stats["2"] ?? 0;
  const period = getGamePhase(data);
  const minute = getMinute(data);

  return {
    fixtureId: data.FixtureId,
    homeGoals,
    awayGoals,
    period,
    minute,
    ts: data.Ts ?? Date.now(),
  };
}

function normalizeEvent(data) {
  const action = data.Action || "";
  const minute = getMinute(data);

  // Only show meaningful events -- filter out possession noise
  const meaningfulActions = [
    "goal", "shot", "yellow_card", "red_card", "corner",
    "penalty", "free_kick", "throw_in", "goal_kick",
    "possible", "var", "offside", "substitution"
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

  return {
    fixtureId: data.FixtureId,
    type,
    team: data.Participant === 1 ? "home" : "away",
    minute,
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
