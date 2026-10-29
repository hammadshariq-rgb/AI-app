// What leaves a user's computer in a crash report? Nothing that identifies them.
const os = require('os');
const path = require('path');
const c = require(path.join(__dirname, '..', 'src', 'services', 'crash.js'));

let pass = 0, fail = 0;
const ok = (n, x) => { if (x) pass++; else { fail++; console.log('FAIL ' + n); } };

const home = os.homedir();
const ev = {
  user: { id: 1, email: 'a@b.c' }, server_name: 'HAMMAD-PC', request: { url: 'x' },
  contexts: { device: { name: 'x' }, culture: {}, os: { name: 'Windows' } },
  breadcrumbs: [{ category: 'console', message: '[CHAT] my secret business plans' }, { category: 'navigation' }],
  message: 'failed at ' + path.join(home, 'Desktop', 'notes.txt'),
  exception: { values: [{
    value: 'ENOENT ' + path.join(home, 'Documents', 'budget.xlsx'),
    stacktrace: { frames: [{ filename: path.join(home, 'AppData', 'main.js'), abs_path: path.join(home, 'x.js'), vars: { password: 'hunter2' } }] },
  }] },
};
const out = JSON.stringify(c.scrub(ev));
const user = os.userInfo().username;

ok('the home folder is gone from every path', !out.includes(home.replace(/\\/g, '\\\\')) && !out.includes(home));
ok('the account name is gone', !out.toLowerCase().includes(user.toLowerCase()));
ok('paths still say where, as ~', out.includes('~'));
ok('the computer name is gone', !out.includes('HAMMAD-PC'));
ok('what they typed (console) is gone', !out.includes('secret business plans'));
ok('local variables are gone', !out.includes('hunter2'));
ok('identity and request are gone', !/"user"|"request"/.test(out));
ok('the operating system is kept, it explains crashes', out.includes('Windows'));
ok('non-console breadcrumbs are kept', out.includes('navigation'));

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;
