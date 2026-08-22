function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Offline / online detection ────────────────────────────────────────────────
const offlineBanner = document.getElementById('offlineBanner');
const offlineBannerText = document.getElementById('offlineBannerText');
function updateOnlineState() {
  if (!offlineBanner) return;
  if (navigator.onLine) {
    offlineBanner.classList.add('hidden');
  } else {
    offlineBannerText.textContent = 'No internet connection — I can\'t respond until it\'s back';
    offlineBanner.classList.remove('hidden');
  }
}
window.addEventListener('online',  updateOnlineState);
window.addEventListener('offline', updateOnlineState);
updateOnlineState(); // run once on load

// Move #mainPanel to body so no ancestor overflow/stacking context clips its hit region
;(function() { const mp = document.getElementById('mainPanel'); if (mp) document.body.appendChild(mp); })();

const splash = document.getElementById('splash');
const splashName = document.getElementById('splashName');
const splashStatus = document.getElementById('splashStatus');
const setupView = document.getElementById('setup');
const mainView = document.getElementById('main');

// Auth elements
const nameStep = document.getElementById('nameStep');
const authStep = document.getElementById('authStep');
const reloginStep = document.getElementById('reloginStep');
const setupName = document.getElementById('setupName');
const nameNext = document.getElementById('nameNext');
const tabSignup = document.getElementById('tabSignup');
const tabLogin = document.getElementById('tabLogin');
const googleBtn = document.getElementById('googleBtn');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authSubmit = document.getElementById('authSubmit');
const authError = document.getElementById('authError');
const authFooter = document.getElementById('authFooter');
const switchToLogin = document.getElementById('switchToLogin');
const signupEmailField = document.getElementById('signupEmailField');
const reloginEmail = document.getElementById('reloginEmail');
const reloginPassword = document.getElementById('reloginPassword');
const reloginSubmit = document.getElementById('reloginSubmit');
const reloginError = document.getElementById('reloginError');
const reloginGoogle = document.getElementById('reloginGoogle');
const reloginError2 = document.getElementById('reloginError2');
const termsStep = document.getElementById('termsStep');
const agreeBtn = document.getElementById('agreeBtn');
const authDisplayName = document.getElementById('authDisplayName');
const signupNameField = document.getElementById('signupNameField');
const signupGenderField = document.getElementById('signupGenderField');
const termsScroll = document.getElementById('termsScroll');
const termsFadeHint = document.getElementById('termsFadeHint');
const paymentStep = document.getElementById('paymentStep');
const payWaiting = document.getElementById('payWaiting');
const payError = document.getElementById('payError');
const planCards = document.getElementById('planCards');
const billingInterval = document.getElementById('billingInterval');

const orb = document.getElementById('orb');
const orbLabel = document.getElementById('orbLabel');

// ═══════════════════════════════════════════════════════════════
//  THEME TOGGLE — light / dark mode
// ═══════════════════════════════════════════════════════════════
(function initTheme() {
  const btn        = document.getElementById('themeToggleBtn');
  const moonIcon   = document.getElementById('themeMoonIcon');
  const sunIcon    = document.getElementById('themeSunIcon');
  const waveCanvas = document.getElementById('waveCanvas');

  // ── WebGL wave renderer (Threads shader — raw WebGL, no OGL) ──
  const VS = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;
  const FS = `
    precision highp float;
    uniform float iTime;
    uniform vec3  iResolution;
    uniform vec3  uColor;
    uniform float uAmplitude;
    uniform float uDistance;
    uniform vec2  uMouse;
    #define PI 3.1415926538
    const int   u_line_count = 40;
    const float u_line_width = 7.0;
    const float u_line_blur  = 10.0;
    float Perlin2D(vec2 P) {
      vec2 Pi = floor(P);
      vec4 Pf = P.xyxy - vec4(Pi, Pi + 1.0);
      vec4 Pt = vec4(Pi.xy, Pi.xy + 1.0);
      Pt = Pt - floor(Pt * (1.0/71.0)) * 71.0;
      Pt += vec2(26.0,161.0).xyxy; Pt *= Pt;
      Pt = Pt.xzxz * Pt.yyww;
      vec4 hx = fract(Pt*(1.0/951.135664));
      vec4 hy = fract(Pt*(1.0/642.949883));
      vec4 gx = hx - 0.49999, gy = hy - 0.49999;
      vec4 gr = inversesqrt(gx*gx + gy*gy) * (gx*Pf.xzxz + gy*Pf.yyww);
      gr *= 1.4142135623730950;
      vec2 b = Pf.xy*Pf.xy*Pf.xy*(Pf.xy*(Pf.xy*6.0-15.0)+10.0);
      vec4 b2 = vec4(b, 1.0-b);
      return dot(gr, b2.zxzx * b2.wwyy);
    }
    float px(float c, vec2 r) { return (1.0/max(r.x,r.y))*c; }
    float lineFn(vec2 st, float w, float perc, float off, vec2 mouse, float t, float amp, float dist) {
      float sp = 0.1 + perc*0.4;
      float an = smoothstep(sp, 0.7, st.x) * 0.5 * amp * (1.0+(mouse.y-0.5)*0.2);
      float ts = t/10.0 + (mouse.x-0.5);
      float bl = smoothstep(sp, sp+0.05, st.x) * perc;
      float xn = mix(Perlin2D(vec2(ts,st.x+perc)*2.5),
                     Perlin2D(vec2(ts,st.x+ts)*3.5)/1.5, st.x*0.3);
      float y  = 0.5 + (perc-0.5)*dist + xn/2.0*an;
      float ls = smoothstep(y+(w/2.0)+(u_line_blur*px(1.0,iResolution.xy)*bl), y, st.y);
      float le = smoothstep(y, y-(w/2.0)-(u_line_blur*px(1.0,iResolution.xy)*bl), st.y);
      return clamp((ls-le)*(1.0-smoothstep(0.0,1.0,pow(perc,0.3))), 0.0, 1.0);
    }
    void main() {
      vec2 uv = gl_FragCoord.xy / iResolution.xy;
      float s = 1.0;
      for (int i = 0; i < u_line_count; i++) {
        float p = float(i)/float(u_line_count);
        s *= 1.0 - lineFn(uv, u_line_width*px(1.0,iResolution.xy)*(1.0-p), p,
                          PI*p, uMouse, iTime, uAmplitude, uDistance);
      }
      float v = 1.0 - s;
      gl_FragColor = vec4(uColor * v, v);
    }
  `;

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    return sh;
  }

  let waveRAF = null;
  let waveGL  = null;

  function startWave() {
    if (waveRAF) return;
    const gl = waveCanvas.getContext('webgl') || waveCanvas.getContext('experimental-webgl');
    if (!gl) return;
    waveGL = gl;
    gl.clearColor(0,0,0,0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER,   VS));
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, 'iTime');
    const uRes  = gl.getUniformLocation(prog, 'iResolution');
    const uCol  = gl.getUniformLocation(prog, 'uColor');
    const uAmp  = gl.getUniformLocation(prog, 'uAmplitude');
    const uDist = gl.getUniformLocation(prog, 'uDistance');
    const uMou  = gl.getUniformLocation(prog, 'uMouse');

    // Cyan — same accent colour as dark mode (#00c8ff)
    gl.uniform3fv(uCol,  [0.0, 0.784, 1.0]);
    gl.uniform1f(uAmp,   1.6);
    gl.uniform1f(uDist,  0.22);
    gl.uniform2fv(uMou,  [0.5, 0.5]);

    function resize() {
      const { clientWidth: w, clientHeight: h } = waveCanvas.parentElement || document.body;
      waveCanvas.width  = w;
      waveCanvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform3fv(uRes, [w, h, w / (h || 1)]);
    }
    window.addEventListener('resize', resize);
    // display:none→block doesn't reflow synchronously; double-RAF guarantees
    // the browser has measured the canvas before we set the WebGL viewport
    resize();
    requestAnimationFrame(() => requestAnimationFrame(() => resize()));

    function frame(t) {
      waveRAF = requestAnimationFrame(frame);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, t * 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    waveRAF = requestAnimationFrame(frame);
  }

  function stopWave() {
    if (waveRAF) { cancelAnimationFrame(waveRAF); waveRAF = null; }
  }

  // ── Apply/remove theme ──
  // dark mode → show sun (click to go light); light mode → show moon (click to go dark)
  function applyTheme(light) {
    if (light) {
      document.body.classList.add('light-mode');
      sunIcon.classList.add('hidden');    // hide sun in light mode
      moonIcon.classList.remove('hidden'); // show moon in light mode
      startWave();
      if (window._particles) window._particles.start();
    } else {
      document.body.classList.remove('light-mode');
      moonIcon.classList.add('hidden');   // hide moon in dark mode
      sunIcon.classList.remove('hidden'); // show sun in dark mode
      stopWave();
      if (window._particles) window._particles.stop();
    }
    const dotCanvas  = document.getElementById('dotSurface');
    const hillCanvas = document.getElementById('hillSurface');
    if (dotCanvas)  dotCanvas.style.display  = light ? 'none'  : '';
    if (hillCanvas) hillCanvas.style.display = light ? ''      : 'none';
    if (!light && window._dotSurface) window._dotSurface.setColor([0.0, 0.55, 1.0], 0.72);
    localStorage.setItem('theme', light ? 'light' : 'dark');
  }

  btn.addEventListener('click', () => {
    applyTheme(!document.body.classList.contains('light-mode'));
  });

  // Restore saved preference — poll until canvas has real dimensions then start wave
  const _savedLight = localStorage.getItem('theme') === 'light';
  if (_savedLight) {
    document.body.classList.add('light-mode');
    sunIcon.classList.add('hidden');
    moonIcon.classList.remove('hidden');
    (function waitForCanvas() {
      const w = waveCanvas.clientWidth || (waveCanvas.parentElement && waveCanvas.parentElement.clientWidth);
      if (w && w > 0) { startWave(); }
      else { requestAnimationFrame(waitForCanvas); }
    })();
  }
})();

// ── Animated 3-D dot surface (dark mode) ──────────────────────────────────
(function initDotSurface() {
  const canvas = document.getElementById('dotSurface');
  if (!canvas) return;

  const AMOUNTX = 55, AMOUNTY = 80, SEP = 85, TOTAL = AMOUNTX * AMOUNTY;

  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) return;

  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const VS = `
    attribute vec3 aPos;
    uniform mat4 uMVP;
    varying float vW;
    void main() {
      vec4 clip    = uMVP * vec4(aPos, 1.0);
      gl_Position  = clip;
      gl_PointSize = clamp(3800.0 / clip.w, 1.0, 6.0);
      vW = clip.w;
    }
  `;
  const FS = `
    precision mediump float;
    uniform vec3  uColor;
    uniform float uAlpha;
    varying float vW;
    void main() {
      vec2  c = 2.0 * gl_PointCoord - 1.0;
      float r = dot(c, c);
      if (r > 1.0) discard;
      if (r < 0.18) discard;
      float edge = 1.0 - smoothstep(0.55, 1.0, r);
      float fog  = 1.0 - smoothstep(1800.0, 5000.0, vW);
      gl_FragColor = vec4(uColor, uAlpha * edge * fog);
    }
  `;

  function mkShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s); return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, mkShader(gl.VERTEX_SHADER,   VS));
  gl.attachShader(prog, mkShader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const aPosLoc   = gl.getAttribLocation(prog,  'aPos');
  const uMVPLoc   = gl.getUniformLocation(prog, 'uMVP');
  const uColLoc   = gl.getUniformLocation(prog, 'uColor');
  const uAlphaLoc = gl.getUniformLocation(prog, 'uAlpha');

  // Precompute static XZ grid
  const xz = new Float32Array(TOTAL * 2);
  for (let ix = 0; ix < AMOUNTX; ix++)
    for (let iy = 0; iy < AMOUNTY; iy++) {
      const i = ix * AMOUNTY + iy;
      xz[i*2]   = ix * SEP - (AMOUNTX * SEP) / 2;
      xz[i*2+1] = iy * SEP - (AMOUNTY * SEP) / 2;
    }
  const posData = new Float32Array(TOTAL * 3);
  const buf = gl.createBuffer();

  // ── Matrix helpers ──────────────────────────────────────────────────
  function perspective(fovY, asp, n, f) {
    const t = 1 / Math.tan(fovY / 2), m = new Float32Array(16);
    m[0] = t/asp; m[5] = t;
    m[10] = (f+n)/(n-f); m[11] = -1; m[14] = 2*f*n/(n-f);
    return m;
  }
  function lookAt(ex, ey, ez, tx, ty, tz) {
    let zx=ex-tx, zy=ey-ty, zz=ez-tz;
    let l = Math.hypot(zx,zy,zz); zx/=l; zy/=l; zz/=l;
    // right = cross(up=(0,1,0), z)
    let xx=zz, xy=0, xz2=-zx;
    l = Math.hypot(xx,xy,xz2); xx/=l; xy/=l; xz2/=l;
    // up' = cross(z, right)
    const yx=zy*xz2-zz*xy, yy=zz*xx-zx*xz2, yz=zx*xy-zy*xx;
    const m = new Float32Array(16);
    m[0]=xx;  m[4]=xy;  m[8] =xz2; m[12]=-(xx*ex +xy*ey +xz2*ez);
    m[1]=yx;  m[5]=yy;  m[9] =yz;  m[13]=-(yx*ex +yy*ey +yz*ez);
    m[2]=zx;  m[6]=zy;  m[10]=zz;  m[14]=-(zx*ex +zy*ey +zz*ez);
    m[15]=1; return m;
  }
  function mul4(a, b) {
    const m = new Float32Array(16);
    for (let i=0;i<4;i++) for (let j=0;j<4;j++) {
      let s=0; for (let k=0;k<4;k++) s += a[i+k*4]*b[k+j*4]; m[i+j*4]=s;
    }
    return m;
  }

  function resize() {
    const el = canvas.parentElement || document.body;
    const w  = el.clientWidth  || window.innerWidth;
    const h  = el.clientHeight || window.innerHeight;
    if (!w || !h) return;
    canvas.width = w; canvas.height = h;
    gl.viewport(0, 0, w, h);
    const P   = perspective(60 * Math.PI / 180, w / h, 1, 10000);
    const V   = lookAt(0, 355, 1220, 0, 0, 0);
    const mvp = mul4(P, V);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(uMVPLoc, false, mvp);
  }
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(() => requestAnimationFrame(resize));

  // Initial colour from saved theme
  const _isLight = document.body.classList.contains('light-mode');
  gl.uniform3fv(uColLoc, _isLight ? [0, 0, 0] : [0.0, 0.55, 1.0]);
  gl.uniform1f(uAlphaLoc, _isLight ? 0.38 : 0.72);

  let t = 0, dsRAF = null;
  function frame() {
    dsRAF = requestAnimationFrame(frame);
    for (let ix = 0; ix < AMOUNTX; ix++)
      for (let iy = 0; iy < AMOUNTY; iy++) {
        const i = ix * AMOUNTY + iy;
        posData[i*3]   = xz[i*2];
        posData[i*3+1] = Math.sin((ix + t) * 0.3) * 50 + Math.sin((iy + t) * 0.5) * 50;
        posData[i*3+2] = xz[i*2+1];
      }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, false, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, TOTAL);
    t += 0.1;
  }
  frame();

  window._dotSurface = {
    setColor(rgb, alpha) {
      gl.useProgram(prog);
      gl.uniform3fv(uColLoc, rgb);
      gl.uniform1f(uAlphaLoc, alpha !== undefined ? alpha : 0.72);
    }
  };
})();

const chat = document.getElementById('chat');
const micBtn = document.getElementById('micBtn');

function fixLayout() {
  // no-op: mainPanel centering is handled by CSS flex (leftNav is position:fixed so out of flow)
}
window.addEventListener('resize', fixLayout);
const micLabel = document.getElementById('micLabel');
const fileBtn = document.getElementById('fileBtn'); // may be null if removed from UI
const closeBtn = document.getElementById('closeBtn');
const clearBtn = document.getElementById('clearBtn');
const historyBtn = document.getElementById('historyBtn');
const historySidebar = document.getElementById('historySidebar');
const historyClose = document.getElementById('historyClose');
const historyList = document.getElementById('historyList');
const cardPanel = document.getElementById('cardPanel');
const cardContent = document.getElementById('cardContent');
const cardSource = document.getElementById('cardSource');
document.getElementById('cardClose')?.addEventListener('click', () => cardPanel.classList.add('hidden'));
const voiceSpeedSlider = document.getElementById('voiceSpeedSlider');
const voiceSpeedVal = document.getElementById('voiceSpeedVal');

let history = [];
let profile = null;
let isRecording = false;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let pcmChunks = [];
let currentStream = null;

// ===================== FAVOURITES =====================
let favourites = JSON.parse(localStorage.getItem('jarvis_favourites') || '[]');

const FAV_PATTERNS = {
  stock:  /\b(stock|share|price|ticker|nasdaq|nyse|s&p|dow|market cap|ipo|dividend|\$[A-Z]{1,5})\b/i,
  sports: /\b(score|match|game|fixture|result|goal|standings|league|premier|champions|nba|nfl|nhl|f1|grand prix|cricket|tennis|golf|boxing|ufc|rugby)\b/i,
  tv:     /\b(movie|film|show|series|episode|season|release|premiere|streaming|netflix|disney|hbo|cinema|trailer|cast)\b/i,
  news:   /\b(election|president|minister|government|war|conflict|breaking|latest|today|update)\b/i,
};

function detectFavType(message) {
  for (const [type, re] of Object.entries(FAV_PATTERNS)) {
    if (re.test(message)) return type;
  }
  return null;
}

const FAV_ICONS = { stock: '📈', sports: '⚽', tv: '🎬', news: '📰', general: '⭐' };
const FAV_LABELS = { stock: 'STOCK / MARKET', sports: 'SPORTS', tv: 'MOVIE / TV', news: 'NEWS', general: 'GENERAL' };

function saveFavourites() {
  localStorage.setItem('jarvis_favourites', JSON.stringify(favourites));
}

function extractTicker(query) {
  const m = query.match(/\$([A-Z]{1,5})\b/) || query.match(/\b([A-Z]{1,5})\s+stock\b/i);
  return m ? m[1].toUpperCase() : null;
}

async function fetchStockPrice(ticker) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m&_=${Date.now()}`);
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prev  = meta.previousClose || meta.chartPreviousClose;
    const change = price - prev;
    const pct    = ((change / prev) * 100).toFixed(2);
    return { price: price.toFixed(2), change: change.toFixed(2), pct, currency: meta.currency || 'USD', dir: change >= 0 ? 'up' : 'down' };
  } catch { return null; }
}

async function refreshFavCard(fav) {
  if (fav.type === 'stock' && fav.ticker) {
    const data = await fetchStockPrice(fav.ticker);
    if (data) {
      fav.liveData = data;
      fav.lastUpdated = Date.now();
      saveFavourites();
    }
  }
}

function buildFavCardHTML(fav) {
  const icon  = FAV_ICONS[fav.type] || '⭐';
  const label = FAV_LABELS[fav.type] || 'GENERAL';
  const added = new Date(fav.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  let liveText = '—';
  let liveClass = '';
  let detailHTML = `<strong>QUERY:</strong> ${fav.query}<br><strong>ADDED:</strong> ${added}`;

  if (fav.type === 'stock' && fav.liveData) {
    const d = fav.liveData;
    liveText  = `${d.currency} ${d.price}`;
    liveClass = d.dir;
    const arrow = d.dir === 'up' ? '▲' : '▼';
    detailHTML = `<strong>TICKER:</strong> ${fav.ticker || '—'}<br><strong>PRICE:</strong> ${d.currency} ${d.price}<br><strong>CHANGE:</strong> ${arrow} ${d.change} (${d.pct}%)<br><strong>UPDATED:</strong> ${new Date(fav.lastUpdated).toLocaleTimeString()}`;
  }

  return `
    <div class="fav-card" data-id="${fav.id}">
      <div class="fav-card-header">
        <div class="fav-card-icon">${icon}</div>
        <div class="fav-card-info">
          <div class="fav-card-title">${fav.title}</div>
          <div class="fav-card-type">${label}</div>
        </div>
        <div class="fav-card-live ${liveClass}">${liveText}</div>
        <button class="fav-card-toggle" title="Expand">▼</button>
      </div>
      <div class="fav-card-body">
        <div class="fav-card-body-inner">
          <div class="fav-card-detail">${detailHTML}</div>
          <div class="fav-card-actions">
            <button class="fav-card-btn refresh" data-id="${fav.id}">↻ REFRESH</button>
            <button class="fav-card-btn open-browser" data-url="${fav.url}">↗ OPEN</button>
            <button class="fav-card-btn remove" data-id="${fav.id}">✕ REMOVE</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderFavourites() {
  const list  = document.getElementById('favouritesList');
  const empty = document.getElementById('favouritesEmpty');
  if (!list) return;
  if (favourites.length === 0) {
    list.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';
  list.innerHTML = favourites.map(buildFavCardHTML).join('');

  // Toggle expand
  list.querySelectorAll('.fav-card-header').forEach(header => {
    header.addEventListener('click', () => {
      const card   = header.closest('.fav-card');
      const body   = card.querySelector('.fav-card-body');
      const toggle = card.querySelector('.fav-card-toggle');
      body.classList.toggle('open');
      toggle.classList.toggle('open');
    });
  });

  // Refresh
  list.querySelectorAll('.fav-card-btn.refresh').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id  = btn.dataset.id;
      const fav = favourites.find(f => f.id === id);
      if (!fav) return;
      btn.textContent = '↻ ...';
      await refreshFavCard(fav);
      renderFavourites();
    });
  });

  // Open in browser
  list.querySelectorAll('.fav-card-btn.open-browser').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.jarvis.openUrl(btn.dataset.url);
    });
  });

  // Remove
  list.querySelectorAll('.fav-card-btn.remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      favourites = favourites.filter(f => f.id !== btn.dataset.id);
      saveFavourites();
      renderFavourites();
    });
  });
}

function addFavourite(title, query, url, type) {
  const existing = favourites.find(f => f.query === query);
  if (existing) return existing.id;
  const id  = Date.now().toString();
  const ticker = type === 'stock' ? extractTicker(query) : null;
  const fav = { id, title, query, url, type: type || 'general', ticker, addedAt: Date.now(), liveData: null, lastUpdated: null };
  favourites.unshift(fav);
  saveFavourites();
  if (type === 'stock' && ticker) refreshFavCard(fav).then(() => renderFavourites());
  else renderFavourites();
  return id;
}

// Panel open/close + quick-access bubble
const favouritesPanel = document.getElementById('lnavPaneFavourites');
const favBubble       = document.getElementById('favBubble');
const favBubbleList   = document.getElementById('favBubbleList');
const FAV_ICONS_MAP   = { stock: '📈', sports: '⚽', tv: '🎬', news: '📰', general: '⭐' };

function buildFavBubble() {
  if (!favBubbleList) return;
  if (!favourites.length) {
    favBubbleList.innerHTML = '<div class="fav-bubble-empty">No favourites yet</div>';
    return;
  }
  favBubbleList.innerHTML = favourites.map(f => `
    <div class="fav-bubble-item" data-query="${encodeURIComponent(f.query)}">
      <span class="fav-bubble-icon">${FAV_ICONS_MAP[f.type] || '⭐'}</span>
      <span class="fav-bubble-label">${esc(f.title)}</span>
      <button class="fav-bubble-remove" data-query="${encodeURIComponent(f.query)}" title="Remove">✕</button>
    </div>`).join('');

  favBubbleList.querySelectorAll('.fav-bubble-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.fav-bubble-remove')) return;
      const q = decodeURIComponent(el.dataset.query);
      favBubble.classList.add('hidden');
      sendToJarvis(q);
    });
  });

  favBubbleList.querySelectorAll('.fav-bubble-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const q = decodeURIComponent(btn.dataset.query);
      favourites = favourites.filter(f => f.query !== q);
      saveFavourites();
      buildFavBubble();
      if (!favourites.length) favBubble.classList.add('hidden');
    });
  });
}

// favLauncher removed — favourites accessible via sidebar nav tab

document.getElementById('favouritesClose')?.addEventListener('click', () => {
  historySidebar.classList.add('hidden');
});

// Auto-refresh stocks on startup
(async () => {
  const stockFavs = favourites.filter(f => f.type === 'stock' && f.ticker);
  for (const fav of stockFavs) await refreshFavCard(fav);
  if (stockFavs.length) renderFavourites();
})();

// ===================== STATE =====================
const orbContainer = document.getElementById('orbContainer');
let _sessionMsgCount = 0;
const SPARKLES_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"/><path d="M5 16l.75 2.25L8 19l-2.25.75L5 22l-.75-2.25L2 19l2.25-.75L5 16z"/><path d="M19 2l.5 1.5L21 4l-1.5.5L19 6l-.5-1.5L17 4l1.5-.5L19 2z"/></svg>`;
const COPY_SVG   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function addMessage(role, text) {
  // Row wrapper (flex row, aligns avatar + bubble)
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  // Avatar for assistant
  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = SPARKLES_SVG;
    row.appendChild(avatar);
  }

  // Bubble
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  const textSpan = document.createElement('span');
  textSpan.className = 'msg-text';
  textSpan.textContent = text;
  div.appendChild(textSpan);

  if (role === 'assistant') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = COPY_SVG;
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = CHECK_SVG;
        setTimeout(() => { copyBtn.innerHTML = COPY_SVG; }, 1500);
      });
    });
    div.appendChild(copyBtn);
  }

  row.appendChild(div);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  if (chat.children.length >= 1) orbContainer.classList.add('compact');
  _sessionMsgCount++;
  const el = document.getElementById('swSession');
  if (el) el.textContent = _sessionMsgCount + ' msg' + (_sessionMsgCount !== 1 ? 's' : '');
  return div;
}

function showStopBtn(visible) {
  let btn = document.getElementById('stopResponseBtn');
  if (!btn) return;
  btn.style.display = visible ? 'flex' : 'none';
}

function setState(state) {
  orb.className = state;
  if (state === 'idle') {
    orbLabel.textContent = 'STANDBY';
    micBtn.classList.remove('active');
    animateMicLabel('CLICK TO SPEAK');
    window._shaderGlow = 0.0;
  } else if (state === 'listening') {
    orbLabel.textContent = 'LISTENING';
    micBtn.classList.add('active');
    animateMicLabel('CLICK TO STOP');
    window._shaderGlow = 1.0;
  } else if (state === 'thinking') {
    orbLabel.textContent = 'PROCESSING';
    micBtn.classList.remove('active');
    animateMicLabel('PLEASE WAIT');
    window._shaderGlow = 0.4;
  }
}

function animateMicLabel(text) {
  micLabel.innerHTML = '';
  text.split('').forEach((char, i) => {
    const span = document.createElement('span');
    span.textContent = char === ' ' ? ' ' : char;
    span.className = 'mic-char';
    span.style.animationDelay = `${i * 0.04}s`;
    micLabel.appendChild(span);
  });
}

// ===================== WEBGL SHADER BACKGROUND =====================
(function initShaderBackground() {
  const canvas = document.getElementById('shaderBg');
  if (!canvas) return;
  const gl = canvas.getContext('webgl');
  if (!gl) return;

  const vsSource = `
    attribute vec4 aVertexPosition;
    void main() { gl_Position = aVertexPosition; }
  `;

  const fsSource = `
    precision highp float;
    uniform vec2 iResolution;
    uniform float iTime;
    uniform float uGlow;

    const float overallSpeed = 0.15;
    const float gridSmoothWidth = 0.015;
    const float scale = 5.0;
    const vec4 lineColor = vec4(0.0, 0.72, 1.0, 1.0);
    const float minLineWidth = 0.008;
    const float maxLineWidth = 0.10;
    const float lineSpeed = 1.0 * overallSpeed;
    const float lineAmplitude = 0.38;
    const float lineFrequency = 0.2;
    const float warpSpeed = 0.2 * overallSpeed;
    const float warpFrequency = 0.5;
    const float warpAmplitude = 0.3;
    const float offsetFrequency = 0.5;
    const float offsetSpeed = 1.33 * overallSpeed;
    const float minOffsetSpread = 0.2;
    const float maxOffsetSpread = 0.8;
    const int linesPerGroup = 12;

    #define drawCircle(pos, radius, coord) smoothstep(radius + gridSmoothWidth, radius, length(coord - (pos)))
    #define drawSmoothLine(pos, halfWidth, t) smoothstep(halfWidth, 0.0, abs(pos - (t)))
    #define drawCrispLine(pos, halfWidth, t) smoothstep(halfWidth + gridSmoothWidth, halfWidth, abs(pos - (t)))

    float random(float t) {
      return (cos(t) + cos(t * 1.3 + 1.3) + cos(t * 1.4 + 1.4)) / 3.0;
    }

    float getPlasmaY(float x, float hFade, float offset) {
      return random(x * lineFrequency + iTime * lineSpeed) * hFade * lineAmplitude + offset;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / iResolution.xy;
      vec2 space = (gl_FragCoord.xy - iResolution.xy / 2.0) / iResolution.x * 2.0 * scale;

      float hFade = 1.0 - (cos(uv.x * 6.28) * 0.5 + 0.5);
      float vFade = 1.0 - (cos(uv.y * 6.28) * 0.5 + 0.5);

      space.y += random(space.x * warpFrequency + iTime * warpSpeed) * warpAmplitude * (0.5 + hFade);
      space.x += random(space.y * warpFrequency + iTime * warpSpeed + 2.0) * warpAmplitude * hFade;

      vec4 lines = vec4(0.0);

      for (int l = 0; l < linesPerGroup; l++) {
        float nli = float(l) / float(linesPerGroup);
        float offsetTime = iTime * offsetSpeed;
        float offsetPos = float(l) + space.x * offsetFrequency;
        float rand = random(offsetPos + offsetTime) * 0.5 + 0.5;
        float halfWidth = mix(minLineWidth, maxLineWidth, rand * hFade) / 2.0;
        float offset = random(offsetPos + offsetTime * (1.0 + nli)) * mix(minOffsetSpread, maxOffsetSpread, hFade);
        float linePos = getPlasmaY(space.x, hFade, offset);
        float line = drawSmoothLine(linePos, halfWidth, space.y) / 2.0
                   + drawCrispLine(linePos, halfWidth * 0.15, space.y);
        float cx = mod(float(l) + iTime * lineSpeed, 25.0) - 12.0;
        vec2 cp = vec2(cx, getPlasmaY(cx, hFade, offset));
        float circle = drawCircle(cp, 0.01, space) * 4.0;
        lines += (line + circle) * lineColor * rand;
      }

      // Restrict waves to vertical center band so they don't reach text areas
      float centerFade = smoothstep(0.0, 0.18, uv.y) * smoothstep(1.0, 0.82, uv.y);

      vec4 col = mix(vec4(0.0, 0.02, 0.07, 1.0), vec4(0.0, 0.04, 0.13, 1.0), uv.x);
      col *= vFade;
      col.a = 1.0;
      col += lines * centerFade * (0.6 + uGlow * 0.5);
      gl_FragColor = col;
    }
  `;

  function loadShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
    return shader;
  }

  const program = gl.createProgram();
  gl.attachShader(program, loadShader(gl, gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, loadShader(gl, gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  const attribPos   = gl.getAttribLocation(program, 'aVertexPosition');
  const uResolution = gl.getUniformLocation(program, 'iResolution');
  const uTime       = gl.getUniformLocation(program, 'iTime');
  const uGlowLoc    = gl.getUniformLocation(program, 'uGlow');
  window._shaderGlow = 0.0;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);
  resize();

  const t0 = Date.now();
  function render() {
    const t = (Date.now() - t0) / 1000;
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uGlowLoc, window._shaderGlow || 0.0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(attribPos, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(attribPos);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
})();



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
  const W = 288, H = 130, pad = 0;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / range) * (H * 0.75) - H * 0.12;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color  = positive ? '#3b82f6' : '#ef4444';
  const fill   = positive ? 'rgba(59,130,246,0.18)' : 'rgba(239,68,68,0.18)';
  const lastX  = ((vals.length - 1) / (vals.length - 1) * W).toFixed(1);
  const areaD  = `M ${pts.join(' L ')} L ${lastX},${H} L 0,${H} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="${W}" height="${H}">
    <path d="${areaD}" fill="${fill}"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
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

  // Auto-refresh every 90 seconds
  setInterval(async () => {
    if (!finPortfolio.length) return;
    const syms = finPortfolio.map(s => s.symbol);
    const updated = await Promise.all(
      syms.map(sym => window.jarvis.financeGetStock(sym).catch(() => null))
    );
    const valid = updated.filter(Boolean);
    if (valid.length) { finPortfolio = valid; finRender(); }
  }, 90000);
}

// ===================== DOCK MAGNIFY (scroll + neighbor effect) =====================
(function initDock() {
  const dock = document.getElementById('dockBar');
  if (!dock) return;
  const items = Array.from(dock.querySelectorAll('.dock-item'));

  // Neighbor magnify on hover
  items.forEach((el, i) => {
    el.addEventListener('mouseenter', () => {
      items.forEach((item, j) => {
        const dist = Math.abs(j - i);
        item.classList.remove('dock-near', 'dock-far');
        if (dist === 1) item.classList.add('dock-near');
        else if (dist === 2) item.classList.add('dock-far');
      });
    });
    el.addEventListener('mouseleave', () => {
      items.forEach(item => item.classList.remove('dock-near', 'dock-far'));
    });
  });

  // Scroll over dock zooms the closest item
  let scrollTimeout;
  dock.addEventListener('wheel', (e) => {
    e.preventDefault();
    clearTimeout(scrollTimeout);
    // Find which item mouse is nearest to
    const mx = e.clientX;
    let closest = null, closestDist = Infinity;
    items.forEach(item => {
      const r = item.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const d = Math.abs(cx - mx);
      if (d < closestDist) { closestDist = d; closest = item; }
    });
    if (closest) {
      closest.style.transform = 'scale(1.55) translateY(-7px)';
      closest.style.boxShadow = '0 8px 28px rgba(0,180,255,0.4)';
      scrollTimeout = setTimeout(() => {
        closest.style.transform = '';
        closest.style.boxShadow = '';
      }, 350);
    }
  }, { passive: false });
})();

// ===================== HUD CLOCK =====================
(function initClock() {
  const timeEl = document.getElementById('hudTime');
  const dateEl = document.getElementById('hudDate');
  if (!timeEl) return;
  const days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  function tick() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2,'0');
    const m = String(now.getMinutes()).padStart(2,'0');
    const s = String(now.getSeconds()).padStart(2,'0');
    timeEl.textContent = `${h}:${m}:${s}`;
    dateEl.textContent = `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]}`;
  }
  tick();
  setInterval(tick, 1000);
})();

// ===================== LOCATION + WEATHER =====================
const WeatherWidget = (function() {
  const WMO = {
    0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',
    51:'🌦️',53:'🌦️',55:'🌧️',61:'🌧️',63:'🌧️',65:'🌧️',
    71:'🌨️',73:'🌨️',75:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',
    95:'⛈️',96:'⛈️',99:'⛈️'
  };

  let _lat, _lon, _city, _country, _timer;

  function els() {
    return {
      widget: document.getElementById('hudWeather'),
      temp:   document.getElementById('hudTemp'),
      loc:    document.getElementById('hudLocation'),
    };
  }

  function isEnabled() {
    return localStorage.getItem('locationEnabled') !== 'false';
  }

  async function fetchWeather() {
    const { temp, loc } = els();
    if (!temp) return;
    try {
      const url  = `https://api.open-meteo.com/v1/forecast?latitude=${_lat}&longitude=${_lon}&current=temperature_2m,weathercode&timezone=auto`;
      const data = await fetch(url).then(r => r.json());
      const t    = Math.round(data.current.temperature_2m);
      const icon = WMO[data.current.weathercode] ?? '🌡️';
      temp.textContent = `${icon} ${t}°C`;
      loc.textContent  = `${_city}, ${_country}`;
    } catch {
      temp.textContent = `-- °C`;
      loc.textContent  = _city ? `${_city}, ${_country}` : 'Unavailable';
    }
  }

  async function getLocationFromIP() {
    // Try freeipapi first, then ipapi.co as fallback
    const apis = [
      async () => {
        const d = await fetch('https://freeipapi.com/api/json').then(r => r.json());
        return { lat: d.latitude, lon: d.longitude, city: d.cityName, country: d.countryCode };
      },
      async () => {
        const d = await fetch('https://ipapi.co/json/').then(r => r.json());
        return { lat: d.latitude, lon: d.longitude, city: d.city, country: d.country_code };
      },
      async () => {
        const d = await fetch('https://ipwhois.app/json/').then(r => r.json());
        return { lat: d.latitude, lon: d.longitude, city: d.city, country: d.country_code };
      }
    ];
    for (const api of apis) {
      try {
        const result = await api();
        if (result.lat && result.city) return result;
      } catch { /* try next */ }
    }
    throw new Error('All IP APIs failed');
  }

  async function getLocationFromGPS() {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        async pos => {
          try {
            const { latitude: lat, longitude: lon } = pos.coords;
            const nom  = await fetch(
              `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
              { headers: { 'Accept-Language': 'en' } }
            ).then(r => r.json());
            const city    = nom.address?.city || nom.address?.town || nom.address?.village || nom.address?.county || '—';
            const country = (nom.address?.country_code || '').toUpperCase();
            resolve({ lat, lon, city, country });
          } catch { reject(); }
        },
        () => reject(),
        { timeout: 8000 }
      );
    });
  }

  async function init() {
    const { widget, temp, loc } = els();
    if (!temp) return;

    // Use stored country from signup if available
    const storedCountry = localStorage.getItem('userCountry');

    if (!isEnabled()) {
      if (widget) widget.style.display = 'none';
      return;
    }

    loc.textContent = 'Locating…';

    try {
      ({ lat: _lat, lon: _lon, city: _city, country: _country } = await getLocationFromGPS());
    } catch {
      try {
        ({ lat: _lat, lon: _lon, city: _city, country: _country } = await getLocationFromIP());
      } catch {
        temp.textContent = '--°C';
        loc.textContent  = storedCountry ? `📍 ${storedCountry}` : 'Unavailable';
        return;
      }
    }

    await fetchWeather();
    clearInterval(_timer);
    _timer = setInterval(fetchWeather, 15 * 60 * 1000);
  }

  function setEnabled(on) {
    localStorage.setItem('locationEnabled', on ? 'true' : 'false');
    const { widget, temp, loc } = els();
    if (!widget) return;
    if (on) {
      widget.style.display = '';
      init();
    } else {
      widget.style.display = 'none';
      clearInterval(_timer);
    }
  }

  return { init, setEnabled, isEnabled };
})();

WeatherWidget.init();

// ===================== NEWS FLASH MARQUEE =====================
const NewsFlash = (() => {
  const inner = document.getElementById('newsFlashInner');
  let _headlines = [];

  function render(headlines) {
    if (!inner || !headlines || headlines.length === 0) return;
    _headlines = headlines;
    // Build double-set for seamless loop (50% trick)
    const full = [...headlines, ...headlines];
    inner.innerHTML = full
      .map(h => `<span class="news-item">${h}</span>`)
      .join('');
    // Adjust speed to headline count
    const duration = Math.max(40, headlines.length * 10);
    inner.style.animationDuration = `${duration}s`;
  }

  // Listen for headlines pushed from main process
  window.jarvis.onNewsHeadlines && window.jarvis.onNewsHeadlines((headlines) => {
    render(headlines);
  });

  return { render };
})();

// ===================== CARD PANEL =====================
// Map team/country names → flag emoji for sports cards without logos
const TEAM_FLAGS = {
  'spain': '🇪🇸', 'argentina': '🇦🇷', 'france': '🇫🇷', 'brazil': '🇧🇷',
  'england': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'germany': '🇩🇪', 'portugal': '🇵🇹', 'netherlands': '🇳🇱',
  'italy': '🇮🇹', 'belgium': '🇧🇪', 'croatia': '🇭🇷', 'morocco': '🇲🇦',
  'usa': '🇺🇸', 'united states': '🇺🇸', 'mexico': '🇲🇽', 'canada': '🇨🇦',
  'japan': '🇯🇵', 'south korea': '🇰🇷', 'australia': '🇦🇺', 'saudi arabia': '🇸🇦',
  'uruguay': '🇺🇾', 'colombia': '🇨🇴', 'chile': '🇨🇱', 'ecuador': '🇪🇨',
  'senegal': '🇸🇳', 'ghana': '🇬🇭', 'nigeria': '🇳🇬', 'cameroon': '🇨🇲',
  'switzerland': '🇨🇭', 'denmark': '🇩🇰', 'poland': '🇵🇱', 'serbia': '🇷🇸',
  'iran': '🇮🇷', 'qatar': '🇶🇦', 'wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿', 'scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  'real madrid': '⚽', 'barcelona': '⚽', 'manchester city': '⚽', 'manchester united': '⚽',
  'arsenal': '⚽', 'chelsea': '⚽', 'liverpool': '⚽', 'tottenham': '⚽',
  'psg': '⚽', 'paris saint-germain': '⚽', 'bayern munich': '⚽', 'juventus': '⚽',
  'ac milan': '⚽', 'inter milan': '⚽', 'atletico madrid': '⚽', 'borussia dortmund': '⚽',
};
function getTeamEmoji(name) {
  const key = (name || '').toLowerCase();
  for (const [k, v] of Object.entries(TEAM_FLAGS)) {
    if (key.includes(k)) return v;
  }
  return '🏟️';
}

function showCard(card) {
  if (!card) { cardPanel.classList.add('hidden'); return; }
  cardPanel.classList.remove('hidden');

  if (card.type === 'sports') {
    const scorersHtml = (card.scorers && card.scorers.length)
      ? `<div class="scorers-section"><div class="scorers-title">SCORERS</div>${card.scorers.map(s => `<div class="scorer-row"><span class="scorer-team">${esc(s.team)}</span><span class="scorer-detail">${esc(s.detail)}</span></div>`).join('')}</div>`
      : '';
    const metaHtml = [card.league, card.date, card.venue, card.status].filter(Boolean).map(m => `<span>${esc(m)}</span>`).join(' · ');
    const emoji1 = getTeamEmoji(card.team1);
    const emoji2 = getTeamEmoji(card.team2);
    const logo1Html = card.logo1
      ? `<img class="team-logo" src="${esc(card.logo1)}" alt="${esc(card.team1)}" />`
      : `<div class="team-logo-placeholder">${emoji1}</div>`;
    const logo2Html = card.logo2
      ? `<img class="team-logo" src="${esc(card.logo2)}" alt="${esc(card.team2)}" />`
      : `<div class="team-logo-placeholder">${emoji2}</div>`;
    cardContent.innerHTML = `
      <div class="card-sports">
        <div class="match-label">MATCH RESULT</div>
        <div class="score-row">
          <div class="team-block">
            ${logo1Html}
            <div class="team-name">${esc(card.team1)}</div>
            <div class="team-score">${esc(card.score1)}</div>
          </div>
          <div class="vs-divider">VS</div>
          <div class="team-block">
            ${logo2Html}
            <div class="team-score">${esc(card.score2)}</div>
            <div class="team-name">${esc(card.team2)}</div>
          </div>
        </div>
        ${metaHtml ? `<div class="match-meta">${metaHtml}</div>` : ''}
        ${scorersHtml}
        ${card.motm ? `<div class="motm-row">⭐ MOTM: ${esc(card.motm)}</div>` : ''}
        <div class="match-headline">${esc(card.headline)}</div>
        <button class="card-fav-btn" id="cardFavBtn">⭐ ADD TO FAVOURITES</button>
      </div>`;
    setTimeout(() => {
      const favBtn = document.getElementById('cardFavBtn');
      if (!favBtn) return;
      const matchTitle = `${card.team1} vs ${card.team2}`;
      const matchQuery = `${card.team1} vs ${card.team2} ${card.league || ''}`.trim();
      if (favourites.some(f => f.query === matchQuery)) {
        favBtn.textContent = '✓ IN FAVOURITES'; favBtn.classList.add('added'); favBtn.disabled = true; return;
      }
      favBtn.addEventListener('click', () => {
        addFavourite(matchTitle, matchQuery, card.sourceUrl || `https://www.google.com/search?q=${encodeURIComponent(matchQuery)}`, 'sports');
        favBtn.textContent = '✓ ADDED TO FAVOURITES'; favBtn.classList.add('added'); favBtn.disabled = true;
      });
    }, 50);
  } else if (card.type === 'stock') {
    const changeSign = card.positive ? '+' : '';
    const changeClass = card.positive ? 'positive' : 'negative';
    const arrowIcon = card.positive ? '▲' : '▼';
    const sparkSvg = buildSparkline(card.sparkline || [], card.positive);
    const label = card.isCrypto ? 'CRYPTO' : 'STOCK';
    const metaRows = [
      card.high52 ? `<div class="stock-meta-row"><span>52W HIGH</span><span>${esc(card.currency)} ${esc(card.high52)}</span></div>` : '',
      card.low52  ? `<div class="stock-meta-row"><span>52W LOW</span><span>${esc(card.currency)} ${esc(card.low52)}</span></div>` : '',
      card.marketCap ? `<div class="stock-meta-row"><span>MKT CAP</span><span>${esc(card.marketCap)}</span></div>` : '',
      card.volume ? `<div class="stock-meta-row"><span>VOLUME</span><span>${esc(card.volume)}</span></div>` : '',
    ].filter(Boolean).join('');
    cardContent.innerHTML = `
      <div class="card-stock">
        <div class="stock-type-label">${label}</div>
        <div class="stock-header">
          <div class="stock-symbol">${esc(card.symbol)}</div>
          <div class="stock-name">${esc(card.name)}</div>
        </div>
        <div class="stock-price">${esc(card.currency)} ${esc(card.price)}</div>
        <div class="stock-change ${changeClass}">${arrowIcon} ${changeSign}${esc(card.change)} (${changeSign}${esc(card.changePct)}%) TODAY</div>
        ${sparkSvg}
        ${metaRows ? `<div class="stock-meta">${metaRows}</div>` : ''}
        <a class="stock-link" href="#" id="cardStockLink">View on Yahoo Finance →</a>
        <button class="card-fav-btn" id="cardFavBtn">⭐ ADD TO FAVOURITES</button>
        <button id="cardFinBtn">📊 ADD TO FINANCIAL SECTION</button>
      </div>`;
    // Wire all card buttons
    setTimeout(() => {
      const favBtn = document.getElementById('cardFavBtn');
      const finBtn = document.getElementById('cardFinBtn');
      const stockLink = document.getElementById('cardStockLink');
      if (stockLink && card.sourceUrl) stockLink.addEventListener('click', (e) => { e.preventDefault(); window.jarvis.openUrl(card.sourceUrl); });

      if (favBtn) {
        favBtn.addEventListener('click', () => {
          const title  = `${card.symbol} — ${card.name}`;
          const query  = `${card.symbol} stock price`;
          const url    = card.sourceUrl || `https://finance.yahoo.com/quote/${card.symbol}`;
          const id     = addFavourite(title, query, url, 'stock');
          const fav    = favourites.find(f => f.id === id);
          if (fav) { fav.ticker = card.symbol; fav.liveData = { price: card.price, change: card.change, pct: card.changePct, currency: card.currency, dir: card.positive ? 'up' : 'down' }; fav.lastUpdated = Date.now(); saveFavourites(); renderFavourites(); }
          favBtn.textContent = '✓ ADDED TO FAVOURITES';
          favBtn.classList.add('added');
          favBtn.disabled = true;
        });
        if (favourites.some(f => f.ticker === card.symbol)) {
          favBtn.textContent = '✓ IN FAVOURITES'; favBtn.classList.add('added'); favBtn.disabled = true;
        }
      }

      if (finBtn) {
        // Check if already in panel
        if (finPortfolio.some(s => s.symbol === card.symbol)) {
          finBtn.textContent = '✓ IN FINANCIAL SECTION'; finBtn.classList.add('added'); finBtn.disabled = true;
        }
        finBtn.addEventListener('click', async () => {
          try {
            await window.finAddStock(card);
            finBtn.textContent = '✓ IN FINANCIAL SECTION';
            finBtn.classList.add('added');
            finBtn.disabled = true;
          } catch (err) {
            console.error('finAddStock failed:', err);
            finBtn.textContent = '⚠ ERROR — TRY AGAIN';
          }
        });
      }
    }, 50);
  } else if (card.type === 'private_company') {
    cardContent.innerHTML = `
      <div class="card-private-co">
        <div class="pco-label">PRIVATE COMPANY</div>
        <div class="pco-name">${esc(card.name)}</div>
        <div class="pco-msg">${esc(card.name)} is a privately held company and is not listed on any public stock exchange — no live price data is available.</div>
        <div class="pco-tip">Valuation estimates for private companies are based on funding rounds and are not publicly traded.</div>
      </div>`;
  } else if (card.type === 'company_finance') {
    const changeSign = card.positive ? '+' : '';
    const changeClass = card.positive ? 'positive' : 'negative';
    const arrowIcon = card.positive ? '▲' : '▼';

    // Build SVG revenue bar chart
    function buildRevenueChart(revenues) {
      if (!revenues || !revenues.length) return '<div class="cf-no-data">No historical revenue data available</div>';
      const maxRev = Math.max(...revenues.map(r => r.revenue));
      const barW = 48, gap = 10, h = 90, padL = 4, padB = 20;
      const totalW = revenues.length * (barW + gap) - gap + padL;
      const formatBillions = v => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : `$${v}`;
      const bars = revenues.map((r, i) => {
        const barH = maxRev > 0 ? Math.round((r.revenue / maxRev) * h) : 0;
        const x = padL + i * (barW + gap);
        const y = h - barH;
        return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="4" class="cf-bar" />
                <text x="${x + barW/2}" y="${h + 14}" text-anchor="middle" class="cf-bar-label">${esc(r.year)}</text>
                <text x="${x + barW/2}" y="${y - 4}" text-anchor="middle" class="cf-bar-val">${formatBillions(r.revenue)}</text>`;
      }).join('');
      return `<svg viewBox="0 0 ${totalW} ${h + padB + 12}" class="cf-chart">${bars}</svg>`;
    }

    const chartHtml = buildRevenueChart(card.revenues);
    const metricsHtml = [
      card.marketCap ? `<div class="cf-metric"><span>MKT CAP</span><span>${esc(card.marketCap)}</span></div>` : '',
      card.peRatio   ? `<div class="cf-metric"><span>P/E RATIO</span><span>${esc(card.peRatio)}</span></div>` : '',
      card.profitMargin ? `<div class="cf-metric"><span>PROFIT MARGIN</span><span>${esc(card.profitMargin)}</span></div>` : '',
    ].filter(Boolean).join('');

    cardContent.innerHTML = `
      <div class="card-company-finance">
        <div class="cf-label">COMPANY ANALYTICS</div>
        <div class="cf-header">
          <div class="cf-symbol">${esc(card.symbol)}</div>
          <div class="cf-name">${esc(card.name)}</div>
        </div>
        <div class="cf-price">${esc(card.currency)} ${esc(card.price)}</div>
        <div class="cf-change ${changeClass}">${arrowIcon} ${changeSign}${esc(card.change)} (${changeSign}${esc(card.changePct)}%) TODAY</div>
        ${card.revenues && card.revenues.length ? '<div class="cf-chart-title">ANNUAL REVENUE</div>' : ''}
        ${chartHtml}
        ${metricsHtml ? `<div class="cf-metrics">${metricsHtml}</div>` : ''}
        <div class="cf-actions">
          <button class="card-fav-btn" id="cardFavBtn">⭐ FAVOURITES</button>
          <button class="cf-portfolio-btn" id="cardFinBtn">📊 ADD TO PORTFOLIO</button>
        </div>
        ${card.sourceUrl ? `<a class="stock-link" href="#" id="cardStockLink">View Financials →</a>` : ''}
      </div>`;
    setTimeout(() => {
      const favBtn  = document.getElementById('cardFavBtn');
      const finBtn  = document.getElementById('cardFinBtn');
      const stockLink = document.getElementById('cardStockLink');
      if (stockLink && card.sourceUrl) stockLink.addEventListener('click', e => { e.preventDefault(); window.jarvis.openUrl(card.sourceUrl); });
      if (favBtn) {
        if (favourites.some(f => f.ticker === card.symbol)) {
          favBtn.textContent = '✓ IN FAVOURITES'; favBtn.classList.add('added'); favBtn.disabled = true;
        }
        favBtn.addEventListener('click', () => {
          const title = `${card.symbol} — ${card.name}`;
          const query = `${card.symbol} financials`;
          const url   = card.sourceUrl || `https://finance.yahoo.com/quote/${card.symbol}/financials`;
          addFavourite(title, query, url, 'stock');
          favBtn.textContent = '✓ ADDED'; favBtn.classList.add('added'); favBtn.disabled = true;
        });
      }
      if (finBtn) {
        if (finPortfolio.some(s => s.symbol === card.symbol)) {
          finBtn.textContent = '✓ IN PORTFOLIO'; finBtn.classList.add('added'); finBtn.disabled = true;
        }
        finBtn.addEventListener('click', async () => {
          try {
            await window.finAddStock({ ...card, type: 'stock', sparkline: card.sparkline || [] });
            finBtn.textContent = '✓ IN PORTFOLIO'; finBtn.classList.add('added'); finBtn.disabled = true;
          } catch (err) { finBtn.textContent = '⚠ ERROR'; }
        });
      }
    }, 50);
  } else if (card.type === 'location') {
    const allImages = [card.heroImage, ...(card.images || [])].filter(Boolean);
    const imagesHtml = allImages.length
      ? `<div class="loc-gallery">${allImages.slice(0, 6).map(url =>
          `<img class="loc-img" src="${esc(url)}" alt="${esc(card.title)}" onerror="this.style.display='none'" loading="lazy" />`
        ).join('')}</div>`
      : '';
    cardContent.innerHTML = `
      <div class="card-location">
        <div class="loc-label">LOCATION</div>
        <div class="loc-title">${esc(card.title)}</div>
        ${card.description ? `<div class="loc-desc">${esc(card.description)}</div>` : ''}
        ${imagesHtml}
        ${card.summary ? `<div class="loc-summary">${esc(card.summary)}</div>` : ''}
        <div class="loc-actions">
          ${card.mapsUrl ? `<button class="loc-maps-btn" id="locMapsBtn">📍 Open in Maps</button>` : ''}
          ${card.sourceUrl ? `<button class="loc-wiki-btn" id="locWikiBtn">Wikipedia →</button>` : ''}
        </div>
      </div>`;
    setTimeout(() => {
      document.getElementById('locMapsBtn')?.addEventListener('click', () => window.jarvis.openUrl(card.mapsUrl));
      document.getElementById('locWikiBtn')?.addEventListener('click', () => window.jarvis.openUrl(card.sourceUrl));
    }, 50);

  } else if (card.type === 'places') {
    const placesHtml = (card.places || []).map((p, i) => `
      <div class="place-item" data-idx="${i}">
        <div class="place-name">${esc(p.name)}</div>
        ${p.type ? `<div class="place-type">${esc(p.type)}</div>` : ''}
        <div class="place-addr">${esc(p.address)}</div>
        ${p.phone ? `<div class="place-phone">${esc(p.phone)}</div>` : ''}
        <button class="place-maps-btn" data-url="${esc(p.mapsUrl)}">📍 Maps</button>
        ${p.website ? `<button class="place-web-btn" data-url="${esc(p.website)}">🌐 Website</button>` : ''}
      </div>`).join('');
    cardContent.innerHTML = `
      <div class="card-places">
        <div class="places-label">NEARBY PLACES</div>
        <div class="places-query">${esc(card.query)}</div>
        <div class="places-list">${placesHtml}</div>
      </div>`;
    setTimeout(() => {
      cardContent.querySelectorAll('.place-maps-btn, .place-web-btn').forEach(btn => {
        btn.addEventListener('click', () => window.jarvis.openUrl(btn.dataset.url));
      });
    }, 50);

  } else if (card.type === 'movie') {
    const ratingHtml = card.imdbRating ? `<div class="movie-rating">⭐ ${esc(card.imdbRating)} <span style="opacity:.5;font-size:11px">IMDb</span></div>` : '';
    const metaItems = [card.year, card.runtime, card.rated].filter(Boolean);
    const metaHtml = metaItems.length ? `<div class="movie-meta">${metaItems.map(esc).join(' · ')}</div>` : '';
    const genreHtml = card.genre ? `<div class="movie-genre">${esc(card.genre)}</div>` : '';
    const releasedHtml = card.released ? `<div class="movie-released">Released: ${esc(card.released)}</div>` : '';
    const directorHtml = card.director ? `<div class="movie-crew"><span class="crew-label">DIRECTOR</span> ${esc(card.director)}</div>` : '';
    const castHtml = card.cast ? `<div class="movie-crew"><span class="crew-label">CAST</span> ${esc(card.cast)}</div>` : '';
    const plotHtml = card.plot ? `<div class="movie-plot">${esc(card.plot)}</div>` : '';
    cardContent.innerHTML = `
      <div class="card-movie">
        <div class="movie-type-label">MOVIE / FILM</div>
        <div class="movie-body">
          ${card.poster ? `<img class="movie-poster" src="${esc(card.poster)}" alt="${esc(card.title)}" onerror="this.style.display='none'" />` : ''}
          <div class="movie-info">
            <div class="movie-title">${esc(card.title)}</div>
            ${metaHtml}
            ${ratingHtml}
            ${genreHtml}
            ${releasedHtml}
          </div>
        </div>
        ${directorHtml}
        ${castHtml}
        ${plotHtml}
        ${card.sourceUrl ? `<a class="stock-link" href="${esc(card.sourceUrl)}" target="_blank">View on IMDb →</a>` : ''}
        <button class="card-fav-btn" id="cardFavBtn">⭐ ADD TO FAVOURITES</button>
      </div>`;
    setTimeout(() => {
      const favBtn = document.getElementById('cardFavBtn');
      if (!favBtn) return;
      const favQuery = `${card.title} ${card.year || ''} movie`.trim();
      if (favourites.some(f => f.query === favQuery)) {
        favBtn.textContent = '✓ IN FAVOURITES'; favBtn.classList.add('added'); favBtn.disabled = true; return;
      }
      favBtn.addEventListener('click', () => {
        addFavourite(card.title, favQuery, card.sourceUrl || `https://www.imdb.com/find?q=${encodeURIComponent(card.title)}`, 'tv');
        favBtn.textContent = '✓ ADDED TO FAVOURITES'; favBtn.classList.add('added'); favBtn.disabled = true;
      });
    }, 50);
  } else if (card.type === 'person') {
    cardContent.innerHTML = `
      <div class="card-person">
        ${card.imageUrl ? `<img class="person-photo" src="${esc(card.imageUrl)}" alt="${esc(card.name)}" />` : '<div class="person-photo-placeholder">👤</div>'}
        <div class="person-name">${esc(card.name)}</div>
        ${card.subtitle ? `<div class="person-subtitle">${esc(card.subtitle)}</div>` : ''}
        ${card.bio ? `<div class="person-bio">${esc(card.bio)}</div>` : ''}
        <button class="card-fav-btn" id="personFavBtn">⭐ ADD TO FAVOURITES</button>
      </div>`;
    setTimeout(() => {
      const favBtn = document.getElementById('personFavBtn');
      if (!favBtn) return;
      favBtn.addEventListener('click', () => {
        addFavourite(card.name, card.name, card.sourceUrl || `https://en.wikipedia.org/wiki/${encodeURIComponent(card.name)}`, 'general');
        favBtn.textContent = '✓ ADDED TO FAVOURITES'; favBtn.classList.add('added'); favBtn.disabled = true;
      });
      const photo = cardContent.querySelector('.person-photo');
      if (photo && card.sourceUrl) {
        photo.style.cursor = 'pointer';
        photo.addEventListener('click', () => window.jarvis.openUrl(card.sourceUrl));
      }
    }, 50);
  } else if (card.type === 'animal') {
    cardContent.innerHTML = `
      <div class="card-animal">
        <div class="animal-label">ANIMAL</div>
        ${card.imageUrl ? `<img class="animal-photo" src="${esc(card.imageUrl)}" alt="${esc(card.name)}" />` : ''}
        <div class="animal-name">${esc(card.name)}</div>
        ${card.description ? `<div class="animal-desc">${esc(card.description)}</div>` : ''}
        ${card.funFact ? `<div class="animal-fact"><span class="fact-label">DID YOU KNOW</span> ${esc(card.funFact)}</div>` : ''}
        ${card.sourceUrl ? `<a class="card-source-link" href="#" id="animalWikiLink">📖 Wikipedia</a>` : ''}
      </div>`;
    setTimeout(() => {
      const link = document.getElementById('animalWikiLink');
      if (link && card.sourceUrl) link.addEventListener('click', (e) => { e.preventDefault(); window.jarvis.openUrl(card.sourceUrl); });
      const photo = cardContent.querySelector('.animal-photo');
      if (photo && card.sourceUrl) { photo.style.cursor = 'pointer'; photo.addEventListener('click', () => window.jarvis.openUrl(card.sourceUrl)); }
    }, 50);
  } else if (card.type === 'character') {
    cardContent.innerHTML = `
      <div class="card-character">
        <div class="character-label">CHARACTER</div>
        ${card.imageUrl ? `<img class="character-photo" src="${esc(card.imageUrl)}" alt="${esc(card.name)}" />` : ''}
        <div class="character-name">${esc(card.name)}</div>
        ${card.showName ? `<div class="character-show">${esc(card.showName)}</div>` : ''}
        ${card.subtitle ? `<div class="character-subtitle">${esc(card.subtitle)}</div>` : ''}
        ${card.sourceUrl ? `<a class="card-source-link" href="#" id="charWikiLink">📖 Wikipedia</a>` : ''}
      </div>`;
    setTimeout(() => {
      const link = document.getElementById('charWikiLink');
      if (link && card.sourceUrl) link.addEventListener('click', (e) => { e.preventDefault(); window.jarvis.openUrl(card.sourceUrl); });
      const photo = cardContent.querySelector('.character-photo');
      if (photo && card.sourceUrl) { photo.style.cursor = 'pointer'; photo.addEventListener('click', () => window.jarvis.openUrl(card.sourceUrl)); }
    }, 50);
  } else if (card.type === 'image') {
    cardContent.innerHTML = `
      <div class="card-image">
        <div class="img-label">AI GENERATED</div>
        <img src="${esc(card.imageUrl)}" alt="${esc(card.title)}" style="width:100%;border-radius:10px;margin:10px 0;cursor:pointer;" id="generatedImgCard" />
        <div class="img-desc">${esc(card.description)}</div>
        <a class="img-download" href="${esc(card.imageUrl)}" download="jarvis-image.png" target="_blank">⬇ DOWNLOAD IMAGE</a>
      </div>`;
    setTimeout(() => {
      const img = document.getElementById('generatedImgCard');
      if (img && card.imageUrl) img.addEventListener('click', () => window.jarvis.openUrl(card.imageUrl));
    }, 50);
  } else if (card.type === 'wiki_card') {
    // Wikipedia image card — generic visual for any topic (person, animal, place, game, brand, etc.)
    cardContent.innerHTML = `
      <div class="card-wiki">
        <div class="wiki-label">VISUAL RESULT</div>
        ${card.imageUrl ? `<img class="wiki-photo" src="${esc(card.imageUrl)}" alt="${esc(card.title)}" onerror="this.style.display='none'" />` : ''}
        <div class="wiki-title">${esc(card.title)}</div>
        ${card.description ? `<div class="wiki-desc">${esc(card.description)}</div>` : ''}
        ${card.sourceUrl ? `<a class="card-source-link" href="#" id="wikiCardLink">📖 Wikipedia</a>` : ''}
      </div>`;
    setTimeout(() => {
      document.getElementById('wikiCardLink')?.addEventListener('click', (e) => { e.preventDefault(); window.jarvis.openUrl(card.sourceUrl); });
      const photo = cardContent.querySelector('.wiki-photo');
      if (photo && card.sourceUrl) { photo.style.cursor = 'pointer'; photo.addEventListener('click', () => window.jarvis.openUrl(card.sourceUrl)); }
    }, 50);
  } else if (card.type === 'element') {
    const catColors = {
      'Alkali Metal':'#e74c3c','Alkaline Earth':'#e67e22','Transition Metal':'#3498db',
      'Post-Transition':'#1abc9c','Metalloid':'#9b59b6','Nonmetal':'#2ecc71',
      'Halogen':'#f39c12','Noble Gas':'#e91e63','Actinide':'#e53935','Lanthanide':'#7e57c2',
    };
    const catColor = catColors[card.category] || '#6366f1';
    cardContent.innerHTML = `
      <div class="card-element">
        <div class="element-category" style="color:${catColor}">${esc(card.category)}</div>
        <div class="element-hero">
          <div class="element-symbol-big" style="border-color:${catColor};box-shadow:0 0 20px ${catColor}40">${esc(card.symbol)}</div>
          <div class="element-details">
            <div class="element-name-big">${esc(card.name)}</div>
            <div class="element-num">Atomic Number: <strong>${card.atomicNumber}</strong></div>
            <div class="element-num">Atomic Mass: <strong>${esc(card.mass)} u</strong></div>
          </div>
        </div>
        <div class="element-row"><span class="el-label">Group</span><span>${card.group}</span></div>
        <div class="element-row"><span class="el-label">Period</span><span>${card.period}</span></div>
        <div class="element-row"><span class="el-label">Config</span><span style="font-family:monospace;font-size:11px">${esc(card.config)}</span></div>
        <div class="element-desc">${esc(card.desc)}</div>
        <button class="card-fav-btn" id="cardFavBtn">⭐ ADD TO FAVOURITES</button>
      </div>`;
    setTimeout(() => {
      document.getElementById('cardFavBtn')?.addEventListener('click', () => {
        addFavourite(card.name, `${card.name} element`, card.sourceUrl, 'general');
        document.getElementById('cardFavBtn').textContent = '✓ ADDED'; document.getElementById('cardFavBtn').classList.add('added'); document.getElementById('cardFavBtn').disabled = true;
      });
    }, 50);
  } else if (card.type === 'periodic_table') {
    // Mini periodic table layout [period][group] = symbol
    const layout = [
      ['H','','','','','','','','','','','','','','','','','He'],
      ['Li','Be','','','','','','','','','','','B','C','N','O','F','Ne'],
      ['Na','Mg','','','','','','','','','','','Al','Si','P','S','Cl','Ar'],
      ['K','Ca','Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn','Ga','Ge','As','Se','Br','Kr'],
      ['Rb','Sr','Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn','Sb','Te','I','Xe'],
      ['Cs','Ba','*','Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg','Tl','Pb','Bi','Po','At','Rn'],
      ['Fr','Ra','**','Rf','Db','Sg','Bh','Hs','Mt','Ds','Rg','Cn','Nh','Fl','Mc','Lv','Ts','Og'],
    ];
    const catCol = {H:'#2ecc71',He:'#e91e63',Li:'#e74c3c',Na:'#e74c3c',K:'#e74c3c',Rb:'#e74c3c',Cs:'#e74c3c',Fr:'#e74c3c',Be:'#e67e22',Mg:'#e67e22',Ca:'#e67e22',Sr:'#e67e22',Ba:'#e67e22',Ra:'#e67e22',B:'#9b59b6',Si:'#9b59b6',Ge:'#9b59b6',As:'#9b59b6',Sb:'#9b59b6',Te:'#9b59b6',Po:'#9b59b6',C:'#2ecc71',N:'#2ecc71',O:'#2ecc71',P:'#2ecc71',S:'#2ecc71',Se:'#2ecc71',F:'#f39c12',Cl:'#f39c12',Br:'#f39c12',I:'#f39c12',At:'#f39c12',Ts:'#f39c12',Ne:'#e91e63',Ar:'#e91e63',Kr:'#e91e63',Xe:'#e91e63',Rn:'#e91e63',Og:'#e91e63'};
    const rows = layout.map(row =>
      `<div class="pt-row">${row.map(sym => {
        if (!sym) return '<div class="pt-cell pt-empty"></div>';
        if (sym === '*' || sym === '**') return `<div class="pt-cell pt-ref">${sym}</div>`;
        const col = catCol[sym] || '#3498db';
        return `<div class="pt-cell" style="border-color:${col};color:${col}" title="${sym}">${sym}</div>`;
      }).join('')}</div>`
    ).join('');
    cardContent.innerHTML = `
      <div class="card-science">
        <div class="sci-label">PERIODIC TABLE</div>
        <div class="periodic-table-mini">${rows}</div>
        <div class="pt-legend">
          <span style="color:#e74c3c">■ Alkali</span><span style="color:#e67e22">■ Alkaline</span>
          <span style="color:#3498db">■ Transition</span><span style="color:#2ecc71">■ Nonmetal</span>
          <span style="color:#f39c12">■ Halogen</span><span style="color:#e91e63">■ Noble</span>
          <span style="color:#9b59b6">■ Metalloid</span>
        </div>
      </div>`;
  } else if (card.type === 'science') {
    cardContent.innerHTML = `
      <div class="card-science">
        <div class="sci-label">SCIENCE / EDUCATION</div>
        ${card.imageUrl ? `<img class="sci-image" src="${esc(card.imageUrl)}" alt="${esc(card.title)}" onerror="this.style.display='none'" />` : ''}
        <div class="sci-title">${esc(card.title)}</div>
        ${card.subtitle ? `<div class="sci-subtitle">${esc(card.subtitle)}</div>` : ''}
        ${card.summary ? `<div class="sci-summary">${esc(card.summary)}</div>` : ''}
        <button class="card-fav-btn" id="cardFavBtn">⭐ ADD TO FAVOURITES</button>
      </div>`;
    setTimeout(() => {
      document.getElementById('cardFavBtn')?.addEventListener('click', () => {
        addFavourite(card.title, card.title, card.sourceUrl, 'general');
        document.getElementById('cardFavBtn').textContent = '✓ ADDED'; document.getElementById('cardFavBtn').classList.add('added'); document.getElementById('cardFavBtn').disabled = true;
      });
      const img = cardContent.querySelector('.sci-image');
      if (img && card.sourceUrl) { img.style.cursor = 'pointer'; img.addEventListener('click', () => window.jarvis.openUrl(card.sourceUrl)); }
    }, 50);
  } else if (card.type === 'analytics') {
    // Open the analytics panel with fresh data — scroll to top so website card is first
    cardPanel.classList.add('hidden');
    const ap = document.getElementById('analyticsPanel');
    ap.classList.remove('hidden');
    ap.scrollTop = 0;
    const ac = document.getElementById('analyticsContent');
    if (ac) ac.scrollTop = 0;
    loadAnalyticsDashboard();
    return;
  } else if (card.type === 'news') {
    const items = card.headlines.map(h => `<div class="news-item">${esc(h)}</div>`).join('');
    cardContent.innerHTML = `<div class="card-news"><div class="news-title">LATEST NEWS</div>${items}</div>`;
  } else if (card.type === 'calendar') {
    const evRows = (card.events || []).map(e => {
      const start = new Date(e.start);
      const dateStr = start.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = e.allDay ? 'All day' : start.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });
      return `<div class="cal-event"><div class="cal-title">${esc(e.title)}</div><div class="cal-time">${esc(dateStr)} · ${esc(timeStr)}</div></div>`;
    }).join('');
    cardContent.innerHTML = `<div class="card-calendar"><div class="cal-header">📅 UPCOMING EVENTS</div>${evRows || '<div class="cal-empty">No events found.</div>'}</div>`;
  }

  if (card.sourceUrl) {
    cardSource.innerHTML = `SOURCE: <a href="#" id="cardSourceLink">${esc(card.source || card.sourceUrl)}</a>`;
    const link = document.getElementById('cardSourceLink');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); window.jarvis.openUrl(card.sourceUrl); });
  } else {
    cardSource.textContent = card.source ? `SOURCE: ${card.source}` : '';
  }
}

function buildSparkline(values, positive) {
  if (!values.length) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const w = 260, h = 60;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');
  const color = positive ? '#00ff88' : '#ff4444';
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" opacity="0.8"/>
  </svg>`;
}

// ===================== LEFT NAV RAIL =====================
const leftNavTitle = null; // element removed

async function openLeftNavSection(section) {
  document.querySelectorAll('.lnav-pane').forEach(p => p.classList.add('hidden'));
  const pane = document.getElementById('lnavPane' + section.charAt(0).toUpperCase() + section.slice(1));
  if (pane) pane.classList.remove('hidden');
  document.querySelectorAll('#lnavTabs .lnav-tab').forEach(b => b.classList.remove('active'));
  const activeTab = document.querySelector(`#lnavTabs .lnav-tab[data-section="${section}"]`);
  if (activeTab) activeTab.classList.add('active');
  historySidebar.classList.remove('hidden');
  if (section === 'history') await loadHistory();
  if (section === 'connectors') await renderConnectors();
  if (section === 'favourites') renderFavourites();
  if (section === 'settings') await loadSettingsPane();
}

// Tab switching inside sidebar
document.querySelectorAll('#lnavTabs .lnav-tab').forEach(tab => {
  tab.addEventListener('click', () => openLeftNavSection(tab.dataset.section));
});

// ===================== CHAT HISTORY =====================
// historyBtn (hamburger in topBar) toggles the sidebar open/closed
historyBtn?.addEventListener('click', async () => {
  if (!historySidebar.classList.contains('hidden')) {
    historySidebar.classList.add('hidden');
  } else {
    await openLeftNavSection('history');
  }
});

historyClose.addEventListener('click', () => historySidebar.classList.add('hidden'));

async function loadHistory() {
  const sessions = await window.jarvis.listSessions();
  if (!sessions.length) {
    historyList.innerHTML = '<div class="history-empty">No history yet</div>';
    return;
  }
  const now = new Date();
  const todayStr = now.toDateString();
  const yestStr = new Date(now - 86400000).toDateString();
  const groups = { Today: [], Yesterday: [], Earlier: [] };
  sessions.forEach(s => {
    const ds = new Date(s.date).toDateString();
    if (ds === todayStr) groups.Today.push(s);
    else if (ds === yestStr) groups.Yesterday.push(s);
    else groups.Earlier.push(s);
  });
  let html = '';
  for (const [label, items] of Object.entries(groups)) {
    if (!items.length) continue;
    html += `<div class="history-group-label">${label}</div>`;
    html += items.map(s => {
      const d = new Date(s.date);
      const timeStr = d.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
      return `<div class="history-item" data-id="${s.id}">
        <button class="history-delete" data-id="${s.id}">✕</button>
        <div class="history-date">${timeStr}</div>
        <div class="history-preview">${esc(s.preview)}</div>
      </div>`;
    }).join('');
  }
  historyList.innerHTML = html;

  historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('history-delete')) return;
      const session = sessions.find(s => s.id == item.dataset.id);
      if (!session) return;
      chat.innerHTML = '';
      history = [];
      session.messages.forEach(m => addMessage(m.role, m.content));
      history = session.messages.map(m => ({ role: m.role, content: m.content }));
      historySidebar.classList.add('hidden');
    });
  });

  historyList.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.jarvis.deleteSession(Number(btn.dataset.id));
      await loadHistory();
    });
  });
}

async function saveCurrentSession() {
  if (!history.length) return;
  const preview = history[0]?.content?.slice(0, 60) || 'Conversation';
  await window.jarvis.saveSession({ preview, messages: history.map(m => ({ role: m.role, content: m.content })) });
}

// ===================== CONTROLS =====================
function debugFlash(label) {
  const el = document.getElementById('orbLabel');
  if (el) { el.textContent = label; setTimeout(() => { el.textContent = orbLabel.textContent === label ? 'STANDBY' : el.textContent; }, 2000); }
}
closeBtn.addEventListener('click', () => { debugFlash('CLOSING...'); window.jarvis.hide(); });

clearBtn.addEventListener('click', async () => { debugFlash('CLEARING...');
  await saveCurrentSession();
  chat.innerHTML = '';
  history = [];
  _sessionMsgCount = 0;
  cardPanel.classList.add('hidden');
  orbContainer.classList.remove('compact');
  // orb returns to full size — no message
});

if (fileBtn) fileBtn.addEventListener('click', async () => {
  const result = await window.jarvis.openFile();
  if (!result) return;
  if (result.content) {
    await sendToJarvis(`I just opened the file: ${result.path}\n\nHere is its content:\n${result.content}\n\nPlease give me a summary.`);
  } else {
    addMessage('assistant', `Opened ${result.path} — I can't read this file type directly, but it's open for you.`);
  }
});

// ===================== ACTION FLASH =====================
const actionFlash = document.getElementById('actionFlash');
function triggerActionFlash() {
  if (!actionFlash) return;
  actionFlash.classList.remove('flash-in');
  void actionFlash.offsetWidth; // force reflow so animation restarts cleanly
  actionFlash.classList.add('flash-in');
}
// Fire flash immediately when main process starts an action (before app opens)
window.jarvis.onActionFired(() => triggerActionFlash());

// Ctrl+S background voice trigger — press to start, press again to stop & send
window.jarvis.onVoiceTrigger(() => {
  if (isRecording) stopRecording();
  else startRecording();
});

// ===================== AUTO-UPDATE =====================
const updateWrap = document.getElementById('updateWrap');
const updateBtn  = document.getElementById('updateBtn');
const updateBtnLabel = document.getElementById('updateBtnLabel');

// Step 1: update is downloading in background — show downloading state
window.jarvis.onUpdateAvailable && window.jarvis.onUpdateAvailable(({ version }) => {
  updateBtnLabel.textContent = `Downloading v${version}…`;
  updateWrap.classList.remove('hidden');
  updateBtn.disabled = true;
  updateBtn.style.opacity = '0.6';
});

// Step 2: update downloaded — show restart prompt
window.jarvis.onUpdateReady && window.jarvis.onUpdateReady(() => {
  updateBtnLabel.textContent = 'Restart to update';
  updateWrap.classList.remove('hidden');
  updateBtn.disabled = false;
  updateBtn.style.opacity = '1';
});

// Step 3: user clicks — restart and install
updateBtn && updateBtn.addEventListener('click', () => {
  updateBtnLabel.textContent = 'Restarting…';
  updateBtn.disabled = true;
  window.jarvis.installUpdate();
});

// Ctrl+Space — Clipboard AI: auto-fill the input with clipboard text and a prompt
window.jarvis.onClipboardAI(({ text }) => {
  const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
  const prompt = `Summarise and explain this:\n\n${text}`;
  if (userInput) {
    userInput.value = prompt;
    userInput.focus();
    // Show a hint message
    addMessage('assistant', `I've grabbed your clipboard (${text.length} characters). What would you like me to do with it? You can edit the prompt above or just press Enter to summarise it.`);
  }
});

// ===================== ATTACH FILES =====================
let pendingAttachments = [];

const attachBtn   = document.getElementById('attachBtn');
const attachInput = document.getElementById('attachInput');
const attachPreview = document.getElementById('attachPreview');
const dropOverlay = document.getElementById('dropOverlay');
const mainPanel   = document.getElementById('main');

attachBtn.addEventListener('click', () => { debugFlash('ATTACH...'); attachInput.click(); });

attachInput.addEventListener('change', () => {
  processFiles([...attachInput.files]);
  attachInput.value = '';
});

// Drag-and-drop on the whole main panel
mainPanel.addEventListener('dragenter', (e) => { e.preventDefault(); dropOverlay.classList.remove('hidden'); });
mainPanel.addEventListener('dragover',  (e) => { e.preventDefault(); });
mainPanel.addEventListener('dragleave', (e) => { if (!mainPanel.contains(e.relatedTarget)) dropOverlay.classList.add('hidden'); });
mainPanel.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('hidden');
  const files = [...e.dataTransfer.files];
  if (files.length) processFiles(files);
});

function processFiles(files) {
  files.forEach((file) => {
    const reader = new FileReader();
    const isImage = file.type.startsWith('image/');

    reader.onload = (ev) => {
      const result = ev.target.result; // data URL for images, text for others
      const attachment = isImage
        ? { name: file.name, kind: 'image', mimeType: file.type, dataUrl: result, base64: result.split(',')[1] }
        : { name: file.name, kind: 'text',  content: result };

      pendingAttachments.push(attachment);
      renderAttachPreview();
    };

    if (isImage) reader.readAsDataURL(file);
    else         reader.readAsText(file);
  });
}

function renderAttachPreview() {
  if (pendingAttachments.length === 0) {
    attachPreview.classList.add('hidden');
    attachPreview.innerHTML = '';
    return;
  }
  attachPreview.classList.remove('hidden');
  attachPreview.innerHTML = '';

  pendingAttachments.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';

    if (att.kind === 'image') {
      chip.innerHTML = `<img class="attach-chip-thumb" src="${att.dataUrl}"><span class="attach-chip-name">${att.name}</span>`;
    } else {
      chip.innerHTML = `<div class="attach-chip-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div><span class="attach-chip-name">${att.name}</span>`;
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attach-chip-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      pendingAttachments.splice(i, 1);
      renderAttachPreview();
    });
    chip.appendChild(removeBtn);
    attachPreview.appendChild(chip);
  });
}

function addMessageWithAttachments(role, text, attachments) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = SPARKLES_SVG;
    row.appendChild(avatar);
  }

  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;

  (attachments || []).forEach((att) => {
    if (att.kind === 'image') {
      const wrap = document.createElement('div');
      wrap.className = 'msg-attachment';
      const img = document.createElement('img');
      img.src = att.dataUrl;
      wrap.appendChild(img);
      div.appendChild(wrap);
    } else {
      const fileEl = document.createElement('div');
      fileEl.className = 'msg-attachment-file';
      fileEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${att.name}`;
      div.appendChild(fileEl);
    }
  });

  row.appendChild(div);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  if (chat.children.length >= 1) orbContainer.classList.add('compact');
  _sessionMsgCount++;
  const el = document.getElementById('swSession');
  if (el) el.textContent = _sessionMsgCount + ' msg' + (_sessionMsgCount !== 1 ? 's' : '');
}

// ===================== SEND TO AI =====================
async function sendToJarvis(text) {
  // Guard: don't even attempt if we know we're offline
  if (!navigator.onLine) {
    addMessage('assistant', "I can't reach the internet right now. Check your connection and try again.");
    return;
  }

  const attachments = [...pendingAttachments];
  pendingAttachments = [];
  renderAttachPreview();

  addMessageWithAttachments('user', text, attachments);
  history.push({ role: 'user', content: text });
  setState('thinking');
  showStopBtn(true);

  let res;
  try {
    res = await window.jarvis.chat(text, history.slice(-30), attachments);
  } catch (err) {
    // IPC-level throw (e.g. main process crashed) — classify and show
    const msg = (err.message || '').replace(/^Error invoking remote method '[^']+': /, '');
    let friendly = 'Something went wrong. Please try again.';
    if (msg.includes('Premature close') || msg.includes('ECONNRESET') || msg.includes('timed out') || msg.includes('AbortError')) {
      friendly = "That took too long. Please try again in a moment.";
    } else if (msg.includes('ENOTFOUND') || msg.includes('ENETUNREACH') || msg.includes('ECONNREFUSED')) {
      friendly = "I can't reach the internet right now. Check your connection and try again.";
    }
    addMessage('assistant', friendly);
    showStopBtn(false); setState('idle');
    return;
  }
  if (!res || res.error) {
    if (res?.error === 'login_required') {
      addMessage('assistant', 'Session expired — please log in again.');
    } else if (res?.userMsg) {
      // Structured error from classifyAIError — message already spoken via TTS in main.js
      addMessage('assistant', res.userMsg);
    }
    showStopBtn(false); setState('idle');
    return;
  }

  history.push({ role: 'assistant', content: res.text });
  // Don't render a blank bubble — if there's a card it'll display the data visually
  const msgEl = (res.text && res.text.trim()) ? addMessage('assistant', res.text) : null;
  showStopBtn(false); setState('idle');

  // Document creation — show Save options
  if (res.docTitle && (res.docSections || res.docContent) && msgEl) {
    const docSections = res.docSections || [];
    const docRow = document.createElement('div');
    docRow.className = 'doc-action-row';
    const wordBtn = document.createElement('button');
    wordBtn.className = 'doc-btn doc-btn-word';
    wordBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Save as Word File`;
    const gDocBtn = document.createElement('button');
    gDocBtn.className = 'doc-btn doc-btn-gdoc';
    gDocBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Open in Google Docs`;
    wordBtn.addEventListener('click', async () => {
      wordBtn.disabled = true;
      wordBtn.textContent = 'Saving…';
      try {
        // Build plain text for Word from sections
        const plainContent = docSections.map(s => {
          if (s.type === 'heading' || s.type === 'subheading') return s.text;
          if (s.type === 'paragraph') return s.text;
          if (s.type === 'bullet_list') return (s.items || []).map(i => '• ' + i).join('\n');
          if (s.type === 'table') {
            const rows = [];
            if (s.headers) rows.push(s.headers.join('\t'));
            (s.rows || []).forEach(r => rows.push(r.join('\t')));
            return rows.join('\n');
          }
          return '';
        }).filter(Boolean).join('\n\n');
        await window.jarvis.saveWordDoc({ title: res.docTitle, sections: docSections, content: plainContent });
        wordBtn.textContent = '✓ Saved & Opened';
        wordBtn.classList.add('done');
      } catch (e) {
        wordBtn.textContent = 'Error — try again';
        wordBtn.disabled = false;
      }
    });
    gDocBtn.addEventListener('click', async () => {
      gDocBtn.disabled = true;
      gDocBtn.textContent = 'Creating document…';
      try {
        const result = await window.jarvis.openGoogleDoc({ title: res.docTitle, sections: docSections });
        if (result && result.error) {
          gDocBtn.textContent = 'Error — try again';
          gDocBtn.disabled = false;
          const hint = document.createElement('div');
          hint.style.cssText = 'margin-top:6px;padding:6px 10px;background:rgba(255,180,0,0.12);border:1px solid rgba(255,180,0,0.3);border-radius:6px;font-size:11px;color:rgba(255,200,80,0.95);';
          if (result.error === 'not_connected') {
            hint.textContent = '⚠ Google Drive not connected. Connect it in Settings (🔗 icon).';
          } else if (result.error === 'scope_missing') {
            hint.textContent = '⚠ Google Drive needs new permissions. Disconnect & reconnect Google Drive in Settings.';
          } else {
            hint.textContent = '⚠ Failed to create document: ' + (result.detail || 'unknown error');
          }
          gDocBtn.parentElement.appendChild(hint);
          return;
        }
        if (result && result.fallback === 'word') {
          gDocBtn.textContent = '✓ Opened as Word File';
        } else {
          gDocBtn.textContent = '✓ Document Created & Opened';
        }
        gDocBtn.classList.add('done');
      } catch (e) {
        gDocBtn.textContent = 'Error — try again';
        gDocBtn.disabled = false;
      }
    });
    docRow.appendChild(wordBtn);
    docRow.appendChild(gDocBtn);
    msgEl.appendChild(docRow);
  }

  // Slides creation — show Open in Google Slides button
  if (res.slidesTitle && (res.slidesData || res.slidesContent) && msgEl) {
    const slidesData = res.slidesData || [];
    const slidesRow = document.createElement('div');
    slidesRow.className = 'doc-action-row';
    const slidesBtn = document.createElement('button');
    slidesBtn.className = 'doc-btn doc-btn-gdoc';
    slidesBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Open in Google Slides`;
    slidesBtn.addEventListener('click', async () => {
      slidesBtn.disabled = true;
      slidesBtn.textContent = 'Creating presentation…';
      try {
        const result = await window.jarvis.openGoogleSlides({ title: res.slidesTitle, slides: slidesData });
        if (result && result.error) {
          slidesBtn.textContent = 'Error — try again';
          slidesBtn.disabled = false;
          const hint = document.createElement('div');
          hint.style.cssText = 'margin-top:6px;padding:6px 10px;background:rgba(255,180,0,0.12);border:1px solid rgba(255,180,0,0.3);border-radius:6px;font-size:11px;color:rgba(255,200,80,0.95);';
          if (result.error === 'not_connected') {
            hint.textContent = '⚠ Google Drive not connected. Connect it in Settings (🔗 icon).';
          } else if (result.error === 'scope_missing') {
            hint.textContent = '⚠ Google Drive needs new permissions. Disconnect & reconnect Google Drive in Settings.';
          } else {
            hint.textContent = '⚠ Failed to create presentation: ' + (result.detail || 'unknown error');
          }
          slidesBtn.parentElement.appendChild(hint);
          return;
        }
        slidesBtn.textContent = '✓ Presentation Created & Opened';
        slidesBtn.classList.add('done');
      } catch (e) {
        slidesBtn.textContent = 'Error — try again';
        slidesBtn.disabled = false;
      }
    });
    slidesRow.appendChild(slidesBtn);
    msgEl.appendChild(slidesRow);
  }

  // Show email send arrow button when AI drafted an email
  if (res.emailDraft && msgEl) {
    const draft = res.emailDraft;
    const sendRow = document.createElement('div');
    sendRow.className = 'email-send-row';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'email-send-btn';
    sendBtn.title = `Send to ${draft.to}`;
    sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    const sendLabel = document.createElement('span');
    sendLabel.className = 'email-send-label';
    sendLabel.textContent = `Send to ${draft.to}`;
    sendRow.appendChild(sendBtn);
    sendRow.appendChild(sendLabel);
    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      sendLabel.textContent = 'Sending…';
      try {
        const result = await window.jarvis.sendEmail({ to: draft.toEmail || draft.to, subject: draft.subject, body: draft.body });
        if (result && result.ok) {
          sendLabel.textContent = `Sent via ${result.service}`;
          sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
          sendRow.classList.add('sent');
        } else {
          sendLabel.textContent = result?.error || 'Failed to send';
          sendBtn.disabled = false;
        }
      } catch (e) {
        sendLabel.textContent = 'Error — please try again';
        sendBtn.disabled = false;
      }
    });
    msgEl.appendChild(sendRow);
  }

  // Show ⭐ Add to Favourites button for qualifying search responses
  if (res.action && res.action.type === 'open_url' && msgEl) {
    const combined = text + ' ' + (res.text || '');
    const favType  = detectFavType(combined);
    if (favType) {
      const btn = document.createElement('button');
      btn.className = 'msg-fav-btn';
      btn.innerHTML = '⭐ ADD TO FAVOURITES';
      btn.addEventListener('click', () => {
        const title = text.length > 40 ? text.slice(0, 40) + '…' : text;
        addFavourite(title, text, res.action.arg, favType);
        btn.innerHTML = '✓ ADDED';
        btn.classList.add('added');
        btn.disabled = true;
      });
      msgEl.appendChild(document.createElement('br'));
      msgEl.appendChild(btn);
    }
  }

  // Fire flash whenever Jarvis actually executes an action (open app, URL, call, image, etc.)
  if (res.hasAction) {
    triggerActionFlash();
    if (typeof window.rpRefresh === 'function') window.rpRefresh();
    if (res.calendarEvent && typeof window._handleAICalendarEvent === 'function') {
      window._handleAICalendarEvent(res.calendarEvent);
    }
  }

  // Show card if returned
  if (res.card) showCard(res.card);
  else cardPanel.classList.add('hidden');

  if (res.audio) {
    playAudioChunks(Array.isArray(res.audio) ? res.audio : [res.audio]);
  }
}

// Sentence audio arrives from main process mid-stream — play immediately without waiting for full response
window.jarvis.onSentenceAudio(({ audio }) => {
  playAudioChunks([audio]);
});

// ── Proactive reminder fired by the scheduler in main.js ─────────────────────
// ── Reminder toast ────────────────────────────────────────────────────────────
(function() {
  const toast     = document.getElementById('reminderToast');
  const rtText    = document.getElementById('rtText');
  const rtDismiss = document.getElementById('rtDismiss');
  let toastTimer  = null;

  function showToast(text) {
    if (!toast) return;
    rtText.textContent = text;
    toast.classList.remove('hidden');
    // Auto-dismiss after 30 seconds if user doesn't interact
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 30000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toast) toast.classList.add('hidden');
  }

  rtDismiss?.addEventListener('click', hideToast);

  // Snooze buttons
  toast?.querySelectorAll('.rt-snooze').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mins = parseInt(btn.dataset.mins, 10);
      const text = rtText.textContent;
      hideToast();
      // Re-add reminder at snoozed time
      const snoozeTime = Date.now() + mins * 60 * 1000;
      await window.jarvis.reminderAdd({ text, datetime: snoozeTime, earlyMinutes: 0 });
      if (typeof window.rpRefresh === 'function') window.rpRefresh();
    });
  });

  window.jarvis.onReminder(({ text, audio }) => {
    // Show prominent toast
    showToast(text);
    // Play the spoken audio
    if (audio) playAudioChunks([audio]);
    // Pulse the orb briefly — use 'speaking' not 'thinking'
    setState('speaking');
    setTimeout(() => setState('idle'), 4000);
    // Refresh reminders panel so triggered item shows as done
    if (typeof window.rpRefresh === 'function') window.rpRefresh();
  });
})();

// ── Auto-updater notifications ────────────────────────────────────────────────
window.jarvis.onUpdateAvailable(({ version }) => {
  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  banner.innerHTML = `<span>Update v${version} is downloading…</span>`;
  document.body.appendChild(banner);
});

window.jarvis.onUpdateReady(() => {
  const existing = document.getElementById('updateBanner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  banner.className = 'update-ready';
  banner.innerHTML = `<span>Update ready — restart to install</span><button id="updateInstallBtn">Restart Now</button>`;
  document.body.appendChild(banner);
  document.getElementById('updateInstallBtn').addEventListener('click', () => window.jarvis.installUpdate());
});

// Queue and play audio chunks in order — each starts as soon as the previous ends
// This lets us play sentence 1 while sentence 2 is still being synthesized
let audioQueue = [];
let audioPlaying = false;

let voiceVolume = parseFloat(localStorage.getItem('voiceVolume') || '1.5');

function playAudioChunks(chunks) {
  audioQueue.push(...chunks);
  if (!audioPlaying) drainAudioQueue();
}

function drainAudioQueue() {
  if (!audioQueue.length) { audioPlaying = false; return; }
  audioPlaying = true;
  const chunk = audioQueue.shift();
  const audio = new Audio(`data:audio/mp3;base64,${chunk}`);
  // Use Web Audio API to boost volume beyond 100%
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gain.gain.value = voiceVolume;
    source.connect(gain);
    gain.connect(ctx.destination);
  } catch (_) {}
  audio.onended = () => drainAudioQueue();
  audio.onerror = () => drainAudioQueue();
  audio.play().catch(() => drainAudioQueue());
}

// ===================== AUTH =====================
let pendingAssistantName = null;
let authMode = 'signup'; // 'signup' | 'login'

function showAuthStep() {
  nameStep.classList.add('hidden');
  authStep.classList.remove('hidden');
  reloginStep.classList.add('hidden');
}

function showNameStep() {
  nameStep.classList.remove('hidden');
  authStep.classList.add('hidden');
  reloginStep.classList.add('hidden');
}

function showReloginStep(msg) {
  nameStep.classList.add('hidden');
  authStep.classList.add('hidden');
  reloginStep.classList.remove('hidden');
  if (msg) document.getElementById('reloginMsg').textContent = msg;
}

function setAuthMode(mode) {
  authMode = mode;
  if (mode === 'signup') {
    tabSignup.classList.add('active');
    tabLogin.classList.remove('active');
    authSubmit.textContent = 'CREATE ACCOUNT';
    authFooter.innerHTML = 'Already have an account? <a href="#" id="switchToLogin">Log in →</a>';
    signupEmailField.style.display = '';
    signupNameField.style.display = '';
    signupGenderField.style.display = '';
    const signupVoiceFieldEl = document.getElementById('signupVoiceField');
    if (signupVoiceFieldEl) signupVoiceFieldEl.style.display = '';
    const cField = document.getElementById('signupCountryField');
    if (cField) cField.style.display = '';
    document.getElementById('switchToLogin').addEventListener('click', (e) => { e.preventDefault(); setAuthMode('login'); });
  } else {
    tabSignup.classList.remove('active');
    tabLogin.classList.add('active');
    authSubmit.textContent = 'LOG IN';
    authFooter.innerHTML = 'No account? <a href="#" id="switchToSignup">Sign up →</a>';
    signupEmailField.style.display = '';
    signupNameField.style.display = 'none';
    signupGenderField.style.display = 'none';
    const signupVoiceFieldElL = document.getElementById('signupVoiceField');
    if (signupVoiceFieldElL) signupVoiceFieldElL.style.display = 'none';
    const cFieldL = document.getElementById('signupCountryField');
    if (cFieldL) cFieldL.style.display = 'none';
    document.getElementById('switchToSignup').addEventListener('click', (e) => { e.preventDefault(); setAuthMode('signup'); });
  }
  authError.classList.add('hidden');
}

nameNext.addEventListener('click', async () => {
  const name = setupName.value.trim();
  if (!name) { setupName.focus(); return; }
  pendingAssistantName = name;
  if (profile && profile.email) {
    // Coming from post-signup name step — save and proceed
    profile.name = name;
    await window.jarvis.setProfile(profile);
    await checkSubscriptionAndEnter(name, profile.email);
  } else {
    showAuthStep();
  }
});

tabSignup.addEventListener('click', () => setAuthMode('signup'));
tabLogin.addEventListener('click', () => setAuthMode('login'));


// ── Password show/hide toggles ────────────────────────────────────────────────
(function() {
  const EYE_OPEN  = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
  const EYE_CLOSE = `<line x1="1" y1="1" x2="23" y2="23"/><path d="M10.58 10.58A3 3 0 0 0 14.41 13.41"/><path d="M9.88 9.88A3 3 0 0 1 12 9c3 0 5.4 2.56 6.71 4.29"/><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.09 18.09 0 0 1 5.06-5.94"/>`;

  function wire(toggleId, inputId, iconId) {
    const btn   = document.getElementById(toggleId);
    const input = document.getElementById(inputId);
    const icon  = document.getElementById(iconId);
    if (!btn || !input || !icon) return;
    let visible = false;
    btn.addEventListener('click', () => {
      visible = !visible;
      input.type = visible ? 'text' : 'password';
      icon.innerHTML = visible ? EYE_CLOSE : EYE_OPEN;
    });
  }
  wire('authPwToggle',    'authPassword',    'authEyeIcon');
  wire('reloginPwToggle', 'reloginPassword', 'reloginEyeIcon');
})();

// Title selection toggle (SIR / MA'AM / NO TITLE)
let selectedTitle = 'sir';
document.querySelectorAll('#signupGenderField .gender-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#signupGenderField .gender-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedTitle = btn.dataset.value;
  });
});

// Voice selection toggle on signup page (MALE / FEMALE)
let selectedVoice = 'male';
document.querySelectorAll('#signupVoiceField .gender-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#signupVoiceField .gender-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedVoice = btn.dataset.voice;
  });
});

switchToLogin.addEventListener('click', (e) => { e.preventDefault(); setAuthMode('login'); });

authSubmit.addEventListener('click', async () => {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) { authError.textContent = 'Please fill in all fields.'; authError.classList.remove('hidden'); return; }

  authSubmit.disabled = true;
  authSubmit.textContent = authMode === 'signup' ? 'CREATING...' : 'LOGGING IN...';
  authError.classList.add('hidden');

  let result;
  if (authMode === 'signup') {
    result = await window.jarvis.authSignup({ email, password, name: pendingAssistantName || 'My AI' });
  } else {
    result = await window.jarvis.authLogin({ email, password });
  }

  authSubmit.disabled = false;
  authSubmit.textContent = authMode === 'signup' ? 'CREATE ACCOUNT' : 'LOG IN';

  if (result.error) {
    console.error('[Auth] Error:', result.error);
    authError.textContent = result.error;
    authError.classList.remove('hidden');
    return;
  }

  const displayName = (authMode === 'signup' && authDisplayName?.value.trim()) ? authDisplayName.value.trim() : null;
  const title = authMode === 'signup' ? selectedTitle : (profile?.title || 'sir');
  if (authMode === 'signup') {
    const countryEl = document.getElementById('signupCountry');
    if (countryEl?.value) localStorage.setItem('userCountry', countryEl.value);
  }
  const voice = authMode === 'signup' ? selectedVoice : (profile?.voice || 'male');
  const userEmail = result.user?.email || email;

  if (authMode === 'signup' && !pendingAssistantName) {
    // Show name-your-AI step after signup
    profile = { name: 'My AI', email: userEmail, displayName, title, voice };
    await window.jarvis.setProfile(profile);
    showNameStep();
  } else {
    const name = pendingAssistantName || result.user?.name || 'My AI';
    profile = { name, email: userEmail, displayName, title, voice };
    await window.jarvis.setProfile(profile);
    await checkSubscriptionAndEnter(name, userEmail);
  }
});

googleBtn.addEventListener('click', async () => {
  googleBtn.textContent = 'Opening browser...';
  googleBtn.disabled = true;
  await window.jarvis.authGoogle();
  setTimeout(() => { googleBtn.textContent = 'Continue with Google'; googleBtn.disabled = false; }, 3000);
});

window.jarvis.onSubscriptionActivated(async () => {
  const result = await window.jarvis.authVerify();
  if (result.active && profile) {
    setupView.classList.add('hidden');
    await showSplash(profile.name || 'Your AI');
    await enterMain();
  }
});

window.jarvis.onGoogleSuccess(async ({ token, name, email }) => {
  const assistantDisplayName = name || pendingAssistantName || 'Your AI';
  // Ask what the AI should call them — Google gives us their real name,
  // but they may want to be called something shorter like "boss" or "Alex"
  const userCallName = await promptUserCallName(assistantDisplayName);
  profile = { name: assistantDisplayName, email, displayName: userCallName, title: 'none' };
  await window.jarvis.setProfile(profile);
  await checkSubscriptionAndEnter(assistantDisplayName, email);
});

// Re-login submit
reloginSubmit.addEventListener('click', async () => {
  const email = reloginEmail.value.trim();
  const password = reloginPassword.value;
  if (!email || !password) { reloginError.textContent = 'Please fill in all fields.'; reloginError.classList.remove('hidden'); return; }

  reloginSubmit.disabled = true;
  reloginSubmit.textContent = 'LOGGING IN...';
  reloginError.classList.add('hidden');

  const result = await window.jarvis.authLogin({ email, password });
  reloginSubmit.disabled = false;
  reloginSubmit.textContent = 'LOG IN';

  if (result.error) {
    reloginError.textContent = result.error;
    reloginError.classList.remove('hidden');
    return;
  }

  const name = result.user?.name || profile?.name || 'Your AI';
  profile = { name, email: result.user?.email || email };
  await window.jarvis.setProfile(profile);
  await checkSubscriptionAndEnter(name, profile.email);
});

reloginGoogle.addEventListener('click', async () => {
  reloginGoogle.textContent = 'Opening browser...';
  reloginGoogle.disabled = true;
  await window.jarvis.authGoogle();
  setTimeout(() => { reloginGoogle.textContent = 'Sign in with Google'; reloginGoogle.disabled = false; }, 3000);
});

// ===================== PAYMENT =====================
let payPollInterval = null;

async function checkPaymentStatus() {
  const result = await window.jarvis.authVerify();
  if (result.active) {
    clearInterval(payPollInterval);
    payPollInterval = null;
    setupView.classList.add('hidden');
    await showSplash(profile?.name || 'Your AI');
    await enterMain();
  } else {
    payError.textContent = 'Payment not confirmed yet. Try again in a moment.';
    payError.classList.remove('hidden');
    setTimeout(() => payError.classList.add('hidden'), 3000);
  }
}

function showTermsStep() {
  nameStep.classList.add('hidden');
  authStep.classList.add('hidden');
  reloginStep.classList.add('hidden');
  paymentStep.classList.add('hidden');
  termsStep.classList.remove('hidden');
  // reset scroll and lock agree button until scrolled
  termsScroll.scrollTop = 0;
  agreeBtn.disabled = true;
  termsFadeHint.classList.remove('hidden');
  document.querySelector('.setup-box').style.maxWidth = '';
  document.querySelector('.setup-box').style.padding = '';
}

// Unlock agree button once user has scrolled near the bottom
termsScroll.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = termsScroll;
  if (scrollTop + clientHeight >= scrollHeight - 40) {
    agreeBtn.disabled = false;
    termsFadeHint.classList.add('hidden');
  }
});

agreeBtn.addEventListener('click', () => {
  if (!agreeBtn.disabled) {
    localStorage.setItem('termsAccepted', '1');
    showPaymentStep();
  }
});

// Show terms on first signup; skip straight to payment for returning users
function showTermsOrPayment() {
  if (localStorage.getItem('termsAccepted')) {
    showPaymentStep();
  } else {
    showTermsStep();
  }
}

function showPaymentStep() {
  nameStep.classList.add('hidden');
  authStep.classList.add('hidden');
  reloginStep.classList.add('hidden');
  termsStep.classList.add('hidden');
  paymentStep.classList.remove('hidden');
  // reset to plan selection view
  planCards.classList.remove('hidden');
  billingInterval.classList.add('hidden');
  payWaiting.classList.add('hidden');
  payError.classList.add('hidden');
  // widen the setup-box for plan cards
  document.querySelector('.setup-box').style.maxWidth = '560px';
  document.querySelector('.setup-box').style.padding = '32px 28px';
}

// Show a quick inline prompt asking what the AI should call the user.
// Resolves with the entered name (or falls back to googleName if skipped).
function promptUserCallName(googleName) {
  return new Promise((resolve) => {
    // Reuse the setup box — inject a temporary step
    const box = document.getElementById('setupBox');
    const existing = document.getElementById('callNamePrompt');
    if (existing) { resolve(googleName); return; }

    const div = document.createElement('div');
    div.id = 'callNamePrompt';
    div.innerHTML = `
      <p style="margin:0 0 14px;font-size:13px;color:rgba(200,225,255,0.75)">What should ${pendingAssistantName || 'your AI'} call you?</p>
      <div class="setup-field">
        <label>YOUR NAME</label>
        <div class="auth-input-wrap">
          <input id="callNameInput" type="text" placeholder="e.g. ${googleName.split(' ')[0]}, boss, captain…" autocomplete="off" style="text-transform:none" />
        </div>
      </div>
      <button id="callNameBtn" class="shine-btn">LET'S GO →</button>`;

    // Hide all other steps, show this one
    Array.from(box.querySelectorAll(':scope > div')).forEach(el => el.classList.add('hidden'));
    box.appendChild(div);

    const input = div.querySelector('#callNameInput');
    const btn = div.querySelector('#callNameBtn');
    setTimeout(() => input.focus(), 100);

    const finish = () => {
      const val = input.value.trim();
      div.remove();
      resolve(val || googleName.split(' ')[0] || googleName);
    };
    btn.addEventListener('click', finish);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
  });
}

async function checkSubscriptionAndEnter(name, email) {
  // Re-verify token to get latest subscription status
  const result = await window.jarvis.authVerify();
  // Allow entry for all logged-in users (subscribed or not)
  if (result.needsLogin) {
    setupView.classList.remove('hidden');
    return;
  }
  setupView.classList.add('hidden');
  await showSplash(name);
  await enterMain();
}

// Plan selection — Get Premium → show billing interval picker
document.getElementById('choosePremium').addEventListener('click', () => {
  planCards.classList.add('hidden');
  billingInterval.classList.remove('hidden');
  payError.classList.add('hidden');
});

// Plan selection — Try for Free → enter as free user
document.getElementById('chooseFree').addEventListener('click', async () => {
  // Mark as free tier and enter the app
  profile.tier = 'free';
  await window.jarvis.setProfile(profile);
  await showSplash(profile.name);
  await enterMain(true);
});

// Back from billing interval to plan cards
document.getElementById('payBackBtn').addEventListener('click', () => {
  billingInterval.classList.add('hidden');
  planCards.classList.remove('hidden');
  payError.classList.add('hidden');
});

// Helper: open Stripe checkout with a plan param
async function openStripeCheckout(plan) {
  try {
  console.log('[checkout] opening plan:', plan);
  await window.jarvis.openCheckout(plan);
  billingInterval.classList.add('hidden');
  planCards.classList.add('hidden');
  payWaiting.classList.remove('hidden');
  payPollInterval = setInterval(checkPaymentStatus, 4000);
  } catch(e) { console.error('[checkout] error:', e); }
}

document.getElementById('payMonthly').addEventListener('click', () => openStripeCheckout('monthly'));
document.getElementById('payAnnual').addEventListener('click',  () => openStripeCheckout('annual'));
document.getElementById('payCheckBtn').addEventListener('click', checkPaymentStatus);

// ===================== SPLASH / MAIN =====================
async function showSplash(name) {
  splashName.textContent = (name || 'YOUR AI').toUpperCase();
  splashStatus.textContent = 'Initializing systems...';
  splash.classList.remove('hidden');
  await new Promise(r => setTimeout(r, 500));
  splashStatus.textContent = 'Loading neural interface...';
  await new Promise(r => setTimeout(r, 600));
  splashStatus.textContent = 'Systems online.';
  await new Promise(r => setTimeout(r, 500));
  splash.classList.add('hidden');
}

async function enterMain(skipWelcome = false, returningUser = false) {
  // Load finance panel after entering main — never block splash
  setTimeout(() => finLoad().catch(() => {}), 1200);
  profile.wasSubscribed = true;
  await window.jarvis.setProfile(profile);

  const aiName = (profile.name || 'YOUR AI').toUpperCase();
  document.getElementById('aiName').textContent = aiName;
  document.getElementById('enterAiName').textContent = aiName;

  setupView.classList.add('hidden');

  // Show welcome screen only on first-ever login, not on re-activations
  const welcomeKey = 'hasSeenWelcome_' + (profile.email || aiName);
  const hasSeenWelcome = localStorage.getItem(welcomeKey);
  const welcomeScreen = document.getElementById('welcomeScreen');

  if (!skipWelcome && !hasSeenWelcome) {
    welcomeScreen.classList.remove('hidden');
    initSpikySphere();

    document.getElementById('enterBtn').addEventListener('click', async () => {
      localStorage.setItem(welcomeKey, '1');
      welcomeScreen.classList.add('fade-out');
      setTimeout(() => {
        welcomeScreen.classList.add('hidden');
        mainView.classList.remove('hidden');
        fixLayout();
        setState('idle');
      }, 800);
      try {
        const addressAs = profile.displayName || (profile.title && profile.title !== 'none' ? profile.title : null) || 'sir';
        const greeting = `Welcome, ${addressAs}. All systems are online. How may I assist you?`;
        const audio = await window.jarvis.speak(greeting);
        if (audio) playAudioChunks([audio]);
      } catch (_) {}
    }, { once: true });
  } else {
    welcomeScreen.classList.add('hidden');
    mainView.classList.remove('hidden');
    fixLayout();
    setState('idle');

    // Returning user — greet them every time they summon the app
    if (returningUser) {
      try {
        const title = profile.title && profile.title !== 'none' ? profile.title : 'sir';
        const addressAs = profile.displayName || title;
        const greeting = `Welcome back, ${addressAs}.`;
        const audio = await window.jarvis.speak(greeting);
        if (audio) playAudioChunks([audio]);
      } catch (e) { console.error('[GREET]', e); }
    }
  }
}

function initSpikySphere() {
  const canvas = document.getElementById('sphereCanvas');
  if (!canvas) return;
  const gl = canvas.getContext('webgl');
  if (!gl) return;

  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  gl.viewport(0, 0, canvas.width, canvas.height);

  const vsSource = `
    attribute vec3 aPos;
    attribute vec3 aNorm;
    uniform mat4 uMVP;
    uniform float uTime;
    varying vec3 vNorm;
    varying float vSpike;

    float hash(float n) { return fract(sin(n) * 43758.5453); }
    float noise(vec3 p) {
      vec3 i = floor(p); vec3 f = fract(p);
      f = f*f*(3.0-2.0*f);
      float n = i.x + i.y*57.0 + i.z*113.0;
      return mix(mix(mix(hash(n),hash(n+1.0),f.x),mix(hash(n+57.0),hash(n+58.0),f.x),f.y),
                 mix(mix(hash(n+113.0),hash(n+114.0),f.x),mix(hash(n+170.0),hash(n+171.0),f.x),f.y),f.z);
    }

    void main() {
      vec3 p = aPos;
      float n = noise(aNorm * 4.0 + uTime * 0.3);
      float spike = pow(n, 3.0) * 0.55;
      vSpike = spike;
      p += aNorm * spike;
      vNorm = aNorm;
      gl_Position = uMVP * vec4(p, 1.0);
    }
  `;

  const fsSource = `
    precision mediump float;
    varying vec3 vNorm;
    varying float vSpike;

    void main() {
      vec3 light = normalize(vec3(0.5, 1.0, 1.0));
      float diff = max(dot(normalize(vNorm), light), 0.0);
      vec3 base = mix(vec3(0.0, 0.35, 0.85), vec3(0.0, 0.85, 1.0), vSpike * 3.0);
      vec3 col = base * (0.35 + 0.65 * diff);
      col += vec3(0.0, 0.5, 1.0) * vSpike * 1.5;
      float rim = 1.0 - max(dot(normalize(vNorm), vec3(0.0,0.0,1.0)), 0.0);
      col += vec3(0.0, 0.7, 1.0) * pow(rim, 3.0) * 0.6;
      gl_FragColor = vec4(col, 0.92);
    }
  `;

  function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s); return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vsSource));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(prog);

  // Build sphere geometry
  const rows = 64, cols = 64;
  const verts = [], norms = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    const phi = Math.PI * r / rows;
    for (let c = 0; c <= cols; c++) {
      const theta = 2 * Math.PI * c / cols;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      verts.push(x, y, z);
      norms.push(x, y, z);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r*(cols+1)+c, b = a+1, d = a+(cols+1), e = d+1;
      idx.push(a,b,d, b,e,d);
    }
  }

  function mkBuf(data, type) {
    const b = gl.createBuffer();
    gl.bindBuffer(type, b);
    gl.bufferData(type, data, gl.STATIC_DRAW);
    return b;
  }
  const vBuf = mkBuf(new Float32Array(verts), gl.ARRAY_BUFFER);
  const nBuf = mkBuf(new Float32Array(norms), gl.ARRAY_BUFFER);
  const iBuf = mkBuf(new Uint16Array(idx), gl.ELEMENT_ARRAY_BUFFER);

  const aPos  = gl.getAttribLocation(prog, 'aPos');
  const aNorm = gl.getAttribLocation(prog, 'aNorm');
  const uMVP  = gl.getUniformLocation(prog, 'uMVP');
  const uTime = gl.getUniformLocation(prog, 'uTime');

  function mat4mul(a, b) {
    const r = new Float32Array(16);
    for (let i=0;i<4;i++) for (let j=0;j<4;j++) for (let k=0;k<4;k++) r[i*4+j]+=a[i*4+k]*b[k*4+j];
    return r;
  }
  function perspective(fov, asp, n, f) {
    const t = Math.tan(fov/2), m = new Float32Array(16);
    m[0]=1/(asp*t); m[5]=1/t; m[10]=-(f+n)/(f-n); m[11]=-1; m[14]=-2*f*n/(f-n); return m;
  }
  function rotY(a) {
    const c=Math.cos(a),s=Math.sin(a),m=new Float32Array(16);
    m[0]=c;m[2]=s;m[5]=1;m[8]=-s;m[10]=c;m[15]=1; return m;
  }
  function rotX(a) {
    const c=Math.cos(a),s=Math.sin(a),m=new Float32Array(16);
    m[0]=1;m[5]=c;m[6]=-s;m[9]=s;m[10]=c;m[15]=1; return m;
  }
  function trans(x,y,z) {
    const m=new Float32Array(16);
    m[0]=1;m[5]=1;m[10]=1;m[15]=1;m[12]=x;m[13]=y;m[14]=z; return m;
  }

  let mouseX = 0, mouseY = 0;
  window.addEventListener('mousemove', e => {
    mouseX = (e.clientX/window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY/window.innerHeight - 0.5) * 2;
  });

  const asp = canvas.width / canvas.height;
  const proj = perspective(Math.PI/4, asp, 0.1, 100);
  const t0 = Date.now();

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let running = true;
  const welcomeEl = document.getElementById('welcomeScreen');

  function renderSphere() {
    if (!running || welcomeEl.classList.contains('hidden')) return;
    requestAnimationFrame(renderSphere);

    const t = (Date.now() - t0) / 1000;
    gl.clearColor(0,0,0,0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(prog);
    gl.uniform1f(uTime, t);

    const view = trans(0, 0.6, -3.2);
    const ry = rotY(t * 0.4 + mouseX * 0.6);
    const rx = rotX(-mouseY * 0.4 + Math.sin(t*0.3)*0.1);
    const mvp = mat4mul(proj, mat4mul(view, mat4mul(ry, rx)));
    gl.uniformMatrix4fv(uMVP, false, mvp);

    gl.bindBuffer(gl.ARRAY_BUFFER, vBuf);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(aPos);

    gl.bindBuffer(gl.ARRAY_BUFFER, nBuf);
    gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(aNorm);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, iBuf);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
  }
  renderSphere();
}

// ===================== CONNECTORS PANEL =====================
const connectorsBtn = { addEventListener: () => {} }; // dock button removed — handled by rail
const connectorsPanel = document.getElementById('lnavPaneConnectors');
const connectorsClose = document.getElementById('connectorsClose');

async function renderConnectors() {
  const status = await window.jarvis.connectorStatus();

  // Gmail row
  const gmailStatus = document.getElementById('gmailStatus');
  const gmailBtn = document.getElementById('gmailBtn');
  if (status.gmail) {
    gmailStatus.textContent = 'Connected';
    gmailStatus.className = 'connector-status connected';
    gmailBtn.textContent = 'DISCONNECT';
    gmailBtn.className = 'connector-btn disconnect';
    gmailBtn.onclick = async () => { await window.jarvis.connectorDisconnect('gmail'); renderConnectors(); };
  } else {
    gmailStatus.textContent = 'Not connected';
    gmailStatus.className = 'connector-status';
    gmailBtn.textContent = 'CONNECT';
    gmailBtn.className = 'connector-btn';
    gmailBtn.onclick = () => showConnectSteps('gmail');
  }

  // Outlook row
  const outlookStatus = document.getElementById('outlookStatus');
  const outlookBtn = document.getElementById('outlookBtn');
  if (status.outlook) {
    outlookStatus.textContent = 'Connected';
    outlookStatus.className = 'connector-status connected';
    outlookBtn.textContent = 'DISCONNECT';
    outlookBtn.className = 'connector-btn disconnect';
    outlookBtn.onclick = async () => { await window.jarvis.connectorDisconnect('outlook'); renderConnectors(); };
  } else {
    outlookStatus.textContent = 'Not connected';
    outlookStatus.className = 'connector-status';
    outlookBtn.textContent = 'CONNECT';
    outlookBtn.className = 'connector-btn';
    outlookBtn.onclick = () => showConnectSteps('outlook');
  }

  // Google Calendar row
  const calendarStatus = document.getElementById('calendarStatus');
  const calendarBtn = document.getElementById('calendarBtn');
  if (calendarStatus && calendarBtn) {
    if (status.calendar) {
      calendarStatus.textContent = 'Connected';
      calendarStatus.className = 'connector-status connected';
      calendarBtn.textContent = 'DISCONNECT';
      calendarBtn.className = 'connector-btn disconnect';
      calendarBtn.onclick = async () => { await window.jarvis.connectorDisconnect('calendar'); renderConnectors(); };
    } else {
      calendarStatus.textContent = 'Not connected';
      calendarStatus.className = 'connector-status';
      calendarBtn.textContent = 'CONNECT';
      calendarBtn.className = 'connector-btn';
      calendarBtn.onclick = () => showConnectSteps('calendar');
    }
  }

  // Google Drive row
  const driveStatus = document.getElementById('driveStatus');
  const driveBtn = document.getElementById('driveBtn');
  if (driveStatus && driveBtn) {
    if (status.drive) {
      driveStatus.textContent = 'Connected';
      driveStatus.className = 'connector-status connected';
      driveBtn.textContent = 'DISCONNECT';
      driveBtn.className = 'connector-btn disconnect';
      driveBtn.onclick = async () => { await window.jarvis.connectorDisconnect('drive'); renderConnectors(); };
    } else {
      driveStatus.textContent = 'Not connected';
      driveStatus.className = 'connector-status';
      driveBtn.textContent = 'CONNECT';
      driveBtn.className = 'connector-btn';
      driveBtn.onclick = () => showConnectSteps('drive');
    }
  }


  // VIP list
  const vipList = document.getElementById('vipList');
  const vips = await window.jarvis.connectorGetVip();
  if (!vips.length) {
    vipList.innerHTML = '<div style="font-size:11px;color:rgba(0,200,255,0.25);padding:4px 0;">No important senders yet.</div>';
  } else {
    vipList.innerHTML = vips.map(v => `
      <div class="vip-item">
        <span>${v}</span>
        <button onclick="removeVip('${v}')">✕</button>
      </div>`).join('');
  }
}

window.removeVip = async (v) => {
  await window.jarvis.connectorRemoveVip(v);
  renderConnectors();
};

document.getElementById('vipAddBtn').addEventListener('click', async () => {
  const val = document.getElementById('vipInput').value.trim();
  if (!val) return;
  await window.jarvis.connectorAddVip(val);
  document.getElementById('vipInput').value = '';
  renderConnectors();
});

document.getElementById('vipInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('vipAddBtn').click();
});

// ===================== MUSIC SERVICE SELECTOR =====================
function renderMusicService(status) {
  // Spotify OAuth row
  const spotifyStatus = document.getElementById('spotifyStatus');
  const spotifyBtn = document.getElementById('spotifyBtn');
  if (spotifyStatus && spotifyBtn) {
    if (status?.spotify) {
      spotifyStatus.textContent = 'Connected — background playback enabled';
      spotifyStatus.className = 'connector-status connected';
      spotifyBtn.textContent = 'DISCONNECT';
      spotifyBtn.className = 'connector-btn disconnect';
      spotifyBtn.onclick = async () => { await window.jarvis.connectorDisconnect('spotify'); renderConnectors(); };
    } else {
      spotifyStatus.textContent = 'Not connected';
      spotifyStatus.className = 'connector-status';
      spotifyBtn.textContent = 'CONNECT';
      spotifyBtn.className = 'connector-btn';
      spotifyBtn.onclick = () => showConnectSteps('spotify');
    }
  }

  // Preferred service selector
  const saved = window.jarvis.getMusicService();
  const selectedEl = document.getElementById('musicServiceSelected');
  if (selectedEl) selectedEl.textContent = saved
    ? saved.charAt(0).toUpperCase() + saved.slice(1)
    : 'None — will use YouTube';

  document.querySelectorAll('.music-service-row').forEach(row => {
    const svc = row.dataset.service;
    row.classList.toggle('active', svc === saved);
    row.onclick = () => { window.jarvis.setMusicService(svc); renderMusicService(status); };
  });
}

// ===================== ANALYTICS CONNECTORS =====================
function renderAnalyticsConnectors(status) {
  // Generic helper: set row state
  function setRow(key, statusEl, btn) {
    if (!statusEl || !btn) return;
    if (status?.[key]) {
      statusEl.textContent = 'Connected';
      statusEl.className = 'connector-status connected';
      btn.textContent = 'DISCONNECT';
      btn.className = 'connector-btn disconnect';
      btn.onclick = async () => { await window.jarvis.connectorDisconnect(key); renderConnectors(); };
    } else {
      // Restore default status text (some rows have custom "not connected" text in HTML)
      if (key !== 'analytics' && key !== 'stripe') {
        statusEl.textContent = 'Not connected';
        statusEl.className = 'connector-status';
      } else {
        statusEl.className = 'connector-status';
      }
      btn.textContent = 'CONNECT';
      btn.className = 'connector-btn';
      btn.onclick = () => showConnectSteps(key);
    }
  }

  setRow('youtube', document.getElementById('youtubeStatus'), document.getElementById('youtubeBtn'));
  setRow('instagram', document.getElementById('instagramStatus'), document.getElementById('instagramBtn'));
  setRow('tiktok', document.getElementById('tiktokStatus'), document.getElementById('tiktokBtn'));
  setRow('shopify', document.getElementById('shopifyStatus'), document.getElementById('shopifyBtn'));
  setRow('squarespace', document.getElementById('squarespaceStatus'), document.getElementById('squarespaceBtn'));
  setRow('analytics', document.getElementById('ganalyticsStatus'), document.getElementById('ganalyticsBtn'));
  setRow('stripe', document.getElementById('stripeStatus'), document.getElementById('stripeBtn'));

  // Show dashboard button if any platform connected
  const viewBtn = document.getElementById('analyticsViewBtn');
  if (viewBtn) {
    const anyConnected = status?.youtube || status?.instagram || status?.tiktok || status?.shopify || status?.squarespace || status?.analytics || status?.stripe;
    viewBtn.classList.toggle('hidden', !anyConnected);
  }
}

// ── Analytics dashboard ──────────────────────────────────────────────────────

function fmtNum(n) {
  if (!n && n !== 0) return '—';
  const num = parseInt(n);
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function renderAnalyticsDashboard(data) {
  const content = document.getElementById('analyticsContent');
  if (!content) return;
  const { youtube, instagram, tiktok, shopify, squarespace, googleAnalytics, stripe } = data;
  const cards = [];

  // ── WEBSITE ANALYTICS — always first, unified card across all platforms ──
  const hasWebsite = googleAnalytics || squarespace || shopify || stripe;
  if (hasWebsite) {
    // Aggregate visitors, sales, products from all connected website sources
    let visitors = '—', sales = '—', products = '—', siteName = '', platform = '';

    if (googleAnalytics) {
      visitors = fmtNum(googleAnalytics.last30Days.users);
      siteName = googleAnalytics.siteName || 'Your Website';
      platform = 'Google Analytics';
      const rev = parseFloat(googleAnalytics.last30Days.revenue || 0);
      if (rev > 0) sales = '$' + (rev > 999 ? (rev/1000).toFixed(1)+'K' : rev.toFixed(0));
      if (googleAnalytics.last30Days.transactions > 0) products = fmtNum(googleAnalytics.last30Days.transactions) + ' orders';
    }
    if (shopify) {
      siteName = shopify.shopName || siteName;
      platform = platform ? platform + ' · Shopify' : 'Shopify';
      sales = '$' + shopify.last30Days.revenue;
      products = fmtNum(shopify.productCount || shopify.last30Days.paidOrders) + ' products';
      visitors = googleAnalytics ? visitors : fmtNum(shopify.totalCustomers) + ' customers';
    }
    if (squarespace) {
      siteName = squarespace.siteName || siteName;
      platform = platform ? platform + ' · Squarespace' : 'Squarespace';
      if (sales === '—') sales = squarespace.last30Days.currency + ' ' + squarespace.last30Days.revenue;
      if (products === '—') products = fmtNum(squarespace.last30Days.orders) + ' orders';
    }
    if (stripe && sales === '—') {
      platform = platform ? platform + ' · Stripe' : 'Stripe';
      sales = stripe.last30Days.currency + ' ' + stripe.last30Days.revenue;
      products = fmtNum(stripe.last30Days.orders) + ' payments';
    }

    // Bounce rate / session for GA
    const bounceRate = googleAnalytics ? googleAnalytics.last30Days.bounceRate + '%' : '—';
    const pageViews  = googleAnalytics ? fmtNum(googleAnalytics.last30Days.pageViews) : '—';

    // Top pages / recent orders
    let listHtml = '';
    if (googleAnalytics?.topPages?.length) {
      listHtml = `<div class="apc-recent"><div class="apc-recent-title">TOP PAGES</div>${
        googleAnalytics.topPages.slice(0,3).map(p =>
          `<div class="apc-recent-item">${p.path}<span>${fmtNum(p.views)} views</span></div>`
        ).join('')}</div>`;
    } else if (squarespace?.recentOrders?.length) {
      listHtml = `<div class="apc-recent"><div class="apc-recent-title">RECENT ORDERS</div>${
        squarespace.recentOrders.slice(0,3).map(o => {
          const date = new Date(o.date).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
          return `<div class="apc-recent-item">#${o.orderNumber} — ${o.total}<span>${date}</span></div>`;
        }).join('')}</div>`;
    } else if (stripe?.recentPayments?.length) {
      listHtml = `<div class="apc-recent"><div class="apc-recent-title">RECENT PAYMENTS</div>${
        stripe.recentPayments.slice(0,3).map(p =>
          `<div class="apc-recent-item">${p.description}<span>${p.amount} · ${p.date}</span></div>`
        ).join('')}</div>`;
    }

    cards.push(`
      <div class="analytics-platform-card website-analytics-card">
        <div class="apc-header">
          <div class="apc-icon website-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </div>
          <div style="flex:1">
            <div class="apc-title" style="color:rgba(0,220,255,0.9)">WEBSITE ANALYTICS</div>
            <div class="apc-subtitle">${siteName || 'Your Website'}</div>
          </div>
          <div class="website-platform-badge">${platform}</div>
        </div>
        <div class="website-analytics-stats">
          <div class="wa-stat visitors">
            <div class="wa-stat-icon">👥</div>
            <div class="wa-stat-val">${visitors}</div>
            <div class="wa-stat-label">VISITORS</div>
            <div class="wa-stat-sub">last 30 days</div>
          </div>
          <div class="wa-stat sales">
            <div class="wa-stat-icon">💰</div>
            <div class="wa-stat-val">${sales}</div>
            <div class="wa-stat-label">SALES</div>
            <div class="wa-stat-sub">last 30 days</div>
          </div>
          <div class="wa-stat products">
            <div class="wa-stat-icon">📦</div>
            <div class="wa-stat-val">${products}</div>
            <div class="wa-stat-label">PRODUCTS</div>
            <div class="wa-stat-sub">in store</div>
          </div>
        </div>
        ${googleAnalytics ? `
        <div class="apc-stats" style="margin-top:0">
          <div class="apc-stat"><div class="apc-stat-val">${pageViews}</div><div class="apc-stat-label">PAGE VIEWS (30D)</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${bounceRate}</div><div class="apc-stat-label">BOUNCE RATE</div></div>
        </div>` : ''}
        ${listHtml}
      </div>`);
  }

  if (youtube) {
    const recentHtml = youtube.recentVideos.slice(0, 3).map(v =>
      `<div class="apc-recent-item">${v.title}</div>`
    ).join('');
    cards.push(`
      <div class="analytics-platform-card">
        <div class="apc-header">
          <div class="apc-icon youtube">▶</div>
          <div>
            <div class="apc-title">YOUTUBE STUDIO</div>
            <div class="apc-subtitle">${youtube.channelName}</div>
          </div>
        </div>
        <div class="apc-stats">
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(youtube.subscribers)}</div><div class="apc-stat-label">SUBSCRIBERS</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(youtube.totalViews)}</div><div class="apc-stat-label">TOTAL VIEWS</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(youtube.videoCount)}</div><div class="apc-stat-label">VIDEOS</div></div>
        </div>
        ${recentHtml ? `<div class="apc-recent"><div class="apc-recent-title">RECENT VIDEOS</div>${recentHtml}</div>` : ''}
      </div>`);
  }

  if (instagram) {
    const recentHtml = instagram.recentPosts.slice(0, 3).map(p =>
      `<div class="apc-recent-item">${p.caption || 'Post'}<span>♥ ${fmtNum(p.likes)}</span></div>`
    ).join('');
    cards.push(`
      <div class="analytics-platform-card">
        <div class="apc-header">
          <div class="apc-icon instagram">📸</div>
          <div>
            <div class="apc-title">INSTAGRAM</div>
            <div class="apc-subtitle">@${instagram.username}</div>
          </div>
        </div>
        <div class="apc-stats">
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(instagram.followers)}</div><div class="apc-stat-label">FOLLOWERS</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(instagram.posts)}</div><div class="apc-stat-label">POSTS</div></div>
        </div>
        ${recentHtml ? `<div class="apc-recent"><div class="apc-recent-title">RECENT POSTS</div>${recentHtml}</div>` : ''}
      </div>`);
  }

  if (tiktok) {
    const recentHtml = tiktok.recentVideos.slice(0, 3).map(v =>
      `<div class="apc-recent-item">${v.title}<span>👁 ${fmtNum(v.views)}</span></div>`
    ).join('');
    cards.push(`
      <div class="analytics-platform-card">
        <div class="apc-header">
          <div class="apc-icon tiktok">♪</div>
          <div>
            <div class="apc-title">TIKTOK</div>
            <div class="apc-subtitle">${tiktok.username}</div>
          </div>
        </div>
        <div class="apc-stats">
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(tiktok.followers)}</div><div class="apc-stat-label">FOLLOWERS</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(tiktok.totalLikes)}</div><div class="apc-stat-label">TOTAL LIKES</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(tiktok.videoCount)}</div><div class="apc-stat-label">VIDEOS</div></div>
        </div>
        ${recentHtml ? `<div class="apc-recent"><div class="apc-recent-title">RECENT VIDEOS</div>${recentHtml}</div>` : ''}
      </div>`);
  }

  if (shopify) {
    cards.push(`
      <div class="analytics-platform-card">
        <div class="apc-header">
          <div class="apc-icon shopify">🛍</div>
          <div>
            <div class="apc-title">SHOPIFY</div>
            <div class="apc-subtitle">${shopify.shopName}</div>
          </div>
        </div>
        <div class="apc-stats">
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(shopify.last30Days.paidOrders)}</div><div class="apc-stat-label">ORDERS (30D)</div></div>
          <div class="apc-stat"><div class="apc-stat-val">$${shopify.last30Days.revenue}</div><div class="apc-stat-label">REVENUE (30D)</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(shopify.totalCustomers)}</div><div class="apc-stat-label">CUSTOMERS</div></div>
        </div>
      </div>`);
  }

  if (squarespace) {
    const recentHtml = (squarespace.recentOrders || []).slice(0, 3).map(o => {
      const date = new Date(o.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return `<div class="apc-recent-item">#${o.orderNumber} — ${o.total}<span>${date}</span></div>`;
    }).join('');
    cards.push(`
      <div class="analytics-platform-card">
        <div class="apc-header">
          <div class="apc-icon squarespace">⬡</div>
          <div>
            <div class="apc-title">SQUARESPACE</div>
            <div class="apc-subtitle">${squarespace.siteName}</div>
          </div>
        </div>
        <div class="apc-stats">
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(squarespace.last30Days.orders)}</div><div class="apc-stat-label">ORDERS (30D)</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${squarespace.last30Days.currency} ${squarespace.last30Days.revenue}</div><div class="apc-stat-label">REVENUE (30D)</div></div>
        </div>
        ${recentHtml ? `<div class="apc-recent"><div class="apc-recent-title">RECENT ORDERS</div>${recentHtml}</div>` : ''}
      </div>`);
  }

  if (stripe) {
    const recentHtml = (stripe.recentPayments || []).map(p =>
      `<div class="apc-recent-item">${p.description}<span>${p.amount} · ${p.date}</span></div>`
    ).join('');
    cards.push(`
      <div class="analytics-platform-card">
        <div class="apc-header">
          <div class="apc-icon stripe">💳</div>
          <div>
            <div class="apc-title">REVENUE & PAYMENTS</div>
            <div class="apc-subtitle">Stripe · any website</div>
          </div>
        </div>
        <div class="apc-stats">
          <div class="apc-stat"><div class="apc-stat-val">${stripe.last30Days.currency} ${stripe.last30Days.revenue}</div><div class="apc-stat-label">REVENUE (30D)</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(stripe.last30Days.orders)}</div><div class="apc-stat-label">PAYMENTS (30D)</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${stripe.last7Days.currency || stripe.last30Days.currency} ${stripe.last7Days.revenue}</div><div class="apc-stat-label">REVENUE (7D)</div></div>
          <div class="apc-stat"><div class="apc-stat-val">${fmtNum(stripe.last7Days.orders)}</div><div class="apc-stat-label">PAYMENTS (7D)</div></div>
        </div>
        ${recentHtml ? `<div class="apc-recent"><div class="apc-recent-title">RECENT PAYMENTS</div>${recentHtml}</div>` : ''}
      </div>`);
  }

  content.innerHTML = cards.length
    ? cards.join('')
    : `<div class="analytics-empty">No connected platforms.<br>Connect YouTube, Instagram,<br>TikTok or Shopify to see stats.</div>`;
}

async function loadAnalyticsDashboard() {
  const content = document.getElementById('analyticsContent');
  const refreshBtn = document.getElementById('analyticsRefreshBtn');
  const lastUpdated = document.getElementById('analyticsLastUpdated');
  if (content) content.innerHTML = '<div class="analytics-loading">Loading stats...</div>';
  if (refreshBtn) { refreshBtn.style.opacity = '0.3'; refreshBtn.style.pointerEvents = 'none'; }
  try {
    const data = await window.jarvis.analyticsGet('all');
    renderAnalyticsDashboard(data);
    if (lastUpdated) {
      const now = new Date();
      lastUpdated.textContent = 'UPDATED ' + now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
  } catch (err) {
    if (content) content.innerHTML = '<div class="analytics-empty">Failed to load stats. Check your connections and try again.</div>';
  }
  if (refreshBtn) { refreshBtn.style.opacity = ''; refreshBtn.style.pointerEvents = ''; }
}

document.getElementById('analyticsViewBtn')?.addEventListener('click', async () => {
  historySidebar.classList.add('hidden');
  const ap = document.getElementById('analyticsPanel');
  ap.classList.remove('hidden');
  ap.scrollTop = 0;
  const ac = document.getElementById('analyticsContent');
  if (ac) ac.scrollTop = 0;
  loadAnalyticsDashboard();
});

document.getElementById('analyticsRefreshBtn')?.addEventListener('click', loadAnalyticsDashboard);

document.getElementById('analyticsClose')?.addEventListener('click', () => {
  document.getElementById('analyticsPanel').classList.add('hidden');
});

// ── Shopify modal ─────────────────────────────────────────────────────────────
// ===================== CONNECTION STEPS MODAL =====================

const CONNECT_STEPS = {
  gmail: {
    icon: '✉', title: 'CONNECT GMAIL', subtitle: 'Google account required',
    steps: [
      'A browser window will open',
      'Sign in with your <strong>Google account</strong>',
      'Click <strong>Allow</strong> to grant email read access',
      'The tab will close — you\'re connected',
    ],
    continueLabel: 'Open Google Sign-In →',
    action: () => window.jarvis.connectorConnect('gmail'),
  },
  outlook: {
    icon: '📧', title: 'CONNECT OUTLOOK', subtitle: 'Microsoft account required',
    steps: [
      'A browser window will open',
      'Sign in with your <strong>Microsoft account</strong>',
      'Click <strong>Accept</strong> to grant email read access',
      'The tab will close — you\'re connected',
    ],
    continueLabel: 'Open Microsoft Sign-In →',
    action: () => window.jarvis.connectorConnect('outlook'),
  },
  calendar: {
    icon: '📅', title: 'CONNECT GOOGLE CALENDAR', subtitle: 'Google account required',
    steps: [
      'A browser window will open',
      'Sign in with your <strong>Google account</strong>',
      'Click <strong>Allow</strong> to grant calendar access',
      'The tab will close — you\'re connected',
    ],
    continueLabel: 'Open Google Sign-In →',
    action: () => window.jarvis.connectorConnect('calendar'),
  },
  drive: {
    icon: '📁', title: 'CONNECT GOOGLE DRIVE', subtitle: 'Google account required',
    steps: [
      'A browser window will open',
      'Sign in with your <strong>Google account</strong>',
      'Click <strong>Allow</strong> to grant Drive read access',
      'The tab will close — you\'re connected',
    ],
    continueLabel: 'Open Google Sign-In →',
    action: () => window.jarvis.connectorConnect('drive'),
  },
  spotify: {
    icon: '🎵', title: 'CONNECT SPOTIFY', subtitle: 'Spotify Premium required for playback',
    steps: [
      'A browser window will open',
      'Log into your <strong>Spotify account</strong>',
      'Click <strong>Agree</strong> to allow playback control',
      'The tab will close — you\'re connected',
    ],
    continueLabel: 'Open Spotify Sign-In →',
    action: () => window.jarvis.connectorConnect('spotify'),
  },
  youtube: {
    icon: '▶', title: 'CONNECT YOUTUBE STUDIO', subtitle: 'Google account with a YouTube channel required',
    steps: [
      'A browser window will open',
      'Sign in with the <strong>Google account</strong> linked to your YouTube channel',
      'Click <strong>Allow</strong> to grant YouTube analytics access',
      'The tab will close — you\'re connected',
    ],
    continueLabel: 'Open Google Sign-In →',
    action: () => window.jarvis.connectorConnect('youtube'),
  },
  instagram: {
    icon: '📸', title: 'CONNECT INSTAGRAM', subtitle: 'Instagram Business or Creator account required',
    steps: [
      'A browser window will open',
      'Log into <strong>Facebook</strong> (Instagram uses Facebook login)',
      'Select the <strong>Facebook Page</strong> linked to your Instagram',
      'Click <strong>Allow</strong> to grant Instagram access',
      'The tab will close — you\'re connected',
    ],
    continueLabel: 'Open Facebook Sign-In →',
    action: () => window.jarvis.connectorConnect('instagram'),
  },
  tiktok: {
    icon: '♪', title: 'CONNECT TIKTOK', subtitle: 'TikTok account required',
    steps: [
      'A browser window will open',
      'Log into your <strong>TikTok account</strong>',
      'Click <strong>Authorize</strong> to allow access',
      'The tab will close — you\'re connected',
    ],
    continueLabel: 'Open TikTok Sign-In →',
    action: () => window.jarvis.connectorConnect('tiktok'),
  },
  analytics: {
    icon: '📈', title: 'CONNECT WEBSITE TRAFFIC', subtitle: 'Works with any website via Google Analytics',
    steps: [
      'Make sure <strong>Google Analytics</strong> is set up on your website (any website builder works)',
      'A browser window will open',
      'Sign in with the <strong>Google account</strong> that owns your Analytics property',
      'Click <strong>Allow</strong> — the tab will close and you\'re connected',
    ],
    continueLabel: 'Open Google Sign-In →',
    action: () => window.jarvis.connectorConnect('analytics'),
  },
  shopify: {
    icon: '🛍', title: 'CONNECT SHOPIFY', subtitle: 'Shopify store owner access required',
    steps: [
      'Log into your <strong>Shopify Admin</strong> at yourstore.myshopify.com/admin',
      'Go to <strong>Settings</strong> <span class="step-arrow">›</span> <strong>Apps and sales channels</strong> <span class="step-arrow">›</span> <strong>Develop apps</strong>',
      'Click <strong>Create an app</strong>, give it any name (e.g. Jarvis)',
      'Click <strong>Configure Admin API scopes</strong> — enable <em>read_orders</em> and <em>read_customers</em>',
      'Click <strong>Install app</strong> then copy the <strong>Admin API access token</strong>',
      'Paste the token and your store URL in the next screen',
    ],
    continueLabel: 'I Have My Token →',
    action: () => document.getElementById('shopifyModal').classList.remove('hidden'),
  },
  squarespace: {
    icon: '⬡', title: 'CONNECT SQUARESPACE', subtitle: 'Squarespace store owner access required',
    steps: [
      'Log into your <strong>Squarespace</strong> account',
      'Go to <strong>Settings</strong> <span class="step-arrow">›</span> <strong>Advanced</strong> <span class="step-arrow">›</span> <strong>API Keys</strong>',
      'Click <strong>Generate Key</strong>',
      'Under permissions, enable <em>Orders — Read</em>',
      'Copy the generated key and paste it in the next screen',
    ],
    continueLabel: 'I Have My Key →',
    action: () => document.getElementById('squarespaceModal').classList.remove('hidden'),
  },
  stripe: {
    icon: '💳', title: 'CONNECT REVENUE & PAYMENTS', subtitle: 'Works with any website that uses Stripe',
    steps: [
      'Log into your <strong>Stripe Dashboard</strong> at dashboard.stripe.com',
      'Click <strong>Developers</strong> in the top-right menu',
      'Click <strong>API Keys</strong> in the left sidebar',
      'Under <em>Secret key</em>, click <strong>Reveal live key</strong>',
      'Copy the key (starts with <em>sk_live_</em>) and paste it in the next screen',
    ],
    continueLabel: 'I Have My Key →',
    action: () => document.getElementById('stripeConnectModal').classList.remove('hidden'),
  },
};

let _stepsAction = null;

function showConnectSteps(service) {
  const cfg = CONNECT_STEPS[service];
  if (!cfg) { window.jarvis.connectorConnect(service); return; }

  document.getElementById('stepsModalIcon').textContent = cfg.icon;
  document.getElementById('stepsModalTitle').textContent = cfg.title;
  document.getElementById('stepsModalSubtitle').textContent = cfg.subtitle;
  document.getElementById('stepsModalContinueLabel').textContent = cfg.continueLabel;

  document.getElementById('stepsModalList').innerHTML = cfg.steps.map((text, i) =>
    `<div class="step-row">
      <div class="step-num">${i + 1}</div>
      <div class="step-text">${text}</div>
    </div>`
  ).join('');

  _stepsAction = cfg.action;
  document.getElementById('connectStepsModal').classList.remove('hidden');
}

document.getElementById('stepsModalCancel').addEventListener('click', () => {
  document.getElementById('connectStepsModal').classList.add('hidden');
  _stepsAction = null;
});

document.getElementById('stepsModalContinue').addEventListener('click', () => {
  document.getElementById('connectStepsModal').classList.add('hidden');
  if (_stepsAction) { _stepsAction(); _stepsAction = null; }
});

// ── Beam border animation ─────────────────────────────────────────────────────
(function () {
  const beamBoxes = new Map(); // el → rafId
  function startBeam(el) {
    if (!el || beamBoxes.has(el)) return;
    let angle = 40;
    let speed = 42; // deg/s idle
    const TARGET_IDLE = 42, TARGET_HOVER = 220;
    let targetSpeed = TARGET_IDLE;
    // mini spring on velocity
    let v = 0;
    const K = 30, D = 11;
    let last = 0;
    function frame(now) {
      if (!last) last = now;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const a = K * (targetSpeed - speed) - D * v;
      v += a * dt; speed += v * dt;
      angle = (angle + speed * dt) % 360;
      el.style.setProperty('--beam-a', angle.toFixed(2) + 'deg');
      beamBoxes.set(el, requestAnimationFrame(frame));
    }
    el.addEventListener('pointerenter', () => { targetSpeed = TARGET_HOVER; });
    el.addEventListener('pointerleave', () => { targetSpeed = TARGET_IDLE; });
    beamBoxes.set(el, requestAnimationFrame(frame));
  }
  function stopBeam(el) {
    if (!el) return;
    cancelAnimationFrame(beamBoxes.get(el));
    beamBoxes.delete(el);
  }
  // Observe modals becoming visible and wire up animation
  function watchModal(overlayId, boxId) {
    const overlay = document.getElementById(overlayId);
    const box     = document.getElementById(boxId);
    if (!overlay || !box) return;
    new MutationObserver(() => {
      if (!overlay.classList.contains('hidden')) startBeam(box);
      else stopBeam(box);
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }
  watchModal('stripeConnectModal',     'stripeConnectBox');
  watchModal('squarespaceModal',       'squarespaceConnectBox');
  watchModal('analyticsPropertyModal', 'analyticsPropertyBox');
}());

// ── Stripe modal ──────────────────────────────────────────────────────────────
function _hideStripeModal() {
  document.getElementById('stripeConnectModal').classList.add('hidden');
  document.getElementById('stripeKeyInput').value = '';
  document.getElementById('stripeModalError').classList.add('hidden');
}
document.getElementById('stripeModalCancel')?.addEventListener('click', _hideStripeModal);
document.getElementById('stripeModalCancelBtn')?.addEventListener('click', _hideStripeModal);
// Click backdrop to close
document.getElementById('stripeConnectModal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) _hideStripeModal();
});

document.getElementById('stripePwToggle')?.addEventListener('click', () => {
  const inp = document.getElementById('stripeKeyInput');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('stripeModalConnect')?.addEventListener('click', async () => {
  const key   = document.getElementById('stripeKeyInput').value.trim();
  const errEl = document.getElementById('stripeModalError');
  errEl.classList.add('hidden');
  if (!key) { errEl.textContent = 'Please paste your Stripe secret key.'; errEl.classList.remove('hidden'); return; }
  if (!key.startsWith('sk_')) { errEl.textContent = "Doesn't look right — key should start with sk_live_ or sk_test_."; errEl.classList.remove('hidden'); return; }
  const btn = document.getElementById('stripeModalConnect');
  btn.disabled = true; btn.textContent = 'Verifying…';
  const result = await window.jarvis.stripeConnect(key);
  btn.disabled = false; btn.textContent = 'CONNECT →';
  if (result.ok) {
    _hideStripeModal();
    renderConnectors();
    const name = result.accountName ? ` (${result.accountName})` : '';
    addMessage('assistant', `Stripe${name} connected! Ask me "how much revenue did I make this month?" or "show me my recent payments".`);
  } else {
    errEl.textContent = result.error || 'Connection failed — check your secret key.';
    errEl.classList.remove('hidden');
  }
});

// ── Squarespace modal ─────────────────────────────────────────────────────────
function _hideSquarespaceModal() {
  document.getElementById('squarespaceModal').classList.add('hidden');
  document.getElementById('squarespaceKeyInput').value = '';
  document.getElementById('squarespaceModalError').classList.add('hidden');
}
document.getElementById('squarespaceModalCancel')?.addEventListener('click', _hideSquarespaceModal);
document.getElementById('squarespaceModalCancelBtn')?.addEventListener('click', _hideSquarespaceModal);
document.getElementById('squarespaceModal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) _hideSquarespaceModal();
});

// Squarespace show/hide key toggle
document.getElementById('squarespacePwToggle')?.addEventListener('click', () => {
  const inp = document.getElementById('squarespaceKeyInput');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('squarespaceModalConnect')?.addEventListener('click', async () => {
  const key   = document.getElementById('squarespaceKeyInput').value.trim();
  const errEl = document.getElementById('squarespaceModalError');
  errEl.classList.add('hidden');
  if (!key) { errEl.textContent = 'Please paste your API key.'; errEl.classList.remove('hidden'); return; }
  const btn = document.getElementById('squarespaceModalConnect');
  btn.disabled = true; btn.textContent = 'Verifying…';
  const result = await window.jarvis.squarespaceConnect(key);
  btn.disabled = false; btn.textContent = 'CONNECT →';
  if (result.ok) {
    _hideSquarespaceModal();
    renderConnectors();
    addMessage('assistant', "Squarespace connected! Ask me \"how many orders did I get this month?\" or \"what's my revenue?\"");
  } else {
    errEl.textContent = result.error || 'Connection failed — check your API key.';
    errEl.classList.remove('hidden');
  }
});

// ── Google Analytics — property picker ───────────────────────────────────────
let _analyticsProperties = [];
let _selectedPropertyId  = null;

function _hideAnalyticsPropertyModal() {
  document.getElementById('analyticsPropertyModal').classList.add('hidden');
  _analyticsProperties = [];
  _selectedPropertyId  = null;
}

function showAnalyticsPropertyPicker(properties) {
  _analyticsProperties = properties || [];
  _selectedPropertyId  = _analyticsProperties[0]?.id || null;

  const list = document.getElementById('analyticsPropertyList');
  if (!_analyticsProperties.length) {
    list.innerHTML = '<div style="color:rgba(255,100,100,0.8);font-size:11px;text-align:center;padding:16px">No GA4 properties found on this account.</div>';
  } else {
    list.innerHTML = _analyticsProperties.map((p, i) => `
      <label class="conn-prop-item${i === 0 ? ' selected' : ''}" data-pid="${p.id}">
        <input type="radio" name="ga4prop" value="${p.id}" ${i === 0 ? 'checked' : ''} />
        <div>
          <div class="conn-prop-name">${p.displayName}</div>
          <div class="conn-prop-id">Property ${p.id} · ${p.websiteUrl || ''}</div>
        </div>
      </label>
    `).join('');
    list.querySelectorAll('.conn-prop-item').forEach(el => {
      el.addEventListener('click', () => {
        list.querySelectorAll('.conn-prop-item').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        _selectedPropertyId = el.dataset.pid;
        const radio = el.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
      });
    });
  }

  document.getElementById('analyticsPropertyModal').classList.remove('hidden');
}

document.getElementById('analyticsPropertyCancel')?.addEventListener('click', _hideAnalyticsPropertyModal);
document.getElementById('analyticsPropertyCancelBtn')?.addEventListener('click', _hideAnalyticsPropertyModal);
document.getElementById('analyticsPropertyModal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) _hideAnalyticsPropertyModal();
});

document.getElementById('analyticsPropertyConfirm')?.addEventListener('click', async () => {
  if (!_selectedPropertyId) return;
  const btn = document.getElementById('analyticsPropertyConfirm');
  btn.disabled = true; btn.textContent = 'Connecting…';
  const result = await window.jarvis.analyticsSelectProperty(_selectedPropertyId);
  btn.disabled = false; btn.textContent = 'CONNECT →';
  if (result?.ok) {
    _hideAnalyticsPropertyModal();
    renderConnectors();
    const prop = _analyticsProperties.find(p => p.id === _selectedPropertyId);
    addMessage('assistant', `Google Analytics connected for "${prop?.displayName || 'your site'}"! Ask me "how many visitors did I get this month?" or "show me my top pages".`);
  }
});

document.getElementById('shopifyModalCancel')?.addEventListener('click', () => {
  document.getElementById('shopifyModal').classList.add('hidden');
});

document.getElementById('shopifyModalConnect')?.addEventListener('click', async () => {
  const shop = document.getElementById('shopifyStoreInput').value.trim();
  const token = document.getElementById('shopifyTokenInput').value.trim();
  const errEl = document.getElementById('shopifyModalError');
  errEl.classList.add('hidden');
  if (!shop || !token) { errEl.textContent = 'Please fill in both fields.'; errEl.classList.remove('hidden'); return; }
  if (!token.startsWith('shpat_')) { errEl.textContent = 'Token should start with shpat_ — make sure you copied the Admin API access token, not a password.'; errEl.classList.remove('hidden'); return; }
  const btn = document.getElementById('shopifyModalConnect');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Connecting...';
  const result = await window.jarvis.shopifyConnect(shop, token);
  btn.disabled = false;
  btn.querySelector('span').textContent = 'Connect →';
  if (result.ok) {
    document.getElementById('shopifyModal').classList.add('hidden');
    document.getElementById('shopifyStoreInput').value = '';
    document.getElementById('shopifyTokenInput').value = '';
    renderConnectors();
    addMessage('assistant', `"${result.shopName}" is connected! Ask me "how are my sales this month?" or "how many orders came in this week?"`);
  } else {
    errEl.textContent = result.error || 'Connection failed. Check your store URL and token.';
    errEl.classList.remove('hidden');
  }
});

// Patch renderConnectors to also render music + analytics sections
const _origRenderConnectors = renderConnectors;
renderConnectors = async function() {
  const status = await _origRenderConnectors();
  const s = await window.jarvis.connectorStatus();
  renderMusicService(s);
  renderAnalyticsConnectors(s);
};

connectorsClose?.addEventListener('click', () => historySidebar.classList.add('hidden'));

// ===================== LANGUAGE PANEL =====================
const LANGUAGES = [
  'Afrikaans','Albanian','Amharic','Arabic','Armenian','Azerbaijani',
  'Basque','Belarusian','Bengali','Bosnian','Bulgarian',
  'Catalan','Cebuano','Chinese (Simplified)','Chinese (Traditional)','Corsican','Croatian','Czech',
  'Danish','Dutch',
  'English','Esperanto','Estonian',
  'Finnish','French','Frisian',
  'Galician','Georgian','German','Greek','Gujarati',
  'Haitian Creole','Hausa','Hawaiian','Hebrew','Hindi','Hmong','Hungarian',
  'Icelandic','Igbo','Indonesian','Irish','Italian',
  'Japanese','Javanese',
  'Kannada','Kazakh','Khmer','Kinyarwanda','Korean','Kurdish','Kyrgyz',
  'Lao','Latin','Latvian','Lithuanian','Luxembourgish',
  'Macedonian','Malagasy','Malay','Malayalam','Maltese','Maori','Marathi','Mongolian','Myanmar (Burmese)',
  'Nepali','Norwegian',
  'Nyanja (Chichewa)',
  'Odia (Oriya)',
  'Pashto','Persian','Polish','Portuguese','Punjabi',
  'Romanian','Russian',
  'Samoan','Scots Gaelic','Serbian','Sesotho','Shona','Sindhi','Sinhala','Slovak','Slovenian','Somali','Spanish','Sundanese','Swahili','Swedish',
  'Tagalog (Filipino)','Tajik','Tamil','Tatar','Telugu','Thai','Turkish','Turkmen',
  'Ukrainian','Urdu','Uyghur','Uzbek',
  'Vietnamese',
  'Welsh',
  'Xhosa',
  'Yiddish','Yoruba',
  'Zulu',
];

const languageBtn = { addEventListener: () => {} }; // dock button removed — handled by rail
const languageSearch = document.getElementById('languageSearch');
const languageListEl = document.getElementById('languageList');

function renderLanguageList(filter = '') {
  const current = window.jarvis.getLanguage();
  const filtered = filter
    ? LANGUAGES.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
    : LANGUAGES;
  languageListEl.innerHTML = filtered.map(lang => `
    <div class="lang-row ${lang === current ? 'active' : ''}" data-lang="${lang}">
      <span>${lang}</span>
      <span class="lang-check">✓</span>
    </div>
  `).join('');
  languageListEl.querySelectorAll('.lang-row').forEach(row => {
    row.addEventListener('click', () => {
      window.jarvis.setLanguage(row.dataset.lang);
      renderLanguageList(languageSearch.value);
    });
  });
}

languageSearch?.addEventListener('input', () => renderLanguageList(languageSearch.value));

// Listen for successful connector OAuth callback
window.jarvis.onConnectorConnected(({ service }) => {
  renderConnectors();
  const connectedMessages = {
    gmail:    'Gmail connected. Say "give me an update" to check your emails.',
    outlook:  'Outlook connected. Say "give me an update" to check your emails.',
    drive:    'Google Drive connected. Say "create me a document about X" or "open my files" to get started.',
    calendar: 'Google Calendar connected. Say "what\'s on my schedule" to see your events.',
    spotify:  'Spotify connected. Say "play some music" to get started.',
    youtube:  'YouTube connected. Say "show me my channel stats" to see your analytics.',
    instagram:'Instagram connected. Say "show me my analytics" to see your reach and followers.',
    tiktok:   'TikTok connected. Say "show me my TikTok stats" to see your performance.',
    analytics:'Google Analytics connected. Say "how many visitors did I get this month?" to see your traffic and revenue.',
  };
  const name = service.charAt(0).toUpperCase() + service.slice(1);
  const msg  = connectedMessages[service] || `${name} connected successfully.`;
  addMessage('assistant', msg);
});

// Show GA4 property picker after OAuth completes
window.jarvis.onAnalyticsShowPropertyPicker && window.jarvis.onAnalyticsShowPropertyPicker(({ properties }) => {
  showAnalyticsPropertyPicker(properties);
});

// ===================== SETTINGS PANE =====================
const profileBtn = { addEventListener: () => {} }; // dock button removed — handled by rail
const profilePanel = null;
const profileClose = null;

async function loadSettingsPane() {
  const [savedProfile, authResult, sessions] = await Promise.all([
    window.jarvis.getProfile(),
    window.jarvis.authVerify(),
    window.jarvis.listSessions(),
  ]);

  const name = savedProfile?.name || profile?.name || 'USER';
  const email = savedProfile?.email || profile?.email || '';
  const since = savedProfile?.createdAt
    ? new Date(savedProfile.createdAt).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
    : authResult?.user?.createdAt
      ? new Date(authResult.user.createdAt).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'N/A';
  const isActive = authResult?.active;

  document.getElementById('profileName').textContent = name.toUpperCase();
  document.getElementById('profileEmail').textContent = email;
  document.getElementById('profileSince').textContent = since;

  // Keep orb name in sync with saved profile name
  const aiNameEl = document.getElementById('aiName');
  if (aiNameEl && name && name !== 'USER') aiNameEl.textContent = name.toUpperCase();

  // Name edit
  const nameInput = document.getElementById('profileNameInput');
  const nameSaveBtn = document.getElementById('profileNameSaveBtn');
  if (nameInput) nameInput.value = savedProfile?.name || profile?.name || '';
  if (nameSaveBtn) {
    const freshSave = nameSaveBtn.cloneNode(true);
    nameSaveBtn.parentNode.replaceChild(freshSave, nameSaveBtn);
    freshSave.addEventListener('click', async () => {
      const newName = document.getElementById('profileNameInput')?.value?.trim();
      if (!newName) return;

      // Merge with existing profile so we don't wipe email etc.
      const existing = await window.jarvis.getProfile() || {};
      await window.jarvis.setProfile({ ...existing, name: newName });

      // Update orb name + account header instantly
      document.getElementById('profileName').textContent = newName.toUpperCase();
      const aiNameEl = document.getElementById('aiName');
      if (aiNameEl) aiNameEl.textContent = newName.toUpperCase();

      freshSave.textContent = 'SAVED ✓';
      setTimeout(() => { freshSave.textContent = 'SAVE'; }, 1800);

      historySidebar?.classList.add('hidden');
    });
  }

  const subEl = document.getElementById('profileSub');
  if (isActive) {
    subEl.textContent = '✓ ACTIVE — $20/month';
    subEl.className = 'profile-value profile-sub-active';
  } else {
    subEl.textContent = '✗ NOT SUBSCRIBED';
    subEl.className = 'profile-value profile-sub-inactive';
  }

  // profileHistoryList removed from account pane — history lives in Chat History tab

  // Location toggle
  const locToggle = document.getElementById('locationToggleBtn');
  if (locToggle) {
    const enabled = WeatherWidget.isEnabled();
    locToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    // Remove any previous listener by cloning
    const fresh = locToggle.cloneNode(true);
    locToggle.parentNode.replaceChild(fresh, locToggle);
    fresh.addEventListener('click', () => {
      const nowOn = fresh.getAttribute('aria-pressed') !== 'true';
      fresh.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
      WeatherWidget.setEnabled(nowOn);
    });
  }

  const locCountryLabel = document.getElementById('profileCountryLabel');
  if (locCountryLabel) {
    locCountryLabel.textContent = localStorage.getItem('userCountry') || '—';
  }
}

// Settings sub-tabs
document.getElementById('settingsTabAccount')?.addEventListener('click', () => {
  document.getElementById('settingsAccountContent')?.classList.remove('hidden');
  document.getElementById('settingsLanguageContent')?.classList.add('hidden');
  document.getElementById('settingsTabAccount')?.classList.add('active');
  document.getElementById('settingsTabLanguage')?.classList.remove('active');
});
document.getElementById('settingsTabLanguage')?.addEventListener('click', () => {
  document.getElementById('settingsAccountContent')?.classList.add('hidden');
  document.getElementById('settingsLanguageContent')?.classList.remove('hidden');
  document.getElementById('settingsTabLanguage')?.classList.add('active');
  document.getElementById('settingsTabAccount')?.classList.remove('active');
  if (languageSearch) languageSearch.value = '';
  renderLanguageList();
  setTimeout(() => {
    const active = languageListEl?.querySelector('.lang-row.active');
    if (active) active.scrollIntoView({ block: 'center' });
  }, 50);
});

document.getElementById('profileLogout')?.addEventListener('click', async () => {
  await window.jarvis.authLogout();
  historySidebar.classList.add('hidden');
  mainView.classList.add('hidden');
  setupView.classList.remove('hidden');
  showAuthStep();
  setAuthMode('login');
});


// ===================== VOICE SPEED =====================
(async () => {
  const saved = await window.jarvis.getVoiceSpeed();
  voiceSpeedSlider.value = saved;
  voiceSpeedVal.textContent = parseFloat(saved).toFixed(2) + 'x';
})();

voiceSpeedSlider.addEventListener('input', () => {
  const val = parseFloat(voiceSpeedSlider.value);
  voiceSpeedVal.textContent = val.toFixed(2) + 'x';
});
voiceSpeedSlider.addEventListener('change', async () => {
  const val = parseFloat(voiceSpeedSlider.value);
  await window.jarvis.setVoiceSpeed(val);
});

// ===================== VOICE VOLUME =====================
const voiceVolumeSlider = document.getElementById('voiceVolumeSlider');
const voiceVolumeVal = document.getElementById('voiceVolumeVal');

const savedVol = parseFloat(localStorage.getItem('voiceVolume') || '1.5');
voiceVolumeSlider.value = savedVol;
voiceVolumeVal.textContent = savedVol.toFixed(1) + 'x';
voiceVolume = savedVol;

voiceVolumeSlider.addEventListener('input', () => {
  const val = parseFloat(voiceVolumeSlider.value);
  voiceVolumeVal.textContent = val.toFixed(1) + 'x';
  voiceVolume = val;
  localStorage.setItem('voiceVolume', val);
  const pv = document.getElementById('profileVolSlider');
  if (pv) { pv.value = val; document.getElementById('profileVolVal').textContent = val.toFixed(1) + 'x'; }
});

// ── Profile panel sliders (sync with main sliders) ──
(async () => {
  const profileSpeedSlider = document.getElementById('profileSpeedSlider');
  const profileSpeedVal    = document.getElementById('profileSpeedVal');
  const profileVolSlider   = document.getElementById('profileVolSlider');
  const profileVolVal      = document.getElementById('profileVolVal');
  if (!profileSpeedSlider) return;

  // Init values from saved settings
  const savedSpeed = await window.jarvis.getVoiceSpeed();
  profileSpeedSlider.value = savedSpeed;
  profileSpeedVal.textContent = parseFloat(savedSpeed).toFixed(2) + 'x';
  profileVolSlider.value = savedVol;
  profileVolVal.textContent = savedVol.toFixed(1) + 'x';

  profileSpeedSlider.addEventListener('input', () => {
    const val = parseFloat(profileSpeedSlider.value);
    profileSpeedVal.textContent = val.toFixed(2) + 'x';
    voiceSpeedSlider.value = val;
    voiceSpeedVal.textContent = val.toFixed(2) + 'x';
  });
  profileSpeedSlider.addEventListener('change', async () => {
    await window.jarvis.setVoiceSpeed(parseFloat(profileSpeedSlider.value));
  });

  profileVolSlider.addEventListener('input', () => {
    const val = parseFloat(profileVolSlider.value);
    profileVolVal.textContent = val.toFixed(1) + 'x';
    voiceVolumeSlider.value = val;
    voiceVolumeVal.textContent = val.toFixed(1) + 'x';
    voiceVolume = val;
    localStorage.setItem('voiceVolume', val);
  });

  // Voice type toggle in account panel
  const savedVoicePref = (await window.jarvis.getProfile())?.voice || 'male';
  const pvMale   = document.getElementById('profileVoiceMale');
  const pvFemale = document.getElementById('profileVoiceFemale');
  function applyVoicePref(pref) {
    if (pref === 'female') {
      pvFemale?.classList.add('active');
      pvMale?.classList.remove('active');
    } else {
      pvMale?.classList.add('active');
      pvFemale?.classList.remove('active');
    }
  }
  applyVoicePref(savedVoicePref);
  [pvMale, pvFemale].forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const pref = btn.dataset.voice;
      applyVoicePref(pref);
      const p = await window.jarvis.getProfile() || {};
      p.voice = pref;
      await window.jarvis.setProfile(p);
    });
  });
})();

window.jarvis.onActivated(async ({ name, profile: storedProfile, returningUser }) => {
  profile = storedProfile;
  history = [];
  const _isReturningUser = !!returningUser;
  mainView.classList.add('hidden');
  setupView.classList.add('hidden');
  cardPanel.classList.add('hidden');
  historySidebar.classList.add('hidden');
  splash.classList.add('hidden');

  // Check auth token
  const authResult = await window.jarvis.authVerify();

  if (authResult.offline) {
    // Server unreachable — only allow in if they previously had an active subscription
    if (storedProfile && storedProfile.name && storedProfile.wasSubscribed) {
      await showSplash(storedProfile.name);
      await enterMain(true, _isReturningUser);
    } else {
      setupView.classList.remove('hidden');
      showNameStep();
    }
    return;
  }

  if (authResult.needsLogin) {
    setupView.classList.remove('hidden');
    if (authResult.reason === 'inactive') {
      // 7-day inactivity — show re-login
      showReloginStep('You\'ve been away for a while. Please log in to continue.');
    } else {
      // First time or returning without token — always show auth first
      showAuthStep();
      setAuthMode('signup');
    }
    return;
  }

  // Token valid — check subscription before entering
  const displayName = storedProfile?.name || authResult.user?.name || 'Your AI';
  profile = {
    name:        displayName,
    email:       authResult.user?.email || storedProfile?.email,
    displayName: storedProfile?.displayName || null,
    title:       storedProfile?.title || null,
    wasSubscribed: storedProfile?.wasSubscribed || false,
  };
  if (authResult.active) {
    await showSplash(displayName);
    await enterMain(true, _isReturningUser);
  } else {
    setupView.classList.remove('hidden');
    showTermsOrPayment();
  }
});

// ===================== RECORDING =====================
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  return btoa(binary);
}

function downsampleTo16k(pcmFloat32, fromRate) {
  const TARGET = 16000;
  if (fromRate === TARGET) return pcmFloat32;
  const ratio = fromRate / TARGET;
  const outLen = Math.floor(pcmFloat32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end   = Math.min(Math.floor((i + 1) * ratio), pcmFloat32.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += pcmFloat32[j];
    out[i] = sum / (end - start);
  }
  return out;
}

function encodeWav(pcmFloat32, sampleRate) {
  const pcm = downsampleTo16k(pcmFloat32, sampleRate);
  const outRate = 16000;
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

let analyserNode = null;
let waveformRaf = null;
const waveformCanvas = document.getElementById('waveformCanvas');
const waveCtx = waveformCanvas ? waveformCanvas.getContext('2d') : null;

// Particle field behind waveform
(function initWaveParticles() {
  if (!waveformCanvas) return;
  const W = waveformCanvas.width, H = waveformCanvas.height;
  const NUM = 28;
  const particles = Array.from({ length: NUM }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    r: 0.6 + Math.random() * 1.2,
    vx: (Math.random() - 0.5) * 0.18,
    vy: (Math.random() - 0.5) * 0.12,
    alpha: 0.18 + Math.random() * 0.32,
    hue: Math.random() < 0.6 ? 210 : 190,
  }));

  function tickParticles() {
    requestAnimationFrame(tickParticles);
    // Draw particles first (under waveform bars)
    // We use a separate offscreen approach: draw on main canvas only when waveform is idle
    if (waveformRaf) return; // waveform is active — it handles its own clear/draw cycle

    const ctx = waveCtx;
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < -2) p.x = W + 2;
      if (p.x > W + 2) p.x = -2;
      if (p.y < -2) p.y = H + 2;
      if (p.y > H + 2) p.y = -2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 90%, 70%, ${p.alpha})`;
      ctx.fill();
    }
  }
  tickParticles();

  // Expose particles array so waveform draw can render them underneath
  waveformCanvas._particles = particles;
})();

function startWaveformDraw() {
  if (!analyserNode || !waveCtx) return;
  const bufLen = analyserNode.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);
  const W = waveformCanvas.width, H = waveformCanvas.height;
  const barCount = 36;
  function draw() {
    waveformRaf = requestAnimationFrame(draw);
    analyserNode.getByteFrequencyData(dataArr);
    // export peak amplitude for the orb shader
    let peak = 0;
    for (let k = 0; k < bufLen; k++) if (dataArr[k] > peak) peak = dataArr[k];
    window._orbAmp = peak / 255;
    waveCtx.clearRect(0, 0, W, H);
    // Draw particles behind bars
    const pts = waveformCanvas._particles;
    if (pts) {
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -2) p.x = W + 2; if (p.x > W + 2) p.x = -2;
        if (p.y < -2) p.y = H + 2; if (p.y > H + 2) p.y = -2;
        waveCtx.beginPath();
        waveCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        waveCtx.fillStyle = `hsla(${p.hue}, 90%, 70%, ${p.alpha * (0.5 + window._orbAmp * 1.5)})`;
        waveCtx.fill();
      }
    }
    const barW = (W / barCount) - 2;
    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor(i * bufLen / barCount / 3);
      const amp = dataArr[idx] / 255;
      const barH = Math.max(3, amp * H * 0.9);
      const x = i * (barW + 2);
      const alpha = 0.4 + amp * 0.6;
      waveCtx.fillStyle = `rgba(0, ${Math.floor(180 + amp * 75)}, 255, ${alpha})`;
      const r = barW / 2;
      waveCtx.beginPath();
      waveCtx.roundRect(x, (H - barH) / 2, barW, barH, r);
      waveCtx.fill();
    }
  }
  draw();
}

function stopWaveformDraw() {
  if (waveformRaf) { cancelAnimationFrame(waveformRaf); waveformRaf = null; }
  if (waveCtx && waveformCanvas) waveCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  if (waveformCanvas) waveformCanvas.classList.remove('active');
}

// ── Mic: keep stream + AudioContext alive between recordings for zero-latency start ──
let micInitialised = false;
let micInitPromise = null;

async function initMicOnce() {
  if (micInitialised && currentStream?.active && audioContext?.state !== 'closed') return true;
  if (micInitPromise) return micInitPromise;
  micInitPromise = (async () => {
    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          sampleRate:       16000,  // Whisper is optimised for 16 kHz
          channelCount:     1,
        }
      });
      audioContext  = new AudioContext({ sampleRate: 16000 });
      await audioContext.resume();
      micInitialised = true;
      return true;
    } catch (err) {
      console.error('[MIC] init error:', err);
      micInitialised = false;
      return false;
    } finally {
      micInitPromise = null;
    }
  })();
  return micInitPromise;
}

// Pre-warm on hover so first press is instant
micBtn.addEventListener('mouseenter', () => { initMicOnce().catch(() => {}); });

async function startRecording() {
  isRecording = true;
  setState('listening');
  if (waveformCanvas) waveformCanvas.classList.add('active');
  pcmChunks = [];

  try {
    const ok = await initMicOnce();
    if (!ok) throw new Error('Microphone access denied');

    // Build fresh nodes each recording (nodes can't be reused after disconnect)
    sourceNode   = audioContext.createMediaStreamSource(currentStream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    sourceNode.connect(analyserNode);
    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);
    startWaveformDraw();
  } catch (err) {
    const errMsg = err.name === 'NotAllowedError' ? 'Microphone permission denied. Please allow mic access and try again.'
                 : err.name === 'NotFoundError'   ? 'No microphone found. Please connect a mic and try again.'
                 : `Mic error: ${err.name || err.message}`;
    addMessage('assistant', errMsg);
    console.error('[MIC] startRecording error:', err.name, err.message);
    isRecording = false;
    setState('idle');
    if (waveformCanvas) waveformCanvas.classList.remove('active');
  }
}

async function stopRecording() {
  isRecording = false;
  stopWaveformDraw();

  if (!audioContext) {
    setState('idle');
    if (waveformCanvas) waveformCanvas.classList.remove('active');
    return;
  }

  // Disconnect nodes but keep stream + AudioContext alive for next recording
  if (processorNode) { processorNode.disconnect(); processorNode = null; }
  if (sourceNode)    { sourceNode.disconnect();    sourceNode    = null; }
  if (analyserNode)  { analyserNode.disconnect();  analyserNode  = null; }

  const sampleRate = audioContext.sampleRate;
  const capturedChunks = pcmChunks.splice(0);

  setState('thinking');
  try {
    const totalLength = capturedChunks.reduce((s, c) => s + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of capturedChunks) { merged.set(chunk, offset); offset += chunk.length; }
    const peak = merged.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    console.log('[MIC] chunks:', capturedChunks.length, 'samples:', totalLength, 'peak:', peak, 'sampleRate:', sampleRate);

    if (peak < 0.0001) {
      addMessage('assistant', 'I didn\'t catch that — please check your microphone and try again.');
      setState('idle');
      return;
    }

    const wavBlob = encodeWav(merged, sampleRate);
    const arrayBuffer = await wavBlob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const text = await window.jarvis.transcribe(base64);
    console.log('[MIC] transcribed:', text);
    if (text && text.trim().length > 1) {
      await sendToJarvis(text.trim());
    } else {
      addMessage('assistant', "I didn't catch that — could you try speaking again?");
      setState('idle');
    }
  } catch (err) {
    const msg = (err.message || '').replace(/^Error invoking remote method '[^']+': /, '');
    addMessage('assistant', msg || 'Could not understand audio. Please try again.');
    setState('idle');
  }
}

micBtn.addEventListener('click', () => {
  debugFlash('MIC TAP');
  if (isRecording) stopRecording();
  else startRecording();
});

// ── Typing mode toggle ────────────────────────────────────────────────────────
(function initTypingMode() {
  const toggleBtn    = document.getElementById('typeModeToggle');  // "SHIFT TO TYPING" (voice mode)
  const typeVoiceBtn = document.getElementById('typeVoiceBtn');     // "SHIFT TO VOICE" (inside typing panel)
  const typeWrap     = document.getElementById('typeInputWrap');
  const typeBoxBorder= document.getElementById('typeBoxBorder');
  const userInput    = document.getElementById('userInput');
  const typeSendBtn  = document.getElementById('typeSendBtn');
  const micControls  = document.getElementById('micWrap');
  const attachWrap   = document.getElementById('attachWrap');
  const clearWrap    = document.getElementById('clearWrap');
  const waveCanvas   = document.getElementById('waveformCanvas');
  if (!toggleBtn || !typeWrap || !userInput) return;

  // Auto-resize textarea + orb compact on typing
  function resizeInput() {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
  }
  userInput.addEventListener('input', () => {
    resizeInput();
    if (userInput.value.trim()) orbContainer.classList.add('compact');
    else if (!chat.children.length) orbContainer.classList.remove('compact');
  });

  function enterTypingMode() {
    if (isRecording) stopRecording();
    micControls?.classList.add('hidden');
    attachWrap?.classList.add('hidden');
    clearWrap?.classList.add('hidden');
    waveCanvas?.classList.add('hidden');
    micLabel?.classList.add('hidden');
    toggleBtn.classList.add('hidden');           // hide the "SHIFT TO TYPING" button
    typeWrap.classList.remove('hidden');
    typeWrap.style.display = 'block';
    userInput.focus();
  }

  function enterVoiceMode() {
    micControls?.classList.remove('hidden');
    attachWrap?.classList.remove('hidden');
    clearWrap?.classList.remove('hidden');
    waveCanvas?.classList.remove('hidden');
    micLabel?.classList.remove('hidden');
    toggleBtn.classList.remove('hidden');        // show the "SHIFT TO TYPING" button again
    typeWrap.classList.add('hidden');
    typeWrap.style.display = 'none';
    // Reset textarea height
    userInput.style.height = '58px';
    userInput.value = '';
  }

  toggleBtn.addEventListener('click', enterTypingMode);
  typeVoiceBtn?.addEventListener('click', enterVoiceMode);

  async function sendTyped() {
    const text = userInput.value.trim();
    if (!text) return;
    userInput.value = '';
    userInput.style.height = '58px';
    await sendToJarvis(text);
  }

  typeSendBtn?.addEventListener('click', sendTyped);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTyped(); }
  });

  // Focus/hover styles — cyan theme to match new input
  userInput.addEventListener('focus', () => { if (typeBoxBorder) { typeBoxBorder.style.borderColor = 'rgba(0,180,255,0.5)'; typeBoxBorder.style.boxShadow = '0 0 12px rgba(0,180,255,0.15)'; } });
  userInput.addEventListener('blur',  () => { if (typeBoxBorder) { typeBoxBorder.style.borderColor = 'rgba(0,160,220,0.25)'; typeBoxBorder.style.boxShadow = 'none'; } });
  typeSendBtn?.addEventListener('mouseenter', () => { typeSendBtn.style.background = 'rgba(0,190,255,0.95)'; typeSendBtn.style.transform = 'scale(1.08)'; typeSendBtn.style.boxShadow = '0 0 16px rgba(0,200,255,0.5)'; });
  typeSendBtn?.addEventListener('mouseleave', () => { typeSendBtn.style.background = 'rgba(0,160,220,0.8)'; typeSendBtn.style.transform = 'scale(1)'; typeSendBtn.style.boxShadow = '0 0 10px rgba(0,180,255,0.3)'; });

  // Stop response button
  const stopResponseBtn = document.getElementById('stopResponseBtn');
  stopResponseBtn?.addEventListener('click', () => {
    showStopBtn(false);
    setState('idle');
    addMessage('assistant', 'Stopped.');
  });
  stopResponseBtn?.addEventListener('mouseenter', () => { if (stopResponseBtn) stopResponseBtn.style.background = 'rgba(200,40,60,0.3)'; });
  stopResponseBtn?.addEventListener('mouseleave', () => { if (stopResponseBtn) stopResponseBtn.style.background = 'rgba(180,40,60,0.18)'; });
}());

// ── Orb mouse tilt ───────────────────────────────────────────────────────────
(function initOrbTilt() {
  const orbEl = document.getElementById('orb');
  if (!orbEl) return;

  // Smooth lerp targets
  let txTarget = 0, tyTarget = 0, tx = 0, ty = 0;
  let rafId = null;

  function lerp(a, b, t) { return a + (b - a) * t; }

  function tick() {
    tx = lerp(tx, txTarget, 0.18);
    ty = lerp(ty, tyTarget, 0.18);
    const scale = 1 + Math.sqrt(txTarget * txTarget + tyTarget * tyTarget) * 0.012;
    orbEl.style.transform =
      `perspective(260px) rotateY(${tx}deg) rotateX(${-ty}deg) scale(${scale})`;
    rafId = requestAnimationFrame(tick);
  }
  tick();

  document.addEventListener('mousemove', (e) => {
    const rect = orbEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // orb not yet visible — skip to avoid NaN
    // Reset if NaN leaked in from an earlier hidden state
    if (!isFinite(tx)) { tx = 0; txTarget = 0; }
    if (!isFinite(ty)) { ty = 0; tyTarget = 0; }
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const r  = rect.width / 2;
    const nx = (e.clientX - cx) / r;
    const ny = (e.clientY - cy) / r;
    const dist = Math.sqrt(nx * nx + ny * ny);
    const proximity = Math.max(0, 1 - dist / 2.2);
    txTarget = nx * 22 * proximity;
    tyTarget = ny * 22 * proximity;
  });
})();

// ===================== SWEEP BEAM — connector rows (staggered) =====================
(function initConnectorBeams() {
  const rows = document.querySelectorAll('.connector-row');
  // Spread delays evenly across the 2s animation cycle so beams fire at different times
  const total = rows.length || 1;
  rows.forEach((row, i) => {
    const delay = -((i / total) * 2).toFixed(2); // negative = start mid-cycle, staggered
    row.style.setProperty('--beam-delay', `${delay}s`);
  });
})();
