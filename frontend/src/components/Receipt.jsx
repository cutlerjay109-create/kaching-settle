import React from "react";

export default function Receipt({ settlement }) {
  if (!settlement) return null;

  const explorerUrl = `https://explorer.solana.com/address/${settlement.proof?.dailyScoresRoot}`;

  return (
    <div className="receipt">
      <div className="receipt-header">
        <span className="receipt-icon">✅</span>
        <h3>Settled by Proof</h3>
      </div>

      <div className="receipt-result">
        <span className={`winner-side ${settlement.winningSide.toLowerCase()}`}>
          {settlement.winningSide} wins
        </span>
        <p className="receipt-question">{settlement.question}</p>
      </div>

      <div className="receipt-proof">
        <p className="proof-label">Verified by TxLINE Merkle proof</p>
        <p className="proof-detail">
          Fixture: <code>{settlement.proof?.fixtureId}</code>
        </p>
        <p className="proof-detail">
          On-chain root: <code>{settlement.proof?.dailyScoresRoot?.slice(0, 20)}...</code>
        </p>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="explorer-link"
        >
          Verify on Solana Explorer →
        </a>
      </div>

      <p className="receipt-note">
        No company decided this. The proof did.
      </p>
    </div>
  );
}
