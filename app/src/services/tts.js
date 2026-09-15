const fetch = require('node-fetch');
const Store = require('electron-store');
const store = new Store();

// OpenAI's voices each carry a fixed accent — fable is British, nova American, and
// there is no Australian at all. So we pick the closest base voice for each
// gender/accent pair and steer the rest with an instruction, which only the
// gpt-4o-mini-tts model honours. Base voices chosen to give the steering the least
// work: fable already sounds British, onyx and nova already sound American.
const VOICE_MATRIX = {
  'british-male':    { voice: 'fable',   accent: 'a natural British English (Received Pronunciation) accent' },
  'british-female':  { voice: 'shimmer', accent: 'a natural British English (Received Pronunciation) accent' },
  'american-male':   { voice: 'onyx',    accent: 'a natural General American accent' },
  'american-female': { voice: 'nova',    accent: 'a natural General American accent' },
  'australian-male': { voice: 'ash',     accent: 'a natural Australian English accent' },
  'australian-female': { voice: 'coral', accent: 'a natural Australian English accent' },
};

function getVoiceConfig() {
  const gender = store.get('profile.voice') || 'male';
  const accent = store.get('profile.accent') || 'british';
  const key = `${accent}-${gender}`;
  const entry = VOICE_MATRIX[key] || VOICE_MATRIX[`british-${gender}`] || VOICE_MATRIX['british-male'];
  return {
    voice: entry.voice,
    instructions: `Speak with ${entry.accent}. Sound like a calm, articulate personal assistant — warm and natural, never robotic or exaggerated. Keep the accent consistent throughout.`,
  };
}

const { safeStorage } = require('electron');
const SERVER = () => process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
function getToken() {
  const raw = store.get('authToken');
  if (!raw) return null;
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); }
  catch { return raw; }
}

let currentSpeed = 0.92;

function setSpeed(speed) {
  currentSpeed = Math.min(4.0, Math.max(0.25, Number(speed) || 0.88));
}

async function synthesize(text) {
  if (!text || !text.trim()) return null;
  try {
    const res = await fetch(`${SERVER()}/ai/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({
        text: text.slice(0, 4096),
        ...getVoiceConfig(),
        speed: currentSpeed,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.audio; // base64
  } catch (err) {
    console.error('[TTS] error:', err.message);
    return null;
  }
}

async function synthesizeChunks(sentences) {
  if (!sentences.length) return [];
  const results = await Promise.all(sentences.map(s => synthesize(s).catch(() => null)));
  return results.filter(Boolean);
}

module.exports = { synthesize, synthesizeChunks, setSpeed };
