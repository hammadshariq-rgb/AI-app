// No sexual content in anything Callisto generates: pictures, posters, video or
// 3D. Checked before an allowance is used or a provider is paid. Two layers:
// a word list that needs no network, then OpenAI's moderation model, which also
// reads the wording a list can't catch and looks at any picture supplied.
// If moderation is unreachable the word list still stands, so generation isn't
// taken down by an outage.

const BLOCKED = /\b(?:naked|nude|nudes|nudity|topless|bottomless|undress(?:ed|ing)?|porn\w*|nsfw|hentai|erotic\w*|sexual\w*|sexy|sex scene|having sex|sex act|genitals?|penis|vagina|nipples?|orgasm\w*|fetish\w*|onlyfans|lingerie|strip ?tease|stripper|boobs?|tits)\b/i;
const REFUSAL = "I can't make sexual content, including nudity. Try describing something else.";

const GUARDED = ['/ai/image', '/ai/magic-edit', '/video/generate', '/models/generate', '/models/from-image', '/models/retexture'];

function looksSexual(text) { return BLOCKED.test(String(text || '')); }

function collect(body) {
  const b = body || {};
  const text = [b.request, b.prompt, b.instruction, b.texture_prompt, b.title, b.description].filter((x) => typeof x === 'string').join('\n').slice(0, 4000);
  const images = [];
  for (const v of [b.imageUrl, b.image_url]) if (typeof v === 'string' && require('./netguard').publicUrl(v)) images.push(v);
  if (typeof b.imageBase64 === 'string' && b.imageBase64) {
    images.push(b.imageBase64.startsWith('data:') ? b.imageBase64 : 'data:image/png;base64,' + b.imageBase64);
  }
  return { text, images };
}

async function moderate(openai, text, images, timeoutMs = 5000) {
  const input = [];
  if (text) input.push({ type: 'text', text });
  for (const url of images) input.push({ type: 'image_url', image_url: { url } });
  if (!input.length) return false;
  const call = openai.moderations.create({ model: 'omni-moderation-latest', input });
  const r = await Promise.race([call, new Promise((ok) => setTimeout(() => ok(null), timeoutMs))]);
  if (!r || !r.results) return false;
  return r.results.some((x) => x.categories && (x.categories.sexual || x.categories['sexual/minors']));
}

// The third layer. Before anything is made, the request goes through the AI,
// which rewrites it into a long, polite description - "a life-size realistic
// female figure, soft smooth skin, full body" - that neither the word list nor
// moderation reads as sexual, and a sex doll came out of it. A small model
// asked one direct question about what the thing IS sees through that.
async function judge(openai, text, timeoutMs = 6000) {
  if (!text || !text.trim()) return false;
  const call = openai.chat.completions.create({
    model: 'gpt-5.4-mini', max_completion_tokens: 5,
    messages: [
      { role: 'system', content: 'You screen requests for an image, video and 3D model generator. Answer YES if what would be made is sexual or for sexual use: a sex doll or love doll (however it is described, including a life-size or realistic female or male figure, body or torso meant as a companion or doll), a sex toy, nudity, exposed genitals or breasts, lingerie or fetish wear, or a body posed or shaped to be sexually suggestive. Answer NO for everything else, including ordinary people, characters, statues, mannequins for clothes, anatomy for medical study, and swimwear in a normal setting. Reply with YES or NO only.' },
      { role: 'user', content: text.slice(0, 3000) },
    ],
  });
  const r = await Promise.race([call, new Promise((ok) => setTimeout(() => ok(null), timeoutMs))]);
  const out = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  return /^\s*yes/i.test(String(out || ''));
}

// Express middleware. Needs the parsed body, and a function returning the client.
function middleware(getOpenAI, onBlock) {
  return async (req, res, next) => {
    if (req.method !== 'POST' || !GUARDED.some((p) => req.path.startsWith(p))) return next();
    const { text, images } = collect(req.body);
    let blocked = looksSexual(text);
    if (!blocked) {
      try { blocked = await moderate(getOpenAI(), text, images); } catch (_) { /* word list stands */ }
    }
    if (!blocked) {
      try { blocked = await judge(getOpenAI(), text); } catch (_) { /* the other layers stand */ }
    }
    if (!blocked) return next();
    try { if (onBlock) onBlock(req); } catch (_) {}
    return res.status(400).json({ error: REFUSAL, blockedContent: true });
  };
}

module.exports = { middleware, looksSexual, collect, moderate, judge, REFUSAL };
