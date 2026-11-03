/* My business, in Account settings. Callisto fills it in from conversation;
   this is where it can be read, corrected and added to. */
(function () {
  'use strict';
  const FIELDS = [
    ['name', 'Business name', 'Bloom Coffee'],
    ['what', 'What you sell or do', 'Specialty coffee and pastries, one shop'],
    ['customers', 'Customers', '~600 regulars, students and office workers'],
    ['revenue', 'Revenue', 'PKR 1.2m a month'],
    ['costs', 'Main costs', 'Rent 250k, beans 300k (imported), staff 280k, power 90k'],
    ['pricing', 'Pricing', 'Latte PKR 750, average order PKR 1,100'],
    ['team', 'Team', '6 staff'],
    ['suppliers', 'Suppliers and where from', 'Beans from Ethiopia via Dubai, milk local'],
    ['markets', 'Where you sell', 'Lahore, plus Instagram orders'],
    ['channels', 'How you sell and market', 'Walk-ins, Instagram, Foodpanda'],
    ['goals', 'Goals', 'Second shop by next summer'],
    ['challenges', 'Challenges', 'Bean costs up with the rupee'],
    ['notes', 'Anything else', ''],
  ];
  const root = document.getElementById('bizFields');
  if (!root || !window.jarvis || !window.jarvis.businessGet) return;

  const css = document.createElement('style');
  css.textContent = `
    .biz-sub{font-size:11.5px;line-height:1.5;color:rgba(170,195,235,.7);margin:6px 0 10px}
    .biz-fields{display:grid;gap:8px}
    .biz-fields label{display:block;font-size:10.5px;letter-spacing:.06em;color:rgba(150,180,235,.75);margin-bottom:3px}
    .biz-fields textarea{width:100%;box-sizing:border-box;min-height:34px;resize:vertical;padding:8px 10px;border-radius:9px;border:1px solid rgba(110,160,255,.22);background:rgba(5,10,30,.55);color:#e6eeff;font:inherit;font-size:12.5px;line-height:1.45}
    .biz-fields textarea:focus-visible{outline:2px solid #6f8cff;outline-offset:1px}
    .biz-row{display:flex;align-items:center;gap:10px;margin-top:10px}
    .biz-msg{font-size:11.5px;color:#7ee0a8}`;
  document.head.appendChild(css);

  root.innerHTML = FIELDS.map(([k, label, eg]) => `<div><label for="biz_${k}">${label}</label>
    <textarea id="biz_${k}" data-k="${k}" rows="1" maxlength="600" placeholder="${eg ? 'e.g. ' + eg : ''}"></textarea></div>`).join('');

  function fill(b) {
    for (const [k] of FIELDS) {
      const el = document.getElementById('biz_' + k);
      if (el && document.activeElement !== el) el.value = (b && b[k]) || '';
    }
  }
  window.jarvis.businessGet().then(fill).catch(() => {});
  window.jarvis.onBusinessChanged?.(fill);

  document.getElementById('bizSave').addEventListener('click', async () => {
    const b = {};
    root.querySelectorAll('textarea').forEach((t) => { b[t.dataset.k] = t.value; });
    const msg = document.getElementById('bizMsg');
    const r = await window.jarvis.businessSave(b).catch(() => null);
    msg.textContent = r && r.ok ? 'Saved' : 'Could not save';
    setTimeout(() => { msg.textContent = ''; }, 2500);
  });
})();
