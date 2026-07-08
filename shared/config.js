// shared/config.js
// Single source of truth for all network config.
// MAINNET -- real World Cup data, real score proofs.

const config = {
  // Solana
  rpc: 'https://api.mainnet-beta.solana.com',
  network: 'mainnet',

  // TxLINE / TxODDS -- mainnet values
  txline: {
    host: 'https://txline.txodds.com',
    programId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
    txlMint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL',
    serviceLevelId: 1,
    durationWeeks: 4,
    leagues: [],
  },

  // Our vault program (filled after deploy)
  settleProgramId: '',

  // Mainnet USDC mint
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

module.exports = config;
