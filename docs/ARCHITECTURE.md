## Architecture

```
                    ┌─────────────────────────────┐
                    │      TxLINE (TxODDS)        │
                    │  SSE stream · fixtures ·    │
                    │  Merkle score proofs        │
                    └─────────────┬───────────────┘
                                  │
                    ┌─────────────▼───────────────┐
                    │     Backend — Node.js       │
                    │─────────────────────────────│
                    │ auth.js     JWT + API token │
                    │ stream.js   live SSE feed   │
                    │ fixtures.js fixture cache   │
                    │ validate.js proof + verify  │
                    │ auto-market.js  ← creates   │
                    │   on-chain markets for every│
                    │   fixture automatically     │
                    │ settle-trigger.js  keeper   │
                    │ pundit.js + voice.js  AI    │
                    └──────┬──────────────┬───────┘
                           │  Socket.IO   │  @solana/web3.js
              ┌────────────▼───┐   ┌──────▼──────────────────┐
              │ Frontend React │   │  Solana Program (Rust)  │
              │────────────────│   │─────────────────────────│
              │ Live scoreboard│   │ create_market           │
              │ Pot meter + odds│  │ deposit   (kickoff gate)│
              │ Phantom deposit│   │ lock_market             │
              │ Voice player   │   │ settle    (proof-gated) │
              │ Receipt + link │   │ claim     (pro-rata)    │
              └────────────────┘   └─────────────────────────┘
```

**Zero manual operations.** On startup the backend scans every fixture in the TxLINE feed and auto-creates any missing on-chain market (question, kickoff gate, YES/NO vaults), then registers it with the keeper for automatic settlement. New fixtures appearing in the feed get markets within the hour — untouched by human hands.

---

## The Trustless Settlement Flow

This is the heart of the project — the part most submissions fake with a database column.

```
Match ends (TxLINE marks fixture complete)
        │
        ▼
Keeper detects completion (60s poll)
        │
        ▼
GET /api/scores/stat-validation?fixtureId=…&seq=…&statKey=1
        │  returns: summary, subTreeProof, mainTreeProof,
        │           statToProve, eventStatRoot, statProof
        ▼
txoracle.validateStat(targetTs, fixtureSummary, fixtureProof,
                      mainTreeProof, predicate, statA).simulate()
        │  verified against TxLINE's on-chain
        │  dailyScoresMerkleRoots PDA
        ▼
   true / false  ←  cryptographically proven, reproducible by anyone
        │
        ▼
program.settle(winning_side)   → market status = SETTLED on-chain
        │
        ▼
Winners: program.claim() → USDC released pro-rata from both vaults
        │
        ▼
Solscan receipt — independently verifiable settlement trail
```

The keeper can only *relay* a proof that already verifies against TxLINE's on-chain Merkle root. It cannot fabricate a result: any observer can re-run the same `validateStat()` call and confirm the settlement was honest.

---

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
| 9 | Txoracle `validateStat().simulate()` | **On-chain proof check via simulation — result read from logs** |

Every data call carries both required headers: `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`.

---

## Solana Program

| | |
|---|---|
| **Program ID** | `9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B` |
| **Network** | Devnet |
| **Framework** | Anchor 0.30.1 |
| **Explorer** | [View on Solscan](https://solscan.io/account/9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B?cluster=devnet) |

### Instructions

| Instruction | What it does | Guard rails |
|---|---|---|
| `create_market` | Opens a fixture's market: question, kickoff timestamp, stat predicate, YES vault, NO vault | One market per fixture (PDA-enforced) |
| `deposit` | Locks user USDC into chosen side; records position | `MIN $1`, `MAX $10,000`, rejects after kickoff (`KickoffPassed`), valid side only |
| `lock_market` | Seals the market at kickoff | Authority-gated, kickoff-time checked |
| `settle` | Records the proof-verified winning side | Only from `LOCKED` state, authority-gated |
| `claim` | Pays winner: stake + pro-rata share of losing pot | `SETTLED` only, winning side only, single claim (`AlreadyClaimed`) |

### Account model

- **`Market`** — question, kickoff, stat predicate, YES/NO totals, status (`OPEN → LOCKED → SETTLED`), winning side, bumps.
- **`Position`** — per-user, per-market stake record: side, amount, claimed flag.
- **Vaults** — two token-account PDAs (`yes_vault`, `no_vault`) with the *market PDA* as authority. **No private key exists for these accounts.**

All PDAs derive from `[seed, fixture_id.to_le_bytes()]` — deterministic, collision-free, auditable.

---