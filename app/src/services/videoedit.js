// Editing a video the person already has: captions in a chosen font, lighting
// and colour, the order and pace of it, transitions between the parts. Runs on
// their own computer with FFmpeg, so the file never leaves it. The AI only
// fills in a plan; every value is checked and limited here before use, and
// nothing it writes reaches a command line except as a checked number or a
// caption held in its own file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MAX_SECONDS = 180;

function ffmpegPath() {
  const p = require('ffmpeg-static');
  return p ? p.replace('app.asar', 'app.asar.unpacked') : null;
}

const FONTS = process.platform === 'win32'
  ? { sans: 'C:/Windows/Fonts/arial.ttf', bold: 'C:/Windows/Fonts/arialbd.ttf', impact: 'C:/Windows/Fonts/impact.ttf', serif: 'C:/Windows/Fonts/georgia.ttf', script: 'C:/Windows/Fonts/comic.ttf', mono: 'C:/Windows/Fonts/consola.ttf' }
  : process.platform === 'darwin'
    ? { sans: '/System/Library/Fonts/Supplemental/Arial.ttf', bold: '/System/Library/Fonts/Supplemental/Arial Bold.ttf', impact: '/System/Library/Fonts/Supplemental/Impact.ttf', serif: '/System/Library/Fonts/Supplemental/Georgia.ttf', script: '/System/Library/Fonts/Supplemental/Comic Sans MS.ttf', mono: '/System/Library/Fonts/Supplemental/Courier New.ttf' }
    : { sans: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' };

const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const COLOUR = /^(?:#[0-9a-f]{6}|white|black|yellow|red|blue|green|orange|pink|cyan|magenta|gold|purple)$/i;
const XFADE = { fade: 'fade', dissolve: 'dissolve', wipe: 'wipeleft', slide: 'slideleft', zoom: 'zoomin', blur: 'hblur' };

// Cleans what the AI sent. Times are clamped to the real length of the video.
function cleanPlan(raw, duration) {
  const p = raw || {};
  let segments = (Array.isArray(p.segments) ? p.segments : []).slice(0, 12)
    .map((s) => ({ start: num(s && s.start, 0, duration, 0), end: num(s && s.end, 0, duration, duration) }))
    .filter((s) => s.end - s.start >= 0.3);
  if (!segments.length) segments = [{ start: 0, end: duration }];
  const shortest = Math.min(...segments.map((s) => s.end - s.start));
  return {
    segments,
    transition: XFADE[p.transition] && segments.length > 1 ? p.transition : 'none',
    transitionSeconds: Math.min(num(p.transition_seconds, 0.2, 2, 0.6), shortest / 2),
    speed: num(p.speed, 0.5, 2, 1),
    brightness: num(p.brightness, -0.4, 0.4, 0),
    contrast: num(p.contrast, 0.5, 1.8, 1),
    saturation: num(p.saturation, 0, 2.5, 1),
    warmth: num(p.warmth, -1, 1, 0),
    vignette: !!p.vignette,
    fadeIn: num(p.fade_in, 0, 3, 0),
    fadeOut: num(p.fade_out, 0, 3, 0),
    captions: (Array.isArray(p.captions) ? p.captions : []).slice(0, 20).map((c) => ({
      text: String((c && c.text) || '').slice(0, 200),
      start: c && c.start != null ? num(c.start, 0, MAX_SECONDS, 0) : null,
      end: c && c.end != null ? num(c.end, 0, MAX_SECONDS, 0) : null,
      position: ['top', 'middle', 'bottom'].includes(c && c.position) ? c.position : 'bottom',
      font: FONTS[c && c.font] ? c.font : 'bold',
      size: num(c && c.size, 16, 140, 0) || 0,
      colour: COLOUR.test(String(c && c.colour)) ? c.colour : 'white',
      box: !!(c && c.box),
    })).filter((c) => c.text.trim()),
  };
}

const fontArg = (f) => "'" + f.replace(/:/g, '\\:') + "'";
const t3 = (n) => Number(n).toFixed(3);

// The FFmpeg arguments for a clean plan. Pure, so it can be tested on its own.
// Caption text is read from cap<N>.txt in the working folder, never put in here.
function buildGraph(plan, { hasAudio, finalDuration }) {
  const g = [];
  plan.segments.forEach((s, i) => {
    g.push(`[0:v]trim=start=${t3(s.start)}:end=${t3(s.end)},setpts=PTS-STARTPTS,fps=30,format=yuv420p,setsar=1[v${i}]`);
    if (hasAudio) g.push(`[0:a]atrim=start=${t3(s.start)}:end=${t3(s.end)},asetpts=PTS-STARTPTS,aresample=44100[a${i}]`);
  });
  const n = plan.segments.length;
  let vLast = 'v0', aLast = 'a0';
  if (n > 1 && plan.transition !== 'none') {
    let offset = 0;
    for (let i = 1; i < n; i++) {
      const prev = plan.segments[i - 1];
      offset += prev.end - prev.start - plan.transitionSeconds;
      g.push(`[${vLast}][v${i}]xfade=transition=${XFADE[plan.transition]}:duration=${t3(plan.transitionSeconds)}:offset=${t3(offset)}[vx${i}]`);
      vLast = `vx${i}`;
      if (hasAudio) { g.push(`[${aLast}][a${i}]acrossfade=d=${t3(plan.transitionSeconds)}[ax${i}]`); aLast = `ax${i}`; }
    }
  } else if (n > 1) {
    const ins = plan.segments.map((_, i) => `[v${i}]` + (hasAudio ? `[a${i}]` : '')).join('');
    g.push(`${ins}concat=n=${n}:v=1:a=${hasAudio ? 1 : 0}[vj]` + (hasAudio ? '[aj]' : ''));
    vLast = 'vj'; aLast = 'aj';
  }

  // xfade can run on past its last input, so the length is stated outright.
  const look = [`trim=duration=${t3(finalDuration * plan.speed)},setpts=PTS-STARTPTS`];
  if (plan.speed !== 1) look.push(`setpts=${t3(1 / plan.speed)}*PTS`);
  if (plan.brightness || plan.contrast !== 1 || plan.saturation !== 1) look.push(`eq=brightness=${t3(plan.brightness)}:contrast=${t3(plan.contrast)}:saturation=${t3(plan.saturation)}`);
  if (plan.warmth) { const w = t3(plan.warmth * 0.25); const c = t3(-plan.warmth * 0.25); look.push(`colorbalance=rm=${w}:gm=0:bm=${c}:rh=${w}:bh=${c}`); }
  if (plan.vignette) look.push('vignette=PI/4.5');
  if (plan.fadeIn) look.push(`fade=t=in:st=0:d=${t3(plan.fadeIn)}`);
  if (plan.fadeOut) look.push(`fade=t=out:st=${t3(Math.max(0, finalDuration - plan.fadeOut))}:d=${t3(plan.fadeOut)}`);
  plan.captions.forEach((c, i) => {
    const y = c.position === 'top' ? 'h*0.08' : c.position === 'middle' ? '(h-text_h)/2' : 'h*0.86-text_h';
    const size = c.size || 'h/16';
    const when = (c.start != null || c.end != null)
      ? `:enable='between(t,${t3(c.start || 0)},${t3(c.end != null ? c.end : finalDuration)})'` : '';
    look.push(`drawtext=fontfile=${fontArg(FONTS[c.font])}:textfile=cap${i}.txt:expansion=none:fontsize=${size}:fontcolor=${c.colour}:x=(w-text_w)/2:y=${y}:line_spacing=8:borderw=3:bordercolor=black@0.75`
      + (c.box ? ':box=1:boxcolor=black@0.5:boxborderw=14' : '') + when);
  });
  look.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  g.push(`[${vLast}]${look.join(',')}[vout]`);

  if (hasAudio) {
    const a = [];
    if (plan.speed !== 1) a.push(`atempo=${t3(plan.speed)}`);
    if (plan.fadeIn) a.push(`afade=t=in:st=0:d=${t3(plan.fadeIn)}`);
    if (plan.fadeOut) a.push(`afade=t=out:st=${t3(Math.max(0, finalDuration - plan.fadeOut))}:d=${t3(plan.fadeOut)}`);
    g.push(`[${aLast}]${a.length ? a.join(',') : 'anull'}[aout]`);
  }
  return g.join(';');
}

function finalLength(plan) {
  let d = plan.segments.reduce((s, x) => s + (x.end - x.start), 0);
  if (plan.transition !== 'none') d -= plan.transitionSeconds * (plan.segments.length - 1);
  return d / plan.speed;
}

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(String(stderr || ''));
    });
  });
}

// Length and whether there's sound, from what FFmpeg prints about the input.
async function probe(bin, input) {
  let text = '';
  try { await run(bin, ['-hide_banner', '-i', input]); } catch (e) { text = e.stderr || ''; }
  const m = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  return {
    duration: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0,
    hasAudio: /Stream #.*Audio:/.test(text),
  };
}

async function edit({ input, outputDir, plan: rawPlan }) {
  const bin = ffmpegPath();
  if (!bin || !fs.existsSync(bin)) return { error: 'The video editor is not available on this computer yet.' };
  if (!input || !fs.existsSync(input)) return { error: 'I could not find that video on your computer. Attach it with the + button and ask again.' };
  const info = await probe(bin, input);
  if (!info.duration) return { error: 'I could not read that video file.' };
  if (info.duration > MAX_SECONDS) return { error: `That video is too long to edit here. The limit is ${MAX_SECONDS / 60} minutes.` };

  const plan = cleanPlan(rawPlan, info.duration);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'callisto-edit-'));
  try {
    plan.captions.forEach((c, i) => fs.writeFileSync(path.join(work, `cap${i}.txt`), c.text, 'utf8'));
    fs.mkdirSync(outputDir, { recursive: true });
    const base = path.basename(input).replace(/\.[^.]+$/, '').replace(/ edited( \d+)?$/, '').slice(0, 60);
    const output = path.join(outputDir, `${base} edited ${Date.now()}.mp4`);
    const graph = buildGraph(plan, { hasAudio: info.hasAudio, finalDuration: finalLength(plan) });
    const args = ['-y', '-hide_banner', '-i', input, '-filter_complex', graph, '-map', '[vout]'];
    if (info.hasAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
    await run(bin, args, work);
    return { ok: true, output, seconds: finalLength(plan) };
  } catch (e) {
    console.warn('[videoedit]', String(e.stderr || e.message).slice(-600));
    return { error: 'That edit did not work on this video. Try asking for something simpler.' };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { edit, cleanPlan, buildGraph, finalLength, probe, ffmpegPath };
