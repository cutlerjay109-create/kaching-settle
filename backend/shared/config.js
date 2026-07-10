// shared/config.js
// Network: DEVNET
// - Solana program deployed on devnet
// - TxLINE data from mainnet API (free World Cup tier)
// - Devnet USDC for testing

const config = {
  // Solana — devnet (program is here)
  rpc: 'https://api.devnet.solana.com',
  network: 'devnet',

  // TxLINE / TxODDS — mainnet API (has real World Cup data)
  // Note: TxLINE data API is separate from Solana cluster
  txline: {
    host: 'https://txline.txodds.com',
    programId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
    txlMint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL',
    serviceLevelId: 1,
    durationWeeks: 4,
    leagues: [],
  },

  // Our vault program — deployed on devnet
  settleProgramId: '9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B',

  // Devnet USDC mint
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

module.exports = config;
