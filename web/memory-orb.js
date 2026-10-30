// The memory orb: everything Callisto remembers about the person, orbiting a
// particle globe, with a panel beside it to search, add and remove memories.
// Opened from Account → MEMORY. Facts are plain strings kept by main.js
// (store 'memories', synced to the cloud), so this only reads and edits that.
(function () {
  'use strict';

  // Rough sorting so the orbit reads as a picture of a life, not a list.
  const KINDS = [
    { id: 'people', label: 'People', colour: '#f472b6', re: /\b(girlfriend|boyfriend|wife|husband|partner|mum|mom|dad|father|mother|brother|sister|son|daughter|friend|kids?|family|name is)\b/i },
    { id: 'work', label: 'Work', colour: '#3aa9ff', re: /\b(business|company|brand|startup|client|customers?|revenue|sales|job|work|boss|team|launch|product|shop|store|app|website|marketing|instagram|tiktok)\b/i },
    { id: 'food', label: 'Food & places', colour: '#f59e0b', re: /\b(food|eat|eats|likes? .*(pizza|sushi|curry|burger|coffee|tea)|restaurant|cafe|dish|favourite place|favorite place|travel|holiday|city|lives in|from|visit)\b/i },
    { id: 'sport', label: 'Sport', colour: '#10b981', re: /\b(football|soccer|cricket|basketball|nba|nfl|f1|formula|tennis|gym|team|match|supports?|fan of|golf|boxing|ufc)\b/i },
    { id: 'life', label: 'Life', colour: '#a78bfa', re: /\b(birthday|anniversary|wedding|moved|moving|baby|pregnant|graduat|exam|uni|school|health|hospital|holiday|trip|engaged)\b/i },
  ];
  const OTHER = { id: 'other', label: 'Other', colour: '#9fb4d8' };
  const kindOf = (fact) => KINDS.find((k) => k.re.test(fact)) || OTHER;

  const STYLE = `
  #memOrb{position:fixed;inset:0;z-index:2147483000;display:flex;background:rgba(2,4,10,.78);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);opacity:0;transition:opacity .28s ease;font-family:inherit;color:#dce6fa}
  #memOrb.open{opacity:1}
  #memOrb .mo-stage{position:relative;flex:1;min-width:0;overflow:hidden}
  #memOrb canvas{position:absolute;inset:0;width:100%;height:100%}#memOrb .mo-fx{opacity:.75}
  #memOrb .mo-ring{position:absolute;border:1px solid rgba(110,160,255,.14);border-radius:50%;pointer-events:none}
  #memOrb .mo-chip{position:absolute;left:0;top:0;max-width:190px;padding:7px 12px;border-radius:999px;font-size:12px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:rgba(8,14,32,.86);border:1px solid var(--k);box-shadow:0 0 14px color-mix(in srgb,var(--k) 35%,transparent);cursor:pointer;transition:max-width .2s ease,background .2s ease;will-change:transform}
  #memOrb .mo-chip:hover,#memOrb .mo-chip.hot{max-width:340px;white-space:normal;background:rgba(14,24,52,.97);z-index:5}
  #memOrb .mo-chip i{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--k);margin-right:7px;vertical-align:1px}
  #memOrb .mo-title{position:absolute;left:28px;top:22px;letter-spacing:.22em;font-size:11px;color:rgba(160,190,240,.7)}
  #memOrb .mo-title b{display:block;font-size:22px;letter-spacing:.04em;color:#eef4ff;font-weight:600;margin-top:4px}
  #memOrb .mo-empty{position:absolute;left:50%;top:50%;transform:translate(-50%,120px);text-align:center;color:rgba(170,195,240,.7);font-size:13px;max-width:320px}
  #memOrb .mo-panel{width:360px;flex:none;display:flex;flex-direction:column;gap:14px;padding:22px 20px;background:linear-gradient(180deg,rgba(10,16,34,.92),rgba(5,8,20,.95));border-left:1px solid rgba(110,160,255,.14)}
  #memOrb .mo-head{display:flex;align-items:center;justify-content:space-between}
  #memOrb .mo-head span{font-size:11px;letter-spacing:.2em;color:rgba(160,190,240,.65)}
  #memOrb .mo-x{width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#cfdcf6;font-size:18px;cursor:pointer}
  #memOrb .mo-x:hover{background:rgba(255,255,255,.1)}
  #memOrb .mo-add{display:flex;gap:8px}#memOrb .mo-add input{flex:1}
  #memOrb input{min-width:0;padding:10px 12px;border-radius:10px;border:1px solid rgba(110,160,255,.2);background:rgba(255,255,255,.04);color:#eef4ff;font:inherit;font-size:13px;outline:none}
  #memOrb input:focus{border-color:#3aa9ff;box-shadow:0 0 0 3px rgba(58,169,255,.15)}
  #memOrb .mo-btn{padding:0 14px;border-radius:10px;border:0;background:linear-gradient(135deg,#3aa9ff,#0f37b4);color:#fff;font:inherit;font-size:12px;font-weight:600;letter-spacing:.06em;cursor:pointer}
  #memOrb .mo-btn:disabled{opacity:.45;cursor:default}
  #memOrb .mo-hint{font-size:11px;color:rgba(150,175,225,.55);margin-top:-6px}
  #memOrb .mo-kinds{display:flex;flex-wrap:wrap;gap:6px}
  #memOrb .mo-kind{padding:5px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#b9c9e8;font:inherit;font-size:11px;cursor:pointer}
  #memOrb .mo-kind.on{border-color:var(--k);color:#fff;background:color-mix(in srgb,var(--k) 18%,transparent)}
  #memOrb .mo-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:4px}
  #memOrb .mo-row{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid transparent;font-size:13px;line-height:1.4}
  #memOrb .mo-row.hot{border-color:rgba(58,169,255,.45);background:rgba(58,169,255,.08)}
  #memOrb .mo-row i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--k);margin-top:6px}
  #memOrb .mo-row span{flex:1;word-break:break-word}
  #memOrb .mo-del{flex:none;border:0;background:none;color:rgba(200,215,245,.4);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px}
  #memOrb .mo-del:hover{color:#ff7a8a}
  #memOrb .mo-foot{font-size:11px;color:rgba(150,175,225,.5)}
  @media (max-width:820px){#memOrb{flex-direction:column}#memOrb .mo-panel{width:auto;height:46%;border-left:0;border-top:1px solid rgba(110,160,255,.14)}}
  @media (prefers-reduced-motion:reduce){#memOrb{transition:none}}
  `;

  // The app has window.jarvis; the website hands in its own adapter that talks
  // to the server. Same three calls either way.
  const api = () => window.CallistoMemoryApi || window.jarvis;

  let root = null, raf = 0, facts = [], filter = 'all', search = '', hot = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ── The particle globe ─────────────────────────────────────────────────
  function globe(canvas) {
    const ctx = canvas.getContext('2d');
    const N = 900, pts = [];
    for (let i = 0; i < N; i++) {           // evenly spread over a sphere
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
      pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    }
    const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let a = 0;
    return function draw(cx, cy, R) {
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.6);
      g.addColorStop(0, 'rgba(58,120,255,0.22)'); g.addColorStop(1, 'rgba(15,55,180,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.6, 0, 7); ctx.fill();
      if (!still) a += 0.0035;
      const ca = Math.cos(a), sa = Math.sin(a), tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
      for (const [x, y, z] of pts) {
        const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
        const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
        const d = (z2 + 1) / 2;               // 0 back … 1 front
        ctx.fillStyle = `rgba(${110 + 100 * d | 0},${170 + 70 * d | 0},255,${0.12 + 0.75 * d})`;
        const s = 0.6 + 1.5 * d;
        ctx.fillRect(cx + x1 * R - s / 2, cy + y2 * R - s / 2, s, s);
      }
    };
  }

  // ── The sky behind it: electric mist with a lightning beam through the orb ──
  // One WebGL layer for both, drawn at half resolution (it is soft by nature,
  // and a full-size shader on a laptop GPU costs battery for nothing). Without
  // WebGL the plain dark background simply shows.
  function sky(canvas) {
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) return null;
    const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const FS = `precision mediump float;
uniform vec2 res;uniform float t;
float h1(float p){p=fract(p*.1031);p*=p+33.33;p*=p+p;return fract(p);}
float h2(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
float n2(vec2 x){vec2 p=floor(x),f=fract(x);f=f*f*(3.-2.*f);
  return mix(mix(h2(p),h2(p+vec2(1,0)),f.x),mix(h2(p+vec2(0,1)),h2(p+vec2(1,1)),f.x),f.y);}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float mist(vec2 p,int oct){float z=2.,rz=0.;mat2 m=mat2(.8,.6,-.6,.8);
  for(int i=0;i<5;i++){if(i>=oct)break;rz+=abs((n2(p*1.5)-.5)*4.)/z;z*=2.;p*=2.;p*=m;}return rz;}
float bolt(vec2 p){float v=0.,a=.5;for(int i=0;i<8;i++){v+=a*n2(p);p*=rot(.45);p*=2.;a*=.5;}return v;}
void main(){
  vec2 uv=gl_FragCoord.xy/res;vec2 p=uv*2.-1.;p.x*=res.x/res.y;vec2 bp=p;
  float tm=t*.2;
  /* electric mist */
  vec2 q=(p+5.)*.5;
  float rb=mist(q*.5+tm*.17,3)*.1;
  q*=rot(rb*.2+atan(q.y,q.x)*3.);
  float rz=mist(q*.9-tm*.7,5)*12.*abs(sin(bp.x*.5-tm*4.-2.));
  vec3 col=sqrt(abs(vec3(.098,.098,.44)/(1.-rz)));
  col*=.28;
  /* lightning beam, blue, down the middle */
  vec2 l=p;l+=2.*bolt(l*2.+.8*t*1.6)-1.;
  float d=abs(l.x);
  vec3 bc=vec3(.24,.42,.8);
  col+=bc*(mix(0.,.07,h1(floor(t*1.6*12.)))/max(d,.004))*.2;
  /* fade the edges so the panel side stays calm */
  col*=smoothstep(1.6,.2,length(bp*vec2(.8,1.)));
  /* quieter still where the memories sit, so text stays readable */
  col*=mix(.45,1.,smoothstep(.25,.9,length(bp)));
  gl_FragColor=vec4(min(col,vec3(1.)),1.);
}`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'res'), uT = gl.getUniformLocation(prog, 't');
    const start = performance.now();
    const draw = (frozen) => {
      const w = Math.max(1, canvas.clientWidth / 2 | 0), h = Math.max(1, canvas.clientHeight / 2 | 0);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uT, frozen ? 3.0 : (performance.now() - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    draw.dispose = () => { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {} };
    return draw;
  }

  // ── Rings of memories ──────────────────────────────────────────────────
  function shown() {
    const q = search.toLowerCase();
    return facts.filter((f) => (filter === 'all' || kindOf(f).id === filter) && (!q || f.toLowerCase().includes(q)));
  }

  function buildOrbit() {
    const stage = root.querySelector('.mo-stage');
    stage.querySelectorAll('.mo-ring,.mo-chip').forEach((n) => n.remove());
    // As many as fit without piling up: fewer on a small stage.
    const small = Math.min(stage.clientWidth, stage.clientHeight) < 520;
    const list = shown().slice().reverse().slice(0, small ? 10 : 24); // newest first
    const rings = small
      ? [{ k: 0.55, n: 4, speed: 1 }, { k: 0.88, n: 6, speed: -0.6 }]
      : [{ k: 0.42, n: 6, speed: 1 }, { k: 0.62, n: 8, speed: -0.7 }, { k: 0.82, n: 10, speed: 0.5 }];
    const chips = [];
    let i = 0;
    rings.forEach((ring, ri) => {
      const ringEl = document.createElement('div');
      ringEl.className = 'mo-ring'; ringEl.dataset.k = ring.k;
      stage.appendChild(ringEl);
      const mine = list.slice(i, i + ring.n); i += ring.n;
      mine.forEach((f, j) => {
        const el = document.createElement('div');
        el.className = 'mo-chip';
        el.style.setProperty('--k', kindOf(f).colour);
        el.innerHTML = '<i></i>' + esc(f);
        el.title = f;
        el.addEventListener('mouseenter', () => { paused = true; mark(f); });
        el.addEventListener('mouseleave', () => { paused = false; mark(null); });
        el.addEventListener('click', () => {
          const row = root.querySelector('.mo-row[data-f="' + CSS.escape(f) + '"]');
          if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        stage.appendChild(el);
        chips.push({ el, ring, base: (j / Math.max(mine.length, 1)) * Math.PI * 2 + ri * 0.6 });
      });
    });
    root.querySelector('.mo-empty').style.display = facts.length ? 'none' : '';
    return chips;
  }

  function mark(f) {
    hot = f;
    root.querySelectorAll('.mo-chip').forEach((c) => c.classList.toggle('hot', c.title === f));
    root.querySelectorAll('.mo-row').forEach((r) => r.classList.toggle('hot', r.dataset.f === f));
  }

  // ── The side panel ─────────────────────────────────────────────────────
  function renderPanel() {
    const counts = { all: facts.length };
    facts.forEach((f) => { const k = kindOf(f).id; counts[k] = (counts[k] || 0) + 1; });
    root.querySelector('.mo-kinds').innerHTML = [{ id: 'all', label: 'All', colour: '#3aa9ff' }, ...KINDS, OTHER]
      .filter((k) => k.id === 'all' || counts[k.id])
      .map((k) => `<button class="mo-kind${filter === k.id ? ' on' : ''}" data-k="${k.id}" style="--k:${k.colour}">${k.label} ${counts[k.id] || 0}</button>`).join('');
    const list = shown().slice().reverse();
    root.querySelector('.mo-list').innerHTML = list.length
      ? list.map((f) => `<div class="mo-row" data-f="${esc(f)}" style="--k:${kindOf(f).colour}"><i></i><span>${esc(f)}</span><button class="mo-del" title="Forget this" aria-label="Forget this">×</button></div>`).join('')
      : `<div class="mo-foot">${facts.length ? 'Nothing matches.' : 'Nothing remembered yet.'}</div>`;
    root.querySelector('.mo-foot-count').textContent = facts.length + ' of 120 memories · used in every reply';
  }

  let chips = [], paused = false, fx = null;
  function refresh() { chips = buildOrbit(); renderPanel(); }

  function open() {
    if (root) return;
    if (!document.getElementById('memOrbCss')) {
      const st = document.createElement('style'); st.id = 'memOrbCss'; st.textContent = STYLE; document.head.appendChild(st);
    }
    root = document.createElement('div');
    root.id = 'memOrb';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Memory');
    root.innerHTML = `
      <div class="mo-stage"><canvas class="mo-fx" aria-hidden="true"></canvas><canvas class="mo-globe"></canvas>
        <div class="mo-title">MEMORY<b>What I know about you</b></div>
        <div class="mo-empty">Nothing yet. Tell me things as we talk — or add them on the right — and they'll orbit here.</div>
      </div>
      <aside class="mo-panel">
        <div class="mo-head"><span>MEMORY ORB</span><button class="mo-x" aria-label="Close">×</button></div>
        <div class="mo-add"><input class="mo-new" maxlength="300" placeholder="e.g. My girlfriend is called Sara"><button class="mo-btn" disabled>ADD</button></div>
        <div class="mo-hint">Names, your business, what you like, what's going on — anything worth remembering.</div>
        <input class="mo-search" placeholder="Search memories…">
        <div class="mo-kinds"></div>
        <div class="mo-list"></div>
        <div class="mo-foot mo-foot-count"></div>
      </aside>`;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('open'));

    const canvas = root.querySelector('canvas.mo-globe'), stage = root.querySelector('.mo-stage');
    const draw = globe(canvas);
    fx = sky(root.querySelector('canvas.mo-fx'));
    const newIn = root.querySelector('.mo-new'), addBtn = root.querySelector('.mo-btn');

    root.querySelector('.mo-x').onclick = close;
    newIn.oninput = () => { addBtn.disabled = !newIn.value.trim(); };
    const add = async () => {
      const v = newIn.value.trim(); if (!v) return;
      addBtn.disabled = true;
      try { facts = await api().addMemory(v); } catch (_) {}
      newIn.value = ''; refresh(); mark(v);
    };
    addBtn.onclick = add;
    newIn.onkeydown = (e) => { if (e.key === 'Enter') add(); };
    root.querySelector('.mo-search').oninput = (e) => { search = e.target.value; refresh(); };
    root.querySelector('.mo-kinds').onclick = (e) => {
      const b = e.target.closest('.mo-kind'); if (!b) return;
      filter = b.dataset.k; refresh();
    };
    root.querySelector('.mo-list').onclick = async (e) => {
      const row = e.target.closest('.mo-row'); if (!row) return;
      if (e.target.closest('.mo-del')) {
        try { facts = await api().removeMemory(row.dataset.f); } catch (_) {}
        refresh();
      } else mark(hot === row.dataset.f ? null : row.dataset.f);
    };
    root.querySelector('.mo-list').onmouseover = (e) => { const r = e.target.closest('.mo-row'); if (r && r.dataset.f !== hot) mark(r.dataset.f); };
    document.addEventListener('keydown', onKey);

    let t = 0;
    const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const loop = () => {
      const w = stage.clientWidth, h = stage.clientHeight, cx = w / 2, cy = h / 2 + 10;
      const span = Math.min(w, h) * 0.5;
      if (fx) fx(still);
      draw(cx, cy, span * 0.26);
      stage.querySelectorAll('.mo-ring').forEach((r) => {
        const d = span * 2 * r.dataset.k;
        r.style.width = r.style.height = d + 'px'; r.style.left = (cx - d / 2) + 'px'; r.style.top = (cy - d / 2) + 'px';
      });
      if (!paused && !still) t += 0.0022;
      for (const c of chips) {
        const ang = c.base + t * c.ring.speed, R = span * c.ring.k;
        const x = cx + Math.cos(ang) * R, y = cy + Math.sin(ang) * R;
        c.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
      }
      raf = requestAnimationFrame(loop);
    };

    api().getMemories().then((m) => { facts = Array.isArray(m) ? m : []; refresh(); loop(); })
      .catch(() => { facts = []; refresh(); loop(); });
    setTimeout(() => newIn.focus(), 300);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    if (!root) return;
    cancelAnimationFrame(raf);
    if (fx && fx.dispose) fx.dispose();
    fx = null;
    document.removeEventListener('keydown', onKey);
    const r = root; root = null; chips = []; hot = null;
    r.classList.remove('open');
    setTimeout(() => r.remove(), 280);
  }

  window.CallistoMemoryOrb = { open, close };
})();
