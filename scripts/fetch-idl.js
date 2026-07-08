
require("module").globalPaths.push(__dirname + "/../backend/node_modules");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey } = require("@solana/web3.js");
const fs = require("fs");

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const programId = new PublicKey("9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B");
  
  const idl = await anchor.Program.fetchIdl(programId, { connection });
  if (idl === null || idl === undefined) {
    console.log("IDL not found on chain");
    return;
  }
  fs.writeFileSync("backend/idl/kaching_settle.json", JSON.stringify(idl, null, 2));
  console.log("IDL saved to backend/idl/kaching_settle.json");
  console.log("Instructions:", idl.instructions.map(i => i.name));
}

main().catch(console.error);
