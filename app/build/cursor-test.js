// Does the hand cursor actually click?
//
// Loads the real index.html, replaces MediaPipe and the camera with stubs, then
// feeds it a hand that opens and closes. A pinch should move the cursor and
// press whatever is under it. Reports every error the page throws, which is how
// the missing handScale would have shown up.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.setPath('userData', path.join(app.getPath('temp'), 'callisto-cursor-test'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: true, x: 0, y: 0,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'cursor-harness-preload.js'),
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || /error|not defined|not a function|undefined/i.test(message)) {
      errors.push(message);
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const result = await win.webContents.executeJavaScript(`
(async () => {
  const log = [];
  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errs.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));

  // ---- stub the camera ----
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  const cctx = canvas.getContext('2d');
  // Keep painting, or captureStream produces no frames at all and video.play()
  // never resolves - which stalls startGesture before it starts its loops.
  let tick = 0;
  setInterval(() => {
    tick++;
    cctx.fillStyle = tick % 2 ? '#123' : '#345';
    cctx.fillRect(0, 0, 320, 240);
  }, 40);
  const fakeStream = canvas.captureStream(20);
  navigator.mediaDevices.getUserMedia = async () => fakeStream;

  // ---- stub MediaPipe Hands ----
  let onResultsCb = null;
  window.Hands = function Hands() {
    return {
      setOptions() {},
      onResults(cb) { onResultsCb = cb; },
      send: async () => {},
      close() {},
    };
  };

  // A left hand, palm to camera. 21 landmarks; only the ones the cursor and
  // pinch use need to be realistic.
  //   0 wrist, 4 thumb tip, 8 index tip, 9 middle MCP, 12 middle tip
  function hand(pinch) {
    const lm = [];
    for (let i = 0; i < 21; i++) lm.push({ x: 0.5, y: 0.6, z: 0 });
    lm[0]  = { x: 0.50, y: 0.80, z: 0 };   // wrist
    lm[9]  = { x: 0.50, y: 0.55, z: 0 };   // middle knuckle -> span 0.25
    lm[12] = { x: 0.52, y: 0.40, z: 0 };   // middle tip
    lm[8]  = { x: 0.56, y: 0.38, z: 0 };   // index tip
    lm[4]  = pinch ? { x: 0.555, y: 0.385, z: 0 }   // thumb touching index
                   : { x: 0.38,  y: 0.62,  z: 0 };  // thumb well away
    // fingers up/down helpers read tips vs pips; keep them plausible
    lm[5] = { x: 0.56, y: 0.56 }; lm[6] = { x: 0.57, y: 0.48 }; lm[7] = { x: 0.57, y: 0.42 };
    lm[10] = { x: 0.50, y: 0.47 }; lm[11] = { x: 0.51, y: 0.43 };
    lm[13] = { x: 0.45, y: 0.56 }; lm[14] = { x: 0.44, y: 0.49 }; lm[16] = { x: 0.44, y: 0.42 };
    lm[17] = { x: 0.41, y: 0.58 }; lm[18] = { x: 0.40, y: 0.52 }; lm[20] = { x: 0.40, y: 0.46 };
    return lm;
  }

  // Something to click, right where the cursor will be.
  const target = document.createElement('button');
  target.id = '__clickTarget';
  target.textContent = 'target';
  Object.assign(target.style, {
    position: 'fixed', left: '0px', top: '0px',
    width: '100vw', height: '100vh', zIndex: 2147483647, opacity: '0.001',
  });
  let clicks = 0;
  target.addEventListener('click', () => { clicks++; });
  document.body.appendChild(target);

  // ---- turn gestures on ----
  const btn = document.getElementById('gestureToggleBtn');
  if (!btn) return { fatal: 'no gestureToggleBtn in the page' };
  btn.click();

  // Wait for startGesture to have built the model and registered onResults.
  for (let i = 0; i < 60 && !onResultsCb; i++) await new Promise(r => setTimeout(r, 100));
  if (!onResultsCb) return { fatal: 'gesture loop never started (onResults never registered)', errs };
  log.push('hand model wired after ' + 'startGesture');

  // Feed frames: open for a while (arms), then pinched (should fire).
  const feed = (pinch) => onResultsCb({
    multiHandLandmarks: [hand(pinch)],
    multiHandedness: [{ label: 'Left', score: 0.99 }],
  });

  for (let i = 0; i < 12; i++) { feed(false); await new Promise(r => setTimeout(r, 40)); }
  const openErrs = errs.length;
  for (let i = 0; i < 25; i++) { feed(true); await new Promise(r => setTimeout(r, 40)); }
  await new Promise(r => setTimeout(r, 400));

  const cur = document.getElementById('magicCursor');
  const gp = document.getElementById('gpActionText');
  const vid = document.querySelector('video');
  return {
    gpStatus: gp ? gp.textContent : '(none)',
    videoReady: vid ? { w: vid.videoWidth, h: vid.videoHeight, paused: vid.paused, hasSrc: !!vid.srcObject } : '(no video el)',
    clicks,
    cursorTransform: cur ? cur.style.transform : '(no cursor element)',
    cursorClasses: cur ? cur.className : '',
    errorsWhileOpen: openErrs,
    errorsTotal: errs.length,
    errs: errs.slice(0, 8),
    log,
  };
})()
  `).catch((e) => ({ fatal: 'injection failed: ' + e.message }));

  console.log(JSON.stringify(result, null, 2));
  if (errors.length) {
    console.log('\nconsole errors:');
    errors.slice(0, 10).forEach((e) => console.log('  ' + String(e).slice(0, 160)));
  }
  app.quit();
});
