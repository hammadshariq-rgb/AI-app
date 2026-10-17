// How big is the picture Callisto uploads for every screen read, and how much
// of the wait is simply sending it?
const { app, desktopCapturer, screen } = require('electron');
const path = require('path');
app.setPath('userData', path.join(app.getPath('temp'), 'callisto-size-probe'));

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  for (const w of [1600, 1280]) {
    const h = Math.round(w * (d.size.height / d.size.width));
    const t0 = Date.now();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    const shot = sources[0].thumbnail;
    const tGrab = Date.now() - t0;

    const t1 = Date.now();
    const png = shot.toDataURL();
    const tPng = Date.now() - t1;

    const t2 = Date.now();
    const jpg = 'data:image/jpeg;base64,' + shot.toJPEG(80).toString('base64');
    const tJpg = Date.now() - t2;

    const t3 = Date.now();
    const jpg90 = 'data:image/jpeg;base64,' + shot.toJPEG(90).toString('base64');
    const tJpg90 = Date.now() - t3;

    console.log(w + ' wide  (grab ' + tGrab + 'ms)');
    console.log('   PNG      ' + String(tPng).padStart(4) + 'ms  ' + (png.length / 1024 / 1024).toFixed(2) + ' MB   <- what it sends now');
    console.log('   JPEG q90 ' + String(tJpg90).padStart(4) + 'ms  ' + (jpg90.length / 1024 / 1024).toFixed(2) + ' MB');
    console.log('   JPEG q80 ' + String(tJpg).padStart(4) + 'ms  ' + (jpg.length / 1024 / 1024).toFixed(2) + ' MB');
    console.log('   saving   ' + Math.round(100 - (jpg90.length / png.length) * 100) + '% smaller at q90');
    console.log('');
  }
  app.quit();
});
