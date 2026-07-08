// backend/src/txline/normalize.js
// Cleans raw TxLINE fixture/score objects into simple shapes
// the rest of the app uses. One place to adapt if TxLINE schema changes.

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

function normalizeScore(s) {
  return {
    fixtureId: s.FixtureId,
    homeGoals: s.Participant1Goals ?? s.HomeGoals ?? 0,
    awayGoals: s.Participant2Goals ?? s.AwayGoals ?? 0,
    period: s.Period ?? s.GamePhase ?? 0,
    minute: s.Minute ?? 0,
    ts: s.Ts ?? Date.now(),
  };
}

function normalizeEvent(e) {
  return {
    fixtureId: e.FixtureId,
    type: e.EventType || e.Type,
    team: e.ParticipantId,
    minute: e.Minute ?? 0,
    player: e.PlayerName || e.Player || null,
    ts: e.Ts ?? Date.now(),
  };
}

module.exports = { normalizeFixture, normalizeScore, normalizeEvent };
