// ── Reception ─────────────────────────────────────────────────────────────────
// Answering a business's phone when nobody can get to it.
//
// The outbound half of calling already exists: Callisto rings a restaurant and
// books your table. This is the other direction - a number that belongs to a
// business, and a voice that picks it up, answers what it can from what the
// owner wrote down, takes a message, and leaves a transcript behind.
//
// Nothing here invents facts about a business. The assistant is given exactly
// what the owner typed and told to say it does not know anything else, because
// a receptionist that guesses opening hours is worse than one that says "let me
// take your number".

const { getDb } = require('./users');

const MAX = { name: 80, line: 300, long: 1500 };

async function profiles() {
  const db = await getDb();
  const col = db.collection('reception');
  await col.createIndex({ userId: 1 }, { unique: true }).catch(() => {});
  await col.createIndex({ phoneNumberId: 1 }).catch(() => {});
  return col;
}

async function callLog() {
  const db = await getDb();
  const col = db.collection('receptionCalls');
  await col.createIndex({ userId: 1, startedAt: -1 }).catch(() => {});
  return col;
}

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .trim()
    .slice(0, max);
}

async function getProfile(userId) {
  const col = await profiles();
  return col.findOne({ userId: String(userId) });
}

async function setProfile(userId, body) {
  const col = await profiles();
  const doc = {
    userId: String(userId),
    businessName: clean(body.businessName, MAX.name),
    greeting: clean(body.greeting, MAX.line),
    hours: clean(body.hours, MAX.line),
    address: clean(body.address, MAX.line),
    services: clean(body.services, MAX.long),
    // Anything else the owner wants it to know: prices, parking, policies.
    notes: clean(body.notes, MAX.long),
    takeMessages: body.takeMessages !== false,
    forwardTo: clean(body.forwardTo, 32),
    phoneNumberId: clean(body.phoneNumberId, 64),
    enabled: !!body.enabled,
    updatedAt: new Date(),
  };
  if (!doc.businessName) return { ok: false, error: 'The business needs a name.' };
  await col.updateOne({ userId: doc.userId }, { $set: doc }, { upsert: true });
  return { ok: true, profile: doc };
}

// Which business owns the number that was just rung.
async function byNumber(phoneNumberId) {
  if (!phoneNumberId) return null;
  const col = await profiles();
  return col.findOne({ phoneNumberId: String(phoneNumberId), enabled: true });
}

// The voice that answers, built from what the owner wrote and nothing else.
function assistantFor(p) {
  const name = p.businessName;
  const known = [
    p.hours ? `Opening hours: ${p.hours}` : null,
    p.address ? `Address: ${p.address}` : null,
    p.services ? `What they do: ${p.services}` : null,
    p.notes ? `Other things to know: ${p.notes}` : null,
  ].filter(Boolean).join('\n');

  const rules = [
    `You are answering the telephone for ${name}. You are not a person and you never pretend to be one.`,
    `Your first words must make that clear - say you are an automated assistant for ${name}.`,
    '',
    'WHAT YOU KNOW',
    known || 'You have not been told anything about this business beyond its name.',
    '',
    'HOW YOU BEHAVE',
    '1. Answer only from what you were told above. If you do not know something - a price, whether a date is free, whether someone is in - say plainly that you do not know and offer to take a message. Never guess, and never invent an answer that sounds right.',
    '2. Be brief. This is a phone call, not a chat: two or three sentences at a time, and let them talk.',
    '3. If they want to be called back, or want something you cannot answer, take their name, their number and what it is about, and read the number back to them to check it.',
    '4. If they ask to speak to a person, say you will pass the message on straight away.',
    '5. Never take a card number, a password, or anything else that should not be said out loud to a machine. If they start to, stop them and say someone will call back.',
    '6. End politely once they have what they came for.',
  ];
  if (p.forwardTo) {
    rules.push(`7. If they clearly need a person and will not settle for a message, you may transfer them to ${p.forwardTo}.`);
  }

  return {
    name: `${name} reception`,
    firstMessage: p.greeting || `Hello, you have reached ${name}. I am an automated assistant - how can I help?`,
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.3,
      messages: [{ role: 'system', content: rules.join('\n') }],
    },
    voice: { provider: 'vapi', voiceId: 'Elliot' },
    // A caller who has stopped talking has finished their sentence; waiting
    // longer than this feels like the line has gone dead.
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 600,
    endCallPhrases: ['goodbye', 'bye for now', 'thanks, bye'],
    analysisPlan: {
      summaryPrompt: 'In two sentences: who called, what they wanted, and anything they asked to be passed on. If they left a number, include it.',
    },
  };
}

async function logCall(userId, call) {
  const col = await callLog();
  await col.insertOne({
    userId: String(userId),
    from: clean(call.from, 32),
    startedAt: call.startedAt ? new Date(call.startedAt) : new Date(),
    seconds: Number(call.seconds) || 0,
    summary: clean(call.summary, MAX.long),
    transcript: clean(call.transcript, 20000),
    endedReason: clean(call.endedReason, 80),
    read: false,
  });
}

async function recentCalls(userId, limit = 30) {
  const col = await callLog();
  return col
    .find({ userId: String(userId) })
    .sort({ startedAt: -1 })
    .limit(Math.max(1, Math.min(100, Number(limit) || 30)))
    .toArray();
}

async function markRead(userId, id) {
  const { ObjectId } = require('mongodb');
  const col = await callLog();
  try {
    await col.updateOne({ _id: new ObjectId(String(id)), userId: String(userId) }, { $set: { read: true } });
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
}

module.exports = { getProfile, setProfile, byNumber, assistantFor, logCall, recentCalls, markRead };
