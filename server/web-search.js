// ── Knowing what is happening now ─────────────────────────────────────────────
// The model knows the world only up to its training date, so "Tesla's flying
// car" or "Anthropic's IPO" drew a blank or, worse, a confident guess. When a
// question is about something current, or about a named company, product or
// person, the web is searched first and the answer is written from what it
// finds, with the sources.
//
// needsWeb() decides cheaply, on the words alone; lookup() does the search.

// Words that mean "now", or things that change.
const RECENT = /\b(latest|recent|recently|new|newest|now|currently|current|today|tonight|yesterday|this (?:week|month|year)|last (?:week|month|year)|20(?:2[4-9]|3\d)|news|update|updates|launch(?:ed|es)?|release(?:d|s)?|release date|announc(?:ed|ement)|ipo|listing|acquir(?:ed|es)|acquisition|merger|ceo|founder|stock|shares?|share price|market cap|valuation|revenue|earnings|profit|funding|raised|price of|cost of|how much (?:is|does)|who won|winner|elected|election|result|ranking|rumou?r|leak|delay(?:ed)?|recall(?:ed)?|lawsuit|ban(?:ned)?|still|yet|anymore)\b/i;
// A named thing: a capitalised word that is not just the start of the sentence.
const NAMED = /(?:^|[^.!?]\s)(?!I\b)[A-Z][a-zA-Z0-9&.-]{1,}/;
// Things a search adds nothing to.
const NO_WEB = /^\s*(?:hi|hey|hello|thanks|thank you|ok|okay|yes|no|lol)\b|\b(?:my|our|mine)\s+(?:revenue|sales|orders|followers|subscribers|analytics|calendar|email|inbox|tasks?|reminders?|files?|business)\b|\b(?:solve|simplify|differentiate|integrate|factori[sz]e|calculate|prove)\b|\b(?:write|draft|make|create|draw|generate|translate|summari[sz]e)\b|\b(?:joke|poem|story)\b/i;

// People type in lower case, so a name is not always capitalised: the kinds of
// thing that change, and anything someone or something "has" ("tesla's car").
const TOPIC = /\b(?:compan(?:y|ies)|startup|brand|car|cars|phone|iphone|android|app|product|model|chip|gpu|ai|gpt|chatgpt|claude|gemini|openai|anthropic|tesla|spacex|apple|google|meta|microsoft|amazon|nvidia|netflix|bitcoin|crypto|player|team|club|match|movie|film|album|song|series|season|game|console|flying car|robot)\b|\b\w+'s\b/i;

function needsWeb(text) {
  const t = String(text || '').trim();
  if (t.length < 8 || NO_WEB.test(t)) return false;
  return RECENT.test(t) || NAMED.test(t) || TOPIC.test(t);
}

function makeLookup(openai) {
  const cache = new Map();
  return async function lookup(query) {
    const q = String(query || '').trim().slice(0, 400);
    if (!q) return null;
    const key = q.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.text;
    const today = new Date().toISOString().slice(0, 10);
    const r = await openai.responses.create({
      model: 'gpt-4.1-mini',
      tools: [{ type: 'web_search_preview' }],
      input: 'Today is ' + today + '. Search the web for the most recent, reliable information to answer: "' + q + '".\n'
        + 'Reply with 4-8 short factual bullet points, each with its date and any numbers (revenue, prices, dates, percentages) exactly as reported. '
        + 'Say plainly if something has not happened, was cancelled or is only a rumour. Then a line "Sources:" with up to 4 URLs. No opinions.',
    });
    const text = String(r.output_text || '').trim().slice(0, 3500);
    if (text) { cache.set(key, { at: Date.now(), text }); if (cache.size > 500) cache.clear(); }
    return text || null;
  };
}

module.exports = { needsWeb, makeLookup };
