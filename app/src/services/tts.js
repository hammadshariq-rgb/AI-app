const fetch = require('node-fetch');
const Store = require('electron-store');
const store = new Store();

function getVoice() {
  const pref = store.get('profile.voice') || 'male';
  return pref === 'female' ? 'nova' : 'fable';
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
      body: JSON.stringify({ text: text.slice(0, 4096), voice: getVoice(), speed: currentSpeed }),
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
