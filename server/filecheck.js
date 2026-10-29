// ── Is this file what it says it is? ─────────────────────────────────────────
// Every upload here arrives as base64 with a type the CLIENT names —
// "data:image/png;base64,…". Believing that label is how a script gets in
// wearing an image's name: rename evil.php to evil.png and the server would
// have said "a PNG, fine".
//
// So the bytes are read instead. Each real format starts with a fixed
// signature ("magic number"), and a file is accepted only if its signature is
// one we allow AND agrees with the label it came with. Anything that looks
// like markup or a server-side script anywhere near the start is refused
// outright, whatever it claims to be.
//
// Where uploads live, and why .php and .jsp cannot hurt: nothing uploaded is
// ever written to disk, given a file name, or run. It is held in memory for at
// most an hour and sent back with a fixed image/video Content-Type, nosniff,
// and a sandbox policy. This server is Node; it has no PHP or JSP engine to
// execute such a file even if one were somehow stored, and there is no path by
// which an upload becomes a file a web server would serve as code.

// signature check, in order of how common each is
const SIGNATURES = [
  { type: 'image/png',  test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { type: 'image/gif',  test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6)) },
  // MP4 / MOV: an ISO base-media box, with "ftyp" at byte 4.
  { type: 'video/mp4',  test: (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' && !/^qt  /.test(b.toString('ascii', 8, 12)) },
  { type: 'video/quicktime', test: (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' && /^qt  /.test(b.toString('ascii', 8, 12)) },
  // Audio for speech-to-text.
  { type: 'audio/webm', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { type: 'audio/wav',  test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  { type: 'audio/ogg',  test: (b) => b.length > 4 && b.toString('ascii', 0, 4) === 'OggS' },
  { type: 'audio/mpeg', test: (b) => b.length > 3 && (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  { type: 'audio/mp4',  test: (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' && /^M4A /.test(b.toString('ascii', 8, 12)) },
];

// Labels that mean the same container. A .mov labelled video/mp4 is ordinary.
const SAME = {
  'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg',
  'video/x-m4v': 'video/mp4', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4',
  'video/webm': 'audio/webm',          // a webm recording of a voice is still webm
};
const norm = (t) => { const s = String(t || '').toLowerCase().split(';')[0].trim(); return SAME[s] || s; };

// Things that must never get in, wherever they hide. Checked across the first
// 4KB, because a polyglot — a valid image with a script tucked inside — puts
// its payload after the header the signature check looks at.
const DANGEROUS = [
  /<\?php/i, /<\?=/, /<%[@=!\s]/, /<jsp:/i,            // PHP, JSP, ASP
  /<script[\s>]/i, /<html[\s>]/i, /<!doctype html/i,    // a web page
  /<svg[\s>]/i, /<iframe[\s>]/i, /javascript:/i,        // SVG and friends can carry script
  /^#!\//,                                              // a shell script
];
const EXECUTABLE = [
  (b) => b.length > 2 && b[0] === 0x4d && b[1] === 0x5a,                          // Windows .exe / .dll  "MZ"
  (b) => b.length > 4 && b[0] === 0x7f && b.toString('ascii', 1, 4) === 'ELF',     // Linux binary
  (b) => b.length > 4 && b.readUInt32BE(0) >>> 0 === 0xcafebabe,                   // Java class / Mach-O fat
  (b) => b.length > 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(b.readUInt32BE(0) >>> 0), // Mach-O
  (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04, // ZIP / JAR / docx
];

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  for (const s of SIGNATURES) if (s.test(buf)) return s.type;
  return null;
}

// Returns { ok: true, type } or { ok: false, reason, kind }.
//   allowed  - the types this particular route takes
//   declared - what the client said it was (may be empty)
function check(buf, { allowed, declared, maxBytes }) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: 'Empty file.', kind: 'empty' };
  if (maxBytes && buf.length > maxBytes) {
    return { ok: false, reason: `That file is too large (${Math.round(maxBytes / 1048576)} MB max).`, kind: 'too_big' };
  }

  for (const isExe of EXECUTABLE) {
    if (isExe(buf)) return { ok: false, reason: 'That file type is not allowed.', kind: 'executable' };
  }
  const head = buf.subarray(0, 4096).toString('latin1');
  for (const re of DANGEROUS) {
    if (re.test(head)) return { ok: false, reason: 'That file type is not allowed.', kind: 'script' };
  }

  const real = sniff(buf);
  if (!real) return { ok: false, reason: 'That file is not a supported image, video or audio format.', kind: 'unknown' };

  const allow = new Set((allowed || []).map(norm));
  if (!allow.has(real)) return { ok: false, reason: 'That file type is not allowed here.', kind: 'wrong_type' };

  // The label has to agree with the bytes. A mismatch is the renamed-file
  // trick even when both halves are individually harmless.
  const said = norm(declared);
  if (said && said !== real) {
    // Containers that genuinely share a signature are fine.
    const family = (t) => t.split('/')[0];
    const bothMp4ish = /mp4|quicktime/.test(said) && /mp4|quicktime/.test(real);
    if (!bothMp4ish && !(family(said) === 'audio' && family(real) === 'audio')) {
      return { ok: false, reason: 'That file is not what its name says it is.', kind: 'mismatch' };
    }
  }
  return { ok: true, type: real };
}

// Headers for serving something that came from a user. Even if a hostile file
// slipped past everything above, a browser told this cannot run it.
function safeServeHeaders(res, type) {
  res.set('Content-Type', type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cache-Control', 'no-store');
}

module.exports = { check, sniff, safeServeHeaders };
