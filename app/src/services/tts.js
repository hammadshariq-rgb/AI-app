const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let currentSpeed = 0.88;

function setSpeed(speed) {
  currentSpeed = Math.min(4.0, Math.max(0.25, Number(speed) || 0.88));
}

// Standard synthesis — full text to base64 mp3
async function synthesize(text) {
  if (!text || !text.trim()) return null;
  const res = await client.audio.speech.create({
    model: 'tts-1-hd',   // HD quality — clearer, more natural
    voice: 'fable',       // British, elegant, warm voice
    speed: currentSpeed,
    input: text.slice(0, 4096),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString('base64');
}

// Synthesize multiple sentences in parallel, return ordered base64 array
// Use for streaming: synthesize sentence 1 while sentence 2 is still being generated
async function synthesizeChunks(sentences) {
  if (!sentences.length) return [];
  const results = await Promise.all(
    sentences.map(s => synthesize(s).catch(() => null))
  );
  return results.filter(Boolean);
}

module.exports = { synthesize, synthesizeChunks, setSpeed };
