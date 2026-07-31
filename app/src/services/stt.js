const fetch = require('node-fetch');
const Store = require('electron-store');

const store = new Store();
const { safeStorage } = require('electron');
const SERVER = () => process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
function getToken() {
  const raw = store.get('authToken');
  if (!raw) return null;
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); }
  catch { return raw; }
}
const WHISPER_TIMEOUT_MS = 60000;

// Build a Whisper prompt that biases transcription toward the user's name,
// assistant name, and any VIP names — dramatically improves recognition of
// unusual/spelled-out names.
function buildWhisperPrompt() {
  const profile   = store.get('profile') || {};
  const assistantName = store.get('profile.name') || 'Jarvis';
  const displayName   = profile.displayName || '';
  const vipSenders    = store.get('vipSenders') || [];

  // Extract first names from VIP emails  e.g. "amnaweb122@gmail.com" → "Amna"
  const vipNames = vipSenders.map(v => {
    const local = v.split('@')[0];
    const m = local.match(/^([a-zA-Z]+)/);
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : '';
  }).filter(Boolean);

  const names = [...new Set([assistantName, displayName, ...vipNames].filter(Boolean))];
  // Whisper uses the prompt to bias decoding — include likely words/phrases
  return `${names.join(', ')}. Okay, ${assistantName}. Hey ${assistantName}. Send an email. Add a reminder. My name is ${displayName || 'the user'}.`;
}

// Collapse spelt-out letters: "H-A-M-M-A-D" or "H. A. M. M. A. D." → "HAMMAD"
// Also handles "H A M M A D" (space-separated single letters).
function collapseSpelledName(text) {
  // Pattern: single letters separated by hyphens, dots, or spaces (at least 3 letters)
  return text.replace(/\b([A-Za-z])(?:([-.\s])([A-Za-z])){2,}\b/g, (match) => {
    return match.replace(/[-.\s]/g, '').toUpperCase();
  });
}

async function transcribe(audioBuffer, _attempt = 1) {
  console.log('[STT] buffer bytes:', audioBuffer.length, `(attempt ${_attempt})`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  try {
    const res = await fetch(`${SERVER()}/ai/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ audio_b64: audioBuffer.toString('base64') }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`STT ${res.status}: ${errText}`);
    }

    const data = await res.json();
    let text = (data.text || '').trim();
    text = collapseSpelledName(text);
    console.log('[STT] transcript:', text);
    return text;
  } catch (err) {
    clearTimeout(timer);
    const retriable =
      err.name === 'AbortError' ||
      (err.message && (
        err.message.includes('Premature close') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('socket hang up') ||
        err.message.includes('network')
      ));

    if (retriable && _attempt < 3) {
      const delay = _attempt * 1500;
      console.warn(`[STT] Retrying in ${delay}ms (attempt ${_attempt})...`);
      await new Promise(r => setTimeout(r, delay));
      return transcribe(audioBuffer, _attempt + 1);
    }

    console.error('[STT] FAILED:', err.message);
    throw err;
  }
}

module.exports = { transcribe };
