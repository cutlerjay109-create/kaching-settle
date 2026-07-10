import React, { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { claim, refund } from "../lib/solana";

export default function Receipt({ settlement }) {
  if (!settlement) return null;

  const { publicKey } = useWallet();
  const wallet = useWallet();
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [claimTx, setClaimTx] = useState(null);
  const [error, setError] = useState(null);

  const explorerUrl = settlement.proof?.dailyScoresRoot
    ? `https://explorer.solana.com/address/${settlement.proof.dailyScoresRoot}?cluster=devnet`
    : `https://explorer.solana.com/address/${settlement.fixtureId}?cluster=devnet`;

  async function handleClaim() {
    if (!publicKey) return setError("Connect your wallet first");
    setClaiming(true);
    setError(null);
    try {
      if (settlement.voided) {
        // Refund — need to know which side user was on
        // For now show message to contact support
        setError("Market voided — refund coming in v2");
        return;
      }
      const winningSide = settlement.winningSide === "YES" ? 0 : 1;
      const { tx } = await claim(wallet, {
        fixtureId: settlement.fixtureId,
        winningSide,
      });
      setClaimTx(tx);
      setClaimed(true);
    } catch(e) {
      if (e.message.includes("WrongSide") || e.message.includes("0x1779")) {
        setError("You bet on the losing side — no claim available.");
      } else if (e.message.includes("AlreadyClaimed") || e.message.includes("0x1778")) {
        setError("Already claimed.");
      } else {
        setError(e.message.slice(0, 100));
      }
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="receipt">
      <div className="receipt-header">
        <span className="receipt-icon">
          {settlement.voided ? "↩️" : "✅"}
        </span>
        <h3>{settlement.voided ? "Market Voided" : "Settled by Proof"}</h3>
      </div>

      <div className="receipt-result">
        {!settlement.voided && (
          <span className={"winner-side " + (settlement.winningSide || "").toLowerCase()}>
            {settlement.winningSide} wins
          </span>
        )}
        <p className="receipt-question">{settlement.question}</p>
      </div>

      {!settlement.voided && settlement.proof && (
        <div className="receipt-proof">
          <p className="proof-label">Verified by TxLINE Merkle proof</p>
          <p className="proof-detail">Fixture: <code>{settlement.fixtureId}</code></p>
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="explorer-link">
            Verify on Solana Explorer →
          </a>
        </div>
      )}

      {claimed && claimTx ? (
        <div className="claim-success">
          <p>✅ Claimed successfully!</p>
          <a
            href={`https://explorer.solana.com/tx/${claimTx}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="explorer-link"
          >
            View claim transaction →
          </a>
        </div>
      ) : (
        <button
          className="deposit-btn"
          onClick={handleClaim}
          disabled={claiming || !publicKey}
          style={{ marginTop: "12px" }}
        >
          {claiming ? "Claiming..." : settlement.voided ? "Request Refund" : "Claim Winnings"}
        </button>
      )}

      {error && <p className="error" style={{marginTop:"8px"}}>{error}</p>}

      <p className="receipt-note">
        {settlement.voided
          ? "One side had no deposits — your stake will be returned."
          : "No company decided this. The proof did."}
      </p>
    </div>
  );
}
