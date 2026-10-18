// Why does "Callisto, could you play X" come back as "Playing callisto,
// could you play X"? Runs the real stripping and the real local-command
// matcher, then the real respond() if that does not catch it.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
app.setName('Your Own Personal AI');

const SAID = [
  'Callisto, could you play Rich Baby Daddy by Drake on Spotify?',
  'Callisto, could you play road trips by Drake on Spotify?',
  'hey callisto could you play rich baby daddy by drake on spotify',
  'callisto play rich baby daddy by drake',
  'could you play rich baby daddy by drake on spotify',
  'play rich baby daddy by drake on spotify',
];

app.whenReady().then(async () => {
  const aiPath = path.join(__dirname, '..', 'src', 'services', 'ai.js');
  const src = fs.readFileSync(aiPath, 'utf8');

  // Pull the two pieces out so each stage can be seen on its own.
  const grab = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    let d = 0;
    const start = src.indexOf('{', i);
    for (let k = start; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    throw new Error('unbalanced ' + name);
  };
  const stripAddress = new Function('return ' + grab('stripAddress'))();

  const playRe = /^(?:play|put on|queue|listen to)\s+(.+?)(?:\s+on\s+(spotify|apple music|youtube music))?$/;

  console.log('stage 1 - stripping the name and politeness');
  for (const s of SAID) {
    const stripped = stripAddress(s, 'Callisto');
    const lo = stripped.toLowerCase()
      .replace(/['']/g, "'").replace(/["“”]/g, '')
      .replace(/[\s.!?,;:]+$/, '').trim();
    const m = lo.match(playRe);
    console.log('  ' + JSON.stringify(s));
    console.log('     stripped : ' + JSON.stringify(stripped));
    console.log('     local hit: ' + (m ? 'query=' + JSON.stringify(m[1]) + ' service=' + JSON.stringify(m[2] || '') : 'NO MATCH -> goes to the model'));
  }

  console.log('');
  console.log('stage 2 - what respond() actually returns');
  const ai = require(aiPath);
  for (const s of SAID.slice(0, 3)) {
    try {
      const out = await ai.respond({ message: s, assistantName: 'Callisto' });
      const a = out && out.action;
      console.log('  ' + JSON.stringify(s));
      console.log('     action: ' + (a ? a.type + '  arg=' + JSON.stringify(a.arg) : 'none'));
      console.log('     text  : ' + JSON.stringify((out && out.text) || ''));
    } catch (err) {
      console.log('  ' + JSON.stringify(s) + '  ERROR ' + err.message);
    }
  }
  app.quit();
});
