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
      port: 465,
      secure: true,
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

async function send(to, subject, heading, bodyHtml, bodyText) {
  const t = ready();
  if (!t || !to) return false;
  try {
    await t.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text: bodyText,
      html: wrap(heading, bodyHtml),
    });
    console.log('[mail] sent:', subject, '->', to);
    return true;
  } catch (err) {
    console.error('[mail] could not send to', to, '-', err.message);
    return false;
  }
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
     Premium removes the daily limit and opens voice control, calendar sync, documents, 3D Studio and AI video - CA$20 a month or CA$200 a year.
     <br><br>Enjoy Callisto AI.`,
    `Welcome, ${who}.\n\nYour Callisto AI account is ready. Sign in on the desktop app or at callistoai.net and just start talking to it.\n\nYou are on the free plan: 15 messages a day. Premium removes the daily limit - CA$20/month or CA$200/year.\n\nEnjoy Callisto AI.`
  );
}

// ── When somebody buys Premium ────────────────────────────────────────────────
function sendPurchase({ email, name, plan }) {
  const who = firstName(name, email);
  const priced = plan === 'annual'
    ? 'Premium Yearly - CA$200 a year'
    : 'Premium - CA$20 a month';
  return send(
    email,
    'Congratulations on your purchase - Callisto AI Premium',
    `Congratulations, ${esc(who)}.`,
    `Your purchase went through and <strong>${esc(priced)}</strong> is now active on this account.
     <br><br>The daily message limit is gone, and everything is open: voice control, memory and contacts, Google Calendar sync, music control,
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
async function status() {
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
    return { configured: true, verified: true, reason: 'Gmail accepted the credentials', domain: MAIL_USER.split('@')[1] || '' };
  } catch (err) {
    const m = String(err.message || '');
    return {
      configured: true,
      verified: false,
      domain: MAIL_USER.split('@')[1] || '',
      reason: /535|BadCredentials|Username and Password not accepted/i.test(m)
        ? 'Gmail rejected the credentials - MAIL_USER must be an address that can sign in at mail.google.com, and MAIL_PASS must be a 16-character App Password'
        : /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|timed out/i.test(m) ? 'could not reach Gmail from the server - the host may be blocking outbound SMTP'
        : 'unknown',
      detail: m.slice(0, 140),
    };
  }
}

module.exports = { sendWelcome, sendPurchase, status, configured: () => !!ready() };
