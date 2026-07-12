// backend/src/ai/pundit.js
// Generates AI match commentary using Groq.
//
// Fix: this now supports BOTH call styles used by the codebase:
//   generateCommentary({ prompt })                       <- live events (server.js)
//   generateCommentary({ fixture, question, result, winningSide, proof })
// Previously the { prompt } style crashed on fixture.home (undefined),
// which silently killed all live goal/red card/VAR commentary.

const Groq = require("groq-sdk");

// Lazy init — instantiating Groq at import time crashes the whole backend
// (including settlement) whenever GROQ_API_KEY is missing.
let _groq = null;
function getGroq() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) return null;
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

async function generateCommentary(opts = {}) {
  let prompt = opts.prompt;
  const home = opts.fixture?.home || "the home side";
  const away = opts.fixture?.away || "the away side";
  const winningSide = opts.winningSide || "";

  if (!prompt) {
    const { question, result, proof } = opts;
    prompt = `You are an energetic football pundit commentating on a match settlement.

Match: ${home} vs ${away}
Question: "${question}"
Outcome: The answer was ${result ? "YES" : "NO"} — ${winningSide} side wins.
Proof: Verified on-chain at timestamp ${proof?.targetTs ? new Date(proof.targetTs).toISOString() : "now"}.

Write 2 punchy sentences:
1. What happened in the match relevant to this question.
2. Confirm who gets paid and that it was settled trustlessly by cryptographic proof.

Keep it exciting, under 50 words total. No hashtags. No emojis.`;
  }

  try {
    const groq = getGroq();
    if (!groq) throw new Error("GROQ_API_KEY not set");
    const res = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.8,
    });

    return res.choices[0].message.content.trim();
  } catch (e) {
    console.error("[pundit] Groq error:", e.message);
    if (opts.prompt) return null; // live event — silence is fine
    return `${home} vs ${away} is settled. ${winningSide} backers win — verified by TxLINE proof on Solana.`;
  }
}

module.exports = { generateCommentary };
