// Putting a picture on the sketching canvas and drawing over it.
//
// The part worth proving is the export. The canvas is turned into a PNG by
// serialising the SVG and drawing it into a <canvas>, and an SVG loaded that
// way may not fetch anything external - a linked picture would be missing from
// every download, and would taint the canvas so saving threw. So the picture
// has to survive all the way into the PNG, and that is checked by reading the
// pixels back.
//
//   npx electron build/draw-image-probe.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Your Own Personal AI');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 860, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const tmp = path.join(__dirname, '..', 'renderer', '_probe-draw.html');
  fs.writeFileSync(tmp, '<!doctype html><html><head><meta charset="utf-8">'
    + '<link rel="stylesheet" href="style.css">'
    + '<style>html,body{margin:0;height:100%;background:#070a14}</style>'
    + '</head><body></body></html>');
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (_) {} });
  await win.loadFile(tmp);

  const studio = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'draw-studio.js'), 'utf8');
  await win.webContents.executeJavaScript('window.jarvis = { saveImage(){ return {ok:true}; } };1');
  await win.webContents.executeJavaScript(studio + ';1');

  // A picture with an unmistakable colour in it, so it can be found again in
  // the exported pixels rather than merely assumed to be there.
  const result = await win.webContents.executeJavaScript(`(async function(){
    CallistoDraw.show();

    // A solid magenta square, built here and handed over as a real File -
    // exactly what the file picker and a drop would produce.
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const g = c.getContext('2d');
    g.fillStyle = '#ff00aa'; g.fillRect(0, 0, 400, 300);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'test.png', { type: 'image/png' });

    const shape = await CallistoDraw.addImageFile(file);

    // Then draw over it, which is the whole point.
    CallistoDraw.apply({ shapes: [{ type: 'circle', cx: 500, cy: 500, r: 120, stroke: '#00ffcc', width: 14 }] });

    const shapes = CallistoDraw.exportShapes();
    const png = await CallistoDraw.toPng(1);

    // Read the exported PNG back and look for the magenta. If the picture did
    // not survive the export, it simply will not be in there.
    const found = await new Promise((resolve) => {
      if (!png) return resolve({ ok: false, why: 'toPng returned nothing' });
      const im = new Image();
      im.onerror = () => resolve({ ok: false, why: 'exported png would not load' });
      im.onload = () => {
        const cc = document.createElement('canvas');
        cc.width = im.width; cc.height = im.height;
        const gg = cc.getContext('2d');
        gg.drawImage(im, 0, 0);
        let magenta = 0, cyan = 0;
        const d = gg.getImageData(0, 0, cc.width, cc.height).data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gch = d[i+1], b = d[i+2];
          if (r > 200 && gch < 80 && b > 120 && b < 200) magenta++;
          if (r < 80 && gch > 200 && b > 150) cyan++;
        }
        resolve({ ok: true, magenta, cyan, w: im.width, h: im.height });
      };
      im.src = png;
    });

    return {
      shapeType: shape.type,
      hrefIsData: /^data:image\\//.test(shape.href || ''),
      // It must sit UNDER the drawing, or there is nothing to draw on.
      firstIsImage: shapes[0] && shapes[0].type === 'image',
      lastIsCircle: shapes[shapes.length-1] && shapes[shapes.length-1].type === 'circle',
      count: shapes.length,
      onCanvas: !!document.querySelector('#dsLayer image'),
      emptyHidden: document.querySelector('#dsEmpty').classList.contains('hidden'),
      describe: CallistoDraw.describe(),
      fitsCanvas: shape.x >= 0 && shape.y >= 0 && (shape.x + shape.w) <= 1000 && (shape.y + shape.h) <= 1000,
      aspectKept: Math.abs((shape.w / shape.h) - (400 / 300)) < 0.02,
      found,
    };
  })()`);

  await new Promise((r) => setTimeout(r, 600));
  const shot = await win.webContents.capturePage();
  const out = path.join(__dirname, 'draw-image-shot.png');
  fs.writeFileSync(out, shot.toPNG());

  let bad = 0;
  const check = (what, got, want) => {
    const ok = got === want;
    if (!ok) bad++;
    console.log((ok ? '  ok   ' : '  FAIL ') + what + (ok ? '' : '  got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
  };

  check('the file became an image shape', result.shapeType, 'image');
  check('embedded as data, not linked', result.hrefIsData, true);
  check('it sits under the drawing', result.firstIsImage, true);
  check('what you draw goes on top', result.lastIsCircle, true);
  check('it is on the canvas', result.onCanvas, true);
  check('the empty message is gone', result.emptyHidden, true);
  check('it fits on the canvas', result.fitsCanvas, true);
  check('its proportions are kept', result.aspectKept, true);
  check('Callisto is told a picture is there', /photograph the user added/.test(result.describe), true);
  check('and never the data url', result.describe.includes('data:image'), false);
  check('the export worked', result.found.ok, true);
  check('the picture is IN the exported png', (result.found.magenta || 0) > 5000, true);
  check('and so is what was drawn on it', (result.found.cyan || 0) > 200, true);

  console.log('\n  picture pixels in the export: ' + (result.found.magenta || 0));
  console.log('  drawing pixels in the export: ' + (result.found.cyan || 0));
  console.log('  shot: ' + out);
  app.exit(bad ? 1 : 0);
});
