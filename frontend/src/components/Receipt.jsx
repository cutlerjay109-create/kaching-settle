import React, { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { claim, refund, getPosition } from "../lib/solana";

export default function Receipt({ settlement }) {
  if (!settlement) return null;

  const { publicKey } = useWallet();
  const wallet = useWallet();
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [claimTx, setClaimTx] = useState(null);
  const [error, setError] = useState(null);

  const PROGRAM_ID = "9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B";
  const explorerUrl = `https://solscan.io/account/${PROGRAM_ID}?cluster=devnet`;

  async function handleClaim() {
    if (!publicKey) return setError("Connect your wallet first");
    setClaiming(true);
    setError(null);
    try {
      if (settlement.voided) {
        // Refund — look up which side the user was on, then pull
        // their stake back from that side's vault.
        const pos = await getPosition(settlement.fixtureId, publicKey);
        if (!pos) { setError("No position found for this wallet."); return; }
        if (pos.claimed) { setError("Already refunded."); return; }
        const { tx } = await refund(wallet, {
          fixtureId: settlement.fixtureId,
          side: pos.side,
        });
        setClaimTx(tx);
        setClaimed(true);
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
      } else if (e.message.includes("NothingToClaim") || e.message.includes("0x177a")) {
        setError("No funds to claim — this market had no deposits.");
      } else if (e.message.includes("Simulation failed")) {
        setError("Claim failed — you may not have a position on the winning side.");
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
          <p>✅ {settlement.voided ? "Refunded successfully!" : "Claimed successfully!"}</p>
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
