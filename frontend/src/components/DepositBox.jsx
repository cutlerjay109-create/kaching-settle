import React, { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { deposit } from "../lib/solana";

const MIN_STAKE = 1;

export default function DepositBox({ fixtureId, fixture, onDeposit }) {
  const wallet = useWallet();
  const [side, setSide] = useState(null);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [txSig, setTxSig] = useState(null);

  async function handleDeposit() {
    if (!side) return setError("Pick YES or NO first");
    const amt = parseFloat(amount);
    if (!amt || amt < MIN_STAKE) return setError("Minimum stake is $" + MIN_STAKE);

    setLoading(true);
    setError(null);

    try {
      const sideNum = side === "YES" ? 0 : 1;
      const { tx } = await deposit(wallet, {
        fixtureId,
        side: sideNum,
        amountUsdc: amt,
      });
      setTxSig(tx);
      onDeposit(side, amt);
      setDone(true);
    } catch (e) {
      // Show friendly message for common errors
      if (e.message.includes("SideMismatch") || e.message.includes("0x177f")) {
        setError("You already have a position on the other side of this market.");
      } else if (e.message.includes("KickoffPassed") || e.message.includes("0x1776")) {
        setError("Kickoff has passed — this market is now locked. Watch the match!");
      } else if (e.message.includes("BelowMinimumStake") || e.message.includes("0x1773")) {
        setError("Minimum stake is $1 USDC.");
      } else if (e.message.includes("MarketNotOpen") || e.message.includes("0x1770")) {
        setError("This market is not open for deposits.");
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="deposit-done">
        <p>Deposited ${amount} on <strong>{side}</strong></p>
        <a
          href={"https://explorer.solana.com/tx/" + txSig + "?cluster=devnet"}
          target="_blank"
          rel="noopener noreferrer"
          className="explorer-link"
        >
          View transaction on Explorer
        </a>
      </div>
    );
  }

  return (
    <div className="deposit-box">
      <h3>Place your prediction</h3>
      <p className="deposit-question">Will {fixture.home} score a goal?</p>

      <div className="side-buttons">
        <button
          className={"side-btn yes " + (side === "YES" ? "active" : "")}
          onClick={() => setSide("YES")}
        >YES</button>
        <button
          className={"side-btn no " + (side === "NO" ? "active" : "")}
          onClick={() => setSide("NO")}
        >NO</button>
      </div>

      <input
        className="amount-input"
        type="number"
        placeholder={"Amount in USDC (min $" + MIN_STAKE + ")"}
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
        {loading ? "Locking funds..." : "Lock $" + (amount || "?") + " on " + (side || "?")}
      </button>

      <p className="deposit-note">
        Funds lock at kickoff. Paid out automatically by TxLINE proof.
      </p>
    </div>
  );
}
