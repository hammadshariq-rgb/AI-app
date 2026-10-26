// Skills installed from GitHub: reading the address, reading the SKILL.md,
// and choosing the right one for a request.
//
// The install itself hits the network, so that is not tested here. What IS
// tested is everything that decides what gets installed and when it is used,
// which is where the mistakes actually live.

const path = require('path');
const Module = require('module');

// electron-store wants a real Electron app; stub the store this service uses.
const mem = {};
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '../safe-store' || req === './safe-store') {
    return { createStore: () => ({
      get: (k) => mem[k],
      set: (k, v) => { mem[k] = v; },
    }) };
  }
  return realLoad.apply(this, arguments);
};

const skills = require(path.join(__dirname, '..', 'src', 'services', 'skills.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));

/* ── Reading a GitHub address ───────────────────────────────────────────── */
// People paste whatever was in the address bar.
const P = skills.parseRepo;
eq('bare owner/repo', P('owner/repo'), { owner: 'owner', repo: 'repo', branch: null, dir: '' });
eq('full https url', P('https://github.com/anthropics/skills'),
   { owner: 'anthropics', repo: 'skills', branch: null, dir: '' });
eq('no protocol', P('github.com/anthropics/skills'),
   { owner: 'anthropics', repo: 'skills', branch: null, dir: '' });
eq('with www', P('https://www.github.com/a/b'), { owner: 'a', repo: 'b', branch: null, dir: '' });
eq('trailing slash', P('https://github.com/a/b/'), { owner: 'a', repo: 'b', branch: null, dir: '' });
eq('.git suffix', P('https://github.com/a/b.git'), { owner: 'a', repo: 'b', branch: null, dir: '' });
eq('a folder inside a repo', P('https://github.com/a/b/tree/main/skills/instagram'),
   { owner: 'a', repo: 'b', branch: 'main', dir: 'skills/instagram' });
eq('a branch with no folder', P('https://github.com/a/b/tree/dev'),
   { owner: 'a', repo: 'b', branch: 'dev', dir: '' });

// Things that are not a repo must come back null, not a half-parsed guess.
for (const bad of ['', '   ', 'not a url', 'https://gitlab.com/a/b', 'https://example.com', null, undefined]) {
  ok('refuses ' + JSON.stringify(bad), P(bad) === null, 'got ' + JSON.stringify(P(bad)));
}

/* ── Reading a SKILL.md ─────────────────────────────────────────────────── */
const S = skills.parseSkillMd;

const full = S([
  '---',
  'name: Instagram Reel Writer',
  'description: Writes a reel script from an idea. Use when the user wants a reel.',
  '---',
  '',
  '# How to write a reel',
  '',
  'Open with a hook in the first two seconds.',
].join('\n'), 'folder');
eq('name from frontmatter', full.name, 'Instagram Reel Writer');
ok('description from frontmatter', full.description.startsWith('Writes a reel script'));
ok('body is the instructions, not the frontmatter', full.body.includes('first two seconds'));
ok('frontmatter is not left in the body', !full.body.includes('description:'));

// Quoted values, which are common because descriptions contain commas.
const quoted = S('---\nname: "Thing, Quoted"\ndescription: \'Does a thing\'\n---\nBody here.', 'f');
eq('strips double quotes from name', quoted.name, 'Thing, Quoted');
eq('strips single quotes from description', quoted.description, 'Does a thing');

// No frontmatter at all: fall back to the heading, then the folder.
const noFm = S('# Outreach Playbook\n\nSend a short DM first.', 'outreach');
eq('name falls back to the heading', noFm.name, 'Outreach Playbook');
ok('description falls back to the first real line', noFm.description.includes('short DM'));

const bare = S('Just some text with no heading.', 'my-folder');
eq('name falls back to the folder', bare.name, 'my-folder');

// YAML block scalars. Real skill repos use these constantly, and reading only
// the same line gave a description of literally ">" — which told the model
// nothing and made the skill unmatchable.
const folded = S([
  '---',
  'name: Academy Guide',
  'description: >',
  '  When a user asks a question about a product,',
  '  check the catalog first and answer from it.',
  '---',
  'Body text.',
].join('\n'), 'f');
eq('a folded (>) description is read', folded.description,
   'When a user asks a question about a product, check the catalog first and answer from it.');
ok('a folded description is not just the marker', folded.description !== '>');

const literal = S([
  '---',
  'name: API Helper',
  'description: |-',
  '  Line one here.',
  '  Line two here.',
  '---',
  'Body.',
].join('\n'), 'f');
ok('a literal (|-) description is read', literal.description.includes('Line one here.'), literal.description);
ok('a literal description is not just the marker', literal.description !== '|-');

// The block must stop at the next key, not swallow it.
const twoKeys = S('---\ndescription: >\n  some text\nname: After Block\n---\nBody.', 'f');
eq('a key after a block scalar still parses', twoKeys.name, 'After Block');
ok('the block did not swallow the next key', !twoKeys.description.includes('After Block'), twoKeys.description);

// A repo that tries to paste a novel into every prompt gets cut off.
const huge = S('---\nname: Big\n---\n' + 'x'.repeat(50000), 'f');
ok('an enormous body is capped', huge.body.length <= 20000, huge.body.length + ' chars');

// Nothing here may throw, whatever it is handed.
for (const bad of [null, undefined, '', '---\n---\n', '---\nbroken']) {
  try { const r = S(bad, 'fallback'); ok('survives ' + JSON.stringify(bad), typeof r.name === 'string'); }
  catch (e) { fail++; console.log('FAIL threw on ' + JSON.stringify(bad) + ': ' + e.message); }
}

/* ── Choosing one for a request ─────────────────────────────────────────── */
mem.skills = [
  { id: 'reel', name: 'Reel Writer', description: 'Writes Instagram reel scripts and hooks for creators.', body: 'REEL BODY' },
  { id: 'outreach', name: 'Brand Outreach', description: 'Writes pitches to brands for sponsorship deals.', body: 'OUTREACH BODY' },
  { id: 'margin', name: 'Margin Check', description: 'Works out profit margin and unit economics for a product.', body: 'MARGIN BODY' },
];

const names = (m) => skills.match(m, 2).map((s) => s.id);
ok('a reel request finds the reel skill', names('write me an instagram reel script').includes('reel'),
   JSON.stringify(names('write me an instagram reel script')));
ok('a sponsorship request finds outreach', names('write a pitch to brands for sponsorship').includes('outreach'),
   JSON.stringify(names('write a pitch to brands for sponsorship')));
ok('a margin question finds the margin skill', names('what is my profit margin on this product').includes('margin'),
   JSON.stringify(names('what is my profit margin on this product')));
ok('naming a skill outright wins', names('use Margin Check on this')[0] === 'margin',
   JSON.stringify(names('use Margin Check on this')));
eq('an unrelated request matches nothing', names('what is the weather today'), []);
eq('an empty message matches nothing', names(''), []);

// One incidental common word is NOT a match. Following instructions written
// for a different job is worse than answering normally — this is exactly what
// made "write me an instagram reel" pick a documentation skill.
mem.skills = [
  { id: 'docs', name: 'Doc Coauthoring', description: 'Guide users through a workflow for writing documentation when the user wants to write documents.', body: 'B' },
];
eq('a lone weak word does not match', names('write me an instagram reel'), []);
eq('"make" alone does not match', names('make me a video of a dog'), []);

// But a genuine subject match still works.
mem.skills = [
  { id: 'docs', name: 'Doc Coauthoring', description: 'Writing documentation with the user.', body: 'B' },
  { id: 'reel', name: 'Reel Writer', description: 'Instagram reel scripts and hooks.', body: 'B' },
];
ok('a real subject match still works', names('write me an instagram reel').includes('reel'),
   JSON.stringify(names('write me an instagram reel')));
ok('a name word is a strong signal', names('help me with documentation').includes('docs'),
   JSON.stringify(names('help me with documentation')));

// Found by installing a real repo and watching it pick the wrong skills.
mem.skills = [
  { id: 'pdf', name: 'pdf', description: 'Read, combine, split and create PDF files.', body: 'B' },
  { id: 'xlsx', name: 'xlsx', description: 'Open and edit spreadsheet files.', body: 'B' },
  { id: 'mcp-builder', name: 'mcp-builder', description: 'Build an MCP server.', body: 'B' },
];
// Short words are often the most distinctive thing in a request; a length-4
// floor threw away "pdf", "api" and "csv" entirely.
ok('a three-letter subject still matches', names('make a pdf').includes('pdf'),
   JSON.stringify(names('make a pdf')));
// Whole words, not substrings: "build" sits inside "builder", which is how
// "build a spreadsheet" ended up picking the MCP skill.
ok('"build a spreadsheet" finds the spreadsheet skill', names('build a spreadsheet')[0] === 'xlsx',
   JSON.stringify(names('build a spreadsheet')));
ok('a substring is not treated as a word', !names('build a spreadsheet').slice(0, 1).includes('mcp-builder'),
   JSON.stringify(names('build a spreadsheet')));
// And plurals fold, so "scripts" finds a skill about a "script".
mem.skills = [{ id: 'scr', name: 'Script Writer', description: 'Writes a script.', body: 'B' }];
ok('plurals fold to the singular', names('write me some scripts').includes('scr'),
   JSON.stringify(names('write me some scripts')));
ok('never returns more than asked for', skills.match('reel script hooks creators instagram', 2).length <= 2);

/* ── What goes in the prompt ────────────────────────────────────────────── */
// Put the original set back; the matching checks above swapped it out.
mem.skills = [
  { id: 'reel', name: 'Reel Writer', description: 'Writes Instagram reel scripts and hooks for creators.', body: 'REEL BODY' },
  { id: 'outreach', name: 'Brand Outreach', description: 'Writes pitches to brands for sponsorship deals.', body: 'OUTREACH BODY' },
  { id: 'margin', name: 'Margin Check', description: 'Works out profit margin and unit economics for a product.', body: 'MARGIN BODY' },
];
const summary = skills.summaryForPrompt();
ok('the summary names the skills', summary.includes('Reel Writer') && summary.includes('Margin Check'));
ok('the summary carries the descriptions', summary.includes('unit economics'));
ok('the summary does NOT paste the bodies', !summary.includes('REEL BODY'),
   'full bodies in every prompt would cost more room than the conversation');

mem.skills = [];
eq('no skills means no block at all', skills.summaryForPrompt(), '');

Module._load = realLoad;
console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;
