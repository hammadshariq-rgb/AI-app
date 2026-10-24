// The camera panel, rendered with a still image standing in for the camera,
// so what it looks like can be seen rather than assumed.
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
app.setName('Your Own Personal AI'); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 760, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const tmp = path.join(__dirname, '..', 'renderer', '_probe-cam.html');
  fs.writeFileSync(tmp, '<!doctype html><html><head><meta charset="utf-8">'
    + '<style>html,body{margin:0;height:100%;background:#070a14;font-family:system-ui}</style>'
    + '</head><body></body></html>');
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (_) {} });
  await win.loadFile(tmp);
  await win.webContents.executeJavaScript('window.jarvis={cameraLook(){return {ok:true,text:"That jumper works well with the darker trousers - the collar is sitting a little uneven on the left."};}};1');
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'..','renderer','camera-look.js'),'utf8') + ';1');
  // No real camera here, so show the panel and put a still in the stage.
  await win.webContents.executeJavaScript(`(function(){
    CallistoCameraLook.start('how does this look');
    setTimeout(function(){
      var img = document.getElementById('clShot');
      var c = document.createElement('canvas'); c.width=640; c.height=360;
      var g = c.getContext('2d');
      var grd = g.createLinearGradient(0,0,640,360);
      grd.addColorStop(0,'#2b3a55'); grd.addColorStop(1,'#101726');
      g.fillStyle=grd; g.fillRect(0,0,640,360);
      g.fillStyle='#c88a4a'; g.beginPath(); g.arc(320,200,90,0,7); g.fill();
      g.fillStyle='#eef3ff'; g.font='20px system-ui'; g.textAlign='center';
      g.fillText('camera view', 320, 330);
      img.src = c.toDataURL(); img.hidden = false;
      document.getElementById('clVideo').hidden = true;
      document.getElementById('clCount').textContent = '';
      document.getElementById('clStatus').textContent = 'That jumper works well with the darker trousers - the collar is sitting a little uneven on the left.';
      document.getElementById('clAgain').hidden = false;
    }, 400);
  })();1`);
  await new Promise(r=>setTimeout(r,1600));
  const st = await win.webContents.executeJavaScript(`(function(){
    const q=s=>document.querySelector(s);
    return { open: CallistoCameraLook.isOpen(),
      title:(q('.cl-title')||{}).textContent||'',
      status:((q('#clStatus')||{}).textContent||'').slice(0,40),
      buttons:[...document.querySelectorAll('.cl-btn')].map(b=>b.textContent.trim()).join(' | ') };
  })()`);
  const buf = (await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(__dirname,'camlook-shot.png'), buf);
  console.log('  open: '+st.open+'  shot bytes: '+buf.length);
  console.log('  title: '+st.title);
  console.log('  buttons: '+st.buttons);
  await new Promise(r=>setTimeout(r,200));
  app.exit(0);
});
