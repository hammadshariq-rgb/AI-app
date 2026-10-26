/* ─────────────────────────────────────────────────────────────────────────────
   Skills — ways of working, added from GitHub

   Somebody has already worked out how to write a reel that lands, or how to
   run outreach, and written it down. Pointing Callisto at that repository
   means it works the way that person works, for those tasks.

   What is installed is INSTRUCTIONS, not code. Nothing from a repository is
   ever executed - only Markdown is read. That is said plainly in the dialog
   too, because "install from GitHub" sounds like it should mean running
   somebody's program, and here it genuinely does not.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  function styles() {
    if (document.getElementById('skStyles')) return;
    const s = document.createElement('style');
    s.id = 'skStyles';
    s.textContent = `
      /* the + menu */
      #plusMenu{position:fixed;z-index:9600;width:300px;padding:6px;border-radius:14px;
        background:linear-gradient(180deg,#121a2e,#0b1120);
        border:1px solid rgba(120,160,255,.2);box-shadow:0 24px 70px rgba(0,0,0,.6)}
      .pm-item{display:flex;gap:11px;align-items:flex-start;width:100%;padding:10px 11px;
        border:none;background:transparent;border-radius:10px;cursor:pointer;text-align:left;
        color:#dce8ff;font-family:inherit}
      .pm-item:hover{background:rgba(90,130,255,.14)}
      .pm-ico{font-size:15px;line-height:1.3;width:20px;flex-shrink:0;text-align:center}
      .pm-item b{display:block;font-size:12.5px;font-weight:650}
      .pm-item i{display:block;font-style:normal;font-size:11px;margin-top:2px;
        color:rgba(165,190,235,.72);line-height:1.45}

      /* the dialog */
      #skWrap{position:fixed;inset:0;z-index:9700;display:flex;align-items:center;
        justify-content:center;background:rgba(4,6,14,.74);backdrop-filter:blur(10px)}
      #skWrap.hidden{display:none}
      .sk-panel{width:min(620px,93vw);max-height:84vh;overflow:auto;border-radius:18px;padding:22px;
        background:linear-gradient(180deg,#0e1424,#070b14);
        border:1px solid rgba(120,160,255,.18);box-shadow:0 40px 120px rgba(0,0,0,.7)}
      .sk-eyebrow{font-size:9px;letter-spacing:3px;font-weight:700;color:rgba(110,140,205,.6)}
      .sk-title{font-size:19px;font-weight:700;color:#eef3ff;margin:3px 0 6px}
      .sk-sub{font-size:12.5px;line-height:1.6;color:rgba(185,208,250,.82);margin-bottom:16px}
      .sk-input{width:100%;box-sizing:border-box;padding:12px 13px;border-radius:10px;font-size:13px;
        background:rgba(8,13,28,.85);border:1px solid rgba(120,160,255,.24);color:#e8f0ff;
        font-family:inherit;outline:none}
      .sk-input:focus{border-color:rgba(120,170,255,.55)}
      .sk-eg{margin-top:8px;font-size:11px;color:rgba(150,175,220,.6);line-height:1.6}
      .sk-eg code{background:rgba(255,255,255,.05);padding:1px 5px;border-radius:4px;
        font-family:ui-monospace,Consolas,monospace;font-size:10.5px}
      .sk-row{margin-top:16px;display:flex;gap:9px;flex-wrap:wrap;align-items:center}
      .sk-btn{min-height:40px;padding:10px 17px;border-radius:9px;cursor:pointer;border:none;
        font-size:12.5px;font-weight:700;background:rgba(61,92,255,.92);color:#fff;font-family:inherit}
      .sk-btn.ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#cfe0ff}
      .sk-btn:disabled{opacity:.45;cursor:default}
      .sk-msg{margin-top:13px;font-size:12.5px;line-height:1.6;min-height:18px}
      .sk-msg.bad{color:#ff9a9a}
      .sk-msg.good{color:#7ee0a8}
      .sk-note{margin-top:15px;padding:10px 12px;border-radius:9px;font-size:11.5px;line-height:1.6;
        background:rgba(120,160,255,.07);border:1px solid rgba(120,160,255,.15);
        color:rgba(175,200,240,.85)}
      .sk-list{margin-top:4px}
      .sk-item{display:flex;gap:12px;align-items:flex-start;padding:12px 2px;
        border-bottom:1px solid rgba(255,255,255,.06)}
      .sk-item:last-child{border-bottom:none}
      .sk-item-main{flex:1;min-width:0}
      .sk-item-name{font-size:13px;font-weight:650;color:#e9f1ff}
      .sk-item-desc{font-size:11.5px;line-height:1.55;color:rgba(170,195,235,.78);margin-top:3px}
      .sk-item-src{font-size:10.5px;color:rgba(130,155,200,.55);margin-top:4px;
        font-family:ui-monospace,Consolas,monospace}
      .sk-x{background:transparent;border:1px solid rgba(255,120,120,.3);color:#ff9a9a;
        border-radius:7px;min-height:30px;padding:5px 11px;font-size:11px;cursor:pointer;
        flex-shrink:0;font-family:inherit}
      .sk-x:hover{background:rgba(255,80,80,.12)}
      .sk-empty{padding:26px 0;text-align:center;font-size:12.5px;color:rgba(160,185,225,.6);
        line-height:1.7}`;
    document.head.appendChild(s);
  }

  let root;
  function panel(html) {
    styles();
    if (!root) {
      root = document.createElement('div');
      root.id = 'skWrap';
      document.body.appendChild(root);
      root.addEventListener('click', (e) => { if (e.target === root) close(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && root && !root.classList.contains('hidden')) close();
      });
    }
    root.innerHTML = `<div class="sk-panel">${html}</div>`;
    root.classList.remove('hidden');
    return root.querySelector('.sk-panel');
  }

  function close() { if (root) root.classList.add('hidden'); }

  /* ── Adding one ─────────────────────────────────────────────────────────── */
  function add() {
    const p = panel(`
      <div class="sk-eyebrow">CALLISTO &middot; SKILLS</div>
      <div class="sk-title">Add a skill from GitHub</div>
      <div class="sk-sub">Paste the address of a repository that holds one. Callisto will
        follow it whenever a request matches what the skill is for.</div>
      <input class="sk-input" id="skUrl" placeholder="github.com/owner/repo" autocomplete="off" spellcheck="false" />
      <div class="sk-eg">Works with a whole repo or one folder inside it —
        <code>github.com/owner/skills</code> or
        <code>github.com/owner/skills/tree/main/instagram</code></div>
      <div class="sk-msg" id="skMsg"></div>
      <div class="sk-row">
        <button class="sk-btn" id="skGo">Add skill</button>
        <button class="sk-btn ghost" id="skCancel">Cancel</button>
      </div>
      <div class="sk-note"><b>A skill is instructions, not a program.</b> Callisto reads the
        written guidance in the repository and follows it for those tasks. Nothing from
        GitHub is downloaded as code or run on your computer.</div>`);

    const url = p.querySelector('#skUrl');
    const msg = p.querySelector('#skMsg');
    const go = p.querySelector('#skGo');
    url.focus();

    const run = async () => {
      const v = url.value.trim();
      if (!v) { msg.className = 'sk-msg bad'; msg.textContent = 'Paste a GitHub address first.'; return; }
      go.disabled = true;
      msg.className = 'sk-msg';
      msg.textContent = 'Reading that repository…';
      try {
        const r = await window.jarvis.skillsInstall(v);
        if (r && r.error) {
          msg.className = 'sk-msg bad';
          msg.textContent = r.error;
          go.disabled = false;
          return;
        }
        const names = (r.skills || []).map((s) => s.name).join(', ');
        msg.className = 'sk-msg good';
        msg.textContent = `Added ${r.count} skill${r.count === 1 ? '' : 's'}: ${names}`;
        go.disabled = false;
        setTimeout(manage, 1100);
      } catch (err) {
        msg.className = 'sk-msg bad';
        msg.textContent = err.message || 'That did not work.';
        go.disabled = false;
      }
    };

    go.addEventListener('click', run);
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    p.querySelector('#skCancel').addEventListener('click', close);
  }

  /* ── Seeing what is installed ───────────────────────────────────────────── */
  async function manage() {
    let items = [];
    try { items = (await window.jarvis.skillsList()).items || []; } catch (_) {}

    const list = items.length
      ? `<div class="sk-list">${items.map((s) => `
          <div class="sk-item" data-id="${esc(s.id)}">
            <div class="sk-item-main">
              <div class="sk-item-name">${esc(s.name)}</div>
              <div class="sk-item-desc">${esc(s.description || 'No description given.')}</div>
              <div class="sk-item-src">${esc(s.source || '')}</div>
            </div>
            <button class="sk-x" data-remove="${esc(s.id)}">Remove</button>
          </div>`).join('')}</div>`
      : `<div class="sk-empty">No skills yet.<br>Add one from GitHub and Callisto will use it
           whenever it fits what you are doing.</div>`;

    const p = panel(`
      <div class="sk-eyebrow">CALLISTO &middot; SKILLS</div>
      <div class="sk-title">Your skills</div>
      <div class="sk-sub">${items.length
        ? 'Callisto follows these when a request matches what they are for.'
        : 'Ways of working, added from GitHub.'}</div>
      ${list}
      <div class="sk-row">
        <button class="sk-btn" id="skAdd">Add another</button>
        <button class="sk-btn ghost" id="skDone">Done</button>
      </div>`);

    p.querySelector('#skAdd').addEventListener('click', add);
    p.querySelector('#skDone').addEventListener('click', close);
    p.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        await window.jarvis.skillsRemove(b.dataset.remove);
        manage();
      });
    });
  }

  // Everything above puts repository text on screen, so it is escaped. A skill
  // name is whatever somebody wrote in a file on the internet.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.CallistoSkills = { add, manage, close };
})();
