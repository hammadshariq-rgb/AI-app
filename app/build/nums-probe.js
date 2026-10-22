// What the numbers dashboard actually looks like with every platform connected.
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
app.setName('Your Own Personal AI'); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 760, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const web = fs.readFileSync(path.join(__dirname,'..','..','web','index.html'),'utf8');
  // Just the dashboard's own code, with the data call stubbed.
  const a = web.indexOf('  function numsStyles(){');
  const b = web.indexOf('  window._showNumbers = showNums;');
  if (a < 0 || b < 0) throw new Error('could not find the dashboard in web/index.html');
  const src = web.slice(a, b);
  const tmp = path.join(__dirname, 'nums.html');
  fs.writeFileSync(tmp, '<!doctype html><html><head><meta charset="utf-8">'
    + '<style>html,body{margin:0;height:100%;background:#060912;font-family:system-ui,sans-serif}'
    + ':root{--brand:system-ui}</style></head><body><script>'
    + 'var token="x";function showAuthForced(){}\n'
    + 'async function fetchWebStats(){return {stats:{'
    + 'stripe:{currency:"USD",today:240,todayCount:12,week:1480},'
    + 'youtube:{channel:"Callisto AI",subscribers:5600,views:912000,videos:48,latest:{views:14200}},'
    + 'instagram:{username:"callisto.ai",followers:1240,posts:86,latest:{likes:8300,comments:214}},'
    + 'tiktok:{username:"callistoai",followers:9800,likes:44000,videos:31,latest:{views:120400}},'
    + 'analytics:{site:"callistoai.net",visitors:312,pageViews:1840,sessions:410}}};}\n'
    + src + '\nshowNums(false);<' + '/script></body></html>');
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (_) {} });
  await win.loadFile(tmp);
  await new Promise(r=>setTimeout(r,2000));
  const st = await win.webContents.executeJavaScript(`(function(){
    const g=document.getElementById('ndGrid');
    return {cards:g.children.length,
      names:[...g.querySelectorAll('.nd-name')].map(e=>e.textContent).join(' | '),
      bigs:[...g.querySelectorAll('.nd-big')].map(e=>e.textContent).join(' | ')};
  })()`);
  const img = await win.webContents.capturePage();
  const buf = img.toPNG();
  fs.writeFileSync(path.join(__dirname,'nums-shot.png'), buf);
  console.log('  shot bytes: '+buf.length);
  await new Promise(r=>setTimeout(r,300));
  console.log('  cards: '+st.cards);
  console.log('  '+st.names);
  console.log('  '+st.bigs);
  app.exit(0);
});
