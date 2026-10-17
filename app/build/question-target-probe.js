// "Solve question 3" came back with question 2. This reproduces the trap:
// several questions visible at once, each with its own 1/2/3 parts inside it,
// so the bare number matches the wrong block.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

const PAGE = `<body style="margin:0;background:#fff;font-family:Georgia,serif;color:#111;padding:28px;font-size:15px">
  <div style="border:1px solid #ccc;padding:14px;margin-bottom:16px">
    <b>Question 2</b> &nbsp;<span style="color:#666;font-size:12px">Calculator Allowed</span>
    <p>An arithmetic sequence has u<sub>1</sub> = 40, u<sub>2</sub> = 32, u<sub>3</sub> = 24.</p>
    <ol><li>Find the common difference, d.</li>
        <li>Find u<sub>9</sub>.</li>
        <li>Find S<sub>9</sub>.</li></ol>
  </div>
  <div style="border:1px solid #ccc;padding:14px">
    <b>Question 3</b> &nbsp;<span style="color:#666;font-size:12px">Calculator Allowed</span>
    <p>Only one of the following four sequences is geometric.</p>
    <p>a<sub>n</sub> = 1, 5, 10, 15, &hellip; &nbsp;&nbsp; c<sub>n</sub> = 1.5, 3, 4.5, 6, &hellip;</p>
    <p>b<sub>n</sub> = 1/2, 2/3, 3/4, 4/5, &hellip; &nbsp;&nbsp; d<sub>n</sub> = 2, 1, 1/2, 1/4, &hellip;</p>
    <ol><li>State which sequence is geometric and find its common ratio.</li>
        <li>Find the exact value of the eighth term, as a fraction.</li></ol>
  </div></body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 980, height: 640, show: true, x: 0, y: 0,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadURL('data:text/html,' + encodeURIComponent(PAGE));
  await new Promise((r) => setTimeout(r, 1100));
  const img = await win.webContents.capturePage();
  win.hide();

  const Store = require('electron-store');
  const { safeStorage } = require('electron');
  const raw = new Store().get('authToken');
  const token = raw && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw;
  const base = process.env.LICENSE_SERVER_URL || 'https://ai-app-production-9224.up.railway.app';

  // Q3 is geometric (ratio 1/2, eighth term 1/64). Q2 is arithmetic (d = -8).
  const asks = ['solve question 3', 'solve question 2', 'do question 3 part 2'];
  for (const ask of asks) {
    const res = await fetch(base + '/ai/screen-read', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: img.toDataURL(),
        question: 'They asked this out loud while you were watching their screen: "' + ask + '"',
        today: new Date().toDateString(),
      }),
    });
    const out = await res.json().catch(() => ({}));
    const text = String(out.text || out.error || '(empty)');
    const q3 = /geometric|1\/64|ratio/i.test(text);
    const q2 = /arithmetic|common difference|-8|\bd = /i.test(text);
    const want3 = /question 3|part 2/i.test(ask);
    const right = want3 ? (q3 && !/common difference/i.test(text)) : (q2 && !/1\/64/.test(text));
    console.log((right ? 'PASS  ' : 'FAIL  ') + JSON.stringify(ask)
      + '  -> ' + (q3 ? 'Q3-content ' : '') + (q2 ? 'Q2-content' : ''));
    console.log('   ' + text.split(String.fromCharCode(10))[0].slice(0, 120));
  }
  app.quit();
});
