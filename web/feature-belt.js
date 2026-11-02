/* The rotating belt of headline features, above the features grid. Stops under
   the pointer, drags with a flick, and a plate opens to say what it does. The
   maths is the sushi-conveyor component's stadium loop, in plain JavaScript
   because this site has no React. */
(function () {
  'use strict';
  const root = document.getElementById('featureBelt');
  if (!root) return;

  const ICON = {
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
    cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5L5 20"/>',
    hand: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-1V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V13a7 7 0 0 1-7 7c-3 0-4.5-1.5-6-4l-1.6-2.8a1.5 1.5 0 0 1 2.6-1.5L8 14"/>',
    tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
    pen: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  };
  const ITEMS = [
    { id: 'video', name: 'AI Video', where: 'App only', colour: '#ff5d73',
      text: 'Turn a sentence or a photo into a short video, then download it or post it to your socials.',
      facts: ['From text', 'From a photo', 'Video Studio'] },
    { id: 'cube', name: '3D Studio', where: 'App only', colour: '#8a7dff',
      text: 'Describe anything and get a coloured 3D model you can spin, zoom and change by voice or by hand.',
      facts: ['Voice edits', 'Hand control', 'Download'] },
    { id: 'image', name: 'Image Generation', where: 'Web + app', colour: '#39d0ff',
      text: 'Say what you want to see and Callisto draws it, ready to change, download or use in a video.',
      facts: ['From text', 'Edit by asking'] },
    { id: 'hand', name: 'Hand Control', where: 'App only', colour: '#3dffb4',
      text: 'Move the Callisto cursor with one hand and pinch to click, with gestures on the other. No keyboard or mouse.',
      facts: ['Pinch to click', 'Gestures', 'Your own poses'] },
    { id: 'tv', name: 'Cast to TV', where: 'App only', colour: '#ffb648',
      text: 'Say "play this on the TV" and Callisto finds your television and puts it on, with no remote.',
      facts: ['Chromecast', 'Voice'] },
    { id: 'pen', name: 'Sketching', where: 'Web + app', colour: '#ff7bd5',
      text: 'Draw on an open canvas with the pen, by voice, or with your hand, then turn the sketch into 3D or video.',
      facts: ['Pen and shapes', 'Say what to add'] },
  ];

  const SPACING = 1.35, CURVE = 0.95, BAND = 1.22, TILT = 0.8, KB = 0.68, SPEED = 26;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const svgIcon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  const css = document.createElement('style');
  css.textContent = `
    #featureBelt{--fb-belt:#141d33;--fb-side:#090e1c;--fb-rail:#51658f;--fb-island:#0d1426;--fb-text:#eef3ff;--fb-sub:rgba(185,205,245,.78);--fb-card:#0c1324;--fb-line:rgba(130,165,255,.2)}
    body.light #featureBelt{--fb-belt:#3a445c;--fb-side:#1f2638;--fb-rail:#aab6cf;--fb-island:#e6ebf5;--fb-text:#0d1630;--fb-sub:#4a5675;--fb-card:#fff;--fb-line:rgba(30,50,110,.16)}
    .fb-stage{position:relative;width:100%;max-width:1040px;margin:18px auto 0;touch-action:pan-y;user-select:none;overflow-x:clip}
    .fb-stage svg.fb-track{position:absolute;inset:0;overflow:visible;pointer-events:none}
    .fb-plate{position:absolute;left:0;top:0;padding:0;border:0;background:none;border-radius:50%;cursor:pointer;color:#fff;transform-origin:50% 50%;will-change:transform}
    .fb-plate:focus-visible{outline:2px solid #8fb4ff;outline-offset:4px}
    .fb-disc{position:absolute;inset:0;border-radius:50%;display:flex;align-items:center;justify-content:center;border:3px solid var(--c);
      background:radial-gradient(circle at 38% 30%,#2c3f78,#111a36 62%,#070b18);box-shadow:0 12px 20px -6px rgba(0,0,0,.7),inset 0 0 22px color-mix(in srgb,var(--c) 28%,transparent);transition:transform .25s cubic-bezier(.2,.9,.3,1.2)}
    .fb-disc svg{width:42%;height:52%;color:var(--c)}
    .fb-plate.on .fb-disc{transform:translateY(-7%) scale(1.09)}
    .fb-chip{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translate(-50%,4px);white-space:nowrap;padding:5px 10px;border-radius:99px;background:var(--fb-card);border:1px solid var(--fb-line);color:var(--fb-text);font-size:11px;font-weight:600;line-height:1;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none}
    .fb-plate.on .fb-chip{opacity:1;transform:translate(-50%,0)}
    .fb-caption{min-height:46px;max-width:520px;margin:10px auto 0;text-align:center;font-size:14px;line-height:1.5;color:var(--fb-sub)}
    .fb-caption b{color:var(--fb-text)}
    .fb-controls{display:flex;justify-content:center;gap:8px;margin-top:8px}
    .fb-controls button{width:36px;height:36px;border-radius:50%;border:1px solid var(--fb-line);background:var(--fb-card);color:var(--fb-text);cursor:pointer;font-size:14px}
    .fb-controls button:focus-visible,.fb-dialog button:focus-visible,.fb-dialog a:focus-visible{outline:2px solid #8fb4ff;outline-offset:2px}
    .fb-dialog{position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(3,6,14,.72);backdrop-filter:blur(10px)}
    .fb-box{position:relative;width:min(720px,100%);max-height:90vh;overflow:auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:28px;align-items:center;padding:30px;border-radius:26px;background:var(--fb-card);border:1px solid var(--fb-line);color:var(--fb-text);animation:fbIn .28s ease-out}
    .fb-figure{position:relative;aspect-ratio:1;max-width:230px;width:100%;margin:auto}
    .fb-box h3{font-size:28px;font-weight:600;margin:6px 0 8px;color:var(--fb-text)}
    .fb-where{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--fb-sub)}
    .fb-box p{font-size:14px;line-height:1.6;color:var(--fb-sub);margin:0 0 12px}
    .fb-facts{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0 0 16px;padding:0}
    .fb-facts li{font-size:12px;padding:4px 10px;border-radius:99px;border:1px solid var(--fb-line);color:var(--fb-sub)}
    .fb-cta{display:inline-block;padding:10px 20px;border-radius:99px;background:#2f6bff;color:#fff!important;text-decoration:none;font-size:14px;font-weight:600}
    .fb-close{position:absolute;top:12px;right:14px;background:none;border:0;color:var(--fb-sub);font:inherit;font-size:13px;cursor:pointer;padding:6px}
    @keyframes fbIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
    @media (max-width:560px){.fb-box{grid-template-columns:1fr;padding:24px 20px;text-align:center}.fb-figure{max-width:150px}.fb-facts{justify-content:center}}
    @media (prefers-reduced-motion:reduce){.fb-disc,.fb-chip{transition:none}.fb-box{animation:none}}`;
  document.head.appendChild(css);

  root.insertAdjacentHTML('beforeend', `
    <div class="fb-stage" role="group" aria-label="Headline features" aria-roledescription="rotating belt"></div>
    <div class="fb-controls">
      <button type="button" data-a="prev" aria-label="Previous feature">&#8249;</button>
      <button type="button" data-a="pause" aria-label="Pause belt" aria-pressed="false">&#10074;&#10074;</button>
      <button type="button" data-a="next" aria-label="Next feature">&#8250;</button>
    </div>
    <div class="fb-caption" aria-live="polite"></div>`);
  const stage = root.querySelector('.fb-stage');
  const caption = root.querySelector('.fb-caption');
  const IDLE = 'Hover to stop the belt, flick to spin it, pick a plate to see more.';
  caption.textContent = IDLE;

  const plates = ITEMS.map((it, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fb-plate'; b.tabIndex = i ? -1 : 0;
    b.setAttribute('aria-label', it.name + ', ' + it.where);
    b.setAttribute('aria-haspopup', 'dialog');
    b.style.setProperty('--c', it.colour);
    b.innerHTML = `<span class="fb-disc">${svgIcon(it.id)}</span><span class="fb-chip">${esc(it.name)}</span>`;
    stage.appendChild(b);
    return b;
  });

  let g = null, offset = 0, v = SPEED, active = null, paused = false, dialog = null, target = null;
  let raf = 0, last = 0, onScreen = true, drag = null;
  const svgNS = 'http://www.w3.org/2000/svg';
  const track = document.createElementNS(svgNS, 'svg');
  track.setAttribute('class', 'fb-track'); track.setAttribute('aria-hidden', 'true');
  stage.prepend(track);

  function along(u) {
    const { s, r, l } = g;
    let t = ((u % l) + l) % l;
    if (t < s) return { x: s / 2 - t, z: r, nx: 0, nz: 1 };
    t -= s;
    if (t < Math.PI * r) { const f = t / r; return { x: -s / 2 - r * Math.sin(f), z: r * Math.cos(f), nx: -Math.sin(f), nz: Math.cos(f) }; }
    t -= Math.PI * r;
    if (t < s) return { x: -s / 2 + t, z: -r, nx: 0, nz: -1 };
    t -= s;
    const f = Math.min(Math.PI, t / r);
    return { x: s / 2 + r * Math.sin(f), z: -r * Math.cos(f), nx: Math.sin(f), nz: -Math.cos(f) };
  }
  function project(x, z) {
    const k = g.a + g.b * z;
    return { x: g.cx + x * k, y: g.ym + TILT * (g.a * z + (g.b * z * z) / 2), k };
  }
  function edge(off) {
    let d = '';
    for (let j = 0; j < 140; j++) {
      const p = along((j / 140) * g.l), q = project(p.x + p.nx * off, p.z + p.nz * off);
      d += (j ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1);
    }
    return d + 'Z';
  }
  function layout() {
    const width = stage.clientWidth;
    if (!width) return;
    const n = ITEMS.length, spanPerD = 2.35;
    const d = Math.max(74, Math.min(140, width / (spanPerD * 1.72)));
    const l = n * SPACING * d;
    const r = Math.min(CURVE * d, l / (2 * Math.PI));
    const s = Math.max(0, (l - 2 * Math.PI * r) / 2);
    const prevL = g && g.l;
    g = { d, l, r, s, pitch: l / n, cx: width / 2, ym: 0, a: (1 + KB) / 2, b: (1 - KB) / (2 * r), band: BAND * d };
    let top = Infinity, bottom = -Infinity;
    for (let j = 0; j < 120; j++) {
      const p = along((j / 120) * l);
      const rim = project(p.x + p.nx * g.band / 2, p.z + p.nz * g.band / 2);
      const pl = project(p.x, p.z), half = pl.k * d * TILT / 2;
      top = Math.min(top, rim.y, pl.y - half * 1.2 - 34);
      bottom = Math.max(bottom, rim.y + d * 0.14, pl.y + half + d * 0.08);
    }
    g.ym = Math.ceil(-top) + 2;
    const h = Math.ceil(bottom - top) + 4;
    stage.style.height = h + 'px';
    track.setAttribute('width', width); track.setAttribute('height', h);
    track.setAttribute('viewBox', `0 0 ${width} ${h}`);
    const outer = edge(g.band / 2), inner = edge(-g.band / 2), side = Math.max(3, d * 0.07);
    track.innerHTML = `<path d="${outer}${inner}" fill-rule="evenodd" transform="translate(0 ${side})" style="fill:var(--fb-side)"/>
      <path d="${outer}${inner}" fill-rule="evenodd" style="fill:var(--fb-belt)"/>
      <path class="fb-seams" fill="none" stroke="#000" stroke-opacity=".4" stroke-width="${Math.max(1, d * 0.013)}"/>
      <path d="${outer}" fill="none" style="stroke:var(--fb-rail)" stroke-width="${Math.max(2, d * 0.026)}"/>
      <path d="${inner}" fill="none" style="stroke:var(--fb-rail)" stroke-width="${Math.max(1.6, d * 0.02)}"/>
      <path d="${inner}" style="fill:var(--fb-island)"/>`;
    plates.forEach((b) => { b.style.width = d + 'px'; b.style.height = d * TILT + 'px'; });
    offset = prevL ? offset * (l / prevL) : s / 2;
    paint();
  }
  function paint() {
    if (!g) return;
    plates.forEach((b, i) => {
      const p = along(offset - i * g.pitch), q = project(p.x, p.z);
      b.style.transform = `translate3d(${(q.x - g.d / 2).toFixed(2)}px,${(q.y - g.d * TILT / 2).toFixed(2)}px,0) scale(${q.k.toFixed(4)})`;
      b.style.zIndex = i === active ? 2000 : 100 + Math.round(q.y);
    });
    const seams = track.querySelector('.fb-seams');
    if (seams) {
      const count = Math.round(g.l / (0.34 * g.d)), half = g.band * 0.46;
      let d = '';
      for (let j = 0; j < count; j++) {
        const p = along(offset + j * g.l / count);
        const a = project(p.x - p.nx * half, p.z - p.nz * half), c = project(p.x + p.nx * half, p.z + p.nz * half);
        d += `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${c.x.toFixed(1)} ${c.y.toFixed(1)}`;
      }
      seams.setAttribute('d', d);
    }
  }
  function tick(now) {
    raf = 0;
    if (!g || !onScreen || document.hidden) { last = 0; return; }
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    const stopped = paused || active !== null || dialog;
    if (target !== null) {
      v += (31 * (target - offset) - 11 * v) * dt;
      offset += v * dt;
      if (Math.abs(target - offset) < 0.4 && Math.abs(v) < 5) { offset = target; v = 0; target = null; }
    } else if (!drag) {
      const goal = stopped || reduced() ? 0 : SPEED;
      v = goal + (v - goal) * Math.exp(-(stopped ? 7 : 2.6) * dt);
      if (Math.abs(v - goal) < 0.02) v = goal;
      offset += v * dt;
    }
    paint();
    if (drag || target !== null || v !== 0) raf = requestAnimationFrame(tick);
    else last = 0;
  }
  const kick = () => { if (!raf) { last = 0; raf = requestAnimationFrame(tick); } };

  function setActive(i) {
    if (active === i) return;
    active = i;
    plates.forEach((b, k) => { b.classList.toggle('on', k === i); b.tabIndex = k === (i === null ? 0 : i) ? 0 : -1; });
    if (i === null) caption.textContent = IDLE;
    else caption.innerHTML = `<b>${esc(ITEMS[i].name)}</b> · ${esc(ITEMS[i].where)}<br>${esc(ITEMS[i].text)}`;
    paint(); kick();
  }
  function seek(i) {
    if (!g) return;
    const base = g.s / 2 + i * g.pitch;
    target = base + Math.round((offset - base) / g.l) * g.l;
    if (reduced()) { offset = target; target = null; v = 0; paint(); return; }
    kick();
  }
  function step(by, focus) {
    const n = ITEMS.length;
    const from = active !== null ? active : ((Math.round((offset - g.s / 2) / g.pitch) % n) + n) % n;
    const i = ((from + by) % n + n) % n;
    setActive(i); seek(i);
    if (focus) plates[i].focus({ preventScroll: true });
  }

  function openDialog(i) {
    const it = ITEMS[i], back = plates[i];
    setActive(i);
    const el = document.createElement('div');
    el.className = 'fb-dialog';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', it.name);
    el.style.setProperty('--c', it.colour);
    const appOnly = it.where === 'App only';
    el.innerHTML = `<div class="fb-box" id="featureBeltDialog">
      <button type="button" class="fb-close">Close &#10005;</button>
      <div class="fb-figure"><span class="fb-disc">${svgIcon(it.id)}</span></div>
      <div><div class="fb-where">${esc(it.where)}</div><h3>${esc(it.name)}</h3><p>${esc(it.text)}</p>
        <ul class="fb-facts">${it.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="fb-cta" href="/#downloadSec">${appOnly ? 'Download Callisto' : 'Get the app'}</a></div></div>`;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root.appendChild(el);
    dialog = el;
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      el.remove(); dialog = null;
      document.body.style.overflow = prevOverflow;
      back.focus({ preventScroll: true });
      kick();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll('button,a')], a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('.fb-close') || e.target.closest('.fb-cta')) close(); });
    el.querySelector('.fb-close').focus();
    kick();
  }

  plates.forEach((b, i) => {
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !drag) setActive(i); });
    b.addEventListener('focus', () => { if (b.matches(':focus-visible')) setActive(i); });
    b.addEventListener('click', () => {
      if (stage.dataset.dragged) { delete stage.dataset.dragged; return; }
      openDialog(i);
    });
  });
  stage.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !drag && !dialog) setActive(null); });
  stage.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    delete stage.dataset.dragged;
    const box = stage.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, start: offset, moved: false, lane: g && e.clientY - box.top >= g.ym ? 1 : -1, lastX: e.clientX, lastT: e.timeStamp, speed: 0 };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 6) { drag.moved = true; target = null; setActive(null); try { stage.setPointerCapture(e.pointerId); } catch (_) {} }
    if (!drag.moved) return;
    drag.speed = drag.speed * 0.6 + ((e.clientX - drag.lastX) / Math.max(1, e.timeStamp - drag.lastT)) * 0.4;
    drag.lastX = e.clientX; drag.lastT = e.timeStamp;
    const scale = drag.lane > 0 ? 1 : 1 / KB;
    offset = drag.start - drag.lane * dx * scale;
    v = reduced() ? 0 : Math.max(-1400, Math.min(1400, -drag.lane * drag.speed * 1000 * scale));
    kick();
  });
  const endDrag = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.moved) stage.dataset.dragged = '1';
    drag = null; kick();
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1, true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1, true); }
  });
  root.querySelector('.fb-controls').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'prev') step(-1);
    if (b.dataset.a === 'next') step(1);
    if (b.dataset.a === 'pause') {
      paused = !paused;
      b.setAttribute('aria-pressed', String(paused));
      b.innerHTML = paused ? '&#9654;' : '&#10074;&#10074;';
      b.setAttribute('aria-label', paused ? 'Play belt' : 'Pause belt');
      if (!paused) setActive(null);
      kick();
    }
  });

  new ResizeObserver(layout).observe(stage);
  new IntersectionObserver((en) => { onScreen = en.some((x) => x.isIntersecting); if (onScreen) kick(); }).observe(root);
  document.addEventListener('visibilitychange', kick);
  layout(); kick();
})();
