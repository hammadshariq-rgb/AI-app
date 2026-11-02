// What Callisto will not read, look at or answer: nudity and sexual content,
// hate, and links to adult sites. The same refusal everywhere, decided here on
// the server, so no app version or edited request can talk its way past it.
//
// Swearing on its own is not refused. "this fucking printer" gets an answer,
// the way ChatGPT and Claude answer it; it is only counted in the logs. A slur
// used against people is what moderation's hate category catches.
//
// Only categories and the account id are logged, never what was said or sent.

const REFUSAL = "I can't help with that.";

const TEXT_BLOCKED = ['sexual', 'sexual/minors', 'hate', 'hate/threatening'];
const IMAGE_BLOCKED = ['sexual', 'sexual/minors', 'violence/graphic'];

const TEXT_TIMEOUT_MS = 3000;
const IMAGE_TIMEOUT_MS = 8000;

const ADULT_SITES = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'tube8.com',
  'spankbang.com', 'eporner.com', 'beeg.com', 'porn.com', 'rule34.xxx', 'rule34.paheal.net', 'nhentai.net',
  'hanime.tv', 'hentaihaven.xxx', 'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com',
  'bongacams.com', 'livejasmin.com', 'cam4.com', 'myfreecams.com', 'brazzers.com', 'bangbros.com',
  'realitykings.com', 'motherless.com', 'thothub.to', 'erome.com', 'sxyprn.com', 'noodlemagazine.com',
];
const ADULT_ENDINGS = ['.xxx', '.porn', '.adult', '.sex', '.sexy'];
const ADULT_IN_NAME = /(^|[.-])(porn|xxx)|porn|xxx/;

const SWEARING = /\b(fuck\w*|shit\w*|bitch\w*|asshole\w*|cunt\w*|motherfuck\w*)\b/i;
const LINK = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]\S*)?/gi;

function hasAdultLink(text) {
  for (const m of String(text || '').matchAll(LINK)) {
    const host = m[1].toLowerCase().replace(/^www\./, '');
    if (ADULT_SITES.some((d) => host === d || host.endsWith('.' + d))) return true;
    if (ADULT_ENDINGS.some((e) => host.endsWith(e))) return true;
    if (ADULT_IN_NAME.test(host)) return true;
  }
  return false;
}

// The newest thing the person sent, split into its words and its pictures.
// Older turns were already looked at when they were sent.
function lastFromUser(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m && m.role === 'user');
  const content = last && last.content;
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  return {
    text: content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n'),
    images: content.filter((p) => p && p.type === 'image_url' && p.image_url && p.image_url.url).map((p) => p.image_url.url),
  };
}

function createGuard(openai, log = console.log) {
  const flag = (userId, what) => log(`[flag] ${what} user=${userId || 'guest'}`);

  async function moderate(text, images, timeoutMs) {
    const input = [
      ...(text ? [{ type: 'text', text: text.slice(0, 20000) }] : []),
      ...images.slice(0, 4).map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('timed out')), timeoutMs); });
    try {
      const r = await Promise.race([openai.moderations.create({ model: 'omni-moderation-latest', input }), late]);
      return (r.results && r.results[0] && r.results[0].categories) || {};
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolves to the refusal's reason, or null when it is fine. If moderation is
  // down, words carry on because the answering model has its own rules. Pictures
  // do not, because being unable to look is no reason to accept one.
  async function review({ text = '', images = [] }, userId) {
    if (SWEARING.test(text)) flag(userId, 'swearing');
    if (hasAdultLink(text)) { flag(userId, 'adult-link'); return 'adult-link'; }
    if (!text.trim() && !images.length) return null;
    try {
      const cats = await moderate(text, images, images.length ? IMAGE_TIMEOUT_MS : TEXT_TIMEOUT_MS);
      const hit = (images.length ? [...IMAGE_BLOCKED, ...TEXT_BLOCKED] : TEXT_BLOCKED).find((c) => cats[c]);
      if (hit) { flag(userId, hit); return hit; }
      return null;
    } catch (err) {
      console.warn('[flag] moderation unavailable:', err.message);
      return images.length ? 'unchecked-image' : null;
    }
  }

  // Starts the check without waiting on it, so a streaming answer can start at
  // the same moment and nothing is slower. Handlers await req.contentVerdict
  // before sending the person a single word.
  const guardMessages = (req, _res, next) => {
    const uid = req.userId || (req.user && req.user.id);
    req.contentVerdict = review(lastFromUser(req.body && req.body.messages), uid);
    next();
  };

  // For a picture sent on its own, checked before it goes anywhere else.
  const reviewImage = (imageBase64, words, userId) => review({ text: String(words || ''), images: [String(imageBase64)] }, userId);

  return { review, reviewImage, guardMessages };
}

module.exports = { createGuard, hasAdultLink, lastFromUser, REFUSAL };
