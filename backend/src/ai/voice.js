// backend/src/ai/voice.js
// Converts pundit commentary text to audio using ElevenLabs.
// Returns a base64 audio string the frontend plays directly.

const axios = require("axios");

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

async function generateVoice(text) {
  if (!ELEVENLABS_API_KEY || !VOICE_ID) {
    console.warn("[voice] ElevenLabs keys missing — skipping audio");
    return null;
  }

  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
        timeout: 30000,
      }
    );

    const base64 = Buffer.from(res.data).toString("base64");
    console.log("[voice] Audio generated —", base64.length, "chars");
    return `data:audio/mpeg;base64,${base64}`;
  } catch (e) {
    console.error("[voice] ElevenLabs error:", e.message);
    return null;
  }
}

module.exports = { generateVoice };
