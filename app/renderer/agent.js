// ── Working on its own, and being taught ─────────────────────────────────────
//
// Three things live here, and they share one idea: Callisto does the parts it
// can do by itself and stops the moment it needs a person.
//
//   "sort out X for me"            - works through it a step at a time
//   "let me show you how I do X"   - writes the steps down under a name
//   "do the X"                     - carries out one it was taught
//
// Nothing that installs, writes, commits, pushes, deploys or deletes runs
// without a press. That rule lives in the main process, not here, so a change
// in this file cannot loosen it.
(function () {
  'use strict';

  const J = () => window.jarvis || {};
  const say = (t) => { try { window.addMessage('assistant', t); } catch (_) {} };

  // ── Being taught ───────────────────────────────────────────────────────────
  let teaching = null;   // { name, steps }

  const TEACH_START = /^(?:ok(?:ay)?[,\s]+)?(?:let me |i(?:'| a)?ll )?(?:show|teach|walk)\s+(?:you|u)\s+(?:through\s+)?(?:how\s+(?:i|we|to)\s+)?(.+)$/i;
  const TEACH_ALT   = /^(?:remember|learn)\s+how\s+(?:i|we)\s+(.+)$/i;
  const TEACH_END   = /^(?:ok(?:ay)?[,\s]+)?(?:that(?:'s| is)\s+it|that(?:'s| is)\s+all|done|finished|end|save\s+(?:it|that)|stop\s+(?:recording|learning))\b/i;
  const PROC_RUN    = /^(?:ok(?:ay)?[,\s]+)?(?:(?:now\s+)?(?:do|run|carry\s+out|perform)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:procedure|routine|process))?)$/i;
  const PROC_LIST   = /^(?:what|which)\s+(?:procedures|routines|things)\s+(?:do\s+you\s+know|have\s+(?:i|you)\s+taught)/i;

  // A job to go away and work on. Deliberately narrow: this takes over the
  // whole turn, so it only fires on a clear instruction to get something done.
  const TASK_START = /\b(?:sort|fix|work)\s+(?:this|that|it|them)?\s*out\b|\b(?:go\s+(?:and\s+)?)?(?:sort|fix|debug|investigate|set\s+up|install|deploy|build|test|commit|clean\s+up|tidy\s+up|refactor|update)\b[^.?!]{0,80}\b(?:for\s+me|yourself|on\s+your\s+own|please)\b|^(?:go\s+)?(?:ahead\s+and\s+)?(?:sort|fix|debug|investigate)\b/i;

  // Writing code is its own way of asking, and none of the words above cover
  // it: nobody says "fix me a login page for me". These are the shapes people
  // actually use when they want something built.
  const CODE_START = /^(?:ok(?:ay)?[,\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:write|code|build|create|make|add|implement|scaffold|generate|set\s+up)\b[^.?!]{0,100}\b(?:page|web ?page|web ?site|website|web ?app|landing ?page|screen|component|function|class|script|file|endpoint|route|api|form|button|test|tests|feature|app|site|game|portfolio|blog|shop|store|bot|hook|module|method|model|schema|migration|style(?:s|sheet)?|css|html|react|vue|svelte|next(?:\.?js)?|python|node|server|login|signup|dashboard|toggle|modal|navbar|sidebar|footer|header)\b|^(?:start|begin)\s+coding\b|\bwrite\s+(?:me\s+)?(?:some|the)?\s*code\b/i;

  // ...but not when they mean a picture, a video, a document or a 3D model,
  // which have their own makers and must not be swallowed by this.
  const NOT_CODE = /\b(?:picture|image|photo|video|clip|3d\s*model|model\s+of|song|music|poem|story|essay|email|document|slide|deck|spreadsheet|sketch|drawing|logo)\b/i;

  // "the project is in C:\dev\thing", "use the folder ~/code/app"
  const SET_FOLDER = /(?:project|code|repo|folder|work)\s+(?:is\s+)?(?:in|at|under)\s+(.+)$|^(?:use|open|set)\s+(?:the\s+)?folder\s+(.+)$/i;

  let pendingGoal = null;   // what they asked for while no folder was chosen

  async function startTask(goal) {
    const r = await J().taskStart?.(goal);
    if (r && r.ok) {
      say(`Right — working on that in \`${r.folder}\`. I will get on with the safe parts and stop when I need you.`);
      return true;
    }
    if (r && r.error === 'busy') { say(`I am still working on "${r.goal}". Say *"stop"* if you want me to drop it.`); return true; }
    // The handler refuses rather than falling back to the home directory, so
    // whatever route got here still ends at the picker rather than at nothing.
    if (r && r.error === 'no-folder') { pendingGoal = goal; askForFolder(); return true; }
    return false;
  }

  // A button, because a path typed from memory is a poor way to pick a folder.
  function askForFolder() {
    const row = document.createElement('div');
    row.className = 'msg-row assistant';
    row.innerHTML = `
      <div class="msg-avatar">${window.SPARKLES_SVG || ''}</div>
      <div class="msg assistant">
        <span class="msg-text">Which project should I work in? I need a folder before I can read or write anything.</span>
        <div style="margin-top:9px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="gleam gleam-sm" data-agent="pick"><span>Choose folder…</span></button>
          <span style="font-size:11px;opacity:.6">or just tell me: <em>the project is in C:\\dev\\my-app</em></span>
        </div>
      </div>`;
    const chatEl = document.getElementById('chat');
    chatEl.appendChild(row);
    chatEl.scrollTop = chatEl.scrollHeight;
    row.querySelector('[data-agent="pick"]')?.addEventListener('click', async () => {
      const res = await J().pickProjectFolder?.();
      // A folder can be refused for being too broad - a home folder or a whole
      // drive. Saying why beats the button appearing to do nothing.
      if (res && res.error) { say(res.error); return; }
      if (!res || !res.ok) return;
      row.querySelector('button').disabled = true;
      say(`Working in \`${res.folder}\`.`);
      if (pendingGoal) { const g = pendingGoal; pendingGoal = null; await startTask(g); }
    });
  }

  window._checkAgent = async function (text) {
    // Quotes around the whole thing come off first. People type "build me a
    // component" with the quotes included, and every pattern below is
    // anchored to the start of the sentence - so a leading quotation mark
    // meant none of them matched and the request fell through to the model.
    // Curly quotes especially, because that is what most keyboards produce.
    const t = String(text || '')
      .trim()
      .replace(/^["'‘’“”«»`]+/, '')
      .replace(/["'‘’“”«»`]+$/, '')
      .trim();
    if (!t) return false;

    // ── while being taught, everything is a step ────────────────────────────
    if (teaching) {
      if (TEACH_END.test(t)) {
        if (!teaching.steps.length) {
          teaching = null;
          await J().procCancel?.();
          say('Nothing to save — I did not catch any steps. Start again whenever you like.');
          return true;
        }
        const res = await J().procSave?.(teaching.name);
        const saved = teaching;
        teaching = null;
        if (res && res.ok) {
          say(`Saved as **${res.name}**, ${res.steps} step${res.steps === 1 ? '' : 's'}:\n\n${saved.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nSay *"do the ${res.name}"* and I will work through it.`);
        } else {
          say(`I could not save that: ${(res && res.error) || 'unknown problem'}`);
        }
        return true;
      }
      teaching.steps.push(t);
      await J().procNote?.(t, 'say');
      say(`Noted — step ${teaching.steps.length}. Carry on, or say *"that's it"* when you are done.`);
      return true;
    }

    // ── start being taught ─────────────────────────────────────────────────
    const m = t.match(TEACH_START) || t.match(TEACH_ALT);
    if (m && m[1] && m[1].trim().length > 2) {
      const name = m[1].replace(/[.?!]+$/, '').trim();
      teaching = { name, steps: [] };
      await J().procStart?.(name);
      say(`Go on then — walk me through **${name}**, one step per message. I will write each one down. Say *"that's it"* when you have finished.`);
      return true;
    }

    // ── what do you know? ──────────────────────────────────────────────────
    if (PROC_LIST.test(t)) {
      const list = (await J().procList?.()) || [];
      say(list.length
        ? `You have taught me ${list.length}:\n\n${list.map((p) => `• **${p.name}** — ${p.steps} step${p.steps === 1 ? '' : 's'}${p.runs ? `, run ${p.runs}×` : ''}`).join('\n')}`
        : 'Nothing yet. Say *"let me show you how I do the Monday report"* and walk me through it.');
      return true;
    }

    // ── run something it was taught ────────────────────────────────────────
    const pm = t.match(PROC_RUN);
    if (pm && pm[1]) {
      const wanted = pm[1].replace(/[.?!]+$/, '').trim();
      const list = (await J().procList?.()) || [];
      const hit = list.find((p) => p.name.toLowerCase() === wanted.toLowerCase())
        || list.find((p) => wanted.toLowerCase().includes(p.name.toLowerCase()))
        || list.find((p) => p.name.toLowerCase().includes(wanted.toLowerCase()));
      if (hit) {
        const r = await J().procRun?.(hit.name);
        if (r && r.ok) { say(`Working through **${hit.name}** — ${r.steps} step${r.steps === 1 ? '' : 's'}. I will stop and ask if anything needs you.`); return true; }
        say(`I could not start that: ${(r && r.error) === 'busy' ? 'I am already working on something.' : ((r && r.error) || 'unknown problem')}`);
        return true;
      }
      // Not a procedure — fall through so it is treated as an ordinary request.
    }

    // ── "the project is in …" ──────────────────────────────────────────────
    const fm = t.match(SET_FOLDER);
    if (fm && fm[1]) {
      const r = await J().setProjectFolder?.(fm[1].trim());
      if (r && r.ok) {
        say(`Right — I'll work in \`${r.folder}\`.`);
        if (pendingGoal) { const g = pendingGoal; pendingGoal = null; await startTask(g); }
        return true;
      }
      say((r && r.error) || 'I could not find that folder.');
      return true;
    }

    // ── set it to work ─────────────────────────────────────────────────────
    // "How do I add debugging?" is a question, not a request to start work in a
    // project folder.
    const _asking = /^(?:how|what|why|where|when|which|who|is|are|does|do|did|should|can i|could i)\b/i.test(t) || /\?\s*$/.test(t) && !/^(?:can|could|would|will)\s+you\b/i.test(t);
    if (!_asking && (TASK_START.test(t) || (CODE_START.test(t) && !NOT_CODE.test(t)))) {
      // Work needs somewhere to happen. Telling someone "say which folder" and
      // giving them no way to say it is how this used to dead-end in a home
      // directory - so it offers the picker, and remembers what they wanted.
      const chosen = await J().getProjectFolder?.();
      if (!chosen) {
        pendingGoal = t;
        askForFolder();
        return true;
      }
      if (await startTask(t)) return true;
    }
    return false;
  };

  // ── What it is doing, as it does it ─────────────────────────────────────────
  J().onTaskStep?.((d) => {
    if (!d) return;
    if (d.kind === 'running') {
      say(`\`${d.command}\`${d.why ? `\n*${d.why}*` : ''}`);
    } else if (d.kind === 'ran') {
      const out = String(d.output || '').trim();
      say(`${d.ok ? '✅' : '⚠️'} ${d.ok ? 'Done' : 'That failed'}${out ? `\n\n\`\`\`\n${out.slice(-900)}\n\`\`\`` : ''}`);
    } else if (d.kind === 'wrote') {
      say(d.ok
        ? `📝 Wrote \`${d.path}\` — ${d.bytes} bytes.`
        : `⚠️ Could not write \`${d.path}\`: ${d.error || 'unknown problem'}`);
    }
  });

  // ── The two reasons it stops ───────────────────────────────────────────────
  J().onTaskNeedsYou?.((d) => {
    if (!d) return;
    if (d.kind === 'question') {
      say(`🧑 **I need you here.**\n\n${d.question}`);
      window._agentAwaitingAnswer = true;
      return;
    }
    // Something that changes things — a command, or a file to be written.
    // Shown in full, and nothing happens until this is pressed.
    const isWrite = d.kind === 'write';
    const body = isWrite ? String(d.contents || '') : String(d.command || '');
    const lines = isWrite ? body.split('\n').length : 1;
    const row = document.createElement('div');
    row.className = 'msg-row assistant';
    row.innerHTML = `
      <div class="msg-avatar">${window.SPARKLES_SVG || ''}</div>
      <div class="msg assistant">
        <span class="msg-text"><b>${isWrite
          ? `It wants to write <code>${esc(d.path)}</code>`
          : 'This one changes things, so it is yours to approve.'}</b>${d.why ? `<br><span style="opacity:.75">${esc(d.why)}</span>` : ''}</span>
        <pre style="margin:8px 0 6px;padding:8px 10px;border-radius:7px;background:rgba(0,0,0,.35);border:1px solid rgba(100,140,255,.25);font-size:12px;white-space:pre-wrap;word-break:break-word;${isWrite ? 'max-height:320px;overflow:auto' : ''}">${esc(body)}</pre>
        <div style="font-size:10.5px;opacity:.6;margin-bottom:8px">${isWrite
          ? `${lines} line${lines === 1 ? '' : 's'} · replaces whatever is at that path · in ${esc(d.folder || '')}`
          : `in ${esc(d.folder || '')}`}</div>
        <div style="display:flex;gap:8px">
          <button class="gleam gleam-sm" data-agent="run"><span>${isWrite ? 'Write it' : 'Run it'}</span></button>
          <button class="gleam gleam-sm" data-agent="skip" style="opacity:.75"><span>Not that</span></button>
        </div>
      </div>`;
    const chatEl = document.getElementById('chat');
    chatEl.appendChild(row);
    chatEl.scrollTop = chatEl.scrollHeight;

    const done = (approved) => {
      row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;opacity:.65;margin-top:6px';
      note.textContent = approved
        ? (isWrite ? 'Writing it…' : 'Running it…')
        : 'Skipped — finding another way.';
      row.querySelector('.msg').appendChild(note);
      J().taskResume?.({ approved });
    };
    row.querySelector('[data-agent="run"]')?.addEventListener('click', () => done(true));
    row.querySelector('[data-agent="skip"]')?.addEventListener('click', () => done(false));
  });

  J().onTaskDone?.((d) => {
    window._agentAwaitingAnswer = false;
    say(`**Finished.** ${(d && d.summary) || ''}${d && d.runs ? `\n\n*${d.runs} command${d.runs === 1 ? '' : 's'} run.*` : ''}`);
  });

  // An answer to a question it asked goes back to the job, not to ordinary chat.
  const _origCheck = window._checkAgent;
  window._checkAgent = async function (text) {
    if (window._agentAwaitingAnswer) {
      window._agentAwaitingAnswer = false;
      await J().taskResume?.({ answer: text });
      return true;
    }
    return _origCheck(text);
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
