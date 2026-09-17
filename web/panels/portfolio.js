/* Copied from app/renderer/renderer.js (FINANCIAL PANEL + MARKETS OVERLAY) so the website's portfolio is the same as the desktop app's. Data comes from panels/bridge.js. */
// ===================== FINANCIAL PANEL =====================
const finPanel = document.getElementById('finPanel');
const finSlider = document.getElementById('finSlider');
const finDotsEl = document.getElementById('finDots');
let finPortfolio = [];   // array of stock data objects
let finIdx = 0;

function finSparkline(closes, positive) {
  if (!closes || closes.length < 2) return '';
  const vals = closes.filter(Number.isFinite);
  if (vals.length < 2) return '';
  const W = 288, H = 130, padX = 4, padTop = 10, padBot = 6;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const drawH = H - padTop - padBot;
  const pts = vals.map((v, i) => {
    const x = padX + (i / (vals.length - 1)) * (W - padX * 2);
    const y = padTop + drawH - ((v - min) / range) * drawH;
    return [x.toFixed(1), y.toFixed(1)];
  });
  const color  = positive ? '#3b82f6' : '#ef4444';
  const glowColor = positive ? 'rgba(59,130,246,0.7)' : 'rgba(239,68,68,0.7)';
  const fillTop = positive ? 'rgba(59,130,246,0.18)' : 'rgba(239,68,68,0.18)';
  const uid = `fsp${Date.now() % 99999}`;
  const polyPts = pts.map(p => p.join(',')).join(' ');
  const areaD = `M${pts[0][0]},${H} ` + pts.map(p => `L${p[0]},${p[1]}`).join(' ') + ` L${pts[pts.length-1][0]},${H} Z`;
  const lastPt = pts[pts.length - 1];
  // Midpoint reference line (low)
  const midY = (padTop + drawH).toFixed(1);
  // Dotted grid: 5 horizontal lines
  const gridLines = [0.2,0.4,0.6,0.8].map(f => {
    const gy = (padTop + drawH - f * drawH).toFixed(1);
    return `<line x1="${padX}" y1="${gy}" x2="${W - padX}" y2="${gy}" stroke="rgba(255,255,255,0.07)" stroke-width="1" stroke-dasharray="3 6"/>`;
  }).join('');
  // Dot pattern background
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${uid}g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient>
      <filter id="${uid}ls" x="-60%" y="-60%" width="220%" height="220%">
        <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="${glowColor}"/>
      </filter>
      <filter id="${uid}ds" x="-100%" y="-100%" width="300%" height="300%">
        <feDropShadow dx="1" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.9)"/>
      </filter>
    </defs>
    ${gridLines}
    <path d="${areaD}" fill="url(#${uid}g)"/>
    <polyline points="${polyPts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" filter="url(#${uid}ls)"/>
    <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="4.5" fill="${color}" stroke="rgba(10,14,30,0.9)" stroke-width="2" filter="url(#${uid}ds)"/>
  </svg>`;
}

function finBuildBars(positive) {
  // Animated bar chart (translated from Layer4 React component)
  const color   = positive ? '#3b82f6' : '#ef4444';
  const secColor = positive ? '#60a5fa' : '#f87171';
  const heights = [22, 18, 38, 28, 32, 48, 42, 26, 20, 36, 44, 30, 52, 24];
  return heights.map((h, i) => {
    const delay = (i * 0.12).toFixed(2);
    const c = i % 2 === 0 ? color : secColor;
    return `<div class="fp-bar" style="height:${h}px;background:${c};animation:bar-pulse ${1.8 + i * 0.07}s ease-in-out ${delay}s infinite;"></div>`;
  }).join('');
}

function finBuildSlide(stock, idx) {
  const positive = stock.positive;
  const sign = positive ? '+' : '';
  const glowColor = positive ? '59,130,246' : '239,68,68';
  const slide = document.createElement('div');
  slide.className = 'fp-slide';
  slide.innerHTML = `
    <button class="fp-remove" data-sym="${stock.symbol}">✕</button>
    <div class="fp-chart-area">
      <div class="fp-grid"></div>
      <div class="fp-glow">
        <svg width="288" height="130" viewBox="0 0 288 130" preserveAspectRatio="none">
          <defs>
            <radialGradient id="fpg${idx}" cx="50%" cy="50%" r="50%">
              <stop stop-color="rgb(${glowColor})" stop-opacity="0.30"/>
              <stop offset="0.40" stop-color="rgb(${glowColor})" stop-opacity="0.12"/>
              <stop offset="1" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <rect width="288" height="130" fill="url(#fpg${idx})"/>
        </svg>
      </div>
      <div class="fp-spark">${finSparkline(stock.sparkline, positive)}</div>
      <div class="fp-bars-wrap">${finBuildBars(positive)}</div>
      <div class="fp-price-overlay">
        <span class="fp-sym">${stock.symbol}</span>
        <span class="fp-change-badge ${positive ? 'up' : 'dn'}">${sign}${stock.changePct}%</span>
      </div>
    </div>
    <div class="fp-info">
      <span class="fp-name">${stock.name || stock.symbol}</span>
      <span class="fp-price">${stock.currency === 'USD' ? '$' : (stock.currency + ' ')}${stock.price}</span>
    </div>`;

  slide.querySelector('.fp-remove').addEventListener('click', async () => {
    await window.jarvis.financeRemove(stock.symbol);
    finPortfolio = finPortfolio.filter(s => s.symbol !== stock.symbol);
    if (finIdx >= finPortfolio.length) finIdx = Math.max(0, finPortfolio.length - 1);
    finRender();
  });
  return slide;
}

function finGoTo(i) {
  finIdx = Math.max(0, Math.min(finPortfolio.length - 1, i));
  finSlider.style.transform = `translateX(-${finIdx * 288}px)`;
  document.querySelectorAll('.fp-dot').forEach((d, j) => d.classList.toggle('active', j === finIdx));
}

function finRender() {
  if (!finPortfolio.length) { finPanel.classList.add('fp-hidden'); return; }
  finPanel.classList.remove('fp-hidden');
  finSlider.innerHTML = '';
  finDotsEl.innerHTML = '';
  finPortfolio.forEach((stock, i) => {
    finSlider.appendChild(finBuildSlide(stock, i));
    const dot = document.createElement('div');
    dot.className = 'fp-dot' + (i === finIdx ? ' active' : '');
    dot.addEventListener('click', () => finGoTo(i));
    finDotsEl.appendChild(dot);
  });
  finSlider.style.transition = 'none';
  finSlider.style.transform = `translateX(-${finIdx * 288}px)`;
  // re-enable transition after first paint
  requestAnimationFrame(() => { finSlider.style.transition = 'transform 0.38s cubic-bezier(0.22,1,0.36,1)'; });

  // Show/hide nav arrows
  const showNav = finPortfolio.length > 1;
  document.getElementById('finPanelNav').style.display = showNav ? 'flex' : 'none';
}

// Swipe (touch + mouse drag)
(function finSwipe() {
  let startX = 0, dragging = false;
  finPanel.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  finPanel.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) dx < 0 ? finGoTo(finIdx + 1) : finGoTo(finIdx - 1);
  });
  finPanel.addEventListener('mousedown', e => { startX = e.clientX; dragging = true; e.preventDefault(); });
  window.addEventListener('mouseup', e => {
    if (!dragging) return; dragging = false;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 40) dx < 0 ? finGoTo(finIdx + 1) : finGoTo(finIdx - 1);
  });
})();

document.getElementById('finPrev')?.addEventListener('click', () => finGoTo(finIdx - 1));
document.getElementById('finNext')?.addEventListener('click', () => finGoTo(finIdx + 1));
document.getElementById('finPanelClose')?.addEventListener('click', () => finPanel.classList.add('fp-hidden'));

// Public: add a stock card object directly to the panel
window.finAddStock = async function(stock) {
  await window.jarvis.financeAdd(stock); // pass full object so chart data persists
  const exists = finPortfolio.findIndex(s => s.symbol === stock.symbol);
  if (exists === -1) { finPortfolio.push(stock); finIdx = finPortfolio.length - 1; }
  else { finIdx = exists; }
  finRender();
};

// Load saved portfolio — deferred so it never blocks the splash screen
async function finLoad() {
  const saved = await window.jarvis.financePortfolio().catch(() => []);
  // saved is now an array of full stock objects (with cached chart data)
  // Show cached data immediately so charts appear even if offline
  finPortfolio = saved.filter(s => s && s.symbol);
  if (finPortfolio.length) finRender();

  // Refresh prices in background — replace cached data with live data
  const symbols = finPortfolio.map(s => s.symbol);
  if (symbols.length) {
    const fresh = await Promise.all(
      symbols.map(sym => window.jarvis.financeGetStock(sym).catch(() => null))
    );
    const freshValid = fresh.filter(Boolean);
    if (freshValid.length) { finPortfolio = freshValid; finRender(); }
  }

  // Auto-refresh every 30 seconds for live chart updates
  setInterval(async () => {
    if (!finPortfolio.length) return;
    const syms = finPortfolio.map(s => s.symbol);
    const updated = await Promise.all(
      syms.map(sym => window.jarvis.financeGetStock(sym).catch(() => null))
    );
    const valid = updated.filter(Boolean);
    if (valid.length) { finPortfolio = valid; finRender(); }
  }, 30000);
}

// ===================== MARKETS OVERLAY — coverflow + P&L =====================
window.marketsOverlayOpen = false;
let marketsIdx = 0;

// ── Sparkline for detail band ─────────────────────────────────────────────
function moSparkline(closes, positive) {
  if (!closes || closes.length < 2) return '';
  const vals = closes.filter(Number.isFinite);
  if (vals.length < 2) return '';
  const W = 560, H = 140, padX = 8, padTop = 14, padBot = 20;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const range = mx - mn || 1;
  const drawH = H - padTop - padBot;
  const pts = vals.map((v, i) => {
    const x = padX + (i / (vals.length - 1)) * (W - padX * 2);
    const y = padTop + drawH - ((v - mn) / range) * drawH;
    return [x.toFixed(1), y.toFixed(1)];
  });
  const col = positive ? '#00e882' : '#ff6060';
  const glowCol = positive ? 'rgba(0,232,130,0.65)' : 'rgba(255,96,96,0.65)';
  const uid = `mos${Date.now() % 99999}`;
  const polyPts = pts.map(p => p.join(',')).join(' ');
  const areaD = `M${pts[0][0]},${H - padBot} ` + pts.map(p => `L${p[0]},${p[1]}`).join(' ') + ` L${pts[pts.length-1][0]},${H - padBot} Z`;
  const lastPt = pts[pts.length - 1];
  // Index of the low point (for reference line marker)
  const minIdx = vals.indexOf(mn);
  const minPt = pts[minIdx];
  // Horizontal grid lines (dashed, subtle)
  const gridLines = [0.25, 0.5, 0.75].map(f => {
    const gy = (padTop + drawH - f * drawH).toFixed(1);
    return `<line x1="${padX}" y1="${gy}" x2="${W - padX}" y2="${gy}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="4 8"/>`;
  }).join('');
  // Dot grid background (sparse dots)
  const dotPat = `<pattern id="${uid}dp" x="0" y="0" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="9" cy="9" r="0.8" fill="rgba(255,255,255,0.12)"/></pattern>`;
  // Y-axis tick labels (3 price levels)
  const tickPrices = [mn, mn + range * 0.5, mx].map(v => v.toFixed(2));
  const tickYs = [padTop + drawH, padTop + drawH * 0.5, padTop];
  const tickLabels = tickPrices.map((p, ti) =>
    `<text x="${padX + 2}" y="${(tickYs[ti] + (ti === 0 ? -3 : 4)).toFixed(1)}" font-size="9" font-family="'Courier New',monospace" fill="rgba(255,255,255,0.3)" text-anchor="start">${p}</text>`
  ).join('');
  // X-axis tick labels (first, mid, last)
  const xTickCount = Math.min(5, vals.length);
  const xTicks = Array.from({length: xTickCount}, (_, ti) => {
    const idx = Math.round(ti / (xTickCount - 1) * (vals.length - 1));
    const px = pts[idx][0];
    return `<text x="${px}" y="${(H - 4).toFixed(1)}" font-size="9" font-family="'Courier New',monospace" fill="rgba(255,255,255,0.25)" text-anchor="middle">${idx + 1}</text>`;
  }).join('');
  // Reference line at the low point
  const refX = minPt[0];
  const refLine = `<line x1="${refX}" y1="${padTop}" x2="${refX}" y2="${H - padBot}" stroke="${col}" stroke-width="1" stroke-dasharray="4 4" stroke-opacity="0.5"/>
    <circle cx="${refX}" cy="${minPt[1]}" r="3" fill="${col}" stroke="rgba(10,14,30,0.9)" stroke-width="1.5"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
    <defs>
      ${dotPat}
      <linearGradient id="${uid}g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${col}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${col}" stop-opacity="0.02"/>
      </linearGradient>
      <filter id="${uid}ls" x="-60%" y="-60%" width="220%" height="220%">
        <feDropShadow dx="0" dy="5" stdDeviation="10" flood-color="${glowCol}"/>
      </filter>
      <filter id="${uid}ds" x="-100%" y="-100%" width="300%" height="300%">
        <feDropShadow dx="1" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.9)"/>
      </filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#${uid}dp)"/>
    ${gridLines}
    ${tickLabels}
    ${xTicks}
    <path d="${areaD}" fill="url(#${uid}g)"/>
    ${refLine}
    <polyline points="${polyPts}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" filter="url(#${uid}ls)"/>
    <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="5" fill="${col}" stroke="rgba(10,14,30,0.9)" stroke-width="2" filter="url(#${uid}ds)"/>
  </svg>`;
}

// ── Coverflow engine (vanilla JS port, physics-settle) ────────────────────
(function initCoverflow() {
  let cfPos = 0, cfTarget = 0, cfVel = 0, cfRaf = null;
  let cfDrag = null; // {x, pos, v, t}
  const CARD_W = 210;
  const GAP_FRAC = 0.1;
  const ROTATE = 46;
  const DEPTH = 0.55;
  const FADE = 0.18;
  const FALLOFF = 0.56;

  function cfN() { return finPortfolio.length; }
  function cfClamp(p) { return Math.max(0, Math.min(cfN() - 1, p)); }

  function cfPaint() {
    const cards = document.querySelectorAll('.mo-cf-card');
    const pitch = CARD_W * (1 + GAP_FRAC);
    cards.forEach((card, i) => {
      const offset = i - cfPos;
      const dist = Math.abs(offset);
      const ramp = Math.pow(dist, FALLOFF);
      const tilt = Math.min(ROTATE * ramp, 80) * Math.sign(offset);
      const z = -DEPTH * CARD_W * ramp;
      card.style.transform = `translateX(calc(-50% + ${offset * pitch}px)) translateZ(${z}px) rotateY(${-tilt}deg)`;
      card.style.opacity = String(Math.max(0, 1 - FADE * dist));
      card.style.zIndex = String(100 - Math.round(dist * 10));
    });
  }

  function cfSettle(target) {
    if (cfRaf) cancelAnimationFrame(cfRaf);
    cfTarget = cfClamp(target);
    marketsGoTo(Math.round(cfTarget));
    const step = () => {
      const rem = cfTarget - cfPos;
      if (Math.abs(rem) < 0.0005) { cfPos = cfTarget; cfPaint(); cfRaf = null; return; }
      cfPos += rem * 0.16;
      cfPaint();
      cfRaf = requestAnimationFrame(step);
    };
    cfRaf = requestAnimationFrame(step);
  }

  window._cfNudge = function(by) { cfSettle(Math.round(cfTarget) + by); };
  window._cfGoTo = function(i) { cfSettle(i); };

  function cfBuildCards() {
    const frame = document.getElementById('moCfFrame');
    if (!frame) return;
    frame.innerHTML = '';
    finPortfolio.forEach((s, i) => {
      const card = document.createElement('div');
      card.className = 'mo-cf-card';
      const sym = s.currency === 'GBP' ? '£' : s.currency === 'EUR' ? '€' : '$';
      const pct = parseFloat(s.changePct || 0).toFixed(2);
      const col = s.positive ? '#00e882' : '#ff6060';
      const fillCol = s.positive ? 'rgba(0,232,130,0.18)' : 'rgba(255,96,96,0.18)';
      // mini sparkline for the card face
      let sparkSvg = '';
      if (s.sparkline && s.sparkline.length > 1) {
        const vals = s.sparkline.filter(Number.isFinite);
        if (vals.length > 1) {
          const W2 = 210, H2 = 110, padX2 = 4, padTop2 = 8, padBot2 = 4;
          const mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
          const drawH2 = H2 - padTop2 - padBot2;
          const pts2 = vals.map((v, j) => {
            const x = padX2 + (j / (vals.length - 1)) * (W2 - padX2 * 2);
            const y = padTop2 + drawH2 - ((v - mn) / r) * drawH2;
            return [x.toFixed(1), y.toFixed(1)];
          });
          const uid2 = `cfs${i}${Date.now() % 9999}`;
          const polyPts2 = pts2.map(p => p.join(',')).join(' ');
          const areaD2 = `M${pts2[0][0]},${H2} ` + pts2.map(p => `L${p[0]},${p[1]}`).join(' ') + ` L${pts2[pts2.length-1][0]},${H2} Z`;
          const lastPt2 = pts2[pts2.length - 1];
          const glowCol2 = s.positive ? 'rgba(0,232,130,0.65)' : 'rgba(255,96,96,0.65)';
          const gridLines2 = [0.33, 0.66].map(f => {
            const gy = (padTop2 + drawH2 - f * drawH2).toFixed(1);
            return `<line x1="${padX2}" y1="${gy}" x2="${W2 - padX2}" y2="${gy}" stroke="rgba(255,255,255,0.07)" stroke-width="1" stroke-dasharray="3 6"/>`;
          }).join('');
          sparkSvg = `<svg viewBox="0 0 ${W2} ${H2}" preserveAspectRatio="none" width="${W2}" height="${H2}" style="position:absolute;inset:0;width:100%;height:100%" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="${uid2}g" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${col}" stop-opacity="0.28"/>
                <stop offset="100%" stop-color="${col}" stop-opacity="0.02"/>
              </linearGradient>
              <filter id="${uid2}ls" x="-80%" y="-80%" width="260%" height="260%">
                <feDropShadow dx="0" dy="4" stdDeviation="7" flood-color="${glowCol2}"/>
              </filter>
              <filter id="${uid2}ds" x="-150%" y="-150%" width="400%" height="400%">
                <feDropShadow dx="1" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.9)"/>
              </filter>
            </defs>
            ${gridLines2}
            <path d="${areaD2}" fill="url(#${uid2}g)"/>
            <polyline points="${polyPts2}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" filter="url(#${uid2}ls)"/>
            <circle cx="${lastPt2[0]}" cy="${lastPt2[1]}" r="4" fill="${col}" stroke="rgba(10,14,30,0.9)" stroke-width="1.5" filter="url(#${uid2}ds)"/>
          </svg>`;
        }
      }
      card.innerHTML = `
        <div class="mo-cf-card-chart">${sparkSvg}</div>
        <div class="mo-cf-card-info">
          <div class="mo-cf-sym">${s.symbol}</div>
          <div class="mo-cf-name">${s.name || s.symbol}</div>
          <div>
            <span class="mo-cf-price">${sym}${parseFloat(s.price || 0).toFixed(2)}</span>
            <span class="mo-cf-badge ${s.positive ? 'up' : 'dn'}">${s.positive ? '▲ +' : '▼ '}${pct}%</span>
          </div>
        </div>`;
      card.addEventListener('click', () => { if (!cfDrag || Math.abs(cfDrag.moved || 0) < 5) cfSettle(i); });
      frame.appendChild(card);
    });
    cfPos = cfClamp(marketsIdx);
    cfTarget = cfPos;
    cfPaint();
  }
  window._cfBuildCards = cfBuildCards;

  // Pointer drag on the frame
  document.addEventListener('pointerdown', e => {
    const frame = document.getElementById('moCfFrame');
    if (!frame || !frame.contains(e.target)) return;
    if (cfRaf) { cancelAnimationFrame(cfRaf); cfRaf = null; }
    frame.setPointerCapture(e.pointerId);
    cfDrag = { x: e.clientX, pos: cfPos, v: 0, t: performance.now(), moved: 0 };
  });
  document.addEventListener('pointermove', e => {
    if (!cfDrag) return;
    const pitch = CARD_W * (1 + GAP_FRAC);
    const now = performance.now();
    const newPos = cfClamp(cfDrag.pos - (e.clientX - cfDrag.x) / pitch);
    const prev = cfPos;
    cfPos = newPos;
    cfDrag.v = ((cfPos - prev) / Math.max(now - cfDrag.t, 1)) * 1000;
    cfDrag.t = now;
    cfDrag.moved = Math.abs(e.clientX - cfDrag.x);
    cfPaint();
    const idx = Math.max(0, Math.min(finPortfolio.length - 1, Math.round(cfPos)));
    if (idx !== marketsIdx) marketsGoTo(idx);
  });
  document.addEventListener('pointerup', e => {
    if (!cfDrag) return;
    const carried = Math.max(-2, Math.min(2, cfDrag.v * 0.18));
    cfDrag = null;
    cfSettle(cfClamp(Math.round(cfPos + carried)));
  });
  document.addEventListener('pointercancel', () => {
    if (!cfDrag) return;
    cfDrag = null;
    cfSettle(cfClamp(Math.round(cfPos)));
  });
})();

// ── Detail band render ────────────────────────────────────────────────────
function marketsGoTo(idx) {
  if (!finPortfolio.length) return;
  marketsIdx = Math.max(0, Math.min(finPortfolio.length - 1, idx));
  const s = finPortfolio[marketsIdx];
  const sym = s.currency === 'GBP' ? '£' : s.currency === 'EUR' ? '€' : '$';
  const pct = parseFloat(s.changePct || 0).toFixed(2);

  document.getElementById('moDetailSymbol').textContent = s.symbol;
  document.getElementById('moDetailName').textContent = s.name || s.symbol;
  document.getElementById('moDetailPrice').textContent = sym + parseFloat(s.price || 0).toFixed(2);
  const badge = document.getElementById('moDetailBadge');
  badge.textContent = (s.positive ? '▲ +' : '▼ ') + pct + '%';
  badge.className = 'mo-detail-badge ' + (s.positive ? 'pos' : 'neg');
  document.getElementById('moDetailChart').innerHTML = moSparkline(s.sparkline, s.positive);

  // Dots
  const dotsEl = document.getElementById('moDots');
  dotsEl.innerHTML = '';
  finPortfolio.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'mo-dot' + (i === marketsIdx ? ' active' : '');
    d.addEventListener('click', () => { window._cfGoTo && window._cfGoTo(i); });
    dotsEl.appendChild(d);
  });

  // Nav hint
  const hint = document.getElementById('moNavHint');
  hint.textContent = finPortfolio.length > 1 ? '← SWIPE OR DRAG TO BROWSE →' : '';

  // Update P&L currency symbol
  document.getElementById('moPnlCurr').textContent = sym;

  // Update P&L if inputs are filled
  moPnlRecalc();
}

// ── P&L calculator ────────────────────────────────────────────────────────
function moPnlRecalc() {
  const buyInput = document.getElementById('moPnlBuyPrice');
  const sharesInput = document.getElementById('moPnlShares');
  if (!buyInput || !sharesInput) return;
  const buyPrice = parseFloat(buyInput.value);
  const shares = parseFloat(sharesInput.value);
  const s = finPortfolio[marketsIdx];
  if (!s || !buyPrice || !shares || isNaN(buyPrice) || isNaN(shares) || buyPrice <= 0 || shares <= 0) {
    ['moPnlInvested','moPnlCurVal','moPnlPL','moPnlReturn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = '—'; el.className = 'mo-pnl-row-val' + (id === 'moPnlReturn' ? ' mo-pnl-pill' : ''); }
    });
    document.getElementById('moPnlAiTip').textContent = '';
    document.getElementById('moPnlAiTip').className = 'mo-pnl-ai-tip';
    return;
  }
  const sym = s.currency === 'GBP' ? '£' : s.currency === 'EUR' ? '€' : '$';
  const curPrice = s.price || 0;
  const invested = buyPrice * shares;
  const curVal = curPrice * shares;
  const pl = curVal - invested;
  const ret = invested > 0 ? (pl / invested) * 100 : 0;
  const fmt = v => sym + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('moPnlInvested').textContent = fmt(invested);
  document.getElementById('moPnlInvested').className = 'mo-pnl-row-val';
  document.getElementById('moPnlCurVal').textContent = fmt(curVal);
  document.getElementById('moPnlCurVal').className = 'mo-pnl-row-val';
  const plEl = document.getElementById('moPnlPL');
  plEl.textContent = (pl >= 0 ? '+' : '−') + fmt(pl);
  plEl.className = 'mo-pnl-row-val ' + (pl >= 0 ? 'profit' : 'loss');
  const retEl = document.getElementById('moPnlReturn');
  retEl.textContent = (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%';
  retEl.className = 'mo-pnl-row-val mo-pnl-pill ' + (ret >= 0 ? 'profit' : 'loss');
  // AI tip
  const tipEl = document.getElementById('moPnlAiTip');
  if (Math.abs(pl) > 0.005) {
    const adj = pl >= 0 ? 'up' : 'down';
    tipEl.textContent = `You are ${adj} ${fmt(Math.abs(pl))} on ${s.symbol} — a ${Math.abs(ret).toFixed(1)}% ${pl >= 0 ? 'gain' : 'loss'} on your position.`;
    tipEl.className = 'mo-pnl-ai-tip has-tip';
  } else {
    tipEl.textContent = ''; tipEl.className = 'mo-pnl-ai-tip';
  }
}

window.showMarketsOverlay = async function showMarketsOverlay() {
  // If portfolio hasn't loaded yet, load it first
  if (!finPortfolio.length) {
    await finLoad().catch(() => {});
  }
  if (!finPortfolio.length) {
    // Still empty — show overlay with empty state message
    const overlay = document.getElementById('marketsOverlay');
    if (overlay) {
      overlay.classList.add('mo-open');
      window.marketsOverlayOpen = true;
      const cfTrack = document.getElementById('moCfTrack');
      if (cfTrack) cfTrack.innerHTML = '<div style="color:#888;text-align:center;padding:60px 20px;font-size:14px">No stocks in your portfolio yet.<br><br>Say <b>"show me Apple stock"</b> and click <b>Add to Portfolio</b>.</div>';
    }
    return;
  }
  window.marketsOverlayOpen = true;
  // Build coverflow cards
  window._cfBuildCards && window._cfBuildCards();
  // Render detail band for current index
  marketsGoTo(marketsIdx);
  document.getElementById('marketsOverlay').classList.add('mo-open');
}

function closeMarketsOverlay() {
  window.marketsOverlayOpen = false;
  document.getElementById('marketsOverlay').classList.remove('mo-open');
}

// Arrow buttons
document.getElementById('moCfLeft')?.addEventListener('click', () => window._cfNudge && window._cfNudge(-1));
document.getElementById('moCfRight')?.addEventListener('click', () => window._cfNudge && window._cfNudge(1));
// Close button
document.getElementById('moCloseBtn')?.addEventListener('click', closeMarketsOverlay);
// Escape key
document.addEventListener('keydown', e => { if (e.key === 'Escape' && window.marketsOverlayOpen) closeMarketsOverlay(); });
// Click backdrop to close
document.getElementById('marketsOverlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('marketsOverlay')) closeMarketsOverlay();
});
// P&L live recalc
document.getElementById('moPnlBuyPrice')?.addEventListener('input', moPnlRecalc);

// Calculator spotlight: a soft glow follows the cursor across the card and the
// Clear button (same effect as the reference spotlight button).
(function initPnlSpotlight() {
  const card = document.getElementById('moPnlSection');
  const reset = document.getElementById('moPnlReset');
  if (!card) return;
  let raf = 0, px = 0, py = 0;
  card.addEventListener('pointermove', (e) => {
    px = e.clientX; py = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--sx', (px - r.left) + 'px');
      card.style.setProperty('--sy', (py - r.top) + 'px');
      if (reset) {
        const b = reset.getBoundingClientRect();
        reset.style.setProperty('--bx', (px - b.left) + 'px');
        reset.style.setProperty('--by', (py - b.top) + 'px');
      }
    });
  });
  card.addEventListener('pointerenter', () => card.classList.add('is-lit'));
  card.addEventListener('pointerleave', () => { if (!card.contains(document.activeElement)) card.classList.remove('is-lit'); });
  card.addEventListener('focusin', () => card.classList.add('is-lit'));
  card.addEventListener('focusout', () => { if (!card.matches(':hover')) card.classList.remove('is-lit'); });
  reset?.addEventListener('click', () => {
    const b = document.getElementById('moPnlBuyPrice'), sh = document.getElementById('moPnlShares');
    if (b) b.value = ''; if (sh) sh.value = '';
    moPnlRecalc();
    b?.focus();
  });
})();
document.getElementById('moPnlShares')?.addEventListener('input', moPnlRecalc);

// Wire portfolio panel label + expand button → open overlay
document.getElementById('finPanelLabel')?.addEventListener('click', () => showMarketsOverlay());
document.getElementById('finSliderWrap')?.addEventListener('click', () => showMarketsOverlay());
document.getElementById('finExpandBtn')?.addEventListener('click', () => showMarketsOverlay());

// Command interception — "show my markets", "open portfolio", etc.
window._checkMarketsOverlay = async function(text) {
  if (!/show.*my\s+markets|open.*portfolio|portfolio.*overview|my\s+stocks|show.*portfolio|my\s+markets/i.test(text)) return false;
  showMarketsOverlay();
  return true;
};


setTimeout(() => finLoad().catch(() => {}), 1200);
