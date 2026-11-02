/* Connectors, shown working: every app's logo feeds the orb, and the orb hands
   back a card with that app's update. The layout is the ink-orbit flow diagram,
   in plain JavaScript because this site has no React. Figures are examples and
   the card says so. */
(function () {
  'use strict';
  const root = document.getElementById('connectorsHub');
  if (!root) return;

  const APPS = [
    { f: 'youtube', n: 'YouTube Studio', head: 'Your new upload is ahead of your average', stat: '+18%', label: 'views this week', bars: [3, 4, 3, 5, 6, 8] },
    { f: 'instagram', n: 'Instagram', head: 'Yesterday\'s reel brought in new followers', stat: '+214', label: 'followers', bars: [2, 3, 5, 4, 6, 7] },
    { f: 'tiktok', n: 'TikTok Studio', head: 'Your last video is holding viewers longer', stat: '42%', label: 'watched to the end', bars: [4, 3, 5, 6, 5, 7] },
    { f: 'shopify', n: 'Shopify', head: 'Orders are up since the weekend', stat: '37', label: 'orders today', bars: [3, 3, 4, 6, 5, 8] },
    { f: 'squarespace', n: 'Squarespace', head: 'Your new page is getting visitors', stat: '1,204', label: 'visits this week', bars: [2, 4, 4, 5, 6, 6] },
    { f: 'googleanalytics', n: 'Website Analytics', head: 'Most visitors now arrive from search', stat: '61%', label: 'of traffic', bars: [3, 4, 5, 5, 6, 7] },
    { f: 'stripe', n: 'Stripe', head: 'Three payments came in overnight', stat: '$420', label: 'revenue today', bars: [2, 5, 3, 6, 4, 8] },
    { f: 'finance', n: 'Finance', head: 'Your portfolio moved while you were away', stat: '+1.4%', label: 'portfolio today', bars: [4, 3, 4, 5, 5, 7] },
    { f: 'googlecalendar', n: 'Google Calendar', head: 'You have a free hour before your 3pm', stat: '4', label: 'events today', bars: [5, 2, 6, 3, 4, 2] },
    { f: 'spotify', n: 'Spotify', head: 'Your focus playlist is ready when you are', stat: '38', label: 'songs queued', bars: [4, 6, 5, 7, 5, 6] },
  ];

  const css = document.createElement('style');
  css.textContent = `
    #connectorsHub{--ch-ink:#eef3ff;--ch-sub:rgba(185,205,245,.78);--ch-line:rgba(111,212,255,.26);--ch-panel:rgba(7,12,28,.82);--ch-card:#0d1630}
    body.light #connectorsHub{--ch-ink:#0d1630;--ch-sub:#4a5675;--ch-line:rgba(20,70,160,.28);--ch-panel:rgba(255,255,255,.86);--ch-card:#fff}
    .ch-panel{position:relative;display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);align-items:center;gap:0;padding:24px 28px 24px 18px;background:var(--ch-panel);border:1px solid var(--ch-line);border-radius:6px}
    .ch-panel::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,#1a3bff,#00c8ff)}
    .ch-map{width:100%;height:auto;display:block;overflow:visible}
    .ch-wire{fill:none;stroke:var(--ch-line);stroke-width:1;stroke-dasharray:2 4;transition:stroke .25s}
    .ch-wire.on{stroke:#00c8ff;stroke-width:1.6;stroke-dasharray:none}
    .ch-out{fill:none;stroke:#00c8ff;stroke-width:1.6;stroke-dasharray:4 5;animation:chDash 1.1s linear infinite}
    .ch-tile{cursor:pointer;outline:none}
    .ch-tile rect{fill:#0a1230;stroke:rgba(130,165,255,.28);transition:stroke .2s,fill .2s}
    .ch-tile:hover rect,.ch-tile:focus-visible rect,.ch-tile.on rect{stroke:#00c8ff;fill:#102060}
    .ch-pkt{fill:#7fe3ff}
    .ch-orb{animation:chOrb 3.6s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
    .ch-ring{fill:none;stroke:rgba(90,150,255,.3);animation:chRing 3.6s ease-in-out infinite}
    .ch-stack{position:relative;min-height:300px}
    .ch-ghost{position:absolute;inset:0;border:1px solid var(--ch-line);border-radius:6px;background:var(--ch-card)}
    .ch-ghost.a{transform:translate(14px,-14px);opacity:.35}.ch-ghost.b{transform:translate(7px,-7px);opacity:.65}
    .ch-card{position:relative;min-height:300px;padding:22px;border:1px solid var(--ch-line);border-radius:6px;background:var(--ch-card);color:var(--ch-ink);display:flex;flex-direction:column}
    .ch-card.in{animation:chIn .45s cubic-bezier(.2,.8,.2,1)}
    .ch-top{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600}
    .ch-top img{width:18px;height:18px}
    .ch-eg{margin-left:auto;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ch-sub)}
    .ch-head{font-size:18px;line-height:1.3;font-weight:600;margin:16px 0 14px;color:var(--ch-ink)}
    .ch-stat{font-size:40px;line-height:1;font-weight:700;color:#35c9ff;font-variant-numeric:tabular-nums}
    body.light .ch-stat{color:#0a6fc2}
    .ch-label{font-size:13px;color:var(--ch-sub);margin-top:5px}
    .ch-bars{display:flex;align-items:flex-end;gap:7px;height:58px;margin-top:auto;padding-top:14px}
    .ch-bars i{flex:1;border-radius:2px 2px 0 0;background:linear-gradient(180deg,#00c8ff,#1a3bff)}
    @keyframes chDash{to{stroke-dashoffset:-18}}
    @keyframes chOrb{50%{transform:scale(1.05)}}
    @keyframes chRing{50%{opacity:.35}}
    @keyframes chIn{from{opacity:0;transform:translate(14px,-10px) rotate(1.5deg)}to{opacity:1;transform:none}}
    @media (max-width:760px){.ch-panel{grid-template-columns:minmax(0,1fr) minmax(0,1fr);padding:14px 16px 14px 8px}
      .ch-stack,.ch-card{min-height:230px}.ch-card{padding:12px}.ch-top{font-size:11px;gap:6px}.ch-top img{width:14px;height:14px}
      .ch-eg{font-size:8px;letter-spacing:.08em}.ch-head{font-size:13px;margin:10px 0 8px}.ch-stat{font-size:26px}.ch-label{font-size:11px}
      .ch-bars{height:38px;gap:4px}.ch-ghost.a{transform:translate(8px,-8px)}.ch-ghost.b{transform:translate(4px,-4px)}}
    @media (prefers-reduced-motion:reduce){.ch-out,.ch-orb,.ch-ring,.ch-card.in{animation:none}}`;
  document.head.appendChild(css);

  const COLS = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]];
  // On a phone the same picture is drawn narrower, so the card can stay beside
  // the orb rather than dropping below it.
  const SMALL = window.matchMedia('(max-width:760px)').matches;
  const X = SMALL ? [30, 96] : [70, 200], ORB = { x: SMALL ? 222 : 500, y: 210 }, SIZE = 52, WIDE = SMALL ? 300 : 640;
  const pos = [];
  COLS.forEach((col, c) => col.forEach((a, r) => {
    const gap = 84, h = (col.length - 1) * gap;
    pos[a] = { x: X[c], y: 210 - h / 2 + r * gap };
  }));
  const wire = (i) => {
    const p = pos[i], sx = p.x + SIZE / 2, mid = (sx + ORB.x) / 2;
    return `M${sx},${p.y} C${mid},${p.y} ${mid},${ORB.y} ${ORB.x - 46},${ORB.y}`;
  };
  const OUT = `M${ORB.x + 46},${ORB.y} H${WIDE}`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  root.insertAdjacentHTML('beforeend', `<div class="ch-panel">
    <svg class="ch-map" viewBox="0 0 ${WIDE} 420" role="group" aria-label="Apps connected to Callisto">
      <defs><radialGradient id="chOrbFill" cx=".38" cy=".32" r=".8">
        <stop offset="0" stop-color="#8aacff"/><stop offset=".3" stop-color="#3060ff"/><stop offset=".6" stop-color="#1a3bff"/><stop offset="1" stop-color="#05108a"/></radialGradient>
        <filter id="chGlow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="16"/></filter></defs>
      ${APPS.map((_, i) => `<path class="ch-wire" data-w="${i}" d="${wire(i)}"/>`).join('')}
      <path class="ch-out" d="${OUT}"/>
      <circle class="ch-pkt" r="3.4" style="display:none"><animateMotion id="chMotion" dur="1.1s" repeatCount="indefinite" path="${wire(0)}"/></circle>
      <circle cx="${ORB.x}" cy="${ORB.y}" r="42" fill="#1a3bff" opacity=".7" filter="url(#chGlow)"/>
      <circle class="ch-ring" cx="${ORB.x}" cy="${ORB.y}" r="58"/><circle class="ch-ring" cx="${ORB.x}" cy="${ORB.y}" r="74" opacity=".5"/>
      <circle class="ch-orb" cx="${ORB.x}" cy="${ORB.y}" r="44" fill="url(#chOrbFill)"/>
      <text x="${ORB.x}" y="${ORB.y + 100}" text-anchor="middle" font-size="11" letter-spacing="4" font-weight="700" fill="currentColor" style="color:var(--ch-ink)">CALLISTO</text>
      ${APPS.map((a, i) => { const p = pos[i]; return `<g class="ch-tile" data-t="${i}" tabindex="0" role="button" aria-label="${esc(a.n)}">
        <title>${esc(a.n)}</title><rect x="${p.x - SIZE / 2}" y="${p.y - SIZE / 2}" width="${SIZE}" height="${SIZE}" rx="11"/>
        <image href="/assets/logos/${a.f}.svg" x="${p.x - 14}" y="${p.y - 14}" width="28" height="28"/></g>`; }).join('')}
    </svg>
    <div class="ch-stack"><div class="ch-ghost a"></div><div class="ch-ghost b"></div><div class="ch-card" aria-live="polite"></div></div>
  </div>`);

  const card = root.querySelector('.ch-card');
  const pkt = root.querySelector('.ch-pkt');
  const motion = root.querySelector('#chMotion');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let at = -1, held = false, onScreen = false;

  function show(i) {
    if (i === at) return;
    at = i;
    root.querySelectorAll('.ch-wire').forEach((w) => w.classList.toggle('on', +w.dataset.w === i));
    root.querySelectorAll('.ch-tile').forEach((t) => t.classList.toggle('on', +t.dataset.t === i));
    const a = APPS[i];
    card.innerHTML = `<div class="ch-top"><img src="/assets/logos/${a.f}.svg" alt="">${esc(a.n)}<span class="ch-eg">Example</span></div>
      <div class="ch-head">${esc(a.head)}</div><div class="ch-stat">${esc(a.stat)}</div><div class="ch-label">${esc(a.label)}</div>
      <div class="ch-bars" aria-hidden="true">${a.bars.map((b) => `<i style="height:${b * 12}%"></i>`).join('')}</div>`;
    card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
    motion.setAttribute('path', wire(i));
    pkt.style.display = still.matches ? 'none' : '';
  }
  root.querySelectorAll('.ch-tile').forEach((t) => {
    const i = +t.dataset.t;
    t.addEventListener('pointerenter', () => { held = true; show(i); });
    t.addEventListener('pointerleave', () => { held = false; });
    t.addEventListener('focus', () => { held = true; show(i); });
    t.addEventListener('blur', () => { held = false; });
    t.addEventListener('click', () => show(i));
  });
  new IntersectionObserver((e) => { onScreen = e.some((x) => x.isIntersecting); }).observe(root);
  show(0);
  setInterval(() => {
    if (!held && onScreen && !document.hidden && !still.matches) show((at + 1) % APPS.length);
  }, 2800);
})();
