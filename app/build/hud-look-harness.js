// Throwaway: load the real hud.html, hold the microphone open, stack two cards
// on top of it, and save a PNG. The pill and the card stack were pinned to the
// same corner, so this is here to look at them together rather than assume.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.HUD_OUT || path.join(__dirname, 'hud-look.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // Shown on purpose: a hidden window does not advance CSS animations, so
    // the cards sit at the opacity:0 their entry animation starts from and the
    // screenshot comes back empty.
    width: 480, height: 640, show: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'hud.html'));

  await win.webContents.executeJavaScript(`
    document.body.style.background = '#141022';
    require('electron').ipcRenderer.emit('hud:listening', {}, { sustained: true });
    require('electron').ipcRenderer.emit('hud:card', {}, {
      type: 'info',
      text: 'Watching your screen. Say what you need, then press Alt+Shift+C again.',
      ttl: 999000 });
    require('electron').ipcRenderer.emit('hud:card', {}, {
      type: 'info',
      text: '1. The common ratio is r = -7200 / 9000 = -4/5.  2. Using a_n = a_1 r^(n-1), a_25 = 9000(-4/5)^24 = 42.5013.  3. Since |r| < 1, S = 9000 / (1 + 4/5) = 5000.',
      ttl: 999000 });
    true;
  `);

  await new Promise((r) => setTimeout(r, 1400));

  // Measure as well as look: the pill must be visible, and must not be sitting
  // underneath a card.
  const geo = await win.webContents.executeJavaScript(`
    (() => {
      const pill = document.getElementById('listening');
      const stack = document.getElementById('stack');
      const pr = pill.getBoundingClientRect();
      const sr = stack.getBoundingClientRect();
      const cards = [...stack.children].map((c) => {
        const r = c.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
      });
      return {
        pillShown: getComputedStyle(pill).display !== 'none',
        pillHeld: pill.classList.contains('held'),
        bodyListening: document.body.classList.contains('listening'),
        pill: { top: Math.round(pr.top), bottom: Math.round(pr.bottom) },
        stack: { top: Math.round(sr.top), bottom: Math.round(sr.bottom) },
        overlap: sr.bottom > pr.top && sr.top < pr.bottom,
        cards,
        cardCount: stack.children.length,
      };
    })()
  `);
  console.log(JSON.stringify(geo, null, 2));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('wrote ' + OUT);
  app.quit();
});
