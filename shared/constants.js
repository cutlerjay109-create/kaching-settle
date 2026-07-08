// shared/constants.js
// All fixed numbers and seeds used across backend and scripts.

const constants = {
  // Stake limits
  MIN_STAKE_USDC: 1_000_000,      // $1 in USDC (6 decimals)
  MAX_STAKE_USDC: 10_000_000_000, // $10,000 ceiling

  // Market status codes (must match program/src/constants.rs)
  STATUS: {
    OPEN: 0,     // accepting deposits
    LOCKED: 1,   // kickoff hit, deposits closed
    SETTLED: 2,  // result verified, claims open
    VOID: 3,     // cancelled, everyone gets refund
  },

  // Sides
  SIDE: {
    YES: 0,
    NO: 1,
  },

  // PDA seeds (must match program/src/constants.rs exactly)
  SEEDS: {
    MARKET: "market",
    YES_VAULT: "yes_vault",
    NO_VAULT: "no_vault",
    POSITION: "position",
  },

  // Required compute units for proof verification
  COMPUTE_UNITS: 1_400_000,

  // TxLINE epochDay = floor(unixMs / 86400000)
  MS_PER_DAY: 86_400_000,
};

module.exports = constants;
