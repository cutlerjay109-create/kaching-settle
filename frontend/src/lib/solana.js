import { Connection, PublicKey, Transaction } from "@solana/web3.js";

const RPC = "https://api.mainnet-beta.solana.com";

export function getConnection() {
  return new Connection(RPC, "confirmed");
}

// Deposit USDC into the YES or NO vault
// Called from DepositBox once the program is deployed
export async function deposit({ wallet, fixtureId, side, amountUsdc }) {
  // TODO: build and send deposit transaction
  // This will be wired once the program is deployed
  // and settleProgramId is set in shared/config.js
  console.log("deposit called:", { fixtureId, side, amountUsdc });
  throw new Error("Program not deployed yet — set settleProgramId in shared/config.js");
}

// Claim winnings after settlement
export async function claim({ wallet, fixtureId }) {
  console.log("claim called:", { fixtureId });
  throw new Error("Program not deployed yet — set settleProgramId in shared/config.js");
}
