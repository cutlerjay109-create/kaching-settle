
require('dotenv').config({ path: 'backend/.env' });
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, createTransferInstruction, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');

async function main() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  
  // Agent wallet (sender) — paste private key here
  const agentPrivateKey = '3SD5Y71c1Js338mVQCZ4mRoc4RTDU6awbiRbDciA7oxJm277H8tcP9LvfekQDaDU8fRxbYqaG6ePzzZFZW2r9pMH';
  const decoder = bs58.default || bs58;
  const agent = Keypair.fromSecretKey(decoder.decode(agentPrivateKey.trim()));
  
  // Your main wallet (recipient)
  const recipient = new PublicKey('HXyv3RHndummXVjMcXTRaQo1L1sQtxutQtbgfnVC2Hxg');
  const mint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

  console.log('Agent wallet:', agent.publicKey.toBase58());
  
  // Check balances
  const sol = await connection.getBalance(agent.publicKey);
  console.log('SOL balance:', sol/1e9);
  
  const agentAta = getAssociatedTokenAddressSync(mint, agent.publicKey, false, TOKEN_PROGRAM_ID);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID);
  
  let usdcBalance = 0;
  try {
    const acc = await getAccount(connection, agentAta, 'confirmed', TOKEN_PROGRAM_ID);
    usdcBalance = Number(acc.amount);
    console.log('USDC balance:', usdcBalance/1e6);
  } catch {
    console.log('No USDC account');
  }

  const tx = new Transaction();

  // Transfer USDC if any
  if (usdcBalance > 0) {
    tx.add(createTransferInstruction(
      agentAta, recipientAta, agent.publicKey, usdcBalance, [], TOKEN_PROGRAM_ID
    ));
    console.log('Adding USDC transfer...');
  }

  // Transfer SOL (keep some for fees)
  const fees = 0.01 * LAMPORTS_PER_SOL;
  const solToSend = sol - fees;
  if (solToSend > 0) {
    tx.add(SystemProgram.transfer({
      fromPubkey: agent.publicKey,
      toPubkey: recipient,
      lamports: solToSend,
    }));
    console.log('Adding SOL transfer:', solToSend/LAMPORTS_PER_SOL, 'SOL');
  }

  if (tx.instructions.length === 0) {
    console.log('Nothing to transfer');
    return;
  }

  tx.feePayer = agent.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(agent);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('Transfer complete!');
  console.log('Explorer: https://solscan.io/tx/' + sig + '?cluster=devnet');
}
main().catch(e => console.error('Error:', e.message));
