// Launches the real app, lets it settle, and reports anything that broke:
// renderer console errors, failed loads, and whether the things changed in
// this round are actually present at runtime.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP = path.join(__dirname, '..');
const electron = require('electron');

// The installed Callisto holds the single-instance lock, which is keyed on the
// profile directory - so the test instance gets its own, or it quits on start
// without printing a thing.
const PROFILE = path.join(require('os').tmpdir(), 'callisto-smoke-profile');

// --enable-logging makes renderer console output come back on stderr, which is
// where a broken index.html would actually show up.
const child = spawn(electron, [APP, '--user-data-dir=' + PROFILE, '--enable-logging'], {
  cwd: APP,
  env: { ...process.env, CALLISTO_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
const keep = (buf) => { out += buf.toString(); };
child.stdout.on('data', keep);
child.stderr.on('data', keep);

const SECONDS = Number(process.env.SMOKE_SECONDS || 25);
setTimeout(() => {
  child.kill();
  const lines = out.split(/\r?\n/);

  const noise = /GPU|gpu_|cache_util|disk_cache|DevTools|Autofill|Electron Security|chrome_|dxgi|d3d|vulkan|Skia|libva|Failed to create GL|GLES|Passthrough|ANGLE|swiftshader|Gpu Cache|SharedImage|media_foundation|dav1d|registered_|CreateInstance|Vulkan|EGL/i;
  const bad = lines.filter((l) =>
    /error|exception|cannot read|undefined is not|is not a function|unhandled|failed to load|ERR_/i.test(l)
    && !noise.test(l));

  console.log('=== app output, ' + SECONDS + 's ===');
  const marks = [
    ['tray created', /tray created/i],
    ['overlay window created', /overlay window created/i],
    ['shortcuts bound', /shortcut|bound/i],
  ];
  for (const [label, re] of marks) {
    console.log((lines.some((l) => re.test(l)) ? '  seen    ' : '  MISSING ') + label);
  }

  console.log('\n=== problems (' + bad.length + ') ===');
  if (!bad.length) console.log('  none');
  else bad.slice(0, 25).forEach((l) => console.log('  ' + l.trim().slice(0, 160)));

  fs.writeFileSync(path.join(__dirname, 'smoke-output.txt'), out);
  console.log('\nfull output: build/smoke-output.txt (' + lines.length + ' lines)');
  process.exit(bad.length ? 1 : 0);
}, SECONDS * 1000);
