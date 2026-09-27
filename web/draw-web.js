/* ─────────────────────────────────────────────────────────────────────────────
   The drawing page on the website

   The canvas itself is draw-studio.js, shared with the desktop app. This gives
   it what it needs in a browser: shapes from the chat model, its own command
   box wired back into the chat, and the hand-offs to the generators.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var API = 'https://ai-app-production-9224.up.railway.app';
  var D = function () { return window.CallistoDraw; };
  if (!D()) return;

  function token() {
    try { return localStorage.getItem('cai_token'); } catch (_) { return null; }
  }

  /* The model is asked for shapes directly rather than prose. Everything
     already on the canvas is described first, so "put a rocket on top" knows
     what it is on top of. */
  async function ask(instruction) {
    if (!token()) {
      window.CallistoGate?.show('signin', { feature: 'draw' });
      return;
    }
    var prompt = [
      'You are drawing on a 1000x1000 canvas, origin top left.',
      D().describe(),
      '',
      'The user says: "' + instruction + '"',
      '',
      'Reply with ONLY a JSON object, no prose and no code fences:',
      '{"op":"add","title":"short name","shapes":[...]}',
      'op is "add" to keep what is there (the default) or "clear" to start again.',
      'Each shape is one of:',
      '{"type":"rect","x":,"y":,"w":,"h":,"stroke":"#hex","fill":"none","width":4,"radius":0}',
      '{"type":"circle","cx":,"cy":,"r":,"stroke":"#hex","fill":"none","width":4}',
      '{"type":"ellipse","cx":,"cy":,"rx":,"ry":,"stroke":"#hex","fill":"none"}',
      '{"type":"line","x1":,"y1":,"x2":,"y2":,"stroke":"#hex","width":4}',
      '{"type":"polygon","points":[[x,y],[x,y]],"stroke":"#hex","fill":"none"}',
      '{"type":"path","d":"M.. L..","stroke":"#hex","fill":"none"}',
      '{"type":"text","x":,"y":,"text":"","size":48,"stroke":"#hex"}',
      'Place new shapes relative to what is already there so the picture makes sense.'
    ].join('\n');

    try {
      var res = await fetch(API + '/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify({ message: prompt, history: [] })
      });
      var data = await res.json();
      if (!res.ok) {
        if (window.CallistoGate?.fromServerError(Object.assign({ status: res.status }, data), 'drawings')) return;
        throw new Error(data.error || 'Could not reach Callisto.');
      }
      var raw = String(data.text || data.reply || data.message || '');
      // Models like to wrap JSON in fences however firmly you ask them not to.
      var m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Callisto did not send any shapes back.');
      var cmd = JSON.parse(m[0]);
      D().apply(cmd);
    } catch (err) {
      console.error('[draw]', err);
      if (window.addMessage) window.addMessage('assistant', 'I could not draw that. Try describing it a different way.');
    }
  }

  D().onCommand(ask);

  // Turning the drawing into something else, using the web generators.
  D().onHandOff(async function (h) {
    var subject = h.title && h.title !== 'Untitled drawing' ? h.title : 'my drawing';
    if (!window.CallistoCreate) return;
    if (h.kind === 'model') return window.CallistoCreate.handle('make a 3D model of ' + subject + '. ' + h.description);
    if (h.kind === 'video') return window.CallistoCreate.handle('make a video of ' + subject);
    if (h.kind === 'image') return window.CallistoCreate.handle('make a picture of ' + subject + '. ' + h.description);
  });

  // The chat routes "draw me a box" here and then the canvas takes over.
  window._webDraw = function (text) { D().show(); ask(text); };
})();
