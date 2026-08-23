/* ── Config ──────────────────────────────────────────────────────────────── */
const API = 'https://ai-app-production-9224.up.railway.app';

/* ── State ───────────────────────────────────────────────────────────────── */
let token    = localStorage.getItem('cai_token') || null;
let profile  = JSON.parse(localStorage.getItem('cai_profile') || 'null');
let history  = [];
let sessions = JSON.parse(localStorage.getItem('cai_sessions') || '[]');
let aborted  = false;

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const authOverlay   = document.getElementById('authOverlay');
const app           = document.getElementById('app');
const loginForm     = document.getElementById('loginForm');
const signupForm    = document.getElementById('signupForm');
const tabLogin      = document.getElementById('tabLogin');
const tabSignup     = document.getElementById('tabSignup');
const loginError    = document.getElementById('loginError');
const signupError   = document.getElementById('signupError');
const messagesEl    = document.getElementById('messages');
const thinkingRow   = document.getElementById('thinkingRow');
const emptyState    = document.getElementById('emptyState');
const messageInput  = document.getElementById('messageInput');
const sendBtn       = document.getElementById('sendBtn');
const stopBtn       = document.getElementById('stopBtn');
const sidebarEl     = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarHistory = document.getElementById('sidebarHistory');
const newChatBtn    = document.getElementById('newChatBtn');
const userNameEl    = document.getElementById('userName');
const userEmailEl   = document.getElementById('userEmail');
const userAvatarEl  = document.getElementById('userAvatar');
const signOutBtn    = document.getElementById('signOutBtn');

/* ── Auth tabs ───────────────────────────────────────────────────────────── */
tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active');
  tabSignup.classList.remove('active');
  loginForm.classList.remove('hidden');
  signupForm.classList.add('hidden');
  loginError.classList.add('hidden');
});
tabSignup.addEventListener('click', () => {
  tabSignup.classList.add('active');
  tabLogin.classList.remove('active');
  signupForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
  signupError.classList.add('hidden');
});

/* ── Login ───────────────────────────────────────────────────────────────── */
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  const btn = loginForm.querySelector('.auth-submit');
  btn.textContent = 'Signing in…'; btn.disabled = true;
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:    document.getElementById('loginEmail').value.trim(),
        password: document.getElementById('loginPassword').value,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.token) throw new Error(data.error || data.message || 'Invalid email or password.');
    setToken(data.token, data.user || data.profile);
    enterApp();
  } catch (err) {
    showAuthError(loginError, err.message);
  } finally {
    btn.textContent = 'Sign In'; btn.disabled = false;
  }
});

/* ── Signup ──────────────────────────────────────────────────────────────── */
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  signupError.classList.add('hidden');
  const btn = signupForm.querySelector('.auth-submit');
  btn.textContent = 'Creating…'; btn.disabled = true;
  try {
    const res = await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:     document.getElementById('signupName').value.trim(),
        email:    document.getElementById('signupEmail').value.trim(),
        password: document.getElementById('signupPassword').value,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.token) throw new Error(data.error || data.message || 'Could not create account.');
    setToken(data.token, data.user || data.profile);
    enterApp();
  } catch (err) {
    showAuthError(signupError, err.message);
  } finally {
    btn.textContent = 'Create Account'; btn.disabled = false;
  }
});

function showAuthError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function setToken(t, p) {
  token = t;
  profile = p || {};
  localStorage.setItem('cai_token', t);
  localStorage.setItem('cai_profile', JSON.stringify(profile));
}

/* ── Enter / exit app ────────────────────────────────────────────────────── */
function enterApp() {
  authOverlay.classList.add('hidden');
  app.classList.remove('hidden');

  const name  = profile?.name || profile?.displayName || 'User';
  const email = profile?.email || '';
  userNameEl.textContent   = name;
  userEmailEl.textContent  = email;
  userAvatarEl.textContent = name.charAt(0).toUpperCase();

  renderHistory();
  messageInput.focus();
}

signOutBtn.addEventListener('click', () => {
  token = null; profile = null;
  localStorage.removeItem('cai_token');
  localStorage.removeItem('cai_profile');
  app.classList.add('hidden');
  authOverlay.classList.remove('hidden');
  resetChat(false);
});

/* ── Auto-login if token saved ───────────────────────────────────────────── */
if (token && profile) {
  enterApp();
}

/* ── New chat ─────────────────────────────────────────────────────────────── */
newChatBtn.addEventListener('click', () => {
  saveCurrentSession();
  resetChat(true);
  closeSidebar();
});

function resetChat(focus) {
  history = [];
  messagesEl.innerHTML = '';
  messagesEl.classList.remove('visible');
  emptyState.classList.remove('hidden');
  thinkingRow.classList.add('hidden');
  if (focus) messageInput.focus();
}

/* ── Session history ─────────────────────────────────────────────────────── */
function saveCurrentSession() {
  if (!history.length) return;
  const title = history[0].content.slice(0, 55) + (history[0].content.length > 55 ? '…' : '');
  const session = { id: Date.now(), title, messages: [...history] };
  sessions.unshift(session);
  if (sessions.length > 40) sessions = sessions.slice(0, 40);
  localStorage.setItem('cai_sessions', JSON.stringify(sessions));
  renderHistory();
}

function renderHistory() {
  const label = sidebarHistory.querySelector('.history-label');
  sidebarHistory.innerHTML = '';
  if (label) sidebarHistory.appendChild(label);
  const lbl = document.createElement('p');
  lbl.className = 'history-label'; lbl.textContent = 'Recent';
  sidebarHistory.appendChild(lbl);

  if (!sessions.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:12px;color:var(--text-muted);padding:8px 10px';
    empty.textContent = 'No previous chats';
    sidebarHistory.appendChild(empty);
    return;
  }
  sessions.forEach(s => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.textContent = s.title;
    item.addEventListener('click', () => {
      saveCurrentSession();
      loadSession(s);
      closeSidebar();
    });
    sidebarHistory.appendChild(item);
  });
}

function loadSession(s) {
  history = [...s.messages];
  messagesEl.innerHTML = '';
  emptyState.classList.add('hidden');
  messagesEl.classList.add('visible');
  history.forEach(m => appendMessage(m.role, m.content, false));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ── Sidebar (mobile) ─────────────────────────────────────────────────────── */
const backdrop = document.createElement('div');
backdrop.className = 'sidebar-backdrop';
document.body.appendChild(backdrop);

sidebarToggle.addEventListener('click', () => {
  sidebarEl.classList.toggle('open');
  backdrop.classList.toggle('visible');
});
backdrop.addEventListener('click', closeSidebar);

function closeSidebar() {
  sidebarEl.classList.remove('open');
  backdrop.classList.remove('visible');
}

/* ── Input auto-resize ───────────────────────────────────────────────────── */
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
  sendBtn.disabled = !messageInput.value.trim();
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

/* ── Suggestion chips ─────────────────────────────────────────────────────── */
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    messageInput.value = chip.dataset.text;
    messageInput.dispatchEvent(new Event('input'));
    sendMessage();
  });
});

/* ── Stop ─────────────────────────────────────────────────────────────────── */
stopBtn.addEventListener('click', () => {
  aborted = true;
  setThinking(false);
});

/* ── Send message ─────────────────────────────────────────────────────────── */
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !token) return;

  // Clear input
  messageInput.value = '';
  messageInput.style.height = 'auto';
  sendBtn.disabled = true;

  // Show chat area
  emptyState.classList.add('hidden');
  messagesEl.classList.add('visible');

  // Add user message
  appendMessage('user', text);
  history.push({ role: 'user', content: text });

  // Show thinking
  aborted = false;
  setThinking(true);

  try {
    const res = await fetch(`${API}/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: text,
        history: history.slice(-20),
      }),
    });

    if (aborted) return;

    if (res.status === 401) {
      // Token expired
      setThinking(false);
      signOutBtn.click();
      return;
    }

    const data = await res.json();
    if (aborted) return;

    const reply = data.text || data.reply || data.message || 'Sorry, I couldn\'t get a response.';
    setThinking(false);
    appendMessage('assistant', reply);
    history.push({ role: 'assistant', content: reply });

  } catch (err) {
    if (aborted) return;
    setThinking(false);
    appendMessage('assistant', 'Something went wrong. Please check your connection and try again.');
  }
}

/* ── Append message ───────────────────────────────────────────────────────── */
function appendMessage(role, text, animate = true) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;
  if (!animate) row.style.animation = 'none';

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  if (role === 'assistant') {
    avatar.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(180,210,255,0.9)" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`;
  } else {
    avatar.textContent = (profile?.name || 'U').charAt(0).toUpperCase();
  }

  // Content
  const content = document.createElement('div');
  content.className = 'msg-content';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  content.appendChild(bubble);

  // Actions (assistant only)
  if (role === 'assistant') {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied`;
        setTimeout(() => { copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`; }, 1800);
      });
    });
    actions.appendChild(copyBtn);
    content.appendChild(actions);
  }

  row.appendChild(avatar);
  row.appendChild(content);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ── Thinking state ───────────────────────────────────────────────────────── */
function setThinking(on) {
  thinkingRow.classList.toggle('hidden', !on);
  stopBtn.classList.toggle('hidden', !on);
  sendBtn.style.display = on ? 'none' : 'flex';
  if (on) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ── Init ─────────────────────────────────────────────────────────────────── */
renderHistory();
