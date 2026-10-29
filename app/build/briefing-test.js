// The morning briefing: what it says, in what order, and what happens when a
// connector hangs.
//
// Two things used to be wrong. It was spoken as four separate errands run one
// after another, so there was a gap of silence at every join; and the stats
// line stopped after four sentences, which silently dropped whatever came
// last. Both are checked here.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function slice(file, startMark, endMark, needs) {
  const src = fs.readFileSync(file, 'utf8');
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark, a + 1);
  if (a < 0 || b < 0) throw new Error('could not find ' + startMark + ' in ' + path.basename(file));
  const out = src.slice(a, b);
  for (const n of needs) if (out.indexOf(n) < 0) throw new Error('slice is missing ' + n);
  return out;
}

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
}
function order(what, text, first, second) {
  const i = text.indexOf(first);
  const j = text.indexOf(second);
  if (i >= 0 && j >= 0 && i < j) pass++;
  else { fail++; console.log('  FAIL  ' + what + '  (' + first + ' at ' + i + ', ' + second + ' at ' + j + ')'); }
}

// ── The stats line ───────────────────────────────────────────────────────────
const fmtSrc = slice(
  path.join(__dirname, '..', 'src', 'services', 'connectors.js'),
  'function formatAnalyticsForBriefing(',
  'function formatAnalyticsForAI(',
  ['a.instagram', 'a.tiktok', 'a.googleAnalytics', 'a.stripe', 'a.youtube'],
);
const fmtCtx = { console };
vm.createContext(fmtCtx);
vm.runInContext(fmtSrc + '\nthis._f = formatAnalyticsForBriefing;', fmtCtx);
const format = fmtCtx._f;

// Everything connected at once - the case that used to lose its tail.
const all = {
  instagram: { followers: 1240, views30: 50000, recentPosts: [{ views: 8300 }] },
  tiktok: { followers: 9800, likes: 44000, recentVideos: [{ views: 120400 }] },
  // The shape the connector REALLY returns. The first version of this test
  // invented a flat {users, period}, which the briefing code then read - so
  // the test passed while the website line never once appeared in the app.
  googleAnalytics: {
    siteName: 'callistoai.net',
    last7Days: { sessions: 410, users: 312 },
    last30Days: { sessions: 1800, users: 1340 },
  },
  stripe: { currency: 'USD', today: { revenue: 240, orders: 12 }, yesterday: { revenue: 200 }, last7Days: { revenue: 1500 } },
  youtube: { subscribers: 5600, views28: 90000, recentVideos: [{ views: 14200 }] },
  shopify: null,
  squarespace: null,
};
const line = format(all);

check('all five platforms are mentioned',
  ['Instagram', 'TikTok', 'visited', 'taken', 'YouTube'].every((k) => line.includes(k)), true);
order('Instagram before TikTok', line, 'Instagram', 'TikTok');
order('TikTok before the website', line, 'TikTok', 'visited');
order('the website before Stripe', line, 'visited', 'taken');
order('Stripe before YouTube', line, 'taken', 'YouTube');

check('Instagram says its followers', line.includes('1,240 followers'), true);
check('Instagram says the latest post views', line.includes('latest post has 8,300 views'), true);
check('TikTok says its followers', line.includes('9,800 followers'), true);
check('TikTok says the latest video views', line.includes('latest video has 120,400 views'), true);
check('the website says its visitors', line.includes('312 people have visited'), true);
check('and names the site', line.includes('callistoai.net'), true);

// A quiet week must not silence the website entirely: fall back to the month
// rather than saying nothing.
const quiet = format({ googleAnalytics: { last7Days: { users: 0, sessions: 0 }, last30Days: { users: 1340 } } });
check('a quiet week falls back to the month', quiet.includes('1,340'), true);
check('and says which period that is', quiet.includes('thirty days'), true);

// One visitor reads as one person, not "1 people".
const one = format({ googleAnalytics: { last7Days: { users: 1 } } });
check('one visitor reads properly', one.includes('1 person has visited'), true);

// Sessions when users are missing, which some properties do.
const sess = format({ googleAnalytics: { last7Days: { sessions: 88 } } });
check('falls back to sessions', sess.includes('88 people have visited'), true);

// Analytics connected but genuinely empty says nothing rather than "0 people".
check('a brand new property says nothing', format({ googleAnalytics: { last7Days: {}, last30Days: {} } }), null);
check('Stripe says the money', line.includes('USD 240 today'), true);
check('Stripe counts the payments', line.includes('12 payments'), true);
check('YouTube says its subscribers', line.includes('5,600 subscribers'), true);
check('YouTube says the latest video views', line.includes('latest video has 14,200 views'), true);

// Nothing connected says nothing at all, rather than an awkward empty line.
check('nothing connected returns null', format({}), null);

// One platform on its own still works.
const onlyYt = format({ youtube: { subscribers: 10, recentVideos: [{ views: 3 }] } });
check('a single platform still speaks', onlyYt.includes('10 subscribers'), true);

// A platform with no recent posts falls back rather than saying "undefined".
const noPosts = format({ instagram: { followers: 5, views30: 77, recentPosts: [] } });
check('falls back when there is no recent post', noPosts.includes('77 views this month'), true);
check('never says undefined', noPosts.includes('undefined'), false);

// ── The whole briefing ───────────────────────────────────────────────────────
const briefSrc = slice(
  path.join(__dirname, '..', 'renderer', 'renderer.js'),
  'async function composeDailyBriefing(',
  // Up to the announcement card, so the line-splitting helper comes along.
  '\n// The first-of-the-day update',
  ['Promise.all', 'weatherGreeting', 'connectorStatsBriefing', 'taskBriefing'],
);

function runBriefing({ weather, news, stats, tasks }) {
  const ctx = {
    console, setTimeout, clearTimeout, Promise,
    window: { jarvis: {
      weatherGreeting: () => Promise.resolve(weather),
      connectorStatsBriefing: () => Promise.resolve(stats),
      taskBriefing: () => Promise.resolve(tasks),
    } },
    _newsBriefingText: () => Promise.resolve(news),
  };
  vm.createContext(ctx);
  vm.runInContext(briefSrc + '\nthis._b = composeDailyBriefing;', ctx);
  return ctx._b('sir');
}

(async () => {
  const full = await runBriefing({
    weather: "It's 4 degrees and clear.",
    news: "Here's what's happening in the world. One. Two.",
    stats: line,
    tasks: { spoken: 'You have 3 tasks for today.', items: [1, 2, 3] },
  });

  check('starts with the greeting', full.text.startsWith('Welcome back, sir.'), true);
  order('weather before news', full.text, '4 degrees', 'happening in the world');
  order('news before Instagram', full.text, 'happening in the world', 'Instagram');
  order('Instagram before the tasks', full.text, 'Instagram', '3 tasks');
  check('the tasks come last', full.text.trim().endsWith('You have 3 tasks for today.'), true);
  check('it is one piece of text', full.text.includes('\n'), false);
  check('tasks were flagged for the panel refresh', full.hadTasks, true);

  // No tasks today: say nothing about them rather than "you have no tasks".
  const noTasks = await runBriefing({
    weather: 'Mild.', news: null, stats: null, tasks: { spoken: 'You have no tasks.', items: [] },
  });
  check('an empty task list is left out', noTasks.text.includes('tasks'), false);
  check('hadTasks is false', noTasks.hadTasks, false);

  // Nothing available at all still greets them rather than opening silent.
  const bare = await runBriefing({ weather: null, news: null, stats: null, tasks: null });
  check('still greets with nothing to report', bare.text, 'Welcome back, sir.');

  // A connector that never answers must not cost them the rest of it.
  const began = Date.now();
  const hung = await runBriefing({
    weather: new Promise(() => {}),            // never resolves
    news: "Here's what's happening in the world. One.",
    stats: line,
    tasks: { spoken: 'You have 1 task for today.', items: [1] },
  });
  const took = Date.now() - began;
  check('a hung connector is dropped', hung.text.includes('degrees'), false);
  check('everything else still arrived', hung.text.includes('Instagram') && hung.text.includes('1 task'), true);
  check('and it capped rather than hanging', took < 6000, true);
  console.log('  (the hung connector capped after ' + (took / 1000).toFixed(1) + 's)');

  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
  console.log('\n  What it actually says:\n');
  console.log('    ' + full.text.replace(/(.{76}\s)/g, '$1\n    '));
  process.exit(fail ? 1 : 0);
})();
