// ── Messages, FaceTime and phone calls on a Mac ──────────────────────────────
// Uses the Mac's own apps, the way a person would:
//   - Contacts, to turn "Mum" into a number,
//   - Messages, to send an iMessage or (through their iPhone) a text,
//   - FaceTime, for video and audio calls,
//   - tel: links, which macOS rings through their iPhone ("Calls from iPhone").
//
// Nothing here runs without a press on the card Callisto shows first. Every
// value from the conversation is passed to AppleScript as an argument, never
// pasted into the script, so a name or a message cannot turn into code.
const { execFile } = require('child_process');
const { shell } = require('electron');

function osa(script, args) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script, ...args.map((a) => String(a == null ? '' : a))], { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

const PERMISSION_HINT = 'macOS needs your OK first: open System Settings, Privacy & Security, Automation, and allow Callisto to control Messages and Contacts. Then try again.';
function explain(err) {
  if (/not allowed|not authori[sz]ed|-1743|1002/i.test(err)) return PERMISSION_HINT;
  return err || 'The Mac would not do that just now.';
}

// "Mum" -> [{ name, phones: [{label, value}], emails: [...] }], best matches first.
async function findContacts(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, people: [] };
  const script = `on run argv
  set q to item 1 of argv
  set out to ""
  tell application "Contacts"
    set found to (every person whose name contains q)
    repeat with p in found
      set line_ to (name of p) & "\t"
      repeat with ph in (phones of p)
        set line_ to line_ & (label of ph as text) & "=" & (value of ph) & "|"
      end repeat
      set line_ to line_ & "\t"
      repeat with em in (emails of p)
        set line_ to line_ & (value of em) & "|"
      end repeat
      set out to out & line_ & linefeed
    end repeat
  end tell
  return out
end run`;
  const r = await osa(script, [q]);
  if (!r.ok) return { ok: false, error: explain(r.err) };
  const clean = (l) => String(l || '').replace(/^_\$!<|>!\$_$/g, '').toLowerCase();
  const people = r.out.split(/\r?\n/).filter(Boolean).slice(0, 8).map((line) => {
    const [name, phones = '', emails = ''] = line.split('\t');
    return {
      name,
      phones: phones.split('|').filter(Boolean).map((x) => { const i = x.indexOf('='); return { label: clean(x.slice(0, i)), value: x.slice(i + 1) }; }),
      emails: emails.split('|').filter(Boolean),
    };
  });
  // An exact name first, then "starts with", then the rest.
  const low = q.toLowerCase();
  people.sort((a, b) => (b.name.toLowerCase() === low) - (a.name.toLowerCase() === low) || (b.name.toLowerCase().startsWith(low)) - (a.name.toLowerCase().startsWith(low)));
  return { ok: true, people };
}

// iMessage first; a plain text through their iPhone when asked for, or when
// the person is not on iMessage.
async function sendText(target, text, service) {
  const to = String(target || '').trim(), body = String(text || '').trim();
  if (!to || !body) return { ok: false, error: 'Who to, and what to say?' };
  const script = `on run argv
  set theTarget to item 1 of argv
  set theText to item 2 of argv
  set wantSMS to (item 3 of argv) is "sms"
  tell application "Messages"
    if wantSMS then
      set svc to 1st account whose service type = SMS
    else
      set svc to 1st account whose service type = iMessage
    end if
    try
      send theText to participant theTarget of svc
    on error
      send theText to buddy theTarget of svc
    end try
  end tell
  return "sent"
end run`;
  let r = await osa(script, [to, body, service === 'sms' ? 'sms' : 'imessage']);
  // Not on iMessage: try as a text through their iPhone before giving up.
  if (!r.ok && service !== 'sms' && !/not allowed|-1743/i.test(r.err)) r = await osa(script, [to, body, 'sms']);
  return r.ok ? { ok: true } : { ok: false, error: explain(r.err) };
}

// FaceTime video, FaceTime audio, or a normal call through their iPhone.
async function call(target, kind) {
  const to = String(target || '').replace(/[^\d+@.a-zA-Z_-]/g, '');
  if (!to) return { ok: false, error: 'There is no number or address to call.' };
  const scheme = kind === 'facetime' ? 'facetime://' : kind === 'facetime_audio' ? 'facetime-audio://' : 'tel://';
  try { await shell.openExternal(scheme + to); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { findContacts, sendText, call };
