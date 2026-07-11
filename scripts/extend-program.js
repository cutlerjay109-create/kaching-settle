
require('dotenv').config({ path: __dirname + '/../backend/.env' });
const {
  Connection, PublicKey, Keypair, Transaction,
  TransactionInstruction, SystemProgram
} = require('@dirname/../backend/node_modules/@solana/web3.js'.replace('@dirname', __dirname));
const bs58 = require(__dirname + '/../backend/node_modules/bs58');

async function main() {
  const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram } = require(__dirname + '/../backend/node_modules/@solana/web3.js');
  const bs58mod = require(__dirname + '/../backend/node_modules/bs58');
  
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const decoder = bs58mod.default || bs58mod;
  const wallet = Keypair.fromSecretKey(decoder.decode(process.env.WALLET_KEYPAIR.trim()));
  
  const programId = new PublicKey('9n7ZwcVBKVqSU1SV7y5KzKqF5Ctt6kWCb7Kmm2vVXL5B');
  const BPF_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  
  const programInfo = await connection.getAccountInfo(programId);
  const programDataAddress = new PublicKey(programInfo.data.slice(4, 36));
  console.log('Program data:', programDataAddress.toBase58());
  
  const programDataInfo = await connection.getAccountInfo(programDataAddress);
  console.log('Current size:', programDataInfo.data.length);
  
  const data = Buffer.alloc(8);
  data.writeUInt32LE(6, 0);
  data.writeUInt32LE(51200, 4);
  
  const ix = new TransactionInstruction({
    programId: BPF_LOADER,
    keys: [
      { pubkey: programDataAddress, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    ],
    data,
  });
  
  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet);
  
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  
  const newInfo = await connection.getAccountInfo(programDataAddress);
  console.log('Extended! New size:', newInfo.data.length);
  console.log('TX:', sig);
}
main().catch(e => {
  console.error('Error:', e.message);
  if (e.logs) e.logs.forEach(l => console.error(' ', l));
});
