// The website's chat bubbles, rendered with the real stylesheet, so the new
// look and the Copy/Stop buttons can be seen rather than assumed.
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
app.setName('Your Own Personal AI'); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 860, height: 620, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const web = fs.readFileSync(path.join(__dirname,'..','..','web','index.html'),'utf8');
  // Just the bubble rules out of the page's own <style>.
  const css = (web.match(/\.mrow[\s\S]*?#stopBtn \{[^}]*\}/) || [''])[0];
  const tmp = path.join(__dirname, 'webchat.html');
  fs.writeFileSync(tmp, `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{--border:rgba(255,255,255,.1);--text:#dbe5ff}
    html,body{margin:0;height:100%;background:#070b14;font-family:system-ui;padding:26px}
    .mrow{display:flex;gap:10px;margin:14px 0;align-items:flex-start}
    .mrow.user{flex-direction:row-reverse}
    .mav{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;
      justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
    .mav.ai{background:#3d5cff;color:#fff}.mav.usr{background:#2a3350;color:#cfe0ff}
    ${css}
  </style></head><body>
    <div class="mrow user"><div class="mav usr">H</div><div class="mbub user"><p>build me a 3d model of a car</p></div></div>
    <div class="mrow"><div class="mav ai">C</div><div class="mbub ai"><p><strong>Making 3D models</strong> is only in the downloaded app — this page cannot do it.</p><p>Callisto on your computer can, along with everything else here. <a class="mbub-link" href="#">Download it</a> — it is free.</p><div class="mbub-bar" style="opacity:1"><button class="mbub-btn">Copy</button></div></div></div>
    <div style="margin-top:22px;display:flex;gap:10px;align-items:center">
      <span style="color:#6f86b8;font-size:12px">input bar:</span>
      <button id="stopBtn" style="width:34px;height:34px;border-radius:9px">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="white"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      </button>
      <span style="color:#6f86b8;font-size:12px">(replaces send while answering)</span>
    </div>
  </body></html>`);
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (_) {} });
  await win.loadFile(tmp);
  await new Promise(r=>setTimeout(r,900));
  const buf = (await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(__dirname,'webchat-shot.png'), buf);
  console.log('  css rules found: ' + (css ? 'yes' : 'NO') + '   shot bytes: ' + buf.length);
  await new Promise(r=>setTimeout(r,200));
  app.exit(0);
});
