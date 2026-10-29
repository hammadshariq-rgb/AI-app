/* ─────────────────────────────────────────────────────────────────────────────
   Account & security

   Two-factor sign-in, forgotten passwords, the devices signed in, the
   subscription, and deleting the account. Everything here goes through
   window.jarvis.accountCall, which attaches the sign-in token in the main
   process — the page itself never holds it.

   Every piece of text that came from the server is escaped before it goes on
   screen. A device name is built from a user-agent, and a user-agent is
   whatever the other side said it was.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function styles() {
    if (document.getElementById('acStyles')) return;
    const s = document.createElement('style');
    s.id = 'acStyles';
    s.textContent = `
      #acWrap{position:fixed;inset:0;z-index:9800;display:flex;align-items:center;justify-content:center;
        background:rgba(4,6,14,.76);backdrop-filter:blur(10px);padding:16px}
      #acWrap.hidden{display:none}
      .ac-panel{width:min(600px,100%);max-height:88vh;overflow:auto;border-radius:18px;padding:24px;
        background:linear-gradient(180deg,#0e1424,#070b14);border:1px solid rgba(120,160,255,.18);
        box-shadow:0 40px 120px rgba(0,0,0,.7);color:#dce8ff}
      .ac-panel.small{width:min(400px,100%)}
      .ac-eyebrow{font-size:9px;letter-spacing:3px;font-weight:700;color:rgba(110,140,205,.6)}
      .ac-title{font-size:19px;font-weight:700;color:#eef3ff;margin:3px 0 6px}
      .ac-sub{font-size:13px;line-height:1.6;color:rgba(185,208,250,.8);margin:0 0 14px}
      .ac-sec{border-top:1px solid rgba(255,255,255,.07);padding:18px 0 4px}
      .ac-sec:first-of-type{border-top:none;padding-top:6px}
      .ac-sec h3{font-size:14px;font-weight:650;margin:0 0 4px;color:#eef3ff;display:flex;align-items:center;gap:8px}
      .ac-pill{font-size:9.5px;letter-spacing:1.2px;font-weight:700;padding:3px 8px;border-radius:999px}
      .ac-pill.on{background:rgba(73,214,160,.14);color:#6fe0ad;border:1px solid rgba(73,214,160,.3)}
      .ac-pill.off{background:rgba(255,255,255,.05);color:rgba(190,205,235,.7);border:1px solid rgba(255,255,255,.12)}
      .ac-pill.warn{background:rgba(255,176,80,.14);color:#ffc478;border:1px solid rgba(255,176,80,.3)}
      .ac-text{font-size:12.5px;line-height:1.6;color:rgba(180,200,240,.78);margin:0 0 12px}
      .ac-row{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-top:10px}
      .ac-btn{min-height:40px;padding:9px 16px;border-radius:9px;cursor:pointer;border:none;font:inherit;
        font-size:12.5px;font-weight:700;background:rgba(61,92,255,.92);color:#fff}
      .ac-btn.ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#cfe0ff}
      .ac-btn.danger{background:rgba(220,60,60,.88)}
      .ac-btn.danger-ghost{background:transparent;border:1px solid rgba(255,120,120,.35);color:#ff9a9a}
      .ac-btn:disabled{opacity:.45;cursor:default}
      .ac-btn:focus-visible,.ac-input:focus-visible{outline:2px solid #6f8cff;outline-offset:2px}
      .ac-input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;font:inherit;font-size:14px;
        background:rgba(8,13,28,.85);border:1px solid rgba(120,160,255,.24);color:#e8f0ff;outline:none}
      .ac-input.code{font-size:22px;letter-spacing:8px;text-align:center;font-variant-numeric:tabular-nums}
      .ac-label{display:block;font-size:11.5px;color:rgba(170,195,235,.75);margin:10px 0 5px}
      .ac-msg{font-size:12.5px;line-height:1.55;min-height:18px;margin-top:10px}
      /* An empty status line takes no room. Otherwise every section carries a
         blank gap above its buttons until something goes wrong. */
      .ac-msg:empty{min-height:0;margin-top:0}
      .ac-panel{scrollbar-color:rgba(120,160,255,.28) transparent;scrollbar-width:thin}
      .ac-msg.bad{color:#ff9a9a}.ac-msg.good{color:#7ee0a8}
      .ac-qr{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:8px 0 4px}
      .ac-qr img{width:168px;height:168px;border-radius:10px;background:#fff;padding:6px}
      .ac-secret{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;
        background:rgba(255,255,255,.04);padding:8px 10px;border-radius:7px;color:#cfe0ff}
      .ac-codes{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin:10px 0;
        font-family:ui-monospace,Consolas,monospace;font-size:13.5px}
      .ac-codes span{background:rgba(255,255,255,.04);padding:7px 10px;border-radius:6px;text-align:center}
      .ac-dev{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)}
      .ac-dev:last-child{border-bottom:none}
      .ac-dev-main{flex:1;min-width:0}
      .ac-dev-name{font-size:13px;font-weight:600;color:#e9f1ff}
      .ac-dev-meta{font-size:11.5px;color:rgba(165,190,232,.7);margin-top:2px}
      .ac-danger{border:1px solid rgba(255,120,120,.22);border-radius:12px;padding:14px;margin-top:6px}
      @media (prefers-reduced-motion: no-preference){ .ac-panel{animation:acIn .18s ease-out} }
      @keyframes acIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`;
    document.head.appendChild(s);
  }

  let root = null;
  function panel(html, { small } = {}) {
    styles();
    if (!root) {
      root = document.createElement('div');
      root.id = 'acWrap';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      document.body.appendChild(root);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && root && !root.classList.contains('hidden') && root.dataset.closable !== 'no') close();
      });
    }
    root.dataset.closable = 'yes';
    root.innerHTML = `<div class="ac-panel${small ? ' small' : ''}">${html}</div>`;
    root.classList.remove('hidden');
    return root.querySelector('.ac-panel');
  }
  function close() { if (root) { root.classList.add('hidden'); root.innerHTML = ''; } }

  const call = (m, p, b) => window.jarvis.accountCall(m, p, b);
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const ago = (ms) => {
    if (!ms) return '';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' minutes ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
    const d = Math.round(h / 24);
    return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  };

  /* ══ Sign-in: the code step ═══════════════════════════════════════════════ */
  // Called by the sign-in forms with whatever the password step returned. If
  // two-factor is not on, that result goes straight back; if it is, this asks
  // for the code and returns the result of checking it.
  function askTwoFactor(first) {
    if (!first || !first.twoFactorRequired) return Promise.resolve(first);
    return new Promise((resolve) => {
      const p = panel(`
        <div class="ac-eyebrow">CALLISTO &middot; SIGN IN</div>
        <div class="ac-title">Enter your code</div>
        <p class="ac-sub">Open your authenticator app and type the 6-digit code for Callisto AI.
          Lost your phone? Use one of your backup codes instead.</p>
        <label class="ac-label" for="acCode">Code</label>
        <input class="ac-input code" id="acCode" inputmode="numeric" autocomplete="one-time-code" maxlength="11" spellcheck="false">
        <div class="ac-msg" id="acMsg" role="status" aria-live="polite"></div>
        <div class="ac-row">
          <button class="ac-btn" id="acGo">Sign in</button>
          <button class="ac-btn ghost" id="acCancel">Cancel</button>
        </div>`, { small: true });
      const code = p.querySelector('#acCode');
      const msg = p.querySelector('#acMsg');
      const go = p.querySelector('#acGo');
      code.focus();

      const finish = (r) => { close(); resolve(r); };
      const submit = async () => {
        const v = code.value.trim();
        if (!v) { msg.className = 'ac-msg bad'; msg.textContent = 'Type the code from your app.'; return; }
        go.disabled = true; msg.className = 'ac-msg'; msg.textContent = 'Checking…';
        const r = await window.jarvis.authVerify2fa({ challenge: first.challenge, code: v });
        if (r && r.token) return finish(r);
        go.disabled = false;
        msg.className = 'ac-msg bad';
        msg.textContent = (r && r.error) || 'That did not work.';
        // Timed out or locked: back to the password, with the reason.
        if (r && (r.restart || r.locked)) setTimeout(() => finish({ error: r.error }), 1400);
        else { code.select(); }
      };
      go.addEventListener('click', submit);
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      // Six digits typed: send it, which is what people expect.
      code.addEventListener('input', () => { if (/^\d{6}$/.test(code.value.trim())) submit(); });
      p.querySelector('#acCancel').addEventListener('click', () => finish({ error: 'Sign-in cancelled.' }));
    });
  }

  /* ══ Confirming the email address ═════════════════════════════════════════ */
  // After signing up with a password, a 6-digit code goes to their inbox — any
  // provider, Gmail or Hotmail or anything else — and the AI stays shut until
  // it is typed here. Resolves true once verified, false if they leave it for
  // later (it comes back on the next launch).
  function askEmailCode(email) {
    return new Promise((resolve) => {
      const p = panel(`
        <div class="ac-eyebrow">CALLISTO &middot; CONFIRM YOUR EMAIL</div>
        <div class="ac-title">Check your inbox</div>
        <p class="ac-sub">We sent a 6-digit code to <b>${esc(email || 'your email')}</b>. Type it here to finish
          creating your account. It can take a minute — check spam if it is not there.</p>
        <label class="ac-label" for="acVcode">Code</label>
        <input class="ac-input code" id="acVcode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" spellcheck="false">
        <div class="ac-msg" id="acMsg" role="status" aria-live="polite"></div>
        <div class="ac-row">
          <button class="ac-btn" id="acGo">Confirm</button>
          <button class="ac-btn ghost" id="acResend">Send a new code</button>
          <button class="ac-btn ghost" id="acLater">Later</button>
        </div>`, { small: true });
      if (root) root.dataset.closable = 'no';
      const code = p.querySelector('#acVcode');
      const msg = p.querySelector('#acMsg');
      const go = p.querySelector('#acGo');
      code.focus();
      const say = (t, cls) => { msg.className = 'ac-msg ' + (cls || ''); msg.textContent = t; };
      const done = (v) => { if (root) root.dataset.closable = 'yes'; close(); resolve(v); };

      const submit = async () => {
        const v = code.value.trim();
        if (!/^\d{6}$/.test(v)) return say('Type the 6 digits from the email.', 'bad');
        go.disabled = true; say('Checking…');
        const r = await call('POST', '/auth/email/verify', { code: v });
        if (r && r.ok) { say('Email confirmed.', 'good'); return setTimeout(() => done(true), 600); }
        go.disabled = false; say((r && r.error) || 'That did not work.', 'bad'); code.select();
      };
      go.addEventListener('click', submit);
      code.addEventListener('input', () => { if (/^\d{6}$/.test(code.value.trim())) submit(); });
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      p.querySelector('#acResend').addEventListener('click', async (e) => {
        e.target.disabled = true;
        const r = await call('POST', '/auth/email/send');
        say(r && r.ok ? 'A new code is on its way.' : ((r && r.error) || 'Could not send.'), r && r.ok ? 'good' : 'bad');
        setTimeout(() => { e.target.disabled = false; }, 60000);
      });
      p.querySelector('#acLater').addEventListener('click', () => done(false));
    });
  }

  /* ══ Forgotten password ═══════════════════════════════════════════════════ */
  function forgot(prefill) {
    const p = panel(`
      <div class="ac-eyebrow">CALLISTO &middot; PASSWORD</div>
      <div class="ac-title">Reset your password</div>
      <p class="ac-sub">We will email you a link to choose a new one. It works once and lasts 30 minutes.
        This also unlocks an account that was locked after wrong passwords.</p>
      <label class="ac-label" for="acEmail">Email</label>
      <input class="ac-input" id="acEmail" type="email" autocomplete="email" spellcheck="false" value="${esc(prefill || '')}">
      <div class="ac-msg" id="acMsg" role="status" aria-live="polite"></div>
      <div class="ac-row">
        <button class="ac-btn" id="acGo">Send reset link</button>
        <button class="ac-btn ghost" id="acCancel">Close</button>
      </div>`, { small: true });
    const email = p.querySelector('#acEmail');
    const msg = p.querySelector('#acMsg');
    const go = p.querySelector('#acGo');
    email.focus();
    const send = async () => {
      const v = email.value.trim();
      if (!v) { msg.className = 'ac-msg bad'; msg.textContent = 'Type your email address.'; return; }
      go.disabled = true; msg.className = 'ac-msg'; msg.textContent = 'Sending…';
      const r = await window.jarvis.authForgot(v);
      if (r && r.error) { go.disabled = false; msg.className = 'ac-msg bad'; msg.textContent = r.error; return; }
      msg.className = 'ac-msg good';
      msg.textContent = (r && r.message) || 'If that address has an account, a reset link is on its way.';
      go.textContent = 'Sent';
    };
    go.addEventListener('click', send);
    email.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    p.querySelector('#acCancel').addEventListener('click', close);
  }

  /* ══ The settings screen ══════════════════════════════════════════════════ */
  async function open() {
    const p = panel(`
      <div class="ac-eyebrow">CALLISTO &middot; ACCOUNT</div>
      <div class="ac-title">Account &amp; security</div>
      <p class="ac-sub" id="acWho">Loading…</p>
      <div id="acBody"></div>
      <div class="ac-row" style="margin-top:18px"><button class="ac-btn ghost" id="acDone">Done</button></div>`);
    p.querySelector('#acDone').addEventListener('click', close);

    const [meR, sesR, billR] = await Promise.all([
      call('GET', '/auth/me'), call('GET', '/auth/sessions'), call('GET', '/billing/status'),
    ]);
    if (meR && meR.needsLogin) {
      p.querySelector('#acWho').textContent = 'Please sign in again to manage your account.';
      return;
    }
    const me = (meR && (meR.user || meR)) || {};
    p.querySelector('#acWho').textContent = me.email ? 'Signed in as ' + me.email : '';
    const body = p.querySelector('#acBody');
    body.innerHTML = '';
    body.appendChild(twoFactorSection(me));
    body.appendChild(devicesSection(sesR));
    body.appendChild(billingSection(billR, me));
    body.appendChild(deleteSection(me));
  }

  function section(html) {
    const d = document.createElement('div');
    d.className = 'ac-sec';
    d.innerHTML = html;
    return d;
  }

  /* ── Two-factor ─────────────────────────────────────────────────────────── */
  function twoFactorSection(me) {
    const on = !!me.twoFactorEnabled;
    const s = section(`
      <h3>Two-factor sign-in <span class="ac-pill ${on ? 'on' : 'off'}">${on ? 'ON' : 'OFF'}</span></h3>
      <p class="ac-text">${on
        ? 'Signing in with your password also needs a code from your authenticator app.'
        : 'Ask for a code from an authenticator app — Google Authenticator, Authy, 1Password — as well as your password, so a stolen password is not enough on its own.'}
        ${me.hasPassword === false ? '<br>You sign in with Google, so turn on 2-Step Verification in your Google account to protect that.' : ''}</p>
      <div id="tfArea"></div>
      <div class="ac-row" id="tfButtons">
        ${on
          ? '<button class="ac-btn ghost" data-act="codes">New backup codes</button><button class="ac-btn danger-ghost" data-act="off">Turn off</button>'
          : (me.hasPassword === false ? '' : '<button class="ac-btn" data-act="on">Turn on</button>')}
      </div>`);
    const area = s.querySelector('#tfArea');
    const buttons = s.querySelector('#tfButtons');

    s.addEventListener('click', async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'on') return startSetup();
      if (act === 'off') return askThenDo('off');
      if (act === 'codes') return askThenDo('codes');
    });

    async function startSetup() {
      buttons.innerHTML = '';
      area.innerHTML = '<p class="ac-text">Setting up…</p>';
      const r = await call('POST', '/auth/2fa/setup');
      if (!r || r.error) { area.innerHTML = `<p class="ac-msg bad">${esc((r && r.error) || 'That did not work.')}</p>`; return; }
      area.innerHTML = `
        <p class="ac-text"><b>1.</b> Scan this with your authenticator app, or type the key in by hand.</p>
        <div class="ac-qr"><img alt="QR code for your authenticator app" src="${esc(r.qr)}">
          <div style="flex:1;min-width:180px"><div class="ac-label" style="margin-top:0">Key</div>
          <div class="ac-secret">${esc(r.secret)}</div></div></div>
        <p class="ac-text"><b>2.</b> Type the 6-digit code it shows.</p>
        <input class="ac-input code" id="tfCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
        <div class="ac-msg" id="tfMsg" role="status" aria-live="polite"></div>
        <div class="ac-row"><button class="ac-btn" id="tfConfirm">Turn on</button></div>`;
      const input = area.querySelector('#tfCode');
      const msg = area.querySelector('#tfMsg');
      input.focus();
      const confirm = async () => {
        const btn = area.querySelector('#tfConfirm');
        btn.disabled = true; msg.className = 'ac-msg'; msg.textContent = 'Checking…';
        const res = await call('POST', '/auth/2fa/enable', { code: input.value.trim() });
        if (!res || res.error) { btn.disabled = false; msg.className = 'ac-msg bad'; msg.textContent = (res && res.error) || 'That did not work.'; return; }
        showBackupCodes(res.backupCodes, 'Two-factor is on.');
      };
      area.querySelector('#tfConfirm').addEventListener('click', confirm);
      input.addEventListener('input', () => { if (/^\d{6}$/.test(input.value.trim())) confirm(); });
    }

    function showBackupCodes(codes, lead) {
      if (root) root.dataset.closable = 'no';          // do not let these be dismissed by accident
      area.innerHTML = `
        <p class="ac-msg good">${esc(lead)}</p>
        <p class="ac-text"><b>Save these backup codes now.</b> Each one signs you in once if you lose your phone.
          They will not be shown again.</p>
        <div class="ac-codes">${(codes || []).map((c) => `<span>${esc(c)}</span>`).join('')}</div>
        <div class="ac-row">
          <button class="ac-btn ghost" id="tfCopy">Copy them</button>
          <button class="ac-btn" id="tfSaved">I have saved them</button>
        </div>`;
      area.querySelector('#tfCopy').addEventListener('click', (e) => {
        try { navigator.clipboard.writeText((codes || []).join('\n')); e.target.textContent = 'Copied'; } catch (_) {}
      });
      area.querySelector('#tfSaved').addEventListener('click', () => { if (root) root.dataset.closable = 'yes'; open(); });
    }

    // Turning it off, or new backup codes: proven with password and code.
    function askThenDo(what) {
      buttons.innerHTML = '';
      area.innerHTML = `
        <p class="ac-text">${what === 'off'
          ? 'Turning this off makes your password the only thing needed to sign in.'
          : 'New codes replace the old ones, which stop working.'}</p>
        ${what === 'off' ? '<label class="ac-label" for="tfPw">Password</label><input class="ac-input" id="tfPw" type="password" autocomplete="current-password">' : ''}
        <label class="ac-label" for="tfC">Code from your app (or a backup code)</label>
        <input class="ac-input" id="tfC" autocomplete="one-time-code">
        <div class="ac-msg" id="tfMsg" role="status" aria-live="polite"></div>
        <div class="ac-row">
          <button class="ac-btn ${what === 'off' ? 'danger' : ''}" id="tfDo">${what === 'off' ? 'Turn off two-factor' : 'Make new codes'}</button>
          <button class="ac-btn ghost" id="tfBack">Cancel</button>
        </div>`;
      const msg = area.querySelector('#tfMsg');
      area.querySelector('#tfBack').addEventListener('click', open);
      area.querySelector('#tfDo').addEventListener('click', async (e) => {
        e.target.disabled = true; msg.className = 'ac-msg'; msg.textContent = 'One moment…';
        const pwEl = area.querySelector('#tfPw');
        const payload = { code: area.querySelector('#tfC').value.trim(), ...(pwEl ? { password: pwEl.value } : {}) };
        const r = await call('POST', what === 'off' ? '/auth/2fa/disable' : '/auth/2fa/backup-codes', payload);
        if (!r || r.error) { e.target.disabled = false; msg.className = 'ac-msg bad'; msg.textContent = (r && r.error) || 'That did not work.'; return; }
        if (what === 'codes') return showBackupCodes(r.backupCodes, 'New backup codes made.');
        open();
      });
    }
    return s;
  }

  /* ── Devices ────────────────────────────────────────────────────────────── */
  function devicesSection(r) {
    const list = (r && r.sessions) || [];
    const rows = list.map((d) => `
      <div class="ac-dev">
        <div class="ac-dev-main">
          <div class="ac-dev-name">${esc(d.device)}${d.current ? ' <span class="ac-pill on">THIS DEVICE</span>' : ''}</div>
          <div class="ac-dev-meta">Signed in ${esc(fmtDate(d.signedInAt))} · last seen ${esc(ago(d.lastSeenAt))}${d.from ? ' · ' + esc(d.from) : ''}</div>
        </div>
        ${d.current ? '' : `<button class="ac-btn danger-ghost" data-end="${esc(d.id)}">Sign out</button>`}
      </div>`).join('');
    const s = section(`
      <h3>Devices signed in</h3>
      <p class="ac-text">Anything you do not recognise, sign it out — then change your password.</p>
      <div>${rows || '<p class="ac-text">No devices to show.</p>'}</div>
      ${r && r.note ? `<p class="ac-text" style="margin-top:8px">${esc(r.note)}</p>` : ''}
      <div class="ac-msg" id="devMsg" role="status" aria-live="polite"></div>
      <div class="ac-row">
        <button class="ac-btn ghost" data-all="keep">Sign out all other devices</button>
        <button class="ac-btn danger-ghost" data-all="all">Sign out everywhere</button>
      </div>`);
    const msg = s.querySelector('#devMsg');
    s.addEventListener('click', async (e) => {
      const end = e.target.dataset && e.target.dataset.end;
      const all = e.target.dataset && e.target.dataset.all;
      if (end) {
        e.target.disabled = true;
        const res = await call('DELETE', '/auth/sessions/' + end);
        if (res && res.ok) open();
        else { e.target.disabled = false; msg.className = 'ac-msg bad'; msg.textContent = (res && res.error) || 'That did not work.'; }
      }
      if (all) {
        const keep = all === 'keep';
        if (!keep && !window.confirm('Sign out of every device, including this one?')) return;
        e.target.disabled = true;
        const res = await call('POST', '/auth/sessions/signout-everywhere', { keepThisDevice: keep });
        if (!res || !res.ok) { e.target.disabled = false; msg.className = 'ac-msg bad'; msg.textContent = (res && res.error) || 'That did not work.'; return; }
        if (keep) { msg.className = 'ac-msg good'; msg.textContent = 'Every other device has been signed out.'; setTimeout(open, 900); }
        else { close(); window.location.reload(); }
      }
    });
    return s;
  }

  /* ── Subscription ───────────────────────────────────────────────────────── */
  function billingSection(b, me) {
    if (me.freeAccess) {
      return section('<h3>Subscription <span class="ac-pill on">FREE ACCESS</span></h3><p class="ac-text">Your account has premium without a subscription.</p>');
    }
    if (!b || b.error) {
      return section(`<h3>Subscription</h3><p class="ac-text">${esc((b && b.error) || 'Could not load your subscription.')}</p>`);
    }
    let pill, text, btn;
    if (b.active && b.cancelAtPeriodEnd) {
      pill = '<span class="ac-pill warn">ENDING</span>';
      text = `Premium stays on until <b>${esc(fmtDate(b.currentPeriodEnd))}</b>, then your account moves to the free plan. You will not be charged again.`;
      btn = '<button class="ac-btn" data-bill="resume">Keep my subscription</button>';
    } else if (b.active) {
      pill = '<span class="ac-pill on">PREMIUM</span>';
      text = `Renews on ${esc(fmtDate(b.currentPeriodEnd))}. If you end it, you keep premium until then and are not charged again.`;
      btn = '<button class="ac-btn danger-ghost" data-bill="cancel">End subscription</button>';
    } else {
      pill = '<span class="ac-pill off">FREE PLAN</span>';
      text = 'You are on the free plan — 15 messages a day.';
      btn = '';
    }
    const s = section(`
      <h3>Subscription ${pill}</h3>
      <p class="ac-text">${text}</p>
      <div class="ac-msg" id="billMsg" role="status" aria-live="polite"></div>
      <div class="ac-row">${btn}</div>`);
    const msg = s.querySelector('#billMsg');
    s.addEventListener('click', async (e) => {
      const act = e.target.dataset && e.target.dataset.bill;
      if (!act) return;
      if (act === 'cancel' && !window.confirm('End your subscription? You keep premium until ' + fmtDate(b.currentPeriodEnd) + '.')) return;
      e.target.disabled = true; msg.className = 'ac-msg'; msg.textContent = 'One moment…';
      const r = await call('POST', act === 'cancel' ? '/billing/cancel' : '/billing/resume');
      if (!r || r.error) { e.target.disabled = false; msg.className = 'ac-msg bad'; msg.textContent = (r && r.error) || 'That did not work.'; return; }
      open();
    });
    return s;
  }

  /* ── Deleting the account ──────────────────────────────────────────────── */
  function deleteSection(me) {
    const s = section(`
      <h3>Delete account</h3>
      <div class="ac-danger">
        <p class="ac-text" style="margin:0">Deletes your account and everything in it — your connected accounts, settings and history.
          Any subscription is cancelled first, so you are not charged again. This cannot be undone.</p>
        <div id="delArea"><div class="ac-row"><button class="ac-btn danger-ghost" id="delStart">Delete my account…</button></div></div>
      </div>`);
    s.querySelector('#delStart').addEventListener('click', () => {
      const area = s.querySelector('#delArea');
      area.innerHTML = `
        ${me.hasPassword !== false ? '<label class="ac-label" for="delPw">Password</label><input class="ac-input" id="delPw" type="password" autocomplete="current-password">' : ''}
        ${me.twoFactorEnabled ? '<label class="ac-label" for="delCode">Two-factor code</label><input class="ac-input" id="delCode" autocomplete="one-time-code">' : ''}
        <label class="ac-label" for="delConfirm">Type <b>DELETE</b> to confirm</label>
        <input class="ac-input" id="delConfirm" autocomplete="off" spellcheck="false">
        <div class="ac-msg" id="delMsg" role="status" aria-live="polite"></div>
        <div class="ac-row">
          <button class="ac-btn danger" id="delGo" disabled>Delete my account for good</button>
          <button class="ac-btn ghost" id="delBack">Cancel</button>
        </div>`;
      const confirmEl = area.querySelector('#delConfirm');
      const go = area.querySelector('#delGo');
      const msg = area.querySelector('#delMsg');
      confirmEl.addEventListener('input', () => { go.disabled = confirmEl.value !== 'DELETE'; });
      area.querySelector('#delBack').addEventListener('click', open);
      go.addEventListener('click', async () => {
        go.disabled = true; msg.className = 'ac-msg'; msg.textContent = 'Deleting…';
        const pw = area.querySelector('#delPw');
        const code = area.querySelector('#delCode');
        const r = await call('POST', '/auth/account/delete', {
          confirm: confirmEl.value,
          ...(pw ? { password: pw.value } : {}),
          ...(code ? { code: code.value.trim() } : {}),
        });
        if (!r || !r.ok) { go.disabled = false; msg.className = 'ac-msg bad'; msg.textContent = (r && r.error) || 'That did not work.'; return; }
        msg.className = 'ac-msg good';
        msg.textContent = 'Your account has been deleted.';
        setTimeout(() => { close(); window.location.reload(); }, 1600);
      });
    });
    return s;
  }

  window.CallistoAccount = { open, close, forgot, askTwoFactor, askEmailCode };
  // The tray's Account & security item.
  try { window.jarvis && window.jarvis.onAccountOpen && window.jarvis.onAccountOpen(open); } catch (_) {}
})();
