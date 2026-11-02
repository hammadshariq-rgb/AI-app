/* The rotating belt of headline features, above the features grid. Stops under
   the pointer, drags with a flick, and a plate opens to say what it does. The
   maths is the sushi-conveyor component's stadium loop, in plain JavaScript
   because this site has no React. */
(function () {
  'use strict';
  const root = document.getElementById('featureBelt');
  if (!root) return;

  // One family of marks: thin strokes on a 48 grid, geometric rather than pictorial.
  const ICON = {
    video: '<circle cx="24" cy="24" r="17"/><path d="M20 17.5v13L31 24z"/><path d="M24 2.5v3M24 42.5v3M2.5 24h3M42.5 24h3"/>',
    cube: '<path d="M24 5l16.5 9.5v19L24 43 7.5 33.5v-19z"/><path d="M7.5 14.5L24 24l16.5-9.5M24 24v19"/><path d="M15.8 9.8L32.2 19.2" opacity=".45"/>',
    image: '<path d="M6 12V6h6M36 6h6v6M42 36v6h-6M12 42H6v-6"/><path d="M24 12l2.8 9.2L36 24l-9.2 2.8L24 36l-2.8-9.2L12 24l9.2-2.8z"/>',
    hand: '<circle cx="24" cy="24" r="4"/><circle cx="24" cy="24" r="12" stroke-dasharray="3 4"/><path d="M24 4v8M24 36v8M4 24h8M36 24h8"/><path d="M33 33l7 7" opacity=".45"/>',
    tv: '<rect x="5" y="9" width="38" height="25" rx="1.5"/><path d="M17 41h14"/><path d="M12 28a4 4 0 0 1 4 4M12 22a10 10 0 0 1 10 10M12 16a16 16 0 0 1 16 16"/>',
    pen: '<path d="M6 36c7-1 8-13 15-13s5 11 11 11 7-12 10-20"/><circle cx="6" cy="36" r="2.5"/><circle cx="42" cy="14" r="2.5"/><path d="M42 14h-8M42 14v8" opacity=".45"/>',
  };
  const ITEMS = [
    { id: 'video', name: 'AI Video', where: 'App only', colour: '#bcd4ff',
      text: 'Turn a sentence or a photo into a short video, then download it or post it to your socials.',
      facts: ['From text', 'From a photo', 'Video Studio'] },
    { id: 'cube', name: '3D Studio', where: 'App only', colour: '#bcd4ff',
      text: 'Describe anything and get a coloured 3D model you can spin, zoom and change by voice or by hand.',
      facts: ['Voice edits', 'Hand control', 'Download'] },
    { id: 'image', name: 'Image Generation', where: 'Web + app', colour: '#bcd4ff',
      text: 'Say what you want to see and Callisto draws it, ready to change, download or use in a video.',
      facts: ['From text', 'Edit by asking'] },
    { id: 'hand', name: 'Hand Control', where: 'App only', colour: '#bcd4ff',
      text: 'Move the Callisto cursor with one hand and pinch to click, with gestures on the other. No keyboard or mouse.',
      facts: ['Pinch to click', 'Gestures', 'Your own poses'] },
    { id: 'tv', name: 'Cast to TV', where: 'App only', colour: '#bcd4ff',
      text: 'Say "play this on the TV" and Callisto finds your television and puts it on, with no remote.',
      facts: ['Chromecast', 'Voice'] },
    { id: 'pen', name: 'Sketching', where: 'Web + app', colour: '#bcd4ff',
      text: 'Draw on an open canvas with the pen, by voice, or with your hand, then turn the sketch into 3D or video.',
      facts: ['Pen and shapes', 'Say what to add'] },
  ];

  const SPACING = 1.35, CURVE = 0.95, BAND = 1.22, TILT = 0.8, KB = 0.68, SPEED = 26;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const svgIcon = (k) => `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${ICON[k]}</svg>`;

  const css = document.createElement('style');
  css.textContent = `
    #featureBelt,.fb-dialog{--fb-belt:#141d33;--fb-side:#090e1c;--fb-rail:#51658f;--fb-island:#0d1426;--fb-text:#eef3ff;--fb-sub:rgba(185,205,245,.78);--fb-card:#0c1324;--fb-line:rgba(130,165,255,.2)}
    body.light #featureBelt,body.light .fb-dialog{--fb-belt:#3a445c;--fb-side:#1f2638;--fb-rail:#aab6cf;--fb-island:#e6ebf5;--fb-text:#0d1630;--fb-sub:#4a5675;--fb-card:#fff;--fb-line:rgba(30,50,110,.16)}
    .fb-stage{position:relative;width:100%;max-width:1040px;margin:18px auto 0;touch-action:pan-y;user-select:none;overflow-x:clip}
    .fb-stage svg.fb-track{position:absolute;inset:0;overflow:visible;pointer-events:none}
    .fb-plate{position:absolute;left:0;top:0;padding:0;border:0;background:none;border-radius:50%;cursor:pointer;color:#fff;transform-origin:50% 50%;will-change:transform}
    .fb-plate:focus-visible{outline:2px solid #8fb4ff;outline-offset:4px}
    .fb-disc{position:absolute;inset:0;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1px solid rgba(188,212,255,.28);
      background:linear-gradient(160deg,#1a2238 0%,#0b101d 55%,#05070e 100%);box-shadow:0 14px 22px -8px rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.14),inset 0 0 0 4px rgba(255,255,255,.015);transition:transform .25s cubic-bezier(.2,.9,.3,1.2)}
    .fb-disc svg{width:40%;height:50%;color:var(--c)}
    body.light .fb-disc svg{color:#dbe7ff}
    .fb-plate.on .fb-disc{transform:translateY(-7%) scale(1.09);border-color:rgba(188,212,255,.7)}
    .fb-chip{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translate(-50%,4px);white-space:nowrap;padding:5px 10px;border-radius:99px;background:var(--fb-card);border:1px solid var(--fb-line);color:var(--fb-text);font-size:11px;font-weight:600;line-height:1;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none}
    .fb-plate.on .fb-chip{opacity:1;transform:translate(-50%,0)}
    .fb-caption{min-height:46px;max-width:520px;margin:10px auto 0;text-align:center;font-size:14px;line-height:1.5;color:var(--fb-sub)}
    .fb-caption b{color:var(--fb-text)}
    .fb-controls{display:flex;justify-content:center;gap:8px;margin-top:8px}
    .fb-controls button{width:36px;height:36px;border-radius:50%;border:1px solid var(--fb-line);background:var(--fb-card);color:var(--fb-text);cursor:pointer;font-size:14px}
    .fb-controls button:focus-visible,.fb-dialog button:focus-visible,.fb-dialog a:focus-visible{outline:2px solid #8fb4ff;outline-offset:2px}
    .fb-dialog{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(3,6,14,.72);backdrop-filter:blur(10px)}
    .fb-box{position:relative;width:min(1080px,100%);min-height:min(600px,86vh);max-height:92vh;overflow:auto;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);border-radius:6px;background:var(--fb-card);border:1px solid var(--fb-line);color:var(--fb-text);box-shadow:0 50px 140px rgba(0,0,0,.65);animation:fbIn .28s ease-out}
    .fb-figure{position:relative;display:flex;align-items:center;justify-content:center;min-height:280px;padding:40px;background:#05070e;border-right:1px solid var(--fb-line);overflow:hidden;
      background-image:linear-gradient(rgba(188,212,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(188,212,255,.05) 1px,transparent 1px);background-size:48px 48px}
    .fb-figure svg{width:min(62%,280px);height:auto;color:#dbe7ff;stroke-width:.7}
    .fb-count{position:absolute;left:24px;bottom:20px;font:12px/1 'Share Tech Mono',ui-monospace,monospace;letter-spacing:.14em;color:rgba(188,212,255,.6)}
    .fb-copy{display:flex;flex-direction:column;justify-content:center;padding:64px 56px 48px}
    .fb-where{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--fb-sub)}
    .fb-box h3{font-size:clamp(36px,4.6vw,60px);line-height:1.04;font-weight:600;letter-spacing:-.02em;margin:14px 0 20px;color:var(--fb-text)}
    .fb-box p{font-size:18px;line-height:1.6;color:var(--fb-sub);margin:0 0 28px;max-width:44ch}
    .fb-facts{list-style:none;margin:0 0 34px;padding:0;border-top:1px solid var(--fb-line)}
    .fb-facts li{font-size:15px;padding:13px 0;border-bottom:1px solid var(--fb-line);color:var(--fb-text)}
    .fb-cta{align-self:flex-start;padding:15px 28px;border-radius:4px;background:#eef3ff;color:#070b16!important;text-decoration:none;font-size:15px;font-weight:600}
    body.light .fb-cta{background:#0d1630;color:#fff!important}
    .fb-close{position:absolute;top:18px;right:20px;background:none;border:0;color:var(--fb-sub);font:inherit;font-size:14px;cursor:pointer;padding:8px}
    @keyframes fbIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
    @media (max-width:760px){.fb-box{grid-template-columns:1fr;min-height:0}.fb-figure{min-height:200px;border-right:0;border-bottom:1px solid var(--fb-line)}.fb-figure svg{width:120px}.fb-copy{padding:32px 22px 26px}.fb-box p{font-size:16px}}
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
      <div class="fb-figure">${svgIcon(it.id)}<span class="fb-count">0${i + 1} / 0${ITEMS.length}</span></div>
      <div class="fb-copy"><div class="fb-where">${esc(it.where)}</div><h3>${esc(it.name)}</h3><p>${esc(it.text)}</p>
        <ul class="fb-facts">${it.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="fb-cta" href="/#downloadSec">${appOnly ? 'Download Callisto' : 'Get the app'}</a></div></div>`;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(el);
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
