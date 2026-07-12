## TxLINE Endpoints Used

| # | Endpoint | Purpose |
|---|----------|---------|
| 1 | `POST /auth/guest/start` | Obtain guest JWT |
| 2 | Txoracle `subscribe(serviceLevelId, weeks)` | On-chain subscription (free World Cup tier) |
| 3 | `POST /api/token/activate` | Activate API token — signed `txSig:leagues:jwt` |
| 4 | `GET /api/fixtures/snapshot` | Full fixture list (World Cup + friendlies) |
| 5 | `GET /api/scores/stream` (SSE) | Real-time scores, goals, match events |
| 6 | `GET /api/scores/snapshot/:fixtureId` | Point-in-time score state |
| 7 | `GET /api/scores/updates/:fixtureId` | Historical score updates |
| 8 | `GET /api/scores/stat-validation` | **Merkle proof package for on-chain verification** |
| 9 | Txoracle `validateStat().simulate()` | **On-chain proof check via simulation — result read from transaction logs** |

Every data call carries both required headers: `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`.

**Key discoveries from live integration:**
- `validateStat()` does **not** support `.view()` — use `.simulate()` and parse `"Evaluate predicate to: true/false"` from transaction logs
- The `dailyScoresMerkleRoots` PDA address cannot be derived off-chain — pass a dummy PDA to trigger a `ConstraintSeeds` error, then extract the correct address from the program's error logs (`"Right: <address>"`)
- Proof sequences go up to ~300 per match (~27s each) — always fetch the **last** available seq for full-time data. `seq=1` returns early-match data where score is still 0-0
- `statKey=1` = Participant1 goals, `statKey=7` = Participant2 goals (confirmed from live match data)
- `GameState` is always `"scheduled"` even during live play — derive match phase from `StatusId` (2=1H, 3=HT, 4=2H, 5=FT)

---
