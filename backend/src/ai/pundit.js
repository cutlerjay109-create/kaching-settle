// backend/src/ai/pundit.js
// Generates AI match commentary using Groq.
// Explains what happened and why the user got paid.

const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generateCommentary({ fixture, question, result, winningSide, proof }) {
  const prompt = `You are an energetic football pundit commentating on a match settlement.

Match: ${fixture.home} vs ${fixture.away}
Question: "${question}"
Outcome: The answer was ${result ? "YES" : "NO"} — ${winningSide} side wins.
Proof: Verified on-chain at timestamp ${proof?.targetTs ? new Date(proof.targetTs).toISOString() : "now"}.

Write 2 punchy sentences:
1. What happened in the match relevant to this question.
2. Confirm who gets paid and that it was settled trustlessly by cryptographic proof.

Keep it exciting, under 50 words total. No hashtags. No emojis.`;

  try {
    const res = await groq.chat.completions.create({
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.8,
    });

    return res.choices[0].message.content.trim();
  } catch (e) {
    console.error("[pundit] Groq error:", e.message);
    return `${fixture.home} vs ${fixture.away} is settled. ${winningSide} backers win — verified by TxLINE proof on Solana.`;
  }
}

module.exports = { generateCommentary };
