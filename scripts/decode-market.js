
require('dotenv').config({ path: __dirname + '/../backend/.env' });
const { Connection, PublicKey } = require(__dirname + '/../backend/node_modules/@solana/web3.js');
const config = require(__dirname + '/../shared/config');
const constants = require(__dirname + '/../shared/constants');

async function decodeMarket(input) {
  let data;

  if (!input) {
    console.log('Usage: node decode-market.js <fixtureId|base64data>');
    console.log('Example: node decode-market.js 18213979');
    return;
  }

  if (input.match(/^[0-9]+$/)) {
    const connection = new Connection(config.rpc, 'confirmed');
    const PROGRAM_ID = new PublicKey(config.settleProgramId);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(input));
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(constants.SEEDS.MARKET), buf], PROGRAM_ID
    );
    console.log('Market PDA:', pda.toBase58());
    const info = await connection.getAccountInfo(pda);
    if (!info) { console.log('Market not found on-chain'); return; }
    data = info.data;
    console.log('Raw base64:', data.toString('base64'));
  } else {
    data = Buffer.from(input, 'base64');
  }

  const STATUS = {0:'OPEN',1:'LOCKED',2:'SETTLED',3:'VOID'};
  const SIDE = {0:'YES',1:'NO',255:'Not yet settled'};
  const COMPARISON = {0:'greaterThan',1:'lessThan',2:'equalTo'};

  let o = 8;
  const fixtureId = data.readBigUInt64LE(o); o += 8;
  const qLen = data.readUInt32LE(o); o += 4;
  const question = data.slice(o, o+qLen).toString('utf8'); o += qLen;
  const kickoffTs = data.readBigInt64LE(o); o += 8;
  const statKey = data.readUInt32LE(o); o += 4;
  const threshold = data.readBigUInt64LE(o); o += 8;
  const comparison = data.readUInt8(o); o += 1;
  const yesTotal = data.readBigUInt64LE(o); o += 8;
  const noTotal = data.readBigUInt64LE(o); o += 8;
  const status = data.readUInt8(o); o += 1;
  const winningSide = data.readUInt8(o); o += 1;

  const kickoff = new Date(Number(kickoffTs) * 1000).toISOString().replace('T',' ').slice(0,19) + ' UTC';
  const yes = Number(yesTotal)/1e6;
  const no = Number(noTotal)/1e6;
  const total = yes + no;

  console.log('');
  console.log('=== MARKET DECODED ===');
  console.log('Fixture ID:   ', Number(fixtureId));
  console.log('Question:     ', question);
  console.log('Kickoff:      ', kickoff);
  console.log('Stat Key:     ', statKey, '(1 = home goals)');
  console.log('Threshold:    ', Number(threshold));
  console.log('Comparison:   ', COMPARISON[comparison] || comparison);
  console.log('YES Total:    ', '$'+yes.toFixed(2)+' USDC', yes > 0 && total > 0 ? '('+(total/yes).toFixed(2)+'x if right)' : '');
  console.log('NO Total:     ', '$'+no.toFixed(2)+' USDC', no > 0 && total > 0 ? '('+(total/no).toFixed(2)+'x if right)' : '');
  console.log('Status:       ', STATUS[status] || status);
  console.log('Winning Side: ', SIDE[winningSide] || winningSide);
}

decodeMarket(process.argv[2]).catch(console.error);
