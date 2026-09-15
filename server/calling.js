// ── AI phone calling (Vapi) ───────────────────────────────────────────────────
// Places a real outbound call, lets the assistant negotiate on the user's behalf,
// and pauses mid-call to ask the user for approval when the other party proposes
// something outside what they authorised.
//
// The approval handshake is the interesting part. Vapi invokes `request_user_approval`
// as a server tool and waits for our HTTP response. We hold that response open while
// we push the question to the desktop app. If the user answers in time we return the
// decision; if not we tell the assistant to stall and ask again, so we never depend on
// a long webhook timeout.

const { getDb } = require('./users');

const VAPI_BASE = 'https://api.vapi.ai';
const VAPI_API_KEY = process.env.VAPI_API_KEY || '';
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || '';
const CALL_WEBHOOK_SECRET = process.env.CALL_WEBHOOK_SECRET || '';

// How long we hold the tool webhook open waiting for the user. Kept well under any
// provider-side tool timeout — if it lapses the assistant simply asks again.
const APPROVAL_HOLD_MS = 20000;
// How long a long-poll from the desktop waits before returning empty.
const POLL_HOLD_MS = 25000;
// Cost control: outbound calls are billed per minute.
const MAX_CALLS_PER_DAY = 10;

// Live call state. Railway runs a single instance, so in-memory is fine for the
// duration of a call; the finished transcript is persisted to Mongo for history.
const calls = new Map();          // callId -> record
const callsByVapiId = new Map();  // vapi call id -> callId
const dailyCount = new Map();     // `${userId}:${YYYY-MM-DD}` -> n

function today() { return new Date().toISOString().slice(0, 10); }

function newId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Normalise to E.164. Returns null if we can't be confident, rather than dialling
// something wrong — a misdialled number is a real-world side effect.
function toE164(raw, defaultCountry = '') {
  let s = String(raw || '').trim();
  if (!s) return null;
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  if (hadPlus) return '+' + s;
  // 00 international prefix
  if (s.startsWith('00')) return '+' + s.slice(2);
  // Bare 10-digit with a known default country code
  if (defaultCountry && s.length >= 7 && s.length <= 11) {
    const cc = String(defaultCountry).replace(/[^\d]/g, '');
    if (cc) return '+' + cc + s.replace(/^0+/, '');
  }
  return null;
}

function pushEvent(rec, event) {
  rec.seq += 1;
  rec.events.push({ seq: rec.seq, at: Date.now(), ...event });
  if (rec.events.length > 200) rec.events.splice(0, rec.events.length - 200);
  // Wake any long-poll waiting on this call
  const waiters = rec.waiters.splice(0, rec.waiters.length);
  for (const w of waiters) w();
}

// ── Assistant definition ──────────────────────────────────────────────────────

function buildSystemPrompt({ goal, constraints, userName, businessName }) {
  return [
    `You are a polite, efficient voice assistant making a phone call on behalf of ${userName || 'the person you work for'}.`,
    businessName ? `You are calling ${businessName}.` : '',
    '',
    'YOUR GOAL:',
    goal,
    '',
    constraints ? `WHAT YOU ARE AUTHORISED TO AGREE TO:\n${constraints}\n` : '',
    'RULES:',
    `1. Disclosure is mandatory. Your very first sentence must make clear you are an automated assistant calling on behalf of ${userName || 'a client'}. Never imply you are a human. If asked directly whether you are a real person, say plainly that you are an AI assistant.`,
    '2. Speak the way a person does on the phone: short turns, one question at a time. Never deliver a paragraph. Wait for them to finish before replying.',
    '3. If they offer something that differs from your goal or falls outside what you are authorised to agree to — a different time, a different date, a different size, an extra cost, a waitlist instead of a booking — you MUST call the request_user_approval tool. Do not accept or refuse it yourself.',
    '4. Just before calling that tool, tell them naturally that you are checking: "Let me confirm that with them, one moment please." Then call the tool.',
    '5. If the tool result says the user has not answered yet, apologise for the wait, keep them engaged briefly, and call the tool again. Never invent an answer and never guess what the user would want.',
    '6. If the tool result is an approval, accept the offer clearly. If it is a refusal, decline politely and either propose the alternative you were given or ask what else is available.',
    '7. Before hanging up, read the final agreed details back to them and get a confirmation.',
    '8. Never share personal information beyond what is needed — a first name and a contact number if they ask for one. Never share payment details; if payment is required, say the user will handle it directly.',
    '9. If you reach voicemail, an IVR menu you cannot navigate, or the wrong business, do not leave sensitive details. End the call and report what happened.',
    '10. Keep the whole call brief and respectful of their time.',
  ].filter(Boolean).join('\n');
}

function buildAssistant({ goal, constraints, userName, businessName, publicUrl }) {
  const toolServer = {
    url: `${publicUrl}/calls/tool`,
    secret: CALL_WEBHOOK_SECRET,
    timeoutSeconds: Math.ceil(APPROVAL_HOLD_MS / 1000) + 5,
  };

  return {
    name: 'Callisto Assistant',
    firstMessage: `Hi, I'm an automated assistant calling on behalf of ${userName || 'one of my clients'}. Do you have a quick moment?`,
    // Let the callee speak first if they answer with "Hello, Luigi's?"
    firstMessageMode: 'assistant-speaks-first',
    maxDurationSeconds: 600,
    silenceTimeoutSeconds: 30,
    endCallPhrases: ['goodbye', 'bye bye', 'have a good day', 'thanks for your help'],
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.4,
      messages: [
        { role: 'system', content: buildSystemPrompt({ goal, constraints, userName, businessName }) },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'request_user_approval',
            description:
              'Ask the user (the person you are calling on behalf of) to approve something the other party proposed that differs from the original goal or falls outside what you were authorised to agree to. Call this before accepting any such change.',
            parameters: {
              type: 'object',
              properties: {
                proposal: {
                  type: 'string',
                  description: 'The specific alternative being offered, in plain language. For example: "7:00 PM instead of 6:00 PM, same date".',
                },
                reason: {
                  type: 'string',
                  description: 'Why the original request could not be met. For example: "They are fully booked at 6 PM".',
                },
              },
              required: ['proposal'],
            },
          },
          server: toolServer,
        },
      ],
    },
    voice: { provider: 'vapi', voiceId: 'Elliot' },
    server: { url: `${publicUrl}/calls/webhook`, secret: CALL_WEBHOOK_SECRET },
    serverMessages: ['status-update', 'end-of-call-report', 'hang', 'tool-calls'],
  };
}

async function vapi(path, options = {}) {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.message || body?.error || `Vapi ${res.status}`;
    throw new Error(Array.isArray(msg) ? msg.join('; ') : String(msg));
  }
  return body;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// `resolvePublicUrl(req)` is passed in rather than a bare string because PUBLIC_URL
// may only be known once the first request arrives.
function mountCalling(app, { authMiddleware, resolvePublicUrl }) {
  const configured = !!(VAPI_API_KEY && VAPI_PHONE_NUMBER_ID);

  // Lets the desktop app grey out the feature instead of failing at call time.
  app.get('/calls/config', authMiddleware, (_req, res) => {
    res.json({ ok: true, enabled: configured });
  });

  // ── Start a call ───────────────────────────────────────────────────────────
  app.post('/calls/start', authMiddleware, async (req, res) => {
    try {
      if (!configured) {
        return res.status(503).json({ error: "Phone calls aren't available yet — they're being switched on soon." });
      }
      const { phone, goal, constraints, businessName, userName, defaultCountry } = req.body || {};

      if (!goal || !String(goal).trim()) {
        return res.status(400).json({ error: 'Tell me what the call should accomplish.' });
      }
      const number = toE164(phone, defaultCountry);
      if (!number) {
        return res.status(400).json({
          error: 'That phone number needs a country code — save it in international format, like +1 555 123 4567.',
        });
      }

      const key = `${req.userId}:${today()}`;
      const used = dailyCount.get(key) || 0;
      if (used >= MAX_CALLS_PER_DAY) {
        return res.status(429).json({ error: `You've reached the limit of ${MAX_CALLS_PER_DAY} calls today.` });
      }

      const id = newId();
      const rec = {
        id,
        userId: req.userId,
        vapiCallId: null,
        phone: number,
        businessName: businessName || '',
        goal: String(goal).trim(),
        constraints: String(constraints || '').trim(),
        status: 'dialing',
        seq: 0,
        events: [],
        waiters: [],
        pendingApproval: null,
        transcript: '',
        summary: '',
        endedReason: '',
        createdAt: Date.now(),
      };
      calls.set(id, rec);
      dailyCount.set(key, used + 1);
      pushEvent(rec, { type: 'status', status: 'dialing' });

      const assistant = buildAssistant({
        goal: rec.goal,
        constraints: rec.constraints,
        userName,
        businessName: rec.businessName,
        publicUrl: resolvePublicUrl(req),
      });

      let created;
      try {
        created = await vapi('/call', {
          method: 'POST',
          body: JSON.stringify({
            phoneNumberId: VAPI_PHONE_NUMBER_ID,
            customer: { number },
            assistant,
            metadata: { callId: id, userId: req.userId },
          }),
        });
      } catch (err) {
        rec.status = 'failed';
        rec.endedReason = err.message;
        pushEvent(rec, { type: 'ended', status: 'failed', reason: err.message });
        return res.status(502).json({ error: `Couldn't place the call: ${err.message}` });
      }

      rec.vapiCallId = created?.id || null;
      if (rec.vapiCallId) callsByVapiId.set(rec.vapiCallId, id);

      res.json({ ok: true, callId: id, status: rec.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Vapi server tool: request_user_approval ────────────────────────────────
  // Held open while we wait for the user. Always answers with something the
  // assistant can act on, even on timeout.
  app.post('/calls/tool', async (req, res) => {
    if (CALL_WEBHOOK_SECRET) {
      const sent = req.headers['x-vapi-secret'] || req.headers['x-vapi-signature'] || '';
      if (sent !== CALL_WEBHOOK_SECRET) return res.status(401).json({ error: 'bad secret' });
    }

    const msg = req.body?.message || {};
    const toolCall = (msg.toolCallList || msg.toolCalls || [])[0] || msg.functionCall || null;
    const toolCallId = toolCall?.id || msg.toolCallId || null;

    let args = toolCall?.function?.arguments ?? toolCall?.parameters ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }

    const rec = findRecord(msg);
    const reply = (result) => res.json({ results: [{ toolCallId, result }] });

    if (!rec) return reply('Could not reach the user right now. Do not accept the change; tell them you will follow up.');

    const proposal = String(args.proposal || '').trim() || 'a change to the original request';
    const reason = String(args.reason || '').trim();

    // Re-ask for an approval that is already outstanding rather than stacking duplicates
    if (rec.pendingApproval && rec.pendingApproval.proposal === proposal) {
      const decided = await waitForDecision(rec, APPROVAL_HOLD_MS);
      return reply(decisionToResult(decided));
    }

    rec.pendingApproval = {
      id: 'a_' + newId(),
      proposal,
      reason,
      decision: null,
      askedAt: Date.now(),
    };
    pushEvent(rec, { type: 'approval_needed', approval: { ...rec.pendingApproval } });

    const decided = await waitForDecision(rec, APPROVAL_HOLD_MS);
    return reply(decisionToResult(decided));
  });

  // ── Vapi status / end-of-call webhook ──────────────────────────────────────
  app.post('/calls/webhook', async (req, res) => {
    if (CALL_WEBHOOK_SECRET) {
      const sent = req.headers['x-vapi-secret'] || req.headers['x-vapi-signature'] || '';
      if (sent !== CALL_WEBHOOK_SECRET) return res.status(401).json({ error: 'bad secret' });
    }
    res.json({ ok: true }); // acknowledge fast; process below

    try {
      const msg = req.body?.message || {};
      const rec = findRecord(msg);
      if (!rec) return;

      if (msg.type === 'status-update') {
        const s = msg.status || '';
        const map = { queued: 'dialing', ringing: 'ringing', 'in-progress': 'connected', forwarding: 'connected', ended: 'ended' };
        rec.status = map[s] || rec.status;
        pushEvent(rec, { type: 'status', status: rec.status });
      }

      if (msg.type === 'end-of-call-report') {
        rec.status = 'ended';
        rec.endedReason = msg.endedReason || '';
        rec.summary = msg.analysis?.summary || msg.summary || '';
        rec.transcript = msg.artifact?.transcript || msg.transcript || '';
        // Unblock anything still waiting — the call is over
        if (rec.pendingApproval && !rec.pendingApproval.decision) {
          rec.pendingApproval.decision = { approved: false, note: 'call ended' };
        }
        pushEvent(rec, {
          type: 'ended',
          status: 'ended',
          reason: rec.endedReason,
          summary: rec.summary,
          transcript: rec.transcript,
        });
        persist(rec).catch(() => {});
        // Keep briefly so the desktop can drain events, then drop
        setTimeout(() => {
          calls.delete(rec.id);
          if (rec.vapiCallId) callsByVapiId.delete(rec.vapiCallId);
        }, 5 * 60 * 1000);
      }
    } catch (_) { /* webhook already acknowledged */ }
  });

  // ── Desktop: answer a pending approval ─────────────────────────────────────
  app.post('/calls/:id/respond', authMiddleware, (req, res) => {
    const rec = calls.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Call not found or already finished.' });
    if (rec.userId !== req.userId) return res.status(403).json({ error: 'Not your call.' });
    if (!rec.pendingApproval) return res.status(409).json({ error: 'Nothing is waiting for approval.' });

    const approved = !!req.body?.approved;
    const note = String(req.body?.note || '').trim();
    rec.pendingApproval.decision = { approved, note };
    pushEvent(rec, { type: 'approval_resolved', approved, note });
    res.json({ ok: true });
  });

  // ── Desktop: end the call early ────────────────────────────────────────────
  app.post('/calls/:id/hangup', authMiddleware, async (req, res) => {
    const rec = calls.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Call not found.' });
    if (rec.userId !== req.userId) return res.status(403).json({ error: 'Not your call.' });
    try {
      if (rec.vapiCallId) await vapi(`/call/${rec.vapiCallId}`, { method: 'DELETE' });
      rec.status = 'ended';
      pushEvent(rec, { type: 'ended', status: 'ended', reason: 'cancelled by user' });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Desktop: long-poll for events ──────────────────────────────────────────
  app.get('/calls/:id/events', authMiddleware, async (req, res) => {
    const rec = calls.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Call not found or already finished.' });
    if (rec.userId !== req.userId) return res.status(403).json({ error: 'Not your call.' });

    const since = parseInt(req.query.since, 10) || 0;
    const drain = () => rec.events.filter(e => e.seq > since);

    if (drain().length === 0) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        rec.waiters.push(finish);
        setTimeout(finish, POLL_HOLD_MS);
      });
    }

    const out = drain();
    res.json({
      ok: true,
      status: rec.status,
      seq: rec.seq,
      events: out,
      pendingApproval: rec.pendingApproval && !rec.pendingApproval.decision
        ? { id: rec.pendingApproval.id, proposal: rec.pendingApproval.proposal, reason: rec.pendingApproval.reason }
        : null,
    });
  });

  // ── Desktop: recent call history ───────────────────────────────────────────
  app.get('/calls/history', authMiddleware, async (req, res) => {
    try {
      const d = await getDb();
      const rows = await d.collection('calls')
        .find({ userId: req.userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();
      res.json({ ok: true, calls: rows.map(({ _id, ...r }) => r) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function findRecord(msg) {
  const meta = msg?.call?.metadata || msg?.metadata || {};
  if (meta.callId && calls.has(meta.callId)) return calls.get(meta.callId);
  const vid = msg?.call?.id || msg?.callId;
  if (vid && callsByVapiId.has(vid)) return calls.get(callsByVapiId.get(vid));
  return null;
}

// Resolves as soon as the user decides, or after ms — whichever comes first.
function waitForDecision(rec, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const p = rec.pendingApproval;
      if (!p) return resolve(null);
      if (p.decision) return resolve(p.decision);
      if (Date.now() - started >= ms) return resolve(null);
      setTimeout(tick, 250);
    };
    tick();
  });
}

function decisionToResult(decision) {
  if (!decision) {
    return 'The user has not answered yet. Apologise for the delay, ask the other party to bear with you for a moment longer, then call request_user_approval again with the same proposal.';
  }
  if (decision.approved) {
    return `APPROVED. The user accepts this. Confirm it with the other party and proceed.${decision.note ? ` The user adds: ${decision.note}` : ''}`;
  }
  return `DECLINED. The user does not accept this. Politely decline and ask what other options are available.${decision.note ? ` The user adds: ${decision.note}` : ''}`;
}

async function persist(rec) {
  const d = await getDb();
  await d.collection('calls').insertOne({
    callId: rec.id,
    userId: rec.userId,
    phone: rec.phone,
    businessName: rec.businessName,
    goal: rec.goal,
    constraints: rec.constraints,
    status: rec.status,
    endedReason: rec.endedReason,
    summary: rec.summary,
    transcript: rec.transcript,
    createdAt: rec.createdAt,
    endedAt: Date.now(),
  });
}

module.exports = { mountCalling };
