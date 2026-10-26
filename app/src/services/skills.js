// ── Skills from GitHub ────────────────────────────────────────────────────────
// A skill is a folder holding a SKILL.md: a name, a description of when it
// applies, and a body of instructions. Install one from a GitHub repository and
// Callisto can follow it - "write me an Instagram reel" starts behaving the way
// whoever wrote that skill intended.
//
// IMPORTANT, and the reason this file reads only Markdown: a skill is
// INSTRUCTIONS, never code. Nothing fetched here is executed, required, or
// written anywhere it could be. The worst a bad skill can do is give Callisto
// poor advice, which the person who installed it can see and remove - a repo
// that could run code on their machine would be a different thing entirely.
//
// Public repositories only, and no token, so GitHub's unauthenticated rate
// limit applies (60 requests an hour). Installing a skill costs two.

const { createStore } = require('../safe-store');
const store = createStore({ name: 'skills' });

const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';

// A skill body is read by the model as instructions, so it is capped. A repo
// that tried to paste a novel into the prompt would otherwise push out the
// conversation around it.
const MAX_BODY = 20000;
const MAX_SKILLS = 60;

/* ── Reading a GitHub address ───────────────────────────────────────────────
   People paste whatever the address bar had. All of these mean the same repo:
     github.com/owner/repo
     https://github.com/owner/repo.git
     https://github.com/owner/repo/tree/main/skills/instagram
     owner/repo
   The path after tree/<branch> narrows the search to that folder. */
function parseRepo(input) {
  const raw = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!raw) return null;

  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?/i.exec(raw);
  if (m) return { owner: m[1], repo: m[2], branch: m[3] || null, dir: m[4] || '' };

  // "owner/repo" on its own, with an optional folder after it.
  const short = /^([\w.-]+)\/([\w.-]+)(?:\/(.*))?$/.exec(raw);
  if (short) return { owner: short[1], repo: short[2], branch: null, dir: short[3] || '' };

  return null;
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Callisto' },
  });
  if (res.status === 403) throw new Error('GitHub is rate limiting right now. Try again in a few minutes.');
  if (res.status === 404) throw new Error('No repository there. Check the address.');
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Callisto' } });
  if (!res.ok) throw new Error(`Could not read that file (${res.status}).`);
  return res.text();
}

/* ── The SKILL.md itself ────────────────────────────────────────────────────
   Frontmatter between --- lines, then the instructions. `name` and
   `description` are what matter: the description is how Callisto decides the
   skill applies at all, so a skill without one is close to useless and says so
   rather than installing silently. */
function parseSkillMd(text, fallbackName) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  let name = '', description = '', body = src;

  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (fm) {
    body = src.slice(fm[0].length);
    const lines = fm[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      let val = kv[2].trim();

      // YAML block scalars. "description: >" or "description: |-" means the
      // real text is on the indented lines beneath, and reading only the
      // same line gives you the literal string ">" as the description -
      // which is exactly what several real skill repos produced.
      if (/^[|>][-+]?\d*$/.test(val)) {
        const folded = val[0] === '>';          // ">" joins lines, "|" keeps breaks
        const collected = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') { collected.push(''); continue; }
          if (!/^\s/.test(lines[j])) break;     // back to column 0: the block ended
          collected.push(lines[j].replace(/^\s+/, ''));
          i = j;
        }
        val = folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n').trim();
      } else {
        // Strip one layer of quotes; a description often contains commas.
        val = val.replace(/^["']|["']$/g, '');
      }

      if (key === 'name') name = val;
      else if (key === 'description') description = val;
    }
  }

  // No frontmatter name: take the first heading, then the folder it came from.
  if (!name) {
    const h = /^#\s+(.+)$/m.exec(body);
    name = (h ? h[1] : fallbackName || '').trim();
  }
  if (!description) {
    // First non-empty, non-heading line reads as the summary.
    const line = body.split('\n').map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('---'));
    description = (line || '').slice(0, 300);
  }

  return {
    name: String(name || fallbackName || 'skill').trim().slice(0, 80),
    description: String(description || '').trim().slice(0, 500),
    body: body.trim().slice(0, MAX_BODY),
  };
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/* ── Installing ─────────────────────────────────────────────────────────────
   Walks the repository tree for SKILL.md files. One repo can hold many - the
   skill packs people share usually do - so every one found is installed and
   the caller is told how many. */
async function install(input) {
  const loc = parseRepo(input);
  if (!loc) throw new Error("That doesn't look like a GitHub address. Try github.com/owner/repo.");

  // Find the default branch unless they pinned one in the URL.
  let branch = loc.branch;
  if (!branch) {
    const meta = await getJSON(`${API}/repos/${loc.owner}/${loc.repo}`);
    branch = meta.default_branch || 'main';
  }

  const tree = await getJSON(`${API}/repos/${loc.owner}/${loc.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const files = (tree.tree || []).filter((f) => f.type === 'blob');

  const wanted = files.filter((f) => {
    if (!/(^|\/)SKILL\.md$/i.test(f.path)) return false;
    if (loc.dir && !f.path.toLowerCase().startsWith(loc.dir.toLowerCase())) return false;
    return true;
  });

  // Some repos are a single skill with the instructions in the README.
  if (!wanted.length) {
    const readme = files.find((f) => /^readme\.md$/i.test(f.path));
    if (readme) wanted.push(readme);
  }
  if (!wanted.length) throw new Error('No SKILL.md in that repository, so there is nothing to install.');

  const installed = [];
  const existing = list();
  for (const f of wanted.slice(0, MAX_SKILLS)) {
    let text;
    try { text = await getText(`${RAW}/${loc.owner}/${loc.repo}/${branch}/${f.path}`); }
    catch (_) { continue; }

    const folder = f.path.replace(/\/?SKILL\.md$/i, '').split('/').pop() || loc.repo;
    const parsed = parseSkillMd(text, folder);
    if (!parsed.body) continue;

    const id = slug(parsed.name) || slug(folder);
    installed.push({
      id,
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      source: `github.com/${loc.owner}/${loc.repo}`,
      path: f.path,
      addedAt: Date.now(),
    });
  }
  if (!installed.length) throw new Error('Found the files but could not read a skill out of them.');

  // Re-installing a repo replaces its skills rather than doubling them up.
  const keep = existing.filter((s) => !installed.some((n) => n.id === s.id));
  const all = keep.concat(installed).slice(0, MAX_SKILLS);
  store.set('skills', all);

  return { ok: true, count: installed.length, skills: installed.map((s) => ({ id: s.id, name: s.name, description: s.description })) };
}

function list() {
  const all = store.get('skills');
  return Array.isArray(all) ? all : [];
}

function remove(id) {
  const all = list();
  const next = all.filter((s) => s.id !== id);
  store.set('skills', next);
  return { ok: true, removed: all.length - next.length };
}

/* ── Choosing one ───────────────────────────────────────────────────────────
   Scored on the description, which is what a skill's author writes to say when
   it applies, and on the name. Deliberately simple: the model gets the list
   and makes the real decision - this only decides which bodies are worth the
   room in the prompt. */
// Words that appear in the description of almost every skill ever written, so
// finding one says nothing about whether the skill fits. Without this list,
// "write me an instagram reel" matched a documentation skill on the word
// "write" alone and the wrong instructions were followed.
const WEAK = new Set([
  'this', 'that', 'with', 'when', 'what', 'they', 'them', 'from', 'into', 'about',
  'should', 'would', 'could', 'user', 'users', 'using', 'uses', 'use', 'make',
  'makes', 'making', 'create', 'creates', 'creating', 'write', 'writes',
  'writing', 'help', 'helps', 'want', 'wants', 'need', 'needs', 'asks', 'asked',
  'skill', 'skills', 'claude', 'please', 'give', 'gives', 'take', 'takes',
  'your', 'their', 'have', 'been', 'will', 'more', 'than', 'then', 'also',
  'file', 'files', 'work', 'works', 'like', 'such', 'these', 'those', 'some',
]);

// Whole words, not substrings. Matching on substrings made "build a
// spreadsheet" pick a skill called mcp-BUILDer over the spreadsheet one,
// because "build" happens to sit inside "builder". Split on anything that is
// not a letter or digit, so "mcp-builder" and "doc_coauthoring" come apart
// into real words.
const wordsOf = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Crude but effective plural folding, so "scripts" finds "script".
const stem = (w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

function match(message, limit = 2) {
  const text = String(message || '').toLowerCase();
  if (!text.trim()) return [];
  // Three characters, not four: "pdf", "api", "csv" and "seo" are among the
  // most distinctive words a request can contain, and a length-4 floor threw
  // every one of them away.
  const words = wordsOf(text).filter((w) => w.length >= 3 && !WEAK.has(w)).map(stem);
  if (!words.length) return [];

  const scored = list().map((s) => {
    const name = (s.name || '').toLowerCase();
    const nameWords = new Set(wordsOf(name).map(stem));
    const descWords = new Set(wordsOf(s.description).map(stem));
    let score = 0;
    for (const w of new Set(words)) {
      // A word in the NAME is a much stronger signal than one buried in a
      // paragraph of description.
      if (nameWords.has(w)) score += 3;
      else if (descWords.has(w)) score += 1;
    }
    // A skill called for by name wins outright.
    if (name && name.length > 3 && text.includes(name)) score += 10;
    return { skill: s, score };
  });

  // One distinctive word is enough, because WEAK above has already thrown away
  // the words that mean nothing. That is what stops a mismatch, not a high
  // threshold - demanding two real words lost "help me with documentation"
  // against a skill whose whole subject is documentation.
  const good = scored.filter((x) => x.score >= 1);
  good.sort((a, b) => b.score - a.score);
  return good.slice(0, limit).map((x) => x.skill);
}

// What goes in the system prompt: enough for the model to know a skill exists
// and when to reach for it, without pasting every body into every request.
function summaryForPrompt() {
  const all = list();
  if (!all.length) return '';
  const lines = all.slice(0, 40).map((s) => `- ${s.name}: ${s.description || 'no description'}`);
  return `\n\nSKILLS THE USER HAS INSTALLED (from GitHub). When a request matches one, follow its instructions for that task:\n${lines.join('\n')}`;
}

module.exports = { install, list, remove, match, summaryForPrompt, parseRepo, parseSkillMd };
