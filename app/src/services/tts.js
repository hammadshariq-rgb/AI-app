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

// Sentences are spoken in the order they were asked for, so one request that
// never comes back holds up everything behind it. That is what a long silence
// in the middle of an answer was: not a pause, a stuck request. Nothing here is
// allowed to hang - it gets one quick retry and is then given up on, because a
// missing sentence is far better than a minute of nothing.
const TTS_TIMEOUT_MS = 20000;

async function synthesizeOnce(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER()}/ai/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({
        text: text.slice(0, 4096),
        ...getVoiceConfig(),
        speed: currentSpeed,
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.audio; // base64
  } finally {
    clearTimeout(timer);
  }
}

async function synthesize(text) {
  if (!text || !text.trim()) return null;
  try {
    return await synthesizeOnce(text);
  } catch (err) {
    console.error('[TTS] error:', err.message, '- retrying once');
    try {
      return await synthesizeOnce(text);
    } catch (err2) {
      console.error('[TTS] gave up:', err2.message);
      return null;
    }
  }
}

async function synthesizeChunks(sentences) {
  if (!sentences.length) return [];
  const results = await Promise.all(sentences.map(s => synthesize(s).catch(() => null)));
  return results.filter(Boolean);
}

module.exports = { synthesize, synthesizeChunks, setSpeed };
