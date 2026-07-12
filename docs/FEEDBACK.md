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