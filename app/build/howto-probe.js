// "How do I send an email?" while looking at Gmail should come back as the
// actual steps, naming the buttons that are on screen. This renders a
// Gmail-like page and asks exactly that.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

const GMAIL = `<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f6f8fc">
 <div style="display:flex;align-items:center;gap:16px;padding:10px 16px;background:#f6f8fc;border-bottom:1px solid #e0e0e0">
   <div style="font-size:22px">&#9776;</div>
   <div style="font-size:22px;color:#c5221f;font-weight:bold">M Gmail</div>
   <input style="flex:1;padding:10px 14px;border-radius:8px;border:0;background:#eaf1fb" value="Search mail">
   <div style="width:30px;height:30px;border-radius:50%;background:#1a73e8"></div>
 </div>
 <div style="display:flex">
   <div style="width:210px;padding:14px">
     <div style="background:#c2e7ff;border-radius:16px;padding:14px 22px;display:inline-block;font-size:15px">&#9998; Compose</div>
     <div style="margin-top:18px;font-size:14px;line-height:2.3">
       <div style="font-weight:bold">Inbox &nbsp;&nbsp;93</div>
       <div>Starred</div><div>Snoozed</div><div>Sent</div><div>Drafts &nbsp; 15</div><div>More</div>
     </div>
   </div>
   <div style="flex:1;background:#fff;border-radius:14px;margin:10px;padding:10px">
     <div style="font-size:13px;color:#5f6368;padding:8px 4px">Primary</div>
     <div style="border-top:1px solid #eee;padding:11px 4px;font-size:14px"><b>Meshy</b> &nbsp; Your receipt from Meshy #2772-6581</div>
     <div style="border-top:1px solid #eee;padding:11px 4px;font-size:14px"><b>SHARIQ TARIQ</b> &nbsp; Interac e-Transfer: You've received $115.20</div>
     <div style="border-top:1px solid #eee;padding:11px 4px;font-size:14px"><b>study</b> &nbsp; Automatic reply: admission</div>
   </div>
 </div></body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 640, show: true, x: 0, y: 0,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadURL('data:text/html,' + encodeURIComponent(GMAIL));
  await new Promise((r) => setTimeout(r, 1100));
  const img = await win.webContents.capturePage();
  win.hide();

  const Store = require('electron-store');
  const { safeStorage } = require('electron');
  const raw = new Store().get('authToken');
  const token = raw && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw;
  const base = process.env.LICENSE_SERVER_URL || 'https://ai-app-production-9224.up.railway.app';

  const asks = [
    'how do i send an email',
    'how do i find my drafts',
    'i cant figure out how to attach a file',
  ];
  for (const ask of asks) {
    const t0 = Date.now();
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
    const lines = text.split(String.fromCharCode(10)).filter((l) => l.trim());
    console.log(String.fromCharCode(10) + '=== ' + JSON.stringify(ask) + '  (' + (Date.now() - t0) + 'ms)');
    console.log('   lines: ' + lines.length + '   chars: ' + text.length);
    console.log('   numbered steps : ' + /(^|\n)\s*(?:1[.)]|step\s*1)/i.test(text));
    console.log('   names a control: ' + /compose|drafts|inbox|paperclip|attach/i.test(text));
    console.log('---');
    console.log(text);
  }
  app.quit();
});
