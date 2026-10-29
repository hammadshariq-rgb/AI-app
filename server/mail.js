// ── Outgoing email ────────────────────────────────────────────────────────────
// Two letters, sent from Callisto's own Gmail: one when somebody makes an
// account, one when somebody buys Premium.
//
// Nothing here is allowed to break the thing that triggered it. An account must
// still be created and a payment must still be recorded if Gmail is down, if
// the app password has been revoked, or if the address is simply not configured
// yet - so every send is fire-and-forget and every failure is logged and
// swallowed. Callers do not await these.
//
// Configure with two Railway variables (never committed):
//   MAIL_USER  the Gmail address, e.g. callisto.ai.help@gmail.com
//   MAIL_PASS  a Google App Password for that account - NOT the real password
// Google only issues App Passwords to accounts with 2-Step Verification on.

// This container has no route to IPv6. Node otherwise prefers AAAA records,
// so every connection to smtp.gmail.com went to 2607:f8b0:... and died with
// ENETUNREACH before Gmail was ever reached. Setting the resolution order is
// the blunt version of the per-socket lookup below; both are here because the
// per-socket one alone did not take.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (_) {}

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {
  // Dependency not installed in this environment; sends become no-ops below.
}

const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || '';
// What recipients see in the From line. The address still has to be the Gmail
// account itself - Gmail rewrites anything else.
const MAIL_FROM = process.env.MAIL_FROM || (MAIL_USER ? `Callisto AI <${MAIL_USER}>` : '');

let transport = null;
let warned = false;

function ready() {
  if (!nodemailer || !MAIL_USER || !MAIL_PASS) {
    if (!warned) {
      warned = true;
      console.log('[mail] not configured - set MAIL_USER and MAIL_PASS to send welcome and purchase emails');
    }
    return null;
  }
  if (!transport) {
    transport = nodemailer.createTransport({
      // Spelled out rather than service:'gmail', so the address family can be
      // pinned. Node resolves smtp.gmail.com to IPv6 first and the container
      // has no IPv6 route, so every connection died with
      //   connect ENETUNREACH 2607:f8b0:4023:c03::6d:465
      // before it ever spoke to Gmail. family:4 keeps it on IPv4.
      host: 'smtp.gmail.com',
      // 587 with STARTTLS rather than 465 with implicit TLS. Once the IPv6
      // problem was out of the way, 465 reported a plain connection timeout -
      // the port is filtered outbound here. 587 is the one hosts usually
      // leave open, and Gmail serves the same thing on it.
      port: 587,
      secure: false,
      requireTLS: true,
      // family alone was not enough - connections still went out to
      // 2607:f8b0:... and died. Overriding the lookup forces the resolver
      // itself to return A records only, so there is no IPv6 address to try.
      family: 4,
      lookup: (hostname, options, callback) =>
        require('dns').lookup(hostname, { ...options, family: 4, all: false }, callback),
      auth: { user: MAIL_USER, pass: MAIL_PASS },
      // Without these a blocked or stalled SMTP connection hangs rather than
      // failing, and every send sits open waiting on a socket that will never
      // answer. Some hosts block outbound SMTP entirely; better to find that
      // out in ten seconds than never.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    // Say once, at startup, whether Gmail actually accepts these credentials.
    // Without this the first sign of a wrong address or a revoked App Password
    // is a letter that never arrives, with nothing in the logs until somebody
    // happens to make an account.
    transport.verify()
      .then(() => console.log('[mail] Gmail accepted the credentials for', MAIL_USER))
      .catch((err) => {
        console.error('[mail] Gmail REFUSED the credentials for', MAIL_USER, '-', err.message);
        if (/Username and Password not accepted|BadCredentials|535/i.test(err.message || '')) {
          console.error('[mail] Check: (1) MAIL_USER must be an address you can sign into at ' +
            'mail.google.com - a forwarding alias on your domain is not a Google account; ' +
            '(2) MAIL_PASS must be a 16-character Google App Password, not the real password; ' +
            '(3) 2-Step Verification must be on for that account.');
        }
      });
  }
  return transport;
}

// A first name to open with, from whatever we were given. "there" is the
// fallback because "Hi ," reads like a mistake.
function firstName(name, email) {
  const from = String(name || '').trim() || String(email || '').split('@')[0] || '';
  const word = from.split(/[\s.]+/)[0] || '';
  if (!word || word.length > 24) return 'there';
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// One shell for both letters, so they look like they came from the same place.
function wrap(heading, bodyHtml) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#05070f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05070f;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0b1020;border:1px solid rgba(120,150,255,0.18);border-radius:18px;padding:34px 30px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#c9d6ff">
        <tr><td style="font-size:12px;letter-spacing:2px;color:rgba(130,160,255,0.65);padding-bottom:18px">CALLISTO AI</td></tr>
        <tr><td style="font-size:23px;line-height:1.3;font-weight:700;color:#eef3ff;padding-bottom:16px">${heading}</td></tr>
        <tr><td style="font-size:15px;line-height:1.65;color:rgba(201,214,255,0.86)">${bodyHtml}</td></tr>
        <tr><td style="padding-top:28px;border-top:1px solid rgba(120,150,255,0.12);font-size:12px;line-height:1.6;color:rgba(130,160,255,0.45)">
          callistoai.net<br>You are getting this because you made a Callisto AI account.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── Sending over HTTPS instead of SMTP ────────────────────────────────────────
// Railway gives this container no route to IPv6 and will not let an SMTP
// connection out on 465 either, so Gmail by SMTP cannot work here however it is
// configured - measured, not assumed:
//
//   465 over IPv4 -> connection timeout
//   587 over IPv6 -> ENETUNREACH 2607:f8b0:...
//
// An email API answers on 443, which is the one port every host leaves open.
// Set RESEND_API_KEY and this is used; leave it unset and the SMTP path below
// still runs, for anywhere that does allow it.
const RESEND_KEY = process.env.RESEND_API_KEY || '';

async function sendViaHttp(to, subject, html, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + RESEND_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = (body && (body.message || body.error)) || ('HTTP ' + res.status);
    throw new Error(String(why).slice(0, 200));
  }
  return body;
}

// Addresses are masked in the log — logs are kept and read far more widely
// than the database, and a customer list should not be assembled from them.
const masked = (e) => { const s = String(e || ''); const at = s.indexOf('@'); return at > 0 ? s[0] + '***' + s.slice(at) : '***'; };

async function send(to, subject, heading, bodyHtml, bodyText) {
  if (!to) return false;
  const html = wrap(heading, bodyHtml);

  // HTTPS first where it is configured, because it is the one that works here.
  if (RESEND_KEY) {
    try {
      await sendViaHttp(to, subject, html, bodyText);
      console.log('[mail] sent over HTTPS:', subject, '->', masked(to));
      return true;
    } catch (err) {
      console.error('[mail] HTTPS send failed for', masked(to), '-', err.message);
      return false;
    }
  }

  const t = ready();
  if (!t) return false;
  try {
    await t.sendMail({ from: MAIL_FROM, to, subject, text: bodyText, html });
    console.log('[mail] sent over SMTP:', subject, '->', masked(to));
    return true;
  } catch (err) {
    console.error('[mail] SMTP send failed for', masked(to), '-', err.message);
    return false;
  }
}

// ── Signup verification code ─────────────────────────────────────────────────
function sendVerificationCode({ email, name, code }) {
  const who = firstName(name, email);
  return send(
    email,
    code + ' is your Callisto AI code',
    'Confirm your email, ' + esc(who),
    'Enter this code in Callisto to finish creating your account:'
      + '<br><br><div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#3d5cff">' + esc(code) + '</div>'
      + '<br>It expires in 15 minutes. If you did not sign up for Callisto AI, ignore this email.',
    'Your Callisto AI code is ' + code + '. It expires in 15 minutes. If you did not sign up, ignore this email.'
  );
}

// ── Password reset ───────────────────────────────────────────────────────────
// The link is the only copy of the reset token — the server keeps a hash — so
// it is sent here and nowhere else, and expires in half an hour.
function sendPasswordReset({ email, name, link }) {
  const who = firstName(name, email);
  return send(
    email,
    'Reset your Callisto AI password',
    `Reset your password, ${esc(who)}`,
    `Someone asked to reset the password on your Callisto AI account. If it was you, this link sets a new one.
     It works once and expires in 30 minutes.
     <br><br><a href="${esc(link)}" style="display:inline-block;background:#3d5cff;color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:600">Choose a new password</a>
     <br><br>If you did not ask for this, ignore this email — your password has not changed, and nobody can change it without this link.`,
    `Someone asked to reset the password on your Callisto AI account.\n\n`
      + `If it was you, open this link to choose a new one. It works once and expires in 30 minutes:\n${link}\n\n`
      + `If you did not ask for this, ignore this email - your password has not changed.`
  );
}

// ── Something changed on the account ─────────────────────────────────────────
// Two-factor switched on or off, the password changed, every device signed
// out, the account deleted. If it was them, this is a receipt. If it was not,
// it is the one way they find out in time to do something.
const NOTICES = {
  '2fa_on': ['Two-factor sign-in is on', 'Two-factor sign-in is now on for your account. You will be asked for a code from your authenticator app each time you sign in with your password.'],
  '2fa_off': ['Two-factor sign-in was turned off', 'Two-factor sign-in has been turned off for your account. If you did not do this, reset your password straight away.'],
  'password_changed': ['Your password was changed', 'The password on your Callisto AI account has just been changed, and every device was signed out. If you did not do this, reset it straight away.'],
  'signed_out_everywhere': ['Signed out everywhere', 'Every device signed in to your Callisto AI account has been signed out.'],
  'account_deleted': ['Your account has been deleted', 'Your Callisto AI account and everything in it has been deleted, and any subscription has been cancelled. There is nothing more you need to do.'],
  'account_locked': ['Your account was locked', 'Someone entered the wrong password for your Callisto AI account three times, so password sign-in is locked for three hours. If it was you, wait or sign in with Google. If it was not, consider resetting your password.'],
};

function sendSecurityNotice({ email, name, kind }) {
  const n = NOTICES[kind];
  if (!n || !email) return Promise.resolve(false);
  const who = firstName(name, email);
  return send(
    email,
    n[0] + ' — Callisto AI',
    `${esc(n[0])}`,
    `Hi ${esc(who)}, ${esc(n[1])}<br><br><span style="opacity:.6;font-size:13px">Sent ${esc(new Date().toUTCString())}.</span>`,
    `Hi ${who}, ${n[1]}\n\nSent ${new Date().toUTCString()}.`
  );
}

// ── When an account is made ───────────────────────────────────────────────────
// Deliberately not a purchase email: most new accounts are on the free plan,
// and congratulating someone on a purchase they have not made is the kind of
// thing people forward to each other as a joke.
function sendWelcome({ email, name }) {
  const who = firstName(name, email);
  return send(
    email,
    'Welcome to Callisto AI',
    `Welcome, ${esc(who)}.`,
    `Your Callisto AI account is ready. Sign in on the desktop app or at callistoai.net and just start talking to it.
     <br><br>You are on the free plan: <strong>15 messages a day</strong>, weather and live news, image recognition and the homework helper.
     Premium removes the daily limit and opens voice control, calendar sync, documents, 3D Studio and AI video - US$20 a month or US$200 a year.
     <br><br>Enjoy Callisto AI.`,
    `Welcome, ${who}.\n\nYour Callisto AI account is ready. Sign in on the desktop app or at callistoai.net and just start talking to it.\n\nYou are on the free plan: 15 messages a day. Premium removes the daily limit - US$20/month or US$200/year.\n\nEnjoy Callisto AI.`
  );
}

// ── When somebody buys Premium ────────────────────────────────────────────────
function sendPurchase({ email, name, plan }) {
  const who = firstName(name, email);
  const priced = plan === 'annual'
    ? 'Premium Yearly - US$200 a year'
    : 'Premium - US$20 a month';
  return send(
    email,
    'Congratulations on your purchase - Callisto AI Premium',
    `Congratulations, ${esc(who)}.`,
    `Your purchase went through and <strong>${esc(priced)}</strong> is now active on this account.
     <br><br>The daily message limit is gone, and everything is open: voice control, memory, Google Calendar sync, music control,
     document creation, Magic Vision, Magic Edit, 3D Studio, AI video, and posting straight to YouTube, Instagram and TikTok.
     <br><br>Open the app and it will already know - if it still shows the free plan, sign out and back in once.
     <br><br>Enjoy Callisto AI.`,
    `Congratulations, ${who}.\n\nYour purchase went through and ${priced} is now active on this account.\n\nThe daily message limit is gone and every Premium feature is open.\n\nOpen the app and it will already know - if it still shows the free plan, sign out and back in once.\n\nEnjoy Callisto AI.`
  );
}

// Check at boot rather than on the first signup, so a wrong address or a
// revoked App Password shows up in the deploy logs instead of as a letter
// somebody never received.
ready();

// A yes/no the health endpoint can report, so diagnosing a silent mailbox does
// not mean going hunting through deploy logs. It never returns the address or
// the password - only whether Gmail accepted the credentials, and a short
// reason when it did not.
// Railway sets this; it is how we tell whether a push has actually rolled out.
const BUILD = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';

async function status() {
  // HTTPS, when configured, is the one that actually works on this host.
  if (RESEND_KEY) {
    try {
      const res = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: 'Bearer ' + RESEND_KEY },
      });
      if (res.ok) {
        return { build: BUILD, transport: 'https', configured: true, verified: true,
                 reason: 'the email API accepted the key', from: MAIL_FROM };
      }
      // A send-only key is not allowed to read /domains, so a 401 here does NOT
      // mean the key is bad - it may be a perfectly good key with the narrower
      // permission, which is the sensible one to give a server that only sends.
      // Saying "rejected" sent the owner off regenerating a working key.
      if (res.status === 401 || res.status === 403) {
        return { build: BUILD, transport: 'https', configured: true, verified: 'unknown',
                 from: MAIL_FROM,
                 reason: 'the key cannot read /domains. That is expected for a send-only key, '
                   + 'so it may still send perfectly well - make an account on the site to find out. '
                   + 'If you gave it full access, then the key really is wrong.' };
      }
      return { build: BUILD, transport: 'https', configured: true, verified: false,
               from: MAIL_FROM,
               reason: 'the email API answered ' + res.status };
    } catch (err) {
      return { build: BUILD, transport: 'https', configured: true, verified: false,
               reason: 'could not reach the email API', detail: String(err.message).slice(0, 140) };
    }
  }
  if (!nodemailer) return { configured: false, verified: false, reason: 'nodemailer-not-installed' };
  if (!MAIL_USER || !MAIL_PASS) {
    return {
      configured: false,
      verified: false,
      reason: !MAIL_USER && !MAIL_PASS ? 'MAIL_USER and MAIL_PASS are both unset'
        : !MAIL_USER ? 'MAIL_USER is unset'
        : 'MAIL_PASS is unset',
    };
  }
  try {
    // Bounded, so a hanging socket reports as a hang instead of timing out the
    // request and telling us nothing.
    await Promise.race([
      ready().verify(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out reaching Gmail')), 12000)),
    ]);
    return { build: BUILD, configured: true, verified: true, reason: 'Gmail accepted the credentials', domain: MAIL_USER.split('@')[1] || '' };
  } catch (err) {
    const m = String(err.message || '');
    return {
      build: BUILD,
      configured: true,
      verified: false,
      domain: MAIL_USER.split('@')[1] || '',
      reason: /535|BadCredentials|Username and Password not accepted/i.test(m)
        ? 'Gmail rejected the credentials - MAIL_USER must be an address that can sign in at mail.google.com, and MAIL_PASS must be a 16-character App Password'
        : /ENETUNREACH/i.test(m) ? 'no route to that address from this host - usually means an IPv6 address on a host with no IPv6'
      : /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|timed out/i.test(m) ? 'could not reach Gmail from the server - the host may be blocking outbound SMTP'
        : 'unknown',
      detail: m.slice(0, 140),
    };
  }
}

// Sends one real letter and reports exactly what came back, so a silent
// mailbox can be diagnosed instead of guessed at. The recipient is fixed by
// MAIL_TEST_TO and cannot be chosen by the caller - an endpoint that sends
// anywhere on request is a spam relay with extra steps.
async function sendTest() {
  const to = process.env.MAIL_TEST_TO || '';
  if (!to) return { ok: false, reason: 'MAIL_TEST_TO is not set, so there is nowhere safe to send a test.' };
  if (!RESEND_KEY) return { ok: false, reason: 'RESEND_API_KEY is not set.' };
  try {
    const r = await sendViaHttp(
      to,
      'Callisto AI test',
      '<p>This is a test from your Callisto server. If you are reading it, outgoing email works.</p>',
      'This is a test from your Callisto server. If you are reading it, outgoing email works.'
    );
    return { ok: true, to, from: MAIL_FROM, id: r && r.id, reason: 'accepted by the email API' };
  } catch (err) {
    return { ok: false, to, from: MAIL_FROM, reason: String(err.message).slice(0, 300) };
  }
}

module.exports = { sendWelcome, sendPurchase, sendPasswordReset, sendSecurityNotice, sendVerificationCode, status, sendTest, configured: () => !!ready() };
