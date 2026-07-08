import React, { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";

const MIN_STAKE = 1;

export default function DepositBox({ fixtureId, fixture, onDeposit }) {
  const { publicKey } = useWallet();
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function handleDeposit() {
    if (!side) return setError("Pick YES or NO first");
    const amt = parseFloat(amount);
    if (!amt || amt < MIN_STAKE) return setError(`Minimum stake is $${MIN_STAKE}`);

    setLoading(true);
    setError(null);

    try {
      // TODO: call program deposit instruction via lib/solana.js
      // For now, simulate the deposit
      await new Promise(r => setTimeout(r, 1500));
      onDeposit(side, amt);
      setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="deposit-done">
        ✅ Deposited ${amount} on <strong>{side}</strong>
        <p>Your funds are locked in the vault. Good luck!</p>
      </div>
    );
  }

  return (
    <div className="deposit-box">
      <h3>Place your prediction</h3>
      <p className="deposit-question">Will {fixture.home} score a goal?</p>

      <div className="side-buttons">
        <button
          className={`side-btn yes ${side === "YES" ? "active" : ""}`}
          onClick={() => setSide("YES")}
        >
          YES
        </button>
        <button
          className={`side-btn no ${side === "NO" ? "active" : ""}`}
          onClick={() => setSide("NO")}
        >
          NO
        </button>
      </div>

      <input
        className="amount-input"
        type="number"
        placeholder={`Amount in USDC (min $${MIN_STAKE})`}
        value={amount}
        onChange={e => setAmount(e.target.value)}
        min={MIN_STAKE}
      />

      {error && <p className="error">{error}</p>}

      <button
        className="deposit-btn"
        onClick={handleDeposit}
        disabled={loading || !side || !amount}
      >
        {loading ? "Locking funds..." : `Lock $${amount || "?"} on ${side || "?"}`}
      </button>

      <p className="deposit-note">
        Funds lock at kickoff. Paid out automatically by TxLINE proof.
      </p>
    </div>
  );
}
