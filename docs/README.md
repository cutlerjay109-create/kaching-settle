<div align="center">

# ⚡ Kaching Settle

### Trustless Match Markets — The Proof Pays You

**A YES/NO prediction market for the FIFA World Cup 2026 where TxLINE's cryptographic match proof — not a company's server — releases your winnings automatically on Solana.**

[![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF?logo=solana)](https://solscan.io/account/9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B?cluster=devnet)
[![TxLINE](https://img.shields.io/badge/Data-TxLINE%20by%20TxODDS-00D18F)](https://txline.txodds.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.30.1-blue)](https://www.anchor-lang.com/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

[Live App](https://kaching-settle-ten.vercel.app) · [Demo Video](https://youtu.be/Qfw7jJF_wmk?si=cFiNl_-zDPZVKXL6) · [Program on Solscan](https://solscan.io/account/9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B?cluster=devnet)

</div>

---

## Table of Contents

1. [The Problem](#the-problem)
2. [The Solution](#the-solution)
3. [How It Works — User Journey](#how-it-works--user-journey)
4. [Architecture](#architecture)
5. [The Trustless Settlement Flow](#the-trustless-settlement-flow)
6. [TxLINE Endpoints Used](#txline-endpoints-used)
7. [Solana Program](#solana-program)
8. [On-Chain Data — Raw and Decoded](#on-chain-data--raw-and-decoded)
9. [Payout Mathematics](#payout-mathematics)
10. [Tech Stack](#tech-stack)
11. [Running Locally](#running-locally)
12. [Project Structure](#project-structure)
13. [TxLINE API Feedback](#txline-api-feedback)
14. [Security Model](#security-model)
15. [What Makes This Different](#what-makes-this-different)

---

## The Problem

Every online prediction platform has the same weak point: **a company holds the money and decides who won.**

Their server resolves the market. Their database says who gets paid. Their admin keys control the funds. Users are asked to simply trust that the operator won't cheat, freeze withdrawals, or quietly "adjust" an outcome. In sports betting, that trust is routinely abused.

The blockchain was supposed to fix this — yet most "Web3" prediction apps still resolve outcomes on a private backend and merely *record* the result on-chain. The trust problem never left. It just got a crypto logo.

## The Solution

**Kaching Settle removes the human from the money entirely.**

- User funds are locked in a **keyless Program Derived Address (PDA)** — a vault with *no private key in existence*. Not even we can touch it.
- Match outcomes are confirmed by **TxLINE's cryptographic Merkle proofs**, anchored on Solana and verifiable by anyone.
- The Solana program releases funds **only** when the verified result says so. The proof pays you — not us.
- Every payout produces an **on-chain receipt** any judge, auditor, or user can independently verify on Solana Explorer.

One sentence: *we built the part everyone else fakes.*

---

## How It Works — User Journey

```
 BEFORE KICKOFF          DURING MATCH             AFTER FULL TIME
┌────────────────┐     ┌────────────────┐      ┌──────────────────┐
│ Connect wallet │     │ Live scoreboard│      │ Proof fetched    │
│ Pick YES / NO  │ ──► │ via TxLINE SSE │ ──►  │ validateStat()   │
│ Lock USDC in   │     │ AI pundit voice│      │ settle() on-chain│
│ on-chain vault │     │ Deposits sealed│      │ Winners claim    │
└────────────────┘     └────────────────┘      └──────────────────┘
```

**1 — Predict.** Connect Phantom, choose a real World Cup fixture (e.g. *"Will France score against Spain?"*), pick **YES** or **NO**, lock USDC. Minimum stake $1. One wallet, one side per market — a second deposit on the opposing side is rejected on-chain (`SideMismatch`).

**2 — Kickoff seals the vault.** The Solana program compares the on-chain clock to the fixture's kickoff timestamp. The instant kickoff passes, every deposit attempt is rejected at the program level — `KickoffPassed`. No server involved.

**3 — Watch live.** Scores, goals, cards, and stoppage time stream in real time from TxLINE's SSE feed. The scoreboard shows correct period labels (1st Half → 45+2' → HT → 2nd Half → 90+3' → FT). An AI pundit (Groq) generates broadcast-style commentary, voiced by ElevenLabs.

**4 — The proof settles it.** When the fixture completes, our keeper detects it via three independent methods, fetches TxLINE's Merkle proof at the final sequence, and verifies it against TxLINE's on-chain `daily_scores_merkle_roots` PDA via `validateStat()`. The verified boolean — not an admin — determines the winning side, recorded on-chain by `settle()`.

**5 — Winners claim.** Each winner clicks **Claim** once from the market view or the **My Positions** tab. The program computes their proportional share and transfers USDC straight to their wallet, with a Solscan receipt proving exactly why.

**6 — History persists forever.** The My Positions tab reads directly from Solana — not our server. Every bet a user ever placed is visible and claimable days, weeks, or months later, even after the fixture disappears from TxLINE's feed.

---

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
                    │ auth.js       JWT + API token│
                    │ stream.js     live SSE feed  │
                    │ fixtures.js   fixture cache  │
                    │ normalize.js  StatusId map   │
                    │ validate.js   proof + verify │
                    │ auto-market.js ← creates     │
                    │   on-chain markets for every │
                    │   fixture automatically      │
                    │ settle-trigger.js  keeper    │
                    │ pundit.js + voice.js  AI     │
                    └──────┬──────────────┬────────┘
                           │  Socket.IO   │  @solana/web3.js
              ┌────────────▼───┐   ┌──────▼──────────────────┐
              │ Frontend React │   │  Solana Program (Rust)  │
              │────────────────│   │─────────────────────────│
              │ Live scoreboard│   │ create_market           │
              │ Pot meter + odds│  │ deposit (kickoff gate)  │
              │ Phantom deposit│   │ lock_market             │
              │ Voice player   │   │ settle  (proof-gated)   │
              │ Receipt + link │   │ claim   (pro-rata)      │
              │ My Positions   │   │ void_market (expiry)    │
              └────────────────┘   │ refund  (voided markets)│
                                   └─────────────────────────┘
```

**Zero manual operations.** On startup the backend:
1. Authenticates with TxLINE
2. Fetches all fixtures — creates missing on-chain markets automatically
3. Registers every fixture with the keeper bot
4. Connects to TxLINE's live SSE stream
5. Re-checks for new fixtures every hour — any new fixture gets a market within 60 minutes

---

## The Trustless Settlement Flow

This is the heart of the project — the part most submissions fake with a database column.

```
Match ends (TxLINE marks fixture complete)
        │
        ▼
Keeper detects completion via TWO layers:

  LAYER 1 — Instant (SSE stream):
  TxLINE sends StatusId=5 (FT) → onMatchFinished fires
  → keeper.checkAndSettle() runs immediately
  → Settlement within seconds of final whistle

  LAYER 2 — 2.5h Fallback (safety net):
  Every 60s, keeper checks if any market is 2.5h past kickoff
  Catches anything Layer 1 missed (stream drops, restarts)
  Also checks: TxLINE completed list · past-kickoff fixtures
        │
        ▼
Check on-chain vault balances
        │
        ├─ One side = $0 ──► void_market() → STATUS = VOID
        │                     Users call refund() → stake returned
        │
        ├─ 7 days past kickoff, no proof ──► void_market() → STATUS = VOID
        │                                    Emergency exit, funds never stuck
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
        │  ["daily_scores_merkle_roots", epochDay] PDA
        │  Result read from transaction logs:
        │  "Evaluate predicate to: true/false"
        ▼
   true / false  ←  cryptographically proven, reproducible by anyone
        │
        ├─ false + StatNotZero error (6074) = predicate evaluated FALSE
        │   (stat proved to be 0, goals > 0 fails) → NO wins
        │
        └─ true = predicate evaluated TRUE → YES wins
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
| 9 | Txoracle `validateStat().simulate()` | **On-chain proof check via simulation — result read from transaction logs** |

Every data call carries both required headers: `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`.

**TxLINE SSE schema confirmed from live match data:**
- `StatusId` — `2` = 1st Half, `3` = HT, `4` = 2nd Half, `5` = FT (`GameState` is always `"scheduled"` even during live play — ignore it)
- `Clock.Seconds / 60` = match minute
- `Stats["1"]` = home goals, `Stats["2"]` = away goals
- `Action` field = match events (`goal`, `shot`, `corner`, `possible`, etc.)
- `statKey=1` = Participant1 goals (confirmed from live match data at seq=300)
- `statKey=7` = Participant2 goals (confirmed from live match data at seq=300)
- Proof sequences go up to ~300 per match — always fetch the last seq for full-time data

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

### Error Codes

| Code | Name | Meaning |
|---|---|---|
| 6000 | `MarketNotOpen` | Deposits only accepted when OPEN |
| 6001 | `MarketNotLocked` | Settlement requires LOCKED state |
| 6002 | `MarketNotSettled` | Claims require SETTLED state |
| 6003 | `BelowMinimumStake` | Minimum deposit is $1 USDC |
| 6004 | `AboveMaximumStake` | Maximum deposit is $10,000 USDC |
| 6005 | `KickoffNotReached` | Cannot lock before kickoff time |
| 6006 | `KickoffPassed` | Cannot deposit after kickoff |
| 6007 | `InvalidSide` | Side must be 0 (YES) or 1 (NO) |
| 6008 | `AlreadyClaimed` | Position already claimed |
| 6009 | `WrongSide` | Losing side cannot claim |
| 6010 | `NothingToClaim` | No funds in vault |
| 6011 | `Unauthorized` | Only keeper wallet can settle |
| 6012 | `CannotVoid` | Both sides funded and not expired |
| 6013 | `MarketNotVoid` | Refund requires VOID state |
| 6014 | `AlreadyRefunded` | Refund already processed |
| 6015 | `SideMismatch` | Wallet already has position on the other side |
| 6016 | `MarketExpired` | Market past 7-day expiry window |

### Account Model

- **`Market`** — question, kickoff, stat predicate, YES/NO totals, status (`OPEN → LOCKED → SETTLED/VOID`), winning side, bumps.
- **`Position`** — per-user, per-market stake record: side, amount, claimed flag.
- **Vaults** — two token-account PDAs (`yes_vault`, `no_vault`) with the *market PDA* as authority. **No private key exists for these accounts.**

All PDAs derive from `[seed, fixture_id.to_le_bytes()]` — deterministic, collision-free, auditable.

---

## On-Chain Data — Raw and Decoded

Every market's complete state lives as raw bytes on Solana. Anyone can read and decode it independently — no API, no server, no trust required.

### Decode a market yourself

```bash
# By fixture ID (fetches from chain)
node scripts/decode-market.js 18213979

# By raw base64 account data
node scripts/decode-market.js <base64data>
```

### France vs Spain — Open market (pre-match)

**Raw account data (base64):**
```
277VNwDjxppuRhYBAAAAACcAAABXaWxsIEZyYW5jZSBzY29yZSBhIGdvYWwgYWdhaW5zdCBTcGFpbj8w
h1ZqAAAAAAEAAAAAAAAAAAAAAAAACT0AAAAAAEBCDwAAAAAAAP/1qsS+5oJnOSMsHOnOvBzWxaREGDTH
Q9I915fru/cddf///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
```

**Decoded:**
```
Fixture ID:    18237038
Question:      Will France score a goal against Spain?
Kickoff:       2026-07-14 19:00:00 UTC
Stat Key:      1 (Participant1 goals)
Comparison:    greaterThan
YES Total:     $4.00 USDC  →  1.25x if right
NO Total:      $1.00 USDC  →  5.00x if right
Status:        OPEN — accepting deposits until kickoff
Winning Side:  Not yet decided
```

### France vs Spain — Settled market ✅

**Raw account data (base64):**
```
277VNwDjxppuRhYBAAAAACcAAABXaWxsIEZyYW5jZSBzY29yZSBhIGdvYWwgYWdhaW5zdCBTcGFpbj8w
h1ZqAAAAAAEAAAAAAAAAAAAAAACAjVsAAAAAAEBCDwAAAAAAAgH1qsS+5oJnOSMsHOnOvBzWxaREGDTH
Q9I915fru/cddf///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
```

**Decoded:**
```
Fixture ID:    18237038
Question:      Will France score a goal against Spain?
Kickoff:       2026-07-14 19:00:00 UTC
Stat Key:      1 (Participant1 goals)
Comparison:    greaterThan 0
YES Total:     $6.00 USDC  →  1.17x
NO Total:      $1.00 USDC  →  7.00x
Status:        SETTLED ✅
Winning Side:  NO — France scored 0 goals (Spain won 2-0)
               NO bettor collects full $7.00 pot (7x return)
```

*Settled automatically by TxLINE Merkle proof — no human intervention.*

### What changes at settlement

Two bytes flip on-chain when the keeper calls `settle()`:

- `Status` → `0x00` (OPEN) or `0x01` (LOCKED) becomes `0x02` (SETTLED)
- `WinningSide` → `0xFF` (not set) becomes `0x00` (YES) or `0x01` (NO)

Everything else — the question, vault totals, kickoff time — is preserved on-chain permanently and is readable by anyone forever.

---

## Payout Mathematics

Simple, deterministic, and impossible to manipulate:

```
payout = your_stake + (your_stake / winning_side_total) × losing_side_total
```

**Worked example — the underdog reward:**

| Side | Staked | Result |
|------|--------|--------|
| YES (crowd) | $10.00 | wins → each YES dollar earns $0.10 profit (1.1×) |
| NO (underdog) | $1.00 | wins → the $1 collects the whole $10 pot (11×) |

The pool ratio *is* the odds. Nobody sets them, nobody can skew them, and the smaller side is automatically paid more for taking the harder call — visible live in the app's pot meter.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart contract | Rust · Anchor 0.30.1 · Solana devnet |
| Oracle / data | **TxLINE by TxODDS** — SSE stream + Merkle score proofs |
| Backend | Node.js · Express · Socket.IO · @solana/web3.js |
| AI commentary | Groq (`llama-3.1-8b-instant`) text · ElevenLabs TTS voice |
| Frontend | React 18 · Vite · Phantom Wallet Adapter |
| Settlement asset | USDC (SPL token) |
| Hosting | Railway (backend) · Vercel (frontend) |

---

## Running Locally

### Prerequisites
- Node.js 18+
- Phantom wallet set to **Devnet**
- Devnet SOL — [faucet.solana.com](https://faucet.solana.com)
- Devnet USDC — [faucet.circle.com](https://faucet.circle.com)

### Setup

```bash
git clone https://github.com/cutlerjay109-create/kaching-settle.git
cd kaching-settle

# 1 — Backend
cd backend
cp .env.example .env        # fill in your keys
npm install
node src/server.js          # auto-creates markets, starts keeper + stream

# 2 — Frontend (second terminal)
cd frontend
npm install
npm run dev                 # open http://localhost:5173
```

### Environment variables (`backend/.env`)

```ini
WALLET_KEYPAIR=       # base58 private key — keeper wallet (devnet SOL required)
AUTHORITY_KEYPAIRS=   # optional: comma-separated base58 keys for markets created
                      # by other wallets (e.g. Phantom). Keeper picks the right
                      # key per market automatically.
GROQ_API_KEY=         # console.groq.com
ELEVENLABS_API_KEY=   # elevenlabs.io
ELEVENLABS_VOICE_ID=  # your chosen voice
TXLINE_API_TOKEN=     # produced by: node scripts/subscribe.js (free tier)
```

### Scripts

| Script | Purpose |
|---|---|
| `scripts/subscribe.js` | One-time TxLINE on-chain subscription + token activation |
| `scripts/deposit.js` | Terminal deposit onto one side of a market |
| `scripts/create-market.js` | Manual market creation (auto-market normally handles this) |
| `scripts/manual-settle.js` | Emergency manual settlement for completed fixtures |
| `scripts/decode-market.js` | Decode raw on-chain market account data by fixture ID or base64 |
| `scripts/extend-program.js` | Extend program account size before redeployment |
| `scripts/seed-all-markets.js` | Seed markets manually — **requires two separate wallets** due to on-chain `SideMismatch` protection |

---

## Project Structure

```
kaching-settle/
├── program/programs/kaching-settle/   # Anchor program (Rust)
│   └── src/
│       ├── lib.rs                     # 7 instructions
│       ├── instructions/              # create_market · deposit · lock · settle · claim · void · refund
│       ├── state/                     # Market · Position accounts
│       ├── constants.rs               # seeds, stake limits, statuses
│       └── errors.rs                  # 17 explicit error codes
├── backend/src/
│   ├── txline/                        # auth · stream · fixtures · normalize · validate
│   ├── keeper/                        # auto-market · settle-trigger
│   ├── ai/                            # pundit (Groq) · voice (ElevenLabs)
│   ├── program/                       # Solana client
│   └── server.js                      # Express + Socket.IO entry
├── frontend/src/
│   ├── pages/                         # MarketList · MarketView · MyPositions
│   ├── components/                    # DepositBox · PotMeter · LiveFeed · Receipt · VoicePlayer · WalletButton
│   └── lib/                           # solana.js (raw web3, no IDL parsing) · socket.js · idl.json
├── shared/                            # single source of config + constants
├── scripts/                           # subscribe · deposit · settle · decode · extend · seed
└── docs/                              # ENDPOINTS · ARCHITECTURE · FEEDBACK
```

---

## TxLINE API Feedback

**What we loved**

- **One normalized schema** across every competition — zero per-league mapping. Friendlies and World Cup fixtures parse identically.
- **The SSE stream is rock solid.** Hours of continuous connection during development, zero unexplained drops.
- **The proof package is elegant.** `summary + subTreeProof + mainTreeProof + statToProve` maps 1:1 onto `validateStat`'s arguments — once understood, integration was clean.
- **Free World Cup tier with no rate limits** — genuinely generous for a hackathon and it never throttled us once.

**Where we hit friction**

1. **`validateStat` does not support `.view()`.** Calling `.view()` throws "Method does not support views". The correct approach is `.simulate()` followed by parsing `"Evaluate predicate to: true/false"` from the transaction logs. The keeper-attested pattern works well once understood — a note in the docs would save teams hours of debugging.

2. **`dailyScoresMerkleRoots` PDA cannot be derived off-chain.** The program derives this account from an opaque seed we could not reproduce. Our solution: pass a dummy PDA to intentionally trigger a `ConstraintSeeds` error, then extract the correct address from the program's own error logs (`"Right: <address>"`). This self-correcting approach works reliably but a simple helper function or documented seed would be cleaner.

3. **Proof sequences go up to 300+.** A 90-minute match generates approximately 300 proof sequences (~27 seconds each). Fetching `seq=1` returns early-match data where the score is still 0-0. Always fetch the last available sequence for full-time results. This cost us two incorrect settlements before we discovered it.

4. **Devnet fixtures ≠ mainnet fixtures.** Devnet carries friendlies only; World Cup data is mainnet-side. We ended up with a split topology (mainnet TxLINE host + devnet Solana program) that the docs don't explicitly bless.

5. **Activation message format** (`txSig:leagues:jwt`, base64 signature) took trial and error — one concrete worked example in the quickstart would remove all guesswork.

6. **Soccer `statKey` codes are undocumented.** We confirmed from live match data: `statKey=1` = Participant1 goals, `statKey=7` = Participant2 goals. A stat-key table per sport would be a five-minute doc fix that saves hours.

7. **Token-2022 gotcha:** the TxL mint uses Token-2022, so ATA derivation with the classic token program fails silently in subscribe. Worth a call-out box in the docs.

8. **`GameState` is always `"scheduled"` even during live play.** Real match phase must be derived from `StatusId` (2=1H, 3=HT, 4=2H, 5=FT) — not the misleading `GameState` field.

---

## Security Model

| Threat | Mitigation |
|---|---|
| Operator steals funds | Impossible — vaults are keyless PDAs; only program code moves funds |
| Operator fakes a result | Keeper can only relay proofs that verify against TxLINE's on-chain Merkle root; anyone can re-verify |
| Deposit after kickoff | Rejected by on-chain clock check — `KickoffPassed` |
| Betting both sides from one wallet | Rejected on-chain — `SideMismatch` (6015) |
| Double claim | `Position.claimed` flag enforced on-chain — `AlreadyClaimed` |
| Wrong-side claim | `WrongSide` check against on-chain `winning_side` |
| Dust / griefing | $1 minimum stake enforced in-program — `BelowMinimumStake` |
| Funds permanently stuck | 7-day market expiry — `void_market` releases all funds after deadline |
| One-sided market stuck | `void_market` triggered automatically if either vault is $0 at match end |

**Known limitation (disclosed):** settlement is *keeper-attested* — the keeper triggers `settle` after off-chain `validateStat` simulation, because TxLINE's validator does not support view calls. The proof trail remains fully verifiable by third parties; a future version will re-implement Merkle verification in-program for atomic settlement.

**Known limitation (disclosed):** upgrade authority on the program has not been revoked. In production this would be burned to make the program fully immutable.

---

## What Makes This Different

Most hackathon prediction apps are a scoreboard with a database deciding payouts — trust with extra steps.

**Kaching Settle ships the part they skip:**

1. **A real keyless vault** — funds no one can touch, including us.
2. **Proof-gated settlement** — TxLINE's cryptographic result decides winners, verifiably.
3. **Fully automatic market lifecycle** — every fixture in the feed gets an on-chain market, a kickoff gate, and a keeper watching it, with zero human operations.
4. **Instant + fallback settlement detection** — SSE stream triggers settlement within seconds of FT. A 2.5-hour fallback catches anything the stream misses. Funds are never stuck.
5. **Emergency expiry protection** — funds can never be permanently locked. Markets void automatically 7 days past kickoff if no proof arrives.
6. **Side integrity enforcement** — one wallet, one side per market. The program rejects conflicting positions on-chain (`SideMismatch`).
7. **A human face on the cryptography** — an AI pundit explains every settlement in plain language and voice, so a normal football fan understands *why* they got paid.
8. **The underdog engine** — pool-ratio odds that reward the brave call automatically, displayed live.
9. **Permanent betting history** — My Positions reads directly from Solana, showing every bet ever placed regardless of whether the fixture still appears in the TxLINE feed.
10. **Raw on-chain verifiability** — every market's state is readable as raw bytes. Anyone can decode it with `scripts/decode-market.js`, no API required.
11. **Multi-authority keeper** — markets created by any wallet settle automatically. Add any signing key via `AUTHORITY_KEYPAIRS` and the keeper picks the right one per market.

*The proof pays you. That's the whole product.*

---

<div align="center">

**Built for the TxLINE World Cup Hackathon 2026**

Live App: [kaching-settle-ten.vercel.app](https://kaching-settle-ten.vercel.app) · Backend: [kaching-settle-production.up.railway.app](https://kaching-settle-production.up.railway.app/health)

Twitter/X: [@levr_nx](https://x.com/levr_nx) · GitHub: [cutlerjay109-create](https://github.com/cutlerjay109-create)

</div>
