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
const paymentStep = document.getElementById('paymentStep');
const payBtn = document.getElementById('payBtn');
const payWaiting = document.getElementById('payWaiting');
const payError = document.getElementById('payError');

const orb = document.getElementById('orb');
const orbLabel = document.getElementById('orbLabel');
const chat = document.getElementById('chat');
const micBtn = document.getElementById('micBtn');
const micLabel = document.getElementById('micLabel');
const fileBtn = document.getElementById('fileBtn');
const closeBtn = document.getElementById('closeBtn');
const clearBtn = document.getElementById('clearBtn');
const historyBtn = document.getElementById('historyBtn');
const historySidebar = document.getElementById('historySidebar');
const historyClose = document.getElementById('historyClose');
const historyList = document.getElementById('historyList');
const cardPanel = document.getElementById('cardPanel');
const cardContent = document.getElementById('cardContent');
const cardSource = document.getElementById('cardSource');
const voiceSpeedSlider = document.getElementById('voiceSpeedSlider');
const voiceSpeedVal = document.getElementById('voiceSpeedVal');
const contactsPanel = document.getElementById('contactsPanel');
const contactsBtn = document.getElementById('contactsBtn');
const contactsClose = document.getElementById('contactsClose');
const contactsList = document.getElementById('contactsList');
const contactNameInput = document.getElementById('contactNameInput');
const contactPhoneInput = document.getElementById('contactPhoneInput');
const addContactBtn = document.getElementById('addContactBtn');

let history = [];
let profile = null;
let isRecording = false;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let pcmChunks = [];
let currentStream = null;

// ===================== STATE =====================
function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function setState(state) {
  orb.className = state;
  if (state === 'idle') {
    orbLabel.textContent = 'STANDBY';
    micBtn.classList.remove('active');
    animateMicLabel('CLICK TO SPEAK');
  } else if (state === 'listening') {
    orbLabel.textContent = 'LISTENING';
    micBtn.classList.add('active');
    animateMicLabel('CLICK TO STOP');
  } else if (state === 'thinking') {
    orbLabel.textContent = 'PROCESSING';
    micBtn.classList.remove('active');
    animateMicLabel('PLEASE WAIT');
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

    const float overallSpeed = 0.15;
    const float gridSmoothWidth = 0.015;
    const float scale = 5.0;
    const vec4 lineColor = vec4(0.0, 0.72, 1.0, 1.0);
    const float minLineWidth = 0.008;
    const float maxLineWidth = 0.12;
    const float lineSpeed = 1.0 * overallSpeed;
    const float lineAmplitude = 0.8;
    const float lineFrequency = 0.2;
    const float warpSpeed = 0.2 * overallSpeed;
    const float warpFrequency = 0.5;
    const float warpAmplitude = 0.8;
    const float offsetFrequency = 0.5;
    const float offsetSpeed = 1.33 * overallSpeed;
    const float minOffsetSpread = 0.6;
    const float maxOffsetSpread = 2.0;
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

      vec4 col = mix(vec4(0.0, 0.02, 0.07, 1.0), vec4(0.0, 0.04, 0.13, 1.0), uv.x);
      col *= vFade;
      col.a = 1.0;
      col += lines * 0.6;
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
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(attribPos, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(attribPos);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
})();

// ===================== CARD PANEL =====================
function showCard(card) {
  if (!card) { cardPanel.classList.add('hidden'); return; }
  cardPanel.classList.remove('hidden');

  if (card.type === 'sports') {
    const scorersHtml = (card.scorers && card.scorers.length)
      ? `<div class="scorers-section"><div class="scorers-title">SCORERS</div>${card.scorers.map(s => `<div class="scorer-row"><span class="scorer-team">${s.team}</span><span class="scorer-detail">${s.detail}</span></div>`).join('')}</div>`
      : '';
    const metaHtml = [card.league, card.date, card.venue, card.status].filter(Boolean).map(m => `<span>${m}</span>`).join(' · ');
    cardContent.innerHTML = `
      <div class="card-sports">
        <div class="match-label">MATCH RESULT</div>
        <div class="score-row">
          <div class="team-block">
            <div class="team-name">${card.team1}</div>
            <div class="team-score">${card.score1}</div>
          </div>
          <div class="vs-divider">VS</div>
          <div class="team-block">
            <div class="team-score">${card.score2}</div>
            <div class="team-name">${card.team2}</div>
          </div>
        </div>
        ${metaHtml ? `<div class="match-meta">${metaHtml}</div>` : ''}
        ${scorersHtml}
        ${card.motm ? `<div class="motm-row">⭐ MOTM: ${card.motm}</div>` : ''}
        <div class="match-headline">${card.headline}</div>
      </div>`;
  } else if (card.type === 'stock') {
    const changeSign = card.positive ? '+' : '';
    const changeClass = card.positive ? 'positive' : 'negative';
    const arrowIcon = card.positive ? '▲' : '▼';
    const sparkSvg = buildSparkline(card.sparkline || [], card.positive);
    const label = card.isCrypto ? 'CRYPTO' : 'STOCK';
    const metaRows = [
      card.high52 ? `<div class="stock-meta-row"><span>52W HIGH</span><span>${card.currency} ${card.high52}</span></div>` : '',
      card.low52  ? `<div class="stock-meta-row"><span>52W LOW</span><span>${card.currency} ${card.low52}</span></div>` : '',
      card.marketCap ? `<div class="stock-meta-row"><span>MKT CAP</span><span>${card.marketCap}</span></div>` : '',
      card.volume ? `<div class="stock-meta-row"><span>VOLUME</span><span>${card.volume}</span></div>` : '',
    ].filter(Boolean).join('');
    cardContent.innerHTML = `
      <div class="card-stock">
        <div class="stock-type-label">${label}</div>
        <div class="stock-header">
          <div class="stock-symbol">${card.symbol}</div>
          <div class="stock-name">${card.name}</div>
        </div>
        <div class="stock-price">${card.currency} ${card.price}</div>
        <div class="stock-change ${changeClass}">${arrowIcon} ${changeSign}${card.change} (${changeSign}${card.changePct}%) TODAY</div>
        ${sparkSvg}
        ${metaRows ? `<div class="stock-meta">${metaRows}</div>` : ''}
        <a class="stock-link" href="${card.sourceUrl}" target="_blank">View on Yahoo Finance →</a>
      </div>`;
  } else if (card.type === 'person') {
    cardContent.innerHTML = `
      <div class="card-person">
        ${card.imageUrl ? `<img class="person-photo" src="${card.imageUrl}" alt="${card.name}" onclick="window.open('${card.sourceUrl}','_blank')" />` : '<div class="person-photo-placeholder">👤</div>'}
        <div class="person-name">${card.name}</div>
        ${card.subtitle ? `<div class="person-subtitle">${card.subtitle}</div>` : ''}
        ${card.bio ? `<div class="person-bio">${card.bio}</div>` : ''}
      </div>`;
  } else if (card.type === 'image') {
    cardContent.innerHTML = `
      <div class="card-image">
        <div class="img-label">AI GENERATED</div>
        <img src="${card.imageUrl}" alt="${card.title}" style="width:100%;border-radius:10px;margin:10px 0;cursor:pointer;" onclick="window.open('${card.imageUrl}','_blank')" />
        <div class="img-desc">${card.description}</div>
        <a class="img-download" href="${card.imageUrl}" download="jarvis-image.png" target="_blank">⬇ DOWNLOAD IMAGE</a>
      </div>`;
  } else if (card.type === 'news') {
    const items = card.headlines.map(h => `<div class="news-item">${h}</div>`).join('');
    cardContent.innerHTML = `<div class="card-news"><div class="news-title">LATEST NEWS</div>${items}</div>`;
  } else if (card.type === 'calendar') {
    const evRows = (card.events || []).map(e => {
      const start = new Date(e.start);
      const dateStr = start.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = e.allDay ? 'All day' : start.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });
      return `<div class="cal-event"><div class="cal-title">${e.title}</div><div class="cal-time">${dateStr} · ${timeStr}</div></div>`;
    }).join('');
    cardContent.innerHTML = `<div class="card-calendar"><div class="cal-header">📅 UPCOMING EVENTS</div>${evRows || '<div class="cal-empty">No events found.</div>'}</div>`;
  }

  const srcLink = card.sourceUrl
    ? `SOURCE: <a href="#" onclick="require('electron').shell.openExternal('${card.sourceUrl}'); return false;">${card.source}</a>`
    : `SOURCE: ${card.source}`;
  cardSource.innerHTML = srcLink;
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

// ===================== CHAT HISTORY =====================
historyBtn.addEventListener('click', async () => {
  historySidebar.classList.toggle('hidden');
  if (!historySidebar.classList.contains('hidden')) await loadHistory();
});

historyClose.addEventListener('click', () => historySidebar.classList.add('hidden'));

async function loadHistory() {
  const sessions = await window.jarvis.listSessions();
  if (!sessions.length) {
    historyList.innerHTML = '<div class="history-empty">No history yet</div>';
    return;
  }
  historyList.innerHTML = sessions.map(s => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="history-item" data-id="${s.id}">
      <button class="history-delete" data-id="${s.id}">✕</button>
      <div class="history-date">${dateStr}</div>
      <div class="history-preview">${s.preview}</div>
    </div>`;
  }).join('');

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
closeBtn.addEventListener('click', () => window.jarvis.hide());

clearBtn.addEventListener('click', async () => {
  await saveCurrentSession();
  chat.innerHTML = '';
  history = [];
  cardPanel.classList.add('hidden');
  addMessage('assistant', 'Chat cleared. How can I help?');
});

fileBtn.addEventListener('click', async () => {
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

// ===================== SEND TO AI =====================
async function sendToJarvis(text) {
  addMessage('user', text);
  history.push({ role: 'user', content: text });
  setState('thinking');

  const res = await window.jarvis.chat(text, history.slice(-10));
  if (!res || res.error) { setState('idle'); return; }

  history.push({ role: 'assistant', content: res.text });
  addMessage('assistant', res.text);
  setState('idle');

  // Fire flash whenever Jarvis actually executes an action (open app, URL, call, image, etc.)
  if (res.hasAction) triggerActionFlash();

  // Show card if returned
  if (res.card) showCard(res.card);
  else cardPanel.classList.add('hidden');

  if (res.audio) {
    playAudioChunks(Array.isArray(res.audio) ? res.audio : [res.audio]);
  }
}

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
    document.getElementById('switchToLogin').addEventListener('click', (e) => { e.preventDefault(); setAuthMode('login'); });
  } else {
    tabSignup.classList.remove('active');
    tabLogin.classList.add('active');
    authSubmit.textContent = 'LOG IN';
    authFooter.innerHTML = 'No account? <a href="#" id="switchToSignup">Sign up →</a>';
    signupEmailField.style.display = '';
    document.getElementById('switchToSignup').addEventListener('click', (e) => { e.preventDefault(); setAuthMode('signup'); });
  }
  authError.classList.add('hidden');
}

nameNext.addEventListener('click', () => {
  const name = setupName.value.trim();
  if (!name) { setupName.focus(); return; }
  pendingAssistantName = name;
  showAuthStep();
});

tabSignup.addEventListener('click', () => setAuthMode('signup'));
tabLogin.addEventListener('click', () => setAuthMode('login'));

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
    result = await window.jarvis.authSignup({ email, password, name: pendingAssistantName || 'Jarvis' });
  } else {
    result = await window.jarvis.authLogin({ email, password });
  }

  authSubmit.disabled = false;
  authSubmit.textContent = authMode === 'signup' ? 'CREATE ACCOUNT' : 'LOG IN';

  if (result.error) {
    authError.textContent = result.error;
    authError.classList.remove('hidden');
    return;
  }

  const name = result.user?.name || pendingAssistantName || 'Jarvis';
  profile = { name, email: result.user?.email || email };
  await window.jarvis.setProfile(profile);
  await checkSubscriptionAndEnter(name, profile.email);
});

googleBtn.addEventListener('click', async () => {
  googleBtn.textContent = 'Opening browser...';
  googleBtn.disabled = true;
  await window.jarvis.authGoogle();
  setTimeout(() => { googleBtn.textContent = 'Continue with Google'; googleBtn.disabled = false; }, 3000);
});

window.jarvis.onGoogleSuccess(async ({ token, name, email }) => {
  const displayName = name || pendingAssistantName || 'Jarvis';
  profile = { name: displayName, email };
  await window.jarvis.setProfile(profile);
  await checkSubscriptionAndEnter(displayName, email);
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

  const name = result.user?.name || profile?.name || 'Jarvis';
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
    await showSplash(profile?.name || 'Jarvis');
    await enterMain();
  } else {
    payError.textContent = 'Payment not confirmed yet. Try again in a moment.';
    payError.classList.remove('hidden');
    setTimeout(() => payError.classList.add('hidden'), 3000);
  }
}

function showPaymentStep() {
  nameStep.classList.add('hidden');
  authStep.classList.add('hidden');
  reloginStep.classList.add('hidden');
  paymentStep.classList.remove('hidden');
  payWaiting.classList.add('hidden');
  payError.classList.add('hidden');
  payBtn.disabled = false;
  payBtn.textContent = 'SUBSCRIBE NOW →';
}

async function checkSubscriptionAndEnter(name, email) {
  // Re-verify token to get latest subscription status
  const result = await window.jarvis.authVerify();
  if (result.active) {
    setupView.classList.add('hidden');
    await showSplash(name);
    await enterMain();
  } else {
    // Not subscribed — show payment step
    setupView.classList.remove('hidden');
    showPaymentStep();
  }
}

payBtn.addEventListener('click', async () => {
  payBtn.disabled = true;
  payBtn.textContent = 'OPENING BROWSER...';
  payError.classList.add('hidden');

  const token = await window.jarvis.authGetToken();
  const checkoutUrl = `http://localhost:4000/checkout${token ? '?token=' + token : ''}`;
  await window.jarvis.openUrl(checkoutUrl);

  payBtn.classList.add('hidden');
  payWaiting.classList.remove('hidden');

  // Poll every 4 seconds until subscription is active
  payPollInterval = setInterval(checkPaymentStatus, 4000);

  // Manual check button
  document.getElementById('payCheckBtn').addEventListener('click', checkPaymentStatus);
});

// ===================== SPLASH / MAIN =====================
async function showSplash(name) {
  splashName.textContent = (name || 'JARVIS').toUpperCase();
  splashStatus.textContent = 'Initializing systems...';
  splash.classList.remove('hidden');
  await new Promise(r => setTimeout(r, 500));
  splashStatus.textContent = 'Loading neural interface...';
  await new Promise(r => setTimeout(r, 600));
  splashStatus.textContent = 'Systems online.';
  await new Promise(r => setTimeout(r, 500));
  splash.classList.add('hidden');
}

async function enterMain() {
  profile.wasSubscribed = true;
  await window.jarvis.setProfile(profile);

  const aiName = (profile.name || 'JARVIS').toUpperCase();
  document.getElementById('aiName').textContent = aiName;
  document.getElementById('enterAiName').textContent = aiName;

  setupView.classList.add('hidden');
  const welcomeScreen = document.getElementById('welcomeScreen');
  welcomeScreen.classList.remove('hidden');
  initSpikySphere();

  document.getElementById('enterBtn').addEventListener('click', async () => {
    welcomeScreen.classList.add('fade-out');
    setTimeout(() => {
      welcomeScreen.classList.add('hidden');
      mainView.classList.remove('hidden');
      setState('idle');
    }, 800);

    // Welcome greeting via TTS
    try {
      const greeting = `Welcome, ${profile.name || 'sir'}. All systems are online. How may I assist you?`;
      await window.jarvis.speak(greeting);
    } catch (_) {}
  }, { once: true });
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
const connectorsBtn = document.getElementById('connectorsBtn');
const connectorsPanel = document.getElementById('connectorsPanel');
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
    gmailBtn.onclick = () => window.jarvis.connectorConnect('gmail');
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
    outlookBtn.onclick = () => window.jarvis.connectorConnect('outlook');
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
      calendarBtn.onclick = () => window.jarvis.connectorConnect('calendar');
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
      spotifyBtn.onclick = () => window.jarvis.connectorConnect('spotify');
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

// Patch renderConnectors to also render music section
const _origRenderConnectors = renderConnectors;
renderConnectors = async function() {
  const status = await _origRenderConnectors();
  const s = await window.jarvis.connectorStatus();
  renderMusicService(s);
};

connectorsBtn.addEventListener('click', () => {
  const isOpen = !connectorsPanel.classList.contains('hidden');
  if (isOpen) { connectorsPanel.classList.add('hidden'); return; }
  contactsPanel.classList.add('hidden');
  cardPanel.classList.add('hidden');
  document.getElementById('profilePanel').classList.add('hidden');
  document.getElementById('languagePanel').classList.add('hidden');
  connectorsPanel.classList.remove('hidden');
  renderConnectors();
});

connectorsClose.addEventListener('click', () => connectorsPanel.classList.add('hidden'));

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

const languageBtn = document.getElementById('languageBtn');
const languagePanel = document.getElementById('languagePanel');
const languageClose = document.getElementById('languageClose');
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

languageBtn.addEventListener('click', () => {
  const isOpen = !languagePanel.classList.contains('hidden');
  if (isOpen) { languagePanel.classList.add('hidden'); return; }
  connectorsPanel.classList.add('hidden');
  contactsPanel.classList.add('hidden');
  cardPanel.classList.add('hidden');
  document.getElementById('profilePanel').classList.add('hidden');
  languagePanel.classList.remove('hidden');
  languageSearch.value = '';
  renderLanguageList();
  // Scroll to active language
  setTimeout(() => {
    const active = languageListEl.querySelector('.lang-row.active');
    if (active) active.scrollIntoView({ block: 'center' });
  }, 50);
});

languageClose.addEventListener('click', () => languagePanel.classList.add('hidden'));
languageSearch.addEventListener('input', () => renderLanguageList(languageSearch.value));

// Listen for successful connector OAuth callback
window.jarvis.onConnectorConnected(({ service }) => {
  renderConnectors();
  addMessage('assistant', `${service.charAt(0).toUpperCase() + service.slice(1)} connected successfully! Say "give me an update" to check your emails.`);
});

// ===================== PROFILE PANEL =====================
const profileBtn = document.getElementById('profileBtn');
const profilePanel = document.getElementById('profilePanel');
const profileClose = document.getElementById('profileClose');

profileBtn.addEventListener('click', async () => {
  const isOpen = !profilePanel.classList.contains('hidden');
  if (isOpen) { profilePanel.classList.add('hidden'); return; }

  // Close other panels
  contactsPanel.classList.add('hidden');
  cardPanel.classList.add('hidden');

  // Load data
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

  const subEl = document.getElementById('profileSub');
  if (isActive) {
    subEl.textContent = '✓ ACTIVE — $10/month';
    subEl.className = 'profile-value profile-sub-active';
  } else {
    subEl.textContent = '✗ NOT SUBSCRIBED';
    subEl.className = 'profile-value profile-sub-inactive';
  }

  // Chat history
  const histEl = document.getElementById('profileHistoryList');
  if (!sessions.length) {
    histEl.innerHTML = '<div style="color:rgba(0,200,255,0.25);font-size:11px;">No conversations yet.</div>';
  } else {
    histEl.innerHTML = sessions.slice(0, 20).map(s => {
      const d = new Date(s.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
      return `<div class="profile-history-item" title="${s.preview}">${d} — ${s.preview}</div>`;
    }).join('');
  }

  profilePanel.classList.remove('hidden');
});

profileClose.addEventListener('click', () => profilePanel.classList.add('hidden'));

document.getElementById('profileLogout').addEventListener('click', async () => {
  await window.jarvis.authLogout();
  profilePanel.classList.add('hidden');
  mainView.classList.add('hidden');
  setupView.classList.remove('hidden');
  showNameStep();
});

// ===================== CONTACTS =====================
contactsBtn.addEventListener('click', () => {
  const open = contactsPanel.classList.contains('hidden');
  contactsPanel.classList.toggle('hidden', !open);
  cardPanel.classList.add('hidden');
  if (open) renderContacts();
});

contactsClose.addEventListener('click', () => contactsPanel.classList.add('hidden'));

async function renderContacts() {
  const contacts = await window.jarvis.getContacts();
  if (!contacts.length) {
    contactsList.innerHTML = '<div style="color:rgba(0,200,255,0.3);font-size:12px;text-align:center;padding:20px;">No contacts yet. Add one below.</div>';
    return;
  }
  contactsList.innerHTML = contacts.map(c => `
    <div class="contact-card" data-id="${c.id}">
      <div class="contact-name">${c.name}</div>
      ${c.phone ? `<div class="contact-phone">${c.phone}</div>` : ''}
      <div class="contact-actions">
        ${c.phone ? `<button class="call-btn whatsapp" onclick="callContact(${c.id},'whatsapp')">📞 WhatsApp</button>` : ''}
        <button class="call-btn instagram" onclick="callContact(${c.id},'instagram')">📷 Instagram</button>
        <button class="call-btn" onclick="callContact(${c.id},'telegram')">✈️ Telegram</button>
        <button class="call-btn delete-btn" onclick="deleteContact(${c.id})">✕</button>
      </div>
    </div>
  `).join('');
}

window.callContact = async (id, platform) => {
  const contacts = await window.jarvis.getContacts();
  const c = contacts.find(x => x.id === id);
  if (!c) return;
  await window.jarvis.callContact(c.phone || '', platform);
};

window.deleteContact = async (id) => {
  await window.jarvis.deleteContact(id);
  renderContacts();
};

addContactBtn.addEventListener('click', async () => {
  const name = contactNameInput.value.trim();
  const phone = contactPhoneInput.value.trim();
  if (!name) return;
  await window.jarvis.addContact({ name, phone });
  contactNameInput.value = '';
  contactPhoneInput.value = '';
  renderContacts();
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
});

window.jarvis.onActivated(async ({ name, profile: storedProfile }) => {
  profile = storedProfile;
  history = [];
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
      await enterMain();
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
    } else if (storedProfile && storedProfile.name) {
      // Has profile but no token (new device) — skip name step, go straight to login
      pendingAssistantName = storedProfile.name;
      showAuthStep();
      setAuthMode('login');
    } else {
      // First time
      showNameStep();
    }
    return;
  }

  // Token valid — check subscription before entering
  const displayName = authResult.user?.name || storedProfile?.name || 'Jarvis';
  profile = { name: displayName, email: authResult.user?.email || storedProfile?.email };
  if (authResult.active) {
    await showSplash(displayName);
    await enterMain();
  } else {
    setupView.classList.remove('hidden');
    showPaymentStep();
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

function encodeWav(pcmFloat32, sampleRate) {
  const buffer = new ArrayBuffer(44 + pcmFloat32.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcmFloat32.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, pcmFloat32.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcmFloat32.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function startRecording() {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    pcmChunks = [];
    audioContext = new AudioContext();
    sourceNode = audioContext.createMediaStreamSource(currentStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (e) => pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);
    isRecording = true;
    setState('listening');
  } catch (err) {
    addMessage('assistant', `Mic error: ${err.name}: ${err.message}`);
    setState('idle');
  }
}

async function stopRecording() {
  if (!audioContext) return;
  isRecording = false;
  processorNode.disconnect();
  sourceNode.disconnect();
  currentStream.getTracks().forEach(t => t.stop());
  const sampleRate = audioContext.sampleRate;
  await audioContext.close();
  audioContext = null;
  setState('thinking');
  try {
    const totalLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of pcmChunks) { merged.set(chunk, offset); offset += chunk.length; }
    const peak = merged.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (peak < 0.001) {
      addMessage('assistant', 'I didn\'t catch that — please check your microphone and try again.');
      setState('idle');
      return;
    }
    const wavBlob = encodeWav(merged, sampleRate);
    const arrayBuffer = await wavBlob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const text = await window.jarvis.transcribe(base64);
    if (text && text.trim()) await sendToJarvis(text.trim());
    else setState('idle');
  } catch (err) {
    addMessage('assistant', `Error: ${err.message}`);
    setState('idle');
  }
}

micBtn.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});
