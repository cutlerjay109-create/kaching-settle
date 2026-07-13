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

---