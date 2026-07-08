import React, { useState } from "react";
import MarketList from "./pages/MarketList";
import MarketView from "./pages/MarketView";

export default function App() {
  const [selectedFixtureId, setSelectedFixtureId] = useState(null);

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">⚡</span>
          <span className="logo-text">Kaching Settle</span>
        </div>
        <p className="logo-sub">Trustless match markets — proof pays you</p>
      </header>

      <main className="app-main">
        {selectedFixtureId ? (
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
