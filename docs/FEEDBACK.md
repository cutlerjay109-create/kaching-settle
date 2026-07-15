## TxLINE API Feedback

**What we loved**

- **One normalized schema** across every competition — zero per-league mapping. Friendlies and World Cup fixtures parse identically.
- **The SSE stream is rock solid.** Hours of continuous connection during development, zero unexplained drops.
- **The proof package is elegant.** `summary + subTreeProof + mainTreeProof + statToProve` maps 1:1 onto `validateStat`'s arguments — once understood, integration was clean.
- **Free World Cup tier with no rate limits** — genuinely generous for a hackathon and it never throttled us once.

**Where we hit friction**

1. **`validateStat` does not support `.view()`.** Calling `.view()` throws "Method does not support views". The correct approach is `.simulate()` followed by parsing `"Evaluate predicate to: true/false"` from the transaction logs. The keeper-attested pattern works well once understood — a note in the docs would save teams hours of debugging.

2. **`dailyScoresMerkleRoots` PDA cannot be derived off-chain.** The account seed formula is opaque and undocumented. Our workaround: pass a dummy PDA to intentionally trigger a `ConstraintSeeds` error, then extract the correct address from the program's own error logs (`"Right: <address>"`). This self-correcting approach works reliably but a documented helper or seed formula would be cleaner.

3. **Proof sequences go up to 300+.** A 90-minute match generates approximately 300 proof sequences (~27 seconds each). Fetching `seq=1` returns early-match data where the score is still 0-0. The final result only appears at the last available sequence. This cost us two incorrect market settlements before we discovered it. A note in the docs about sequence range would prevent this entirely.

4. **Devnet fixtures ≠ mainnet fixtures.** Devnet carries friendlies only; World Cup data is mainnet-side. We ended up with a split topology (mainnet TxLINE host + devnet Solana program) that the docs don't explicitly bless.

5. **Activation message format** (`txSig:leagues:jwt`, base64 signature) took trial and error — one concrete worked example in the quickstart would remove all guesswork.

6. **Soccer `statKey` codes are undocumented.** We confirmed from live match data: `statKey=1` = Participant1 goals, `statKey=7` = Participant2 goals. A stat-key table per sport would be a five-minute doc fix that saves hours.

7. **Token-2022 gotcha:** the TxL mint uses Token-2022, so ATA derivation with the classic token program fails silently in subscribe. Worth a call-out box in the docs.

8. **`GameState` is always `"scheduled"` even during live play.** Real match phase must be derived from `StatusId` (2=1H, 3=HT, 4=2H, 5=FT) — not the misleading `GameState` field.

9. **FT event not reliably delivered on the SSE stream.** The stream correctly sends live score updates throughout the match, but the final FT event is not guaranteed. TxLINE appears to stop sending events for a fixture when it ends rather than delivering a clean FT signal. We implemented an SSE-triggered instant settlement that works when the event arrives, but a time-based fallback is necessary as the guaranteed settlement path.

---
