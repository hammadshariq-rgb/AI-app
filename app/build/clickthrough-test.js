// Which points on a see-through, full-screen window belong to Callisto, and
// which belong to whatever is behind it.
//
// The old answer was "any element that is not the body", and because the
// window is the size of the whole screen almost every point sits inside SOME
// container - so the answer was yes nearly everywhere, and a click meant for
// the browser behind came to Callisto instead. What should matter is whether
// anything under the pointer is actually painted.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Your Own Personal AI');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true } });

  const tmp = path.join(__dirname, '..', 'renderer', '_probe-ct.html');
  fs.writeFileSync(tmp, `<!doctype html><html><head><meta charset="utf-8">
    <style>
      html,body{margin:0;width:100vw;height:100vh;background:transparent;overflow:hidden}
      /* The see-through scaffolding the orb floats on - these must NOT count. */
      #wrap{position:fixed;inset:0}
      #col{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
      #spacer{width:400px;height:300px;background:transparent}
      #ghost{position:absolute;left:10px;top:10px;width:80px;height:80px;background:rgba(255,255,255,0.02)}
      /* Real, painted Callisto - these MUST count. */
      #panel{position:absolute;right:20px;top:20px;width:200px;height:150px;background:#101626}
      #glass{position:absolute;left:20px;bottom:20px;width:160px;height:90px;background:rgba(20,30,60,0.55)}
      #btn{position:absolute;left:300px;bottom:40px;width:120px;height:40px}
      #hiddenPanel{position:absolute;left:0;top:0;width:50px;height:50px;background:#101626;display:none}
    </style></head><body>
    <div id="wrap"><div id="col"><div id="spacer"></div></div>
      <div id="ghost"></div><div id="panel"></div><div id="glass"></div>
      <button id="btn">Press</button><div id="hiddenPanel"></div>
    </div></body></html>`);
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (_) {} });
  await win.loadFile(tmp);

  // The real function, lifted out of renderer.js rather than copied.
  const rend = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const a = rend.indexOf('  function isClickableEl(el) {');
  const b = rend.indexOf('  function applyClickThrough(overUI) {');
  if (a < 0 || b < 0) throw new Error('could not find isClickableEl in renderer.js');
  const src = rend.slice(a, b);
  if (src.indexOf('getComputedStyle') < 0) throw new Error('slice is missing the painted check');

  const out = await win.webContents.executeJavaScript(`(function(){
    ${src}
    const at = (x, y) => isClickableEl(document.elementFromPoint(x, y));
    // Aimed at where each element actually is, rather than at coordinates
    // worked out from the window size - the content area is shorter than the
    // window, so hard-coded points near the bottom landed outside it.
    const mid = (id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return at(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    };
    return {
      // See-through scaffolding: the click belongs to the app behind.
      middleOfNothing: mid('spacer'),
      overSpacer:      at(Math.round(innerWidth / 2), Math.round(innerHeight / 2)),
      topLeftGhost:    mid('ghost'),
      // Painted Callisto: the click is ours.
      solidPanel:      mid('panel'),
      glassPanel:      mid('glass'),
      aButton:         mid('btn'),
      // A panel that is there in the markup but not on screen.
      hiddenPanel:     (function(){ const h = document.getElementById('hiddenPanel');
                         h.style.display='block'; const r = mid('hiddenPanel');
                         h.style.display='none'; return r; })(),
      afterHiding:     at(10, 10),
    };
  })()`);

  let bad = 0;
  const check = (what, got, want) => {
    const ok = got === want;
    if (!ok) bad++;
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (ok ? '' : '  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
  };

  // These are the ones that were wrong, and that stole clicks from other apps.
  check('empty middle of the screen passes through', out.middleOfNothing, false);
  check('a see-through spacer passes through', out.overSpacer, false);
  check('a nearly-invisible layer passes through', out.topLeftGhost, false);

  // And these must still be Callisto, or none of its buttons work.
  check('a solid panel is Callisto', out.solidPanel, true);
  check('a glass panel is Callisto', out.glassPanel, true);
  check('a button is Callisto', out.aButton, true);

  check('a shown panel counts', out.hiddenPanel, true);
  check('and stops counting once hidden', out.afterHiding, false);

  console.log('\n  ' + (bad ? bad + ' FAILED' : 'all passed'));
  app.exit(bad ? 1 : 0);
});
