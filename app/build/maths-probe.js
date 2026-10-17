// Renders a geometric-sequence question, sends it through the real
// /ai/screen-read, and checks the answer is laid out as steps rather than
// crammed into one paragraph.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 520, show: true, x: 0, y: 0,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  const SUBJECTS = {
    chemistry: `<body style="margin:0;background:#fff;font-family:Georgia,serif;color:#111;padding:40px">
      <h2>Question 5 — Chemistry</h2>
      <p style="font-size:18px">Calculate the mass of carbon dioxide produced when 24.0 g of carbon
      is burned completely in excess oxygen.</p>
      <p style="font-size:18px">C + O<sub>2</sub> &rarr; CO<sub>2</sub></p>
      <p style="font-size:16px">(A<sub>r</sub>: C = 12, O = 16)</p></body>`,

    physics: `<body style="margin:0;background:#fff;font-family:Georgia,serif;color:#111;padding:40px">
      <h2>Question 7 — Physics</h2>
      <p style="font-size:18px">A car of mass 1200 kg accelerates uniformly from rest to 24 m/s
      in 8.0 s along a straight horizontal road.</p>
      <ol style="font-size:17px;line-height:2">
        <li>Calculate the acceleration.</li>
        <li>Calculate the resultant force on the car.</li>
        <li>Calculate the work done on the car.</li>
      </ol></body>`,

    biology: `<body style="margin:0;background:#fff;font-family:Georgia,serif;color:#111;padding:40px">
      <h2>Question 2 — Biology</h2>
      <p style="font-size:18px">A plant is placed in bright light. Explain how the rate of
      photosynthesis changes as light intensity increases, and why it eventually levels off.</p>
      <p style="font-size:16px">(4 marks)</p></body>`,
  };

  const Store = require('electron-store');
  const { safeStorage } = require('electron');
  const raw = new Store().get('authToken');
  const token = raw && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw;
  const base = process.env.LICENSE_SERVER_URL || 'https://ai-app-production-9224.up.railway.app';

  for (const [subject, page] of Object.entries(SUBJECTS)) {
    await win.loadURL('data:text/html,' + encodeURIComponent(page));
    await new Promise((r) => setTimeout(r, 900));
    const img = await win.webContents.capturePage();

    const t0 = Date.now();
    const res = await fetch(base + '/ai/screen-read', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: img.toDataURL(),
        question: 'They asked this out loud while you were watching their screen: "solve this question"',
        today: new Date().toDateString(),
      }),
    });
    const out = await res.json().catch(() => ({}));
    const text = String(out.text || out.error || '(empty)');
    const lines = text.split(String.fromCharCode(10)).filter((l) => l.trim());

    console.log(String.fromCharCode(10) + '================ ' + subject.toUpperCase() + ' ================');
    console.log('  ' + (Date.now() - t0) + 'ms, ' + text.length + ' chars, ' + lines.length + ' lines');
    const BS = String.fromCharCode(92);
    const latexRe = new RegExp([BS + BS + 'frac', BS + BS + 'left', BS + BS + 'right', BS + BS + '[(]', '[$][$]'].join('|'));
    console.log('  LaTeX      : ' + latexRe.test(text));
    console.log('  stepped    : ' + (lines.length >= 5));
    console.log('  has Answer : ' + /answer\s*:/i.test(text));
    console.log('  names rule : ' + /formula|equation|rule|law|because|since|principle/i.test(text));
    console.log('---');
    console.log(text);
  }

  app.quit();
});
