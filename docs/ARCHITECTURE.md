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
                    │ normalize.js  StatusId map  │
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
              │ My Positions   │   │ void_market (expiry)    │
              └────────────────┘   │ refund  (voided markets)│
                                   └─────────────────────────┘
```

**Zero manual operations.** On startup the backend:
1. Authenticates with TxLINE
2. Fetches all fixtures — creates missing on-chain markets automatically
3. Recovers all unsettled markets directly from Solana chain (survives restarts)
4. Registers every fixture with the keeper bot
5. Connects to TxLINE's live SSE stream
6. Re-checks for new fixtures every hour — any new fixture gets a market within 60 minutes

---

## The Trustless Settlement Flow

This is the heart of the project — the part most submissions fake with a database column.

```
Match ends (TxLINE marks fixture complete)
        │
        ▼
Keeper detects completion via THREE methods:
  1. TxLINE completed fixtures list
  2. Past-kickoff fixtures still in feed
  3. All registered markets 2.5+ hours past kickoff
        │
        ▼
Check on-chain vault balances
        │
        ├─ One side = $0 ──► void_market() → STATUS = VOID
        │                     Users call refund() → stake returned
        │
        ├─ 7 days past kickoff ──► void_market() → emergency exit
        │
        └─ Both sides funded ──►
                │
                ▼
Find last available proof sequence (search up to seq=300)
A 90-minute match generates ~300 sequences (~27s each).
Final score only available at the last sequence.
                │
                ▼
GET /api/scores/stat-validation?fixtureId=…&statKey=1&seq=<last>
        │  returns: summary, subTreeProof, mainTreeProof,
        │           statToProve { key, value, period },
        │           eventStatRoot, statProof
        ▼
txoracle.validateStat(targetTs, fixtureSummary, fixtureProof,
                      mainTreeProof, predicate, statA).simulate()
        │  verified against TxLINE's on-chain
        │  dailyScoresMerkleRoots PDA
        │  Result read from transaction logs:
        │  "Evaluate predicate to: true/false"
        │
        ├─ StatNotZero error (6074) = predicate FALSE → NO wins
        │   (stat proved to be 0, goals > 0 fails)
        │
        └─ true/false from logs = actual result
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

The keeper can only *relay* a proof that already verifies against TxLINE's on-chain Merkle root. It cannot fabricate a result: any observer can re-run the same `validateStat()` simulation and confirm the settlement was honest.

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
| `deposit` | Locks user USDC into chosen side; records position | `MIN $1`, `MAX $10,000`, rejects after kickoff (`KickoffPassed`), same-side only (`SideMismatch`) |
| `lock_market` | Seals the market at kickoff | Authority-gated, kickoff-time checked |
| `settle` | Records the proof-verified winning side permanently | Only from `LOCKED` state, authority-gated |
| `claim` | Pays winner: stake + pro-rata share of losing pot | `SETTLED` only, winning side only, single claim (`AlreadyClaimed`) |
| `void_market` | Cancels market if one side empty OR 7 days past kickoff | `LOCKED` state only, authority-gated |
| `refund` | Returns exact stake to user from a voided market | `VOID` state only, once per user (`AlreadyRefunded`) |

### Account model

- **`Market`** — question, kickoff, stat predicate, YES/NO totals, status (`OPEN → LOCKED → SETTLED/VOID`), winning side, bumps.
- **`Position`** — per-user, per-market stake record: side, amount, claimed flag.
- **Vaults** — two token-account PDAs (`yes_vault`, `no_vault`) with the *market PDA* as authority. **No private key exists for these accounts.**

All PDAs derive from `[seed, fixture_id.to_le_bytes()]` — deterministic, collision-free, auditable.

---
