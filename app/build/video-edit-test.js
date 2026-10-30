// Real renders with FFmpeg: a generated test clip goes through a full edit, and
// the result is measured. Run: node build/video-edit-test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const ve = require('../src/services/videoedit');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x || ''); } };

(async () => {
  const bin = ve.ffmpegPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-'));
  const src = path.join(dir, 'in.mp4');
  execFileSync(bin, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=15:s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=d=15', '-shortest', '-pix_fmt', 'yuv420p', src]);
  const silent = path.join(dir, 'quiet.mp4');
  execFileSync(bin, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=6:s=640x360:r=30', '-pix_fmt', 'yuv420p', silent]);
  const out = path.join(dir, 'out');
  const len = async (f) => (await ve.probe(bin, f)).duration;

  const a = await ve.edit({ input: src, outputDir: out, plan: {
    segments: [{ start: 8, end: 12 }, { start: 0, end: 4 }, { start: 4, end: 8 }],
    transition: 'dissolve', transition_seconds: 0.5, brightness: 0.1, contrast: 1.2, saturation: 1.3, warmth: 0.5, vignette: true, fade_in: 1, fade_out: 1,
    captions: [
      { text: "It's: 100% \"real\" % 'quotes' \\ {x}", font: 'impact', position: 'top', colour: 'yellow', box: true },
      { text: 'Second line', font: 'serif', start: 2, end: 4, size: 40 },
    ],
  } });
  ok('full edit renders', a.ok, a.error);
  if (a.ok) { const d = await len(a.output); ok('length after transitions', Math.abs(d - 11) < 0.3, d); ok('keeps sound', (await ve.probe(bin, a.output)).hasAudio); }

  const b = await ve.edit({ input: src, outputDir: out, plan: { speed: 2, captions: [{ text: 'fast' }] } });
  ok('speed renders', b.ok, b.error);
  if (b.ok) { const d = await len(b.output); ok('half length at double speed', Math.abs(d - 7.5) < 0.3, d); }

  const c = await ve.edit({ input: src, outputDir: out, plan: { segments: [{ start: 0, end: 3 }, { start: 5, end: 7 }] } });
  ok('plain cut renders', c.ok, c.error);
  if (c.ok) ok('plain cut length', Math.abs((await len(c.output)) - 5) < 0.3);

  const q = await ve.edit({ input: silent, outputDir: out, plan: { transition: 'wipe', segments: [{ start: 0, end: 3 }, { start: 3, end: 6 }] } });
  ok('video with no sound renders', q.ok, q.error);

  const z = await ve.edit({ input: src, outputDir: out, plan: { brightness: 99, speed: 50, segments: [{ start: -5, end: 9999 }], captions: [{ text: 'x', colour: "red';rm -rf", font: '../../evil' }] } });
  ok('wild values are limited, not obeyed', z.ok, z.error);
  const clean = ve.cleanPlan({ transition: 'evil', speed: 50, captions: [{ text: 'x', colour: "red';x", font: 'evil' }] }, 10);
  ok('bad colour refused', clean.captions[0].colour === 'white');
  ok('bad font refused', clean.captions[0].font === 'bold');
  ok('speed limited', clean.speed === 2);
  ok('caption text never in the command', !ve.buildGraph(ve.cleanPlan({ captions: [{ text: 'SECRETWORD' }] }, 10), { hasAudio: false, finalDuration: 10 }).includes('SECRETWORD'));
  ok('missing file is explained', !!(await ve.edit({ input: path.join(dir, 'no.mp4'), outputDir: out, plan: {} })).error);

  const g = require('../../server/contentguard');
  for (const t of ['a nude woman', 'NSFW art', 'make her naked', 'erotic poster', 'sexy girl dancing']) ok('blocks: ' + t, g.looksSexual(t));
  for (const t of ['a sunset over Essex', 'poster for my gym', 'a basket of fruit', 'a dog in a hat', 'sussex county map']) ok('allows: ' + t, !g.looksSexual(t));
  let flag = false;
  const fake = { moderations: { create: async () => ({ results: [{ categories: { sexual: true } }] }) } };
  flag = await g.moderate(fake, 'wording a list misses', []);
  ok('moderation result is obeyed', flag === true);
  const down = { moderations: { create: () => new Promise(() => {}) } };
  ok('moderation hanging does not stop it', (await g.moderate(down, 'x', [], 50)) === false);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
