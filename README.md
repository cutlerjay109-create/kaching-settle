<div align="center">

# ⚡ Kaching Settle

### Trustless Match Markets — The Proof Pays You

**A YES/NO prediction market for the FIFA World Cup 2026 where TxLINE's cryptographic match proof — not a company's server — releases your winnings automatically on Solana.**

[![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF?logo=solana)](https://solscan.io/account/9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B?cluster=devnet)
[![TxLINE](https://img.shields.io/badge/Data-TxLINE%20by%20TxODDS-00D18F)](https://txline.txodds.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.30.1-blue)](https://www.anchor-lang.com/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

[Live App](#) · [Demo Video](#) · [Program on Solscan](https://solscan.io/account/9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B?cluster=devnet)

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
8. [Payout Mathematics](#payout-mathematics)
9. [Tech Stack](#tech-stack)
10. [Running Locally](#running-locally)
11. [Project Structure](#project-structure)
12. [TxLINE API Feedback](#txline-api-feedback)
13. [Security Model](#security-model)
14. [What Makes This Different](#what-makes-this-different)

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

**1 — Predict.** Connect Phantom, choose a real World Cup fixture (e.g. *"Will France score against Morocco?"*), pick **YES** or **NO**, lock USDC. Minimum stake $1.

**2 — Kickoff seals the vault.** The Solana program compares the on-chain clock to the fixture's kickoff timestamp. The instant kickoff passes, every deposit attempt is rejected at the program level — `KickoffPassed`. No server involved.

**3 — Watch live.** Scores, goals, cards, and stoppage time stream in real time from TxLINE's SSE feed. An AI pundit (Groq) generates broadcast-style commentary, voiced by ElevenLabs.

**4 — The proof settles it.** When the fixture completes, our keeper fetches TxLINE's Merkle proof and verifies it against TxLINE's on-chain `daily_scores_roots` via `validateStat()`. The verified boolean — not an admin — determines the winning side, recorded on-chain by `settle()`.

**5 — Winners claim.** Each winner clicks **Claim** once. The program computes their proportional share and transfers USDC straight to their wallet, with a Solscan receipt proving exactly why.

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
                      mainTreeProof, predicate, stat1).view()
        │  verified against TxLINE's on-chain
        │  ["daily_scores_roots", epochDay] PDA
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
| 9 | Txoracle `validateStat().view()` | **On-chain proof check vs `daily_scores_roots` PDA** |

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
| AI commentary | Groq (`llama3-8b`) text · ElevenLabs TTS voice |
| Frontend | React 18 · Vite · Phantom Wallet Adapter |
| Settlement asset | USDC (SPL token) |

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
WALLET_KEYPAIR=      # base58 private key — keeper wallet (devnet SOL required)
GROQ_API_KEY=        # console.groq.com
ELEVENLABS_API_KEY=  # elevenlabs.io
ELEVENLABS_VOICE_ID= # your chosen voice
TXLINE_API_TOKEN=    # produced by: node scripts/subscribe.js  (free tier)
```

### Useful scripts

| Script | Purpose |
|---|---|
| `scripts/subscribe.js` | One-time TxLINE on-chain subscription + token activation |
| `scripts/spike.js` | Connectivity check: auth, fixtures, proofs |
| `scripts/deposit.js` | Terminal deposit onto either side (demo seeding) |
| `scripts/create-market.js` | Manual market creation (auto-market normally handles this) |

---

## Project Structure

```
kaching-settle/
├── program/programs/kaching-settle/   # Anchor program (Rust)
│   └── src/
│       ├── lib.rs                     # 5 instructions
│       ├── instructions/              # create_market · deposit · lock · settle · claim
│       ├── state/                     # Market · Position accounts
│       ├── constants.rs               # seeds, stake limits, statuses
│       └── errors.rs                  # 12 explicit error codes
├── backend/src/
│   ├── txline/                        # auth · stream · fixtures · normalize · validate
│   ├── keeper/                        # auto-market · settle-trigger
│   ├── ai/                            # pundit (Groq) · voice (ElevenLabs)
│   ├── program/                       # Solana clients
│   └── server.js                      # Express + Socket.IO entry
├── frontend/src/
│   ├── pages/                         # MarketList · MarketView
│   ├── components/                    # DepositBox · PotMeter · LiveFeed · Receipt · VoicePlayer
│   └── lib/                           # solana.js (raw web3, no IDL parsing) · socket.js
├── shared/                            # single source of config + constants
└── scripts/                           # subscribe · spike · deposit · diagnostics
```

---

## TxLINE API Feedback

**What we loved**

- **One normalized schema** across every competition — zero per-league mapping. Friendlies and World Cup fixtures parse identically.
- **The SSE stream is rock solid.** Hours of continuous connection during development, zero unexplained drops.
- **The proof package is elegant.** `summary + subTreeProof + mainTreeProof + statToProve` maps 1:1 onto `validateStat`'s arguments — once understood, integration was clean.
- **Free World Cup tier with no rate limits** — genuinely generous for a hackathon and it never throttled us once.

**Where we hit friction**

1. **`validateStat` is `.view()`-only.** We initially designed for an atomic CPI (verify + release in one transaction) per the track description's wording, then discovered verification is a read-only simulation. Clearer docs on the keeper-attested pattern would save teams a redesign.
2. **Devnet fixtures ≠ mainnet fixtures.** Devnet carries friendlies only; World Cup data is mainnet-side. We ended up with a split topology (mainnet TxLINE host + devnet Solana program) that the docs don't explicitly bless.
3. **Activation message format** (`txSig:leagues:jwt`, base64 signature) took trial and error — one concrete worked example in the quickstart would remove all guesswork.
4. **Soccer `statKey` codes are undocumented.** We inferred `1 = home goals` from NCAA examples. A stat-key table per sport would be a five-minute doc fix that saves hours.
5. **Token-2022 gotcha:** the TxL mint uses Token-2022, so ATA derivation with the classic token program fails silently in subscribe. Worth a call-out box in the docs.

---

## Security Model

| Threat | Mitigation |
|---|---|
| Operator steals funds | Impossible — vaults are keyless PDAs; only program code moves funds |
| Operator fakes a result | Keeper can only relay proofs that verify against TxLINE's on-chain Merkle root; anyone can re-verify |
| Deposit after kickoff | Rejected by on-chain clock check, not server logic |
| Double claim | `Position.claimed` flag, enforced on-chain |
| Wrong-side claim | `WrongSide` check against on-chain `winning_side` |
| Dust / griefing | $1 minimum stake enforced in-program |

**Known limitation (disclosed):** settlement is *keeper-attested* — the keeper triggers `settle` after off-chain `validateStat` verification, because TxLINE's validator is view-only. The proof trail remains fully verifiable by third parties; a future version will re-implement Merkle verification in-program for atomic settlement.

---

## What Makes This Different

Most hackathon prediction apps are a scoreboard with a database deciding payouts — trust with extra steps.

**Kaching Settle ships the part they skip:**

1. **A real keyless vault** — funds no one can touch, including us.
2. **Proof-gated settlement** — TxLINE's cryptographic result decides winners, verifiably.
3. **Fully automatic market lifecycle** — every fixture in the feed gets an on-chain market, a kickoff gate, and a keeper watching it, with zero human operations.
4. **A human face on the cryptography** — an AI pundit explains every settlement in plain language and voice, so a normal football fan understands *why* they got paid.
5. **The underdog engine** — pool-ratio odds that reward the brave call automatically, displayed live.

*The proof pays you. That's the whole product.*

---

<div align="center">

**Built for the TxLINE World Cup Hackathon 2026**

Twitter/X: [@levr_nx](https://x.com/levr_nx) · GitHub: [cutlerjay109-create](https://github.com/cutlerjay109-create)

</div>
