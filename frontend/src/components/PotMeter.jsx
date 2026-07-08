import React from "react";

export default function PotMeter({ yesPot, noPot }) {
  const total = yesPot + noPot;
  const yesPercent = total > 0 ? Math.round((yesPot / total) * 100) : 50;
  const noPercent = 100 - yesPercent;

  const yesMultiplier = noPot > 0 && yesPot > 0
    ? ((yesPot + noPot) / yesPot).toFixed(2)
    : "∞";
  const noMultiplier = yesPot > 0 && noPot > 0
    ? ((yesPot + noPot) / noPot).toFixed(2)
    : "∞";

  return (
    <div className="pot-meter">
      <h3>Current Pot</h3>
      <div className="pot-totals">
        <div className="pot-side yes">
          <span className="pot-label">YES</span>
          <span className="pot-amount">${yesPot.toFixed(2)}</span>
          <span className="pot-multiplier">{yesMultiplier}x if right</span>
        </div>
        <div className="pot-side no">
          <span className="pot-label">NO</span>
          <span className="pot-amount">${noPot.toFixed(2)}</span>
          <span className="pot-multiplier">{noMultiplier}x if right</span>
        </div>
      </div>

      <div className="pot-bar">
        <div className="pot-bar-yes" style={{ width: `${yesPercent}%` }} />
        <div className="pot-bar-no" style={{ width: `${noPercent}%` }} />
      </div>

      <p className="pot-note">
        Total locked: <strong>${total.toFixed(2)} USDC</strong>
        {" "} — small side wins big
      </p>
    </div>
  );
}
