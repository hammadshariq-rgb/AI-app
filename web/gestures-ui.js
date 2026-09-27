/* ─────────────────────────────────────────────────────────────────────────────
   "My gestures" on the website

   Hold a pose for three seconds, name it, and say what it should do — either
   one of Callisto's actions or an instruction in your own words. The matcher
   lives in gestures.js, shared with the desktop app, so a pose recorded here
   behaves the way it does there.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var G = function () { return window.CallistoGestures; };
  var studio, listEl, recEl, saveEl, arc, num, nameIn, actSel, promptIn, warnEl;
  var pending = null, mode = 'builtin';
  var ARC = 2 * Math.PI * 34;

  /* Only the actions that mean something in a browser. Starting and stopping
     the mic are app-only, so offering them here would just disappoint. */
  var WEB_OK = ['open_markets', 'open_calendar', 'close_nav', 'toggle_theme'];

  function esc(s) {
    return String(s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  function build() {
    if (studio) return;
    studio = document.createElement('div');
    studio.id = 'gwStudio';
    studio.className = 'gws gw-hidden';

    var html = [
      '<div class="gws-head"><span class="gws-title">YOUR GESTURES</span>',
      '<button class="gws-x" id="gwsClose" aria-label="Close">&#10005;</button></div>',
      '<div class="gws-list" id="gwsList"></div>',
      '<button class="gw-btn" id="gwsAdd">+ Record a new gesture</button>',
      '<div class="gws-rec gw-hidden" id="gwsRec">',
      '<div class="gws-step">Hold the pose you want to use</div>',
      '<div class="gws-ring"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="34"></circle>',
      '<circle cx="40" cy="40" r="34" id="gwsArc"></circle></svg><span id="gwsNum">3</span></div>',
      '<div class="gws-hint">Keep your hand still in front of the camera</div>',
      '<button class="gw-btn" id="gwsCancel">Cancel</button></div>',
      '<div class="gws-save gw-hidden" id="gwsSave">',
      '<input class="gws-input" id="gwsName" maxlength="40" placeholder="Name it, e.g. Thumbs up">',
      '<div class="gws-tabs">',
      '<button class="gws-tab gws-tab-on" data-mode="builtin">Pick an action</button>',
      '<button class="gws-tab" data-mode="prompt">Or say it in words</button></div>',
      '<select class="gws-input" id="gwsAction"></select>',
      '<input class="gws-input gw-hidden" id="gwsPrompt" maxlength="300" placeholder="Anything you could ask out loud">',
      '<div class="gws-warn gw-hidden" id="gwsWarn"></div>',
      '<div class="gws-row"><button class="gw-btn gw-btn-go" id="gwsSaveBtn">Save gesture</button>',
      '<button class="gw-btn" id="gwsRetry">Record again</button></div></div>'
    ].join('');
    studio.innerHTML = html;
    document.body.appendChild(studio);

    listEl = studio.querySelector('#gwsList');
    recEl = studio.querySelector('#gwsRec');
    saveEl = studio.querySelector('#gwsSave');
    arc = studio.querySelector('#gwsArc');
    num = studio.querySelector('#gwsNum');
    nameIn = studio.querySelector('#gwsName');
    actSel = studio.querySelector('#gwsAction');
    promptIn = studio.querySelector('#gwsPrompt');
    warnEl = studio.querySelector('#gwsWarn');

    studio.querySelector('#gwsClose').addEventListener('click', close);
    studio.querySelector('#gwsAdd').addEventListener('click', record);
    studio.querySelector('#gwsCancel').addEventListener('click', function () {
      if (G()) G().cancelRecording();
      pane(null);
    });
    studio.querySelector('#gwsRetry').addEventListener('click', record);
    studio.querySelector('#gwsSaveBtn').addEventListener('click', save);
    nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
    promptIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });

    Array.prototype.forEach.call(studio.querySelectorAll('.gws-tab'), function (t) {
      t.addEventListener('click', function () {
        mode = t.getAttribute('data-mode');
        Array.prototype.forEach.call(studio.querySelectorAll('.gws-tab'), function (x) {
          x.classList.toggle('gws-tab-on', x === t);
        });
        actSel.classList.toggle('gw-hidden', mode !== 'builtin');
        promptIn.classList.toggle('gw-hidden', mode !== 'prompt');
        if (mode === 'prompt') promptIn.focus();
      });
    });

    var opts = (G() ? G().BUILTIN : []).filter(function (b) {
      return WEB_OK.indexOf(b.id) >= 0;
    });
    actSel.innerHTML = opts.map(function (b) {
      return '<option value="' + b.id + '">' + esc(b.label) + '</option>';
    }).join('');
  }

  function pane(which) {
    recEl.classList.toggle('gw-hidden', which !== 'rec');
    saveEl.classList.toggle('gw-hidden', which !== 'save');
    listEl.classList.toggle('gw-hidden', !!which);
    studio.querySelector('#gwsAdd').classList.toggle('gw-hidden', !!which);
  }

  function actionLabel(a) {
    if (!a) return '';
    if (a.kind === 'prompt') return '"' + a.text + '"';
    var match = (G() ? G().BUILTIN : []).filter(function (x) { return x.id === a.id; })[0];
    return match ? match.label : a.id;
  }

  function render() {
    var items = G() ? G().list() : [];
    listEl.innerHTML = items.length
      ? items.map(function (g) {
          return '<div class="gws-item"><span class="gws-name">' + esc(g.name) + '</span>' +
            '<span class="gws-act">' + esc(actionLabel(g.action)) + '</span>' +
            '<button class="gws-del" data-del="' + esc(g.id) + '" aria-label="Delete">&#10005;</button></div>';
        }).join('')
      : '<div class="gws-empty">No gestures yet. Record one and it works every time you open Callisto in this browser.</div>';

    Array.prototype.forEach.call(listEl.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        G().remove(b.getAttribute('data-del')).then(render);
      });
    });
  }

  function record() {
    // Nothing to read without the camera, so turn it on if it is off.
    if (window.CallistoHandControl && !window.CallistoHandControl.isOn()) {
      window.CallistoHandControl.start();
    }
    pane('rec');
    arc.style.strokeDasharray = ARC;
    arc.style.strokeDashoffset = ARC;

    G().startRecording(
      function (pct) {
        arc.style.strokeDashoffset = String(ARC * (1 - pct));
        num.textContent = String(Math.max(1, Math.ceil((1 - pct) * 3)));
      },
      function (result) {
        if (!result) { pane(null); return; }
        pending = result;
        nameIn.value = '';
        promptIn.value = '';
        warnEl.classList.add('gw-hidden');
        // Warn now rather than letting two gestures fight each other later.
        var clash = G().clashesWith(result.sig);
        if (clash) warn('That looks a lot like "' + clash.name + '". Callisto may confuse the two.');
        else if (result.spread > G().MATCH_THRESHOLD * 0.7) warn('Your hand moved a fair bit. Consider recording again.');
        pane('save');
        nameIn.focus();
      }
    );
  }

  function warn(t) {
    warnEl.textContent = '⚠ ' + t;
    warnEl.classList.remove('gw-hidden');
  }

  function save() {
    if (!pending) return;
    var name = nameIn.value.trim();
    if (!name) { warn('Give it a name first.'); return; }
    var action = mode === 'prompt'
      ? { kind: 'prompt', text: promptIn.value.trim() }
      : { kind: 'builtin', id: actSel.value };
    if (mode === 'prompt' && !action.text) { warn('Say what it should do.'); return; }

    G().save({ name: name, sig: pending.sig, spread: pending.spread, action: action })
      .then(function (r) {
        if (!r || !r.ok) { warn((r && r.error) || 'Could not save that.'); return; }
        pending = null;
        pane(null);
        render();
      });
  }

  function open() {
    build();
    studio.classList.remove('gw-hidden');
    if (G()) G().load().then(render);
  }

  function close() {
    if (studio) studio.classList.add('gw-hidden');
    if (G()) G().cancelRecording();
    pane(null);
  }

  window.openGestureStudio = open;
})();
