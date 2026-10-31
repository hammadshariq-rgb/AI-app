/* ─────────────────────────────────────────────────────────────────────────────
   Picking up where you left off

   Notes what is open as it opens (a document, picture, video, 3D model or
   drawing), and brings it back with the last conversation, recent files and
   browser tabs when asked. Also: several files in one sentence, and pasted links.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var KEY = 'callisto_last_work';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function note(item) {
    item.at = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(item)); } catch (_) {
      // Too big to keep whole (a drawing full of pictures): keep what it was.
      try { localStorage.setItem(KEY, JSON.stringify({ kind: item.kind, title: item.title, at: item.at })); } catch (_) {}
    }
  }
  function wrap(obj, name, fn) {
    if (!obj || typeof obj[name] !== 'function') return;
    var orig = obj[name];
    obj[name] = function () { try { fn.apply(null, arguments); } catch (_) {} return orig.apply(this, arguments); };
  }
  function start() {
    wrap(window.CallistoDocStudio, 'show', function (d) { if (d && !restoring) note({ kind: 'doc', title: d.title, doc: d }); });
    wrap(window.CallistoImageStudio, 'open', function (url, o) { note({ kind: 'image', url: url, title: o && o.title, prompt: o && o.prompt }); });
    wrap(window.CallistoVideoViewer, 'open', function (url, o) { note({ kind: 'video', url: url, title: o && o.title }); });
    wrap(window.CallistoModelViewer, 'open', function (url, o) { note({ kind: 'model', url: url, title: o && o.title, opts: o }); });
    // A drawing changes as it's worked on, so it's noted while it's open.
    setInterval(function () {
      var D = window.CallistoDraw;
      if (D && D.isOpen && D.isOpen() && D.count && D.count() > 0) note({ kind: 'draw', title: D.titleOf && D.titleOf(), shapes: D.exportShapes() });
    }, 20000);
  }

  var restoring = false;
  function reopenFront() {
    var w = load();
    if (!w) return null;
    if (Date.now() - w.at > 14 * 86400000) return null;
    restoring = true;
    try {
      if (w.kind === 'doc' && w.doc && window.CallistoDocStudio) { window.CallistoDocStudio.show(w.doc); return 'your document'; }
      if (w.kind === 'image' && w.url && window.CallistoImageStudio) { window.CallistoImageStudio.open(w.url, { title: w.title, prompt: w.prompt }); return 'your picture'; }
      if (w.kind === 'video' && w.url && window.CallistoVideoViewer) { window.CallistoVideoViewer.open(w.url, { title: w.title }); return 'your video'; }
      if (w.kind === 'model' && w.url && window.CallistoModelViewer) { window.CallistoModelViewer.open(w.url, w.opts || {}); return 'your 3D model'; }
      if (w.kind === 'draw' && w.shapes && window.CallistoDraw) { window.CallistoDraw.show(); window.CallistoDraw.loadShapes(w.shapes, w.title); return 'your drawing'; }
    } catch (_) {} finally { restoring = false; }
    return null;
  }

  // Any way of saying it, as long as it is short. A long sentence that happens
  // to contain "continue" is about something else.
  var RESUME = /\b(?:pick(?:ing)?|take|start)\s+(?:(?:it|this|things?|back)\s+)*(?:up\s+)?(?:back\s+)?(?:from\s+)?(?:where|my\s+work|what)\b|\b(?:resume|restore|reopen|bring back|get back to|back to|continue|carry on(?: with)?)\s+(?:my|our|from|where|what|the)\b[^.?!]{0,30}\b(?:work|session|left|stuff|stopped|doing|yesterday|night|morning|tabs|everything)?|\bwhere\s+(?:was i|were we|did (?:i|we) (?:leave|stop|get to))\b|\bwhat\s+was\s+i\s+(?:doing|working on)\b|\bwhere\s+(?:i|we)\s+left(?:\s+off)?\b|\b(?:left|let)\s+off\b|\brestore my\b/i;
  var NOT_RESUME = /^\s*(?:how|why|explain|what is|what does)\b|\b(?:video|song|movie|episode|music|download|payment|subscription)\b/i;
  window._isResumeRequest = function (t) {
    var s = String(t || '').trim();
    return s.split(/\s+/).length <= 14 && RESUME.test(s) && !NOT_RESUME.test(s);
  };

  // Returns text saying what came back.
  window._resumeWork = async function (restoreChat) {
    var got = [];
    if (await restoreChat()) got.push('our last conversation');
    var front = reopenFront();
    if (front) got.push(front);
    var res = null;
    try { res = await window.jarvis.workRestore(); } catch (_) {}
    if (res && res.files && res.files.length) got.push(res.files.length === 1 ? res.files[0] : res.files.length + ' files');
    if (res && res.tabsOpened) got.push(res.tabsOpened + ' ' + res.browser + ' tab' + (res.tabsOpened === 1 ? '' : 's'));
    var extra = res && res.tabsStillOpen ? ' Your ' + res.browser + ' tabs are still open, so I left them alone.' : '';
    if (!got.length) return 'I couldn\'t find any earlier work to bring back yet.' + extra;
    var list = got.length > 1 ? got.slice(0, -1).join(', ') + ' and ' + got[got.length - 1] : got[0];
    return 'Welcome back. I\'ve reopened ' + list + '.' + extra;
  };

  // "Open budget.pdf and notes.docx", "open my invoice, contract and the logo file"
  var HAS_EXT = /\.[a-z0-9]{2,5}$/i;
  window._filesToOpen = function (t) {
    var m = String(t || '').trim().replace(/[.!]+$/, '').match(/^(?:please\s+)?(?:can you\s+)?(?:open|pull up|bring up|show me)\s+(?:up\s+)?(?:these\s+|the\s+files?\s+|files?\s+)?(.+)$/i);
    if (!m) return null;
    var parts = m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+(?:also\s+)?(?:open\s+)?|\s*&\s*/i).map(function (p) { return p.replace(/^(?:my|the)\s+/i, '').trim(); }).filter(Boolean);
    if (parts.length < 2 || parts.length > 5) return null;
    var filey = parts.filter(function (p) { return HAS_EXT.test(p) || /\b(?:file|document|doc|pdf|spreadsheet|sheet|presentation|slides|deck|photo|picture|image|video)\b/i.test(p); });
    return filey.length ? parts : null;
  };

  // A pasted link, on its own or with "open". A question about a link goes to the AI.
  window._urlsToOpen = function (t) {
    var s = String(t || '').trim().replace(/^(?:please\s+)?(?:can you\s+)?(?:open|go to|visit|load|play|watch)\s+(?:this\s+|that\s+|the\s+)?(?:link\s*:?\s*|url\s*:?\s*|video\s*:?\s*|site\s*:?\s*|website\s*:?\s*)?/i, '').replace(/\s+(?:for me|please)[.!]*$/i, '').trim();
    var bits = s.split(/[\s,]+/).filter(Boolean);
    if (!bits.length || bits.length > 8) return null;
    var urls = [];
    for (var i = 0; i < bits.length; i++) {
      var b = bits[i].replace(/[)>\].,]+$/, '').replace(/^[(<\[]+/, '');
      if (/^https?:\/\/\S+$/i.test(b)) urls.push(b);
      else if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ai|app|dev|me|tv|edu|gov|pk|uk|ca|de|in|au)(?:[/?#]\S*)?$/i.test(b)) urls.push('https://' + b);
      else return null;
    }
    return urls;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
