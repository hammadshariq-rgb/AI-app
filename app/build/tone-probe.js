// Does it actually match how the person is talking? Real prompt, real server.
const { app } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

const CASES = [
  ['brainrot',  'yo wsg callisto, my code is lowkey cooked rn, this bug is crazy'],
  ['casual',    'bro that actually worked lmaooo'],
  ['formal',    'Could you summarise the key considerations for launching a desktop application?'],
  ['rushed',    'just tell me the answer, 15% of 80'],
  ['worried',   "i've been working on this for 3 weeks and i think i'm going to fail, nothing works"],
  ['excited',   'WE GOT OUR FIRST PAYING CUSTOMER!!'],
  ['identity',  'are you actually conscious? do you know what you are?'],
];

app.whenReady().then(async () => {
  const ai = require(path.join(__dirname, '..', 'src', 'services', 'ai.js'));
  for (const [label, msg] of CASES) {
    const t = Date.now();
    let out;
    try {
      out = await ai.respond({ message: msg, assistantName: 'Callisto' });
    } catch (err) {
      console.log(label.padEnd(10) + ' ERROR ' + err.message + '\n');
      continue;
    }
    const text = (out && out.text) || '(no text)';
    console.log('── ' + label + '  (' + (Date.now() - t) + 'ms, ' + text.length + ' chars)');
    console.log('   them: ' + msg);
    console.log('   it  : ' + text.replace(/\n+/g, ' ').slice(0, 300));
    console.log('');
  }
  app.quit();
});
