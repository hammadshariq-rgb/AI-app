/* ─────────────────────────────────────────────────────────────────────────────
   Making pictures, videos and 3D models on the website

   The same generators the desktop app uses, reachable from the browser. Free
   accounts get one of each a day, which the server enforces — this file only
   has to ask nicely and show the answer.

   Long jobs (video, 3D) are polled rather than held open, because a phone that
   locks its screen will drop a hanging request and nobody wants to start again.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var API = 'https://ai-app-production-9224.up.railway.app';

  /* What the user is asking for. Deliberately stricter than the desktop app's
     routing: a browser has no 3D studio to fall back into, so a wrong guess is
     worse here. */
  var WANTS = [
    { kind: 'model', re: /\b(3d model|3-d model|3d print|\bmesh\b|sculpt)\b/i },
    { kind: 'video', re: /\b(video|clip|animation|animate|reel)\b/i },
    { kind: 'image', re: /\b(image|picture|photo|photograph|illustration|artwork|drawing|logo|poster|wallpaper|render)\b/i }
  ];
  var MAKING = /\b(make|create|generate|draw|design|paint|give me|i want|can you (?:make|create|draw|generate))\b/i;

  function wanted(text) {
    if (!text || !MAKING.test(text)) return null;
    for (var i = 0; i < WANTS.length; i++) {
      if (WANTS[i].re.test(text)) return WANTS[i].kind;
    }
    return null;
  }

  /* Strip the instruction so only the subject reaches the generator.
     "make me a picture of a red fox" -> "a red fox" */
  function subjectOf(text) {
    return String(text)
      .replace(/^\s*(?:hey |hi |ok |okay |please )+/i, '')
      .replace(/\b(?:can you |could you |please )\b/gi, '')
      .replace(MAKING, '')
      .replace(/^\s*(?:me|us)\s+/i, '')
      .replace(/^\s*(?:a|an|the)\s+/i, '')
      // Only the medium is dropped. A logo or a poster IS the subject, so
      // stripping those would leave "for my shop" and generate nonsense.
      .replace(/\b(3d model|3-d model|3d print|mesh|sculpt|video|clip|animation|reel|image|picture|photo|photograph|render)\b/gi, '')
      .replace(/^\s*(?:of|about|showing)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function token() {
    try { return localStorage.getItem('cai_token'); } catch (_) { return null; }
  }

  async function post(path, body) {
    var res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify(body)
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      var err = data || {};
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function get(path) {
    var res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token() } });
    if (!res.ok) throw { status: res.status };
    return res.json();
  }

  /* ── Showing the result ────────────────────────────────────────────────── */
  function card(kind) {
    var el = document.createElement('div');
    el.className = 'cw-card';
    el.innerHTML =
      '<div class="cw-head"><span class="cw-kind">' +
        (kind === 'image' ? 'PICTURE' : kind === 'video' ? 'VIDEO' : '3D MODEL') +
      '</span><span class="cw-state" data-state>Starting…</span></div>' +
      '<div class="cw-bar"><i data-bar></i></div>' +
      '<div class="cw-out" data-out></div>';
    var messages = document.getElementById('messages');
    var row = document.createElement('div');
    row.className = 'msg-row assistant';
    row.appendChild(el);
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;

    return {
      state: function (t) { el.querySelector('[data-state]').textContent = t; },
      progress: function (pct) {
        var bar = el.querySelector('[data-bar]');
        bar.style.width = Math.max(3, Math.min(100, pct)) + '%';
      },
      done: function (html) {
        el.querySelector('.cw-bar').remove();
        el.querySelector('[data-state]').textContent = 'Ready';
        el.querySelector('[data-out]').innerHTML = html;
        messages.scrollTop = messages.scrollHeight;
      },
      fail: function (msg) {
        el.classList.add('cw-failed');
        el.querySelector('.cw-bar').remove();
        el.querySelector('[data-state]').textContent = 'Stopped';
        el.querySelector('[data-out]').textContent = msg;
      }
    };
  }

  function downloadLink(url, name, label) {
    // Opened rather than downloaded: the file lives on the generator's CDN and
    // a cross-origin download attribute is ignored anyway.
    return '<a class="cw-dl" href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
  }

  /* ── The three generators ──────────────────────────────────────────────── */
  async function makeImage(prompt, ui) {
    ui.state('Painting…');
    ui.progress(35);
    var r = await post('/ai/image', { prompt: prompt, size: '1024x1024' });
    if (!r || !r.url) throw { error: 'No picture came back.' };
    ui.progress(100);
    ui.done('<img class="cw-img" src="' + r.url + '" alt="' + prompt.replace(/"/g, '') + '">' +
      downloadLink(r.url, 'picture.png', 'Open full size') +
      (r.imagesLeft != null ? '<span class="cw-left">' + r.imagesLeft + ' left today</span>' : ''));
  }

  // Video and 3D both hand back a job to poll. Same shape, same waiting.
  async function poll(path, ui, onReady, label) {
    var tries = 0;
    while (tries < 150) {                     // about 7 minutes at 3s
      await new Promise(function (r) { setTimeout(r, 3000); });
      tries++;
      var job;
      try { job = await get(path); } catch (_) { continue; }
      if (job.progress != null) ui.progress(Math.max(6, job.progress));
      else ui.progress(Math.min(92, 6 + tries * 1.6));
      if (job.status === 'SUCCEEDED' || job.status === 'succeeded' || job.url || job.videoUrl) {
        onReady(job);
        return;
      }
      if (job.status === 'FAILED' || job.status === 'failed' || job.error) {
        throw { error: job.error || (label + ' didn’t finish.') };
      }
      ui.state(label + '… this takes a minute or two');
    }
    throw { error: 'That took too long. Try again in a moment.' };
  }

  async function makeVideo(prompt, ui) {
    ui.state('Starting the video…');
    ui.progress(6);
    var start = await post('/video/generate', { prompt: prompt });
    var id = start.jobId || start.id;
    if (!id) throw { error: 'The video generator didn’t start.' };
    await poll('/video/job/' + id, ui, function (job) {
      var url = job.videoUrl || job.url;
      ui.progress(100);
      ui.done('<video class="cw-video" src="' + url + '" controls playsinline></video>' +
        downloadLink(url, 'video.mp4', 'Open video'));
    }, 'Making the video');
  }

  async function makeModel(prompt, ui) {
    ui.state('Starting the model…');
    ui.progress(6);
    var start = await post('/models/generate', { prompt: prompt, style: 'sculpture' });
    var id = start.jobId || start.id;
    if (!id) throw { error: 'The model generator didn’t start.' };
    await poll('/models/job/' + id, ui, function (job) {
      var url = job.url || job.modelUrl;
      var thumb = job.thumbnail || job.thumbnailUrl;
      ui.progress(100);
      // No 3D viewer on the website, so the thumbnail stands in and the file
      // is there to open in whatever they model with.
      ui.done(
        (thumb ? '<img class="cw-img" src="' + thumb + '" alt="3D model preview">' : '') +
        downloadLink(url, 'model.glb', 'Download the .glb') +
        '<span class="cw-note">Open it in the desktop app to spin it, recolour it and edit it by voice.</span>'
      );
    }, 'Building the model');
  }

  var MAKERS = { image: makeImage, video: makeVideo, model: makeModel };
  var NICE = { image: 'pictures', video: 'videos', model: '3D models' };

  /* The one call the chat makes. Returns true when it took the message. */
  async function handle(text) {
    var kind = wanted(text);
    if (!kind) return false;

    if (!token()) {
      window.CallistoGate?.show('signin', { feature: 'make ' + NICE[kind] });
      return true;
    }

    var prompt = subjectOf(text) || text;
    var ui = card(kind);
    try {
      await MAKERS[kind](prompt, ui);
    } catch (err) {
      // Out of allowance is a gate, not an error — it has a way forward.
      if (window.CallistoGate?.fromServerError(err, NICE[kind])) {
        ui.fail('You’ve used today’s free ' + NICE[kind] + '.');
        return true;
      }
      ui.fail((err && (err.error || err.message)) || 'That didn’t work. Try again.');
    }
    return true;
  }

  window.CallistoCreate = { handle: handle, wanted: wanted, subjectOf: subjectOf };
})();
