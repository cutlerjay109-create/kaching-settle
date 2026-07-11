
require('dotenv').config({ path: 'backend/.env' });
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createTransferInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');

async function main() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const decoder = bs58.default || bs58;
  const sender = Keypair.fromSecretKey(decoder.decode(process.env.WALLET_KEYPAIR.trim()));
  const recipient = new PublicKey('9Uj3XrdajW9tJyFViCYKBuEGNDtkzBMcAEfJivtShcmH');
  const mint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

  const senderAta = getAssociatedTokenAddressSync(mint, sender.publicKey, false, TOKEN_PROGRAM_ID);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID);

  const tx = new Transaction();

  const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
  if (recipientAtaInfo === null) {
    tx.add(createAssociatedTokenAccountInstruction(
      sender.publicKey, recipientAta, recipient, mint, TOKEN_PROGRAM_ID
    ));
    console.log('Creating USDC token account for keeper...');
  }

  tx.add(createTransferInstruction(
    senderAta, recipientAta, sender.publicKey, 10 * 1000000, [], TOKEN_PROGRAM_ID
  ));

  tx.feePayer = sender.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(sender);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('Sent 10 USDC to keeper wallet');
  console.log('Explorer: https://solscan.io/tx/' + sig + '?cluster=devnet');
}
main().catch(console.error);
