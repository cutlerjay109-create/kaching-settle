import React, { useState } from "react";
import MarketList from "./pages/MarketList";
import MarketView from "./pages/MarketView";
import MyPositions from "./pages/MyPositions";

export default function App() {
  const [selectedFixtureId, setSelectedFixtureId] = useState(null);
  const [tab, setTab] = useState("markets");

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">⚡</span>
          <span className="logo-text">Kaching Settle</span>
        </div>
        <p className="logo-sub">Trustless match markets — proof pays you</p>
        <div className="nav-tabs">
          <button
            className={"nav-tab " + (tab === "markets" ? "active" : "")}
            onClick={() => { setTab("markets"); setSelectedFixtureId(null); }}
          >
            Markets
          </button>
          <button
            className={"nav-tab " + (tab === "positions" ? "active" : "")}
            onClick={() => { setTab("positions"); setSelectedFixtureId(null); }}
          >
            My Positions
          </button>
        </div>
      </header>

      <main className="app-main">
        {tab === "positions" ? (
          <MyPositions />
        ) : selectedFixtureId ? (
          <MarketView
            fixtureId={selectedFixtureId}
            onBack={() => setSelectedFixtureId(null)}
          />
        ) : (
          <MarketList onSelect={setSelectedFixtureId} />
        )}
      </main>
    </div>
  );
}
