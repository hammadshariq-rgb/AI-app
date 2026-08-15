/**
 * Google Docs & Slides creation — routes through the Railway server which uses
 * a service account to create the file, then makes it "anyone with link = editor".
 * This bypasses the OAuth scope restrictions caused by Google's verification review.
 */
const fetch      = require('node-fetch');
const Store      = require('electron-store');
const { safeStorage } = require('electron');

// Pull the server URL the same way connectors.js does
const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

const _store = new Store();

function _loadAuthToken() {
  const raw = _store.get('authToken');
  if (!raw) return null;
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); }
  catch { return raw; }
}

// ── Build Docs batchUpdate requests from the structured sections array ─────────

function buildDocsRequests(sections) {
  const textParts = [];
  const markers   = [];   // { start, end, style, isBullet }
  let idx = 1;            // Google Docs body starts at index 1

  for (const sec of (sections || [])) {
    if (!sec || !sec.type) continue;

    if (sec.type === 'heading') {
      const text = (sec.text || '') + '\n';
      markers.push({ start: idx, end: idx + text.length, style: 'HEADING_2' });
      textParts.push(text);
      idx += text.length;

    } else if (sec.type === 'subheading') {
      const text = (sec.text || '') + '\n';
      markers.push({ start: idx, end: idx + text.length, style: 'HEADING_3' });
      textParts.push(text);
      idx += text.length;

    } else if (sec.type === 'paragraph') {
      const text = (sec.text || '') + '\n';
      textParts.push(text);
      idx += text.length;

    } else if (sec.type === 'bullet_list') {
      for (const item of (sec.items || [])) {
        const text = (item || '') + '\n';
        markers.push({ start: idx, end: idx + text.length, isBullet: true });
        textParts.push(text);
        idx += text.length;
      }

    } else if (sec.type === 'table') {
      const headers = sec.headers || [];
      const rows    = sec.rows    || [];
      if (headers.length) {
        const headerLine = headers.join('  |  ') + '\n';
        markers.push({ start: idx, end: idx + headerLine.length, style: 'HEADING_3' });
        textParts.push(headerLine);
        idx += headerLine.length;
        const divider = headers.map(() => '───').join('──┼──') + '\n';
        textParts.push(divider);
        idx += divider.length;
      }
      for (const row of rows) {
        const rowLine = (row || []).join('  |  ') + '\n';
        textParts.push(rowLine);
        idx += rowLine.length;
      }
      textParts.push('\n');
      idx += 1;
    }
  }

  if (!textParts.length) return [];

  const allText  = textParts.join('');
  const requests = [];

  requests.push({ insertText: { location: { index: 1 }, text: allText } });

  for (const m of markers) {
    if (m.isBullet) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: m.start, endIndex: m.end - 1 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    } else {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: m.start, endIndex: m.end },
          paragraphStyle: { namedStyleType: m.style },
          fields: 'namedStyleType',
        },
      });
    }
  }

  return requests;
}

// ── Build Slides batchUpdate requests (without defaultSlide deletion) ──────────

const SLIDE_ACCENT  = { red: 0.102, green: 0.451, blue: 0.918 };
const SLIDE_BG_EVEN = { red: 1,     green: 1,     blue: 1     };
const SLIDE_BG_ODD  = { red: 0.941, green: 0.953, blue: 0.996 };

function buildSlidesRequests(slides) {
  const requests = [];
  for (let i = 0; i < slides.length; i++) {
    const slide   = slides[i];
    const slideId = `slide_${i}`;
    const titleId = `stitle_${i}`;
    const bodyId  = `sbody_${i}`;

    requests.push({
      createSlide: {
        objectId: slideId,
        slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
          { layoutPlaceholder: { type: 'BODY',  index: 0 }, objectId: bodyId  },
        ],
      },
    });
    requests.push({ insertText: { objectId: titleId, insertionIndex: 0, text: slide.heading || `Slide ${i + 1}` } });
    requests.push({ insertText: { objectId: bodyId,  insertionIndex: 0, text: (slide.bullets || []).join('\n') } });
    requests.push({
      updateTextStyle: {
        objectId: titleId, textRange: { type: 'ALL' },
        style: { bold: true, fontSize: { magnitude: 30, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: SLIDE_ACCENT } } },
        fields: 'bold,fontSize,foregroundColor',
      },
    });
    requests.push({
      updateTextStyle: {
        objectId: bodyId, textRange: { type: 'ALL' },
        style: { fontSize: { magnitude: 17, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: { red: 0.13, green: 0.13, blue: 0.13 } } } },
        fields: 'fontSize,foregroundColor',
      },
    });
    requests.push({
      updateSlideProperties: {
        objectId: slideId,
        slideProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: i % 2 === 0 ? SLIDE_BG_EVEN : SLIDE_BG_ODD } } } },
        fields: 'pageBackgroundFill',
      },
    });
  }
  return requests;
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function createGoogleDoc(title, sections) {
  const token = _loadAuthToken();
  if (!token) throw new Error('Not signed in to Jarvis');

  const requests = buildDocsRequests(sections);

  const res = await fetch(`${SERVER}/api/create-google-doc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, requests }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`Server error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Server failed to create doc');
  return data.url;
}

async function createGoogleSlides(title, slides) {
  const token = _loadAuthToken();
  if (!token) throw new Error('Not signed in to Jarvis');

  const requests = buildSlidesRequests(slides || []);

  const res = await fetch(`${SERVER}/api/create-google-slides`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, requests }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`Server error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Server failed to create slides');
  return data.url;
}

module.exports = { createGoogleDoc, createGoogleSlides };
