// Opens the Image Studio for real and photographs it, because the whole
// complaint was about how it looked. Measuring is not enough here.
//
//   npx electron build/image-studio-probe.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Your Own Personal AI');
app.disableHardwareAcceleration();

const OUT = path.join(__dirname, 'image-studio-shot.png');
// A real picture, drawn here, so nothing has to be fetched over the network.
const SAMPLE = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#6b4a2f"/><stop offset="1" stop-color="#2b1d12"/>'
  + '</linearGradient></defs><rect width="640" height="640" fill="url(#g)"/>'
  + '<circle cx="320" cy="300" r="150" fill="#c88a4a" opacity="0.85"/>'
  + '<text x="320" y="315" font-family="serif" font-size="40" fill="#2b1d12" '
  + 'text-anchor="middle">sample</text></svg>',
).toString('base64');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 820, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // The studio on its own, with the app's real stylesheet behind it, so what
  // is photographed is what ships.
  const studio = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'image-studio.js'), 'utf8');
  const css = path.join(__dirname, '..', 'renderer', 'style.css');
  // Written into the renderer folder so style.css resolves the way it does
  // in the app. A data: URL cannot load a file:// stylesheet, and a hidden
  // window never paints - both of which make this photograph nothing.
  const tmp = path.join(__dirname, "..", "renderer", "_probe-image-studio.html");
  fs.writeFileSync(tmp, "<!doctype html><html><head><meta charset=\"utf-8\">"
    + "<link rel=\"stylesheet\" href=\"style.css\">"
    + "<style>html,body{margin:0;height:100%;background:#070a14}</style>"
    + "</head><body></body></html>");
  process.on("exit", () => { try { fs.unlinkSync(tmp); } catch (_) {} });
  await win.loadFile(tmp);

  // The trailing 1 matters: executeJavaScript sends the last value back over
  // IPC, and an object full of functions cannot be cloned.
  await win.webContents.executeJavaScript('window.jarvis = { openUrl(){}, saveImage(){ return {ok:true}; } };1');
  await win.webContents.executeJavaScript(studio + ';1');

  // Loading first: the ring is half the point of it being a studio.
  await win.webContents.executeJavaScript(
    'CallistoImageStudio.onRegenerate(function(){});'
    + 'CallistoImageStudio.showLoading({ title: "a dragon", prompt: "a dragon" });1',
  );
  await new Promise((r) => setTimeout(r, 2500));
  const ring = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'image-studio-loading.png'), ring.toPNG());

  // What the loading state must NOT be offering. "Make another" showing here
  // invites you to repeat a picture that does not exist yet.
  const loading = await win.webContents.executeJavaScript(`(function(){
    const a = document.querySelector('#isAgain');
    const d = document.querySelector('#isDownload');
    return {
      againVisible: !!a && a.getBoundingClientRect().width > 0,
      downloadEnabled: !!d && !d.disabled,
      ringVisible: !document.querySelector('#isRing').hidden,
    };
  })()`);

  // Then the finished picture.
  await win.webContents.executeJavaScript(
    'CallistoImageStudio.open(' + JSON.stringify(SAMPLE)
    + ', { title: "a dragon", prompt: "a fearsome bronze dragon, oil painting, dramatic light" });1',
  );
  await new Promise((r) => setTimeout(r, 1400));

  const state = await win.webContents.executeJavaScript(`(function(){
    const q = (s) => document.querySelector(s);
    const img = q('#isImg');
    return {
      open: CallistoImageStudio.isOpen(),
      eyebrow: (q('.mv-eyebrow') || {}).textContent || '',
      title: (q('#isTitle') || {}).textContent || '',
      imgShown: !!img && !img.hidden && img.classList.contains('is-shown'),
      imgWidth: img ? img.getBoundingClientRect().width : 0,
      downloadLabel: (q('#isDownload span') || {}).textContent || '',
      downloadEnabled: !!q('#isDownload') && !q('#isDownload').disabled,
      againShown: !!q('#isAgain') && !q('#isAgain').hidden,
      promptShown: !!q('#isPrompt') && !q('#isPrompt').hidden,
      promptText: (q('#isPrompt') || {}).textContent || '',
      ringHidden: !!q('#isRing') && q('#isRing').hidden,
      status: (q('#isStatus') || {}).textContent || '',
    };
  })()`);

  const shot = await win.webContents.capturePage();
  fs.writeFileSync(OUT, shot.toPNG());

  let bad = 0;
  const check = (what, got, want) => {
    const ok = got === want;
    if (!ok) bad++;
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (ok ? '' : '  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
  };
  check('while loading: the ring is showing', loading.ringVisible, true);
  check('while loading: make another is hidden', loading.againVisible, false);
  check('while loading: download is disabled', loading.downloadEnabled, false);
  check('the studio is open', state.open, true);
  check('it says it is a studio', /IMAGE STUDIO/.test(state.eyebrow), true);
  check('titled with the prompt', state.title, 'a dragon');
  check('the picture is shown', state.imgShown, true);
  check('and is a decent size', state.imgWidth > 300, true);
  check('the ring is gone', state.ringHidden, true);
  check('download is a proper button', state.downloadLabel, 'Download');
  check('and is enabled', state.downloadEnabled, true);
  check('make another is offered', state.againShown, true);
  check('the prompt is shown', state.promptShown, true);
  check('with the prompt in it', /fearsome bronze dragon/.test(state.promptText), true);
  check('no error showing', state.status, '');

  console.log('\n  loading: ' + path.join(__dirname, 'image-studio-loading.png'));
  console.log('  done:    ' + OUT);
  app.exit(bad ? 1 : 0);
});
