/* ─────────────────────────────────────────────────────────────────────────────
   Icons instead of emoji

   Emoji look different on every machine and cheapen a careful interface: a
   cartoon clapperboard next to a sentence about video. This swaps the ones
   Callisto uses for clean line icons in one consistent style (24px grid,
   1.8px strokes, round joins), coloured from the surrounding text.

   CallistoIcons.svg(emoji)  -> an <svg> string, or '' if there is none
   CallistoIcons.swap(el)    -> replaces the known emoji inside an element
   Chat bubbles and the side card are swapped as they appear.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const P = {
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>',
    brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1Z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
    ruler: '<path d="M3 17 17 3l4 4L7 21Z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
    chat: '<path d="M4 5h16v11H9l-5 4V5Z"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    card: '<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M2.5 10h19M6 15h3"/>',
    cube: '<path d="m12 2.5 8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5Z"/><path d="m3.5 7.25 8.5 4.75 8.5-4.75M12 12v9.5"/>',
    news: '<rect x="3" y="4.5" width="15" height="15" rx="2"/><path d="M18 8h3v9.5a2 2 0 0 1-4 0M7 9h7M7 13h7M7 16.5h4"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    laptop: '<rect x="4" y="4.5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
    tools: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5"/><path d="M5 4l3 3-2 2-3-3"/>',
    bolt: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12Z"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L3 9M4 13a8 8 0 0 0 14.5 4.5L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    note: '<path d="M6 3h9l4 4v14H6Z"/><path d="M15 3v4h4M9 12h6M9 16h4"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    warn: '<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    cross: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.4-2-.5-1.3.4-2.5 1.7-2.5H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
    doc: '<path d="M6 3h9l4 4v14H6Z"/><path d="M15 3v4h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    fire: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-3 5-3 8a6 6 0 0 0 6 6Z"/>',
    wave: '<path d="M7 12V6.5a1.5 1.5 0 0 1 3 0V11M10 10V5a1.5 1.5 0 0 1 3 0v5M13 10V6a1.5 1.5 0 0 1 3 0v6c0 4-2.5 8-7 8-3 0-4.5-2-6-5l-1-2a1.5 1.5 0 0 1 2.6-1.5L7 14"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 10.5a7 7 0 0 0 14 0M12 17.5v4"/>',
    folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.8"/><path d="M6 9.5v.01M18 14.5v.01"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
    heart: '<path d="M12 20s-8-4.8-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.2 12 20 12 20Z"/>',
    trash: '<path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13"/>',
    pin: '<path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4 1.5A3.3 3.3 0 0 0 7 18Z"/>',
    rain: '<path d="M7 15h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4 1.5A3.3 3.3 0 0 0 7 15Z"/><path d="M8 18.5l-1 2M12 18.5l-1 2M16 18.5l-1 2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 6.2l2.1 2.1M17.7 15.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 17.8l2.1-2.1M17.7 8.3l2.1-2.1"/>',
    think: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z"/>',
  };
  const MAP = {
    '🎬': 'video', '📹': 'video', '🎥': 'video', '📱': 'phone', '✅': 'check', '✔️': 'check', '☑️': 'check',
    '📅': 'calendar', '🗓️': 'calendar', '🔔': 'bell', '⏰': 'clock', '📧': 'mail', '✉️': 'mail', '📨': 'mail',
    '🔍': 'search', '🔎': 'search', '✏️': 'pencil', '📝': 'note', '🖊️': 'pencil', '📸': 'camera', '📷': 'camera',
    '🧠': 'brain', '📐': 'ruler', '💬': 'chat', '🚫': 'ban', '💳': 'card', '🧊': 'cube', '🗞️': 'news', '📰': 'news',
    '⤢': 'expand', '💻': 'laptop', '🖥️': 'laptop', '📊': 'chart', '📈': 'chart', '🛠️': 'tools', '🔧': 'tools',
    '⚡': 'bolt', '↩️': 'undo', '🔄': 'refresh', '🔁': 'refresh', '🧑': 'person', '👤': 'person', '🔒': 'lock', '🔐': 'lock',
    '⚠️': 'warn', '❌': 'cross', '🎵': 'music', '🎶': 'music', '🎧': 'music', '🎨': 'palette', '🖼️': 'image', '🖼': 'image',
    '📄': 'doc', '📃': 'doc', '📑': 'doc', '🔥': 'fire', '👋': 'wave', '🌍': 'globe', '🌐': 'globe', '✨': 'sparkle',
    '✦': 'sparkle', '👀': 'eye', '🎙️': 'mic', '🎤': 'mic', '📁': 'folder', '📂': 'folder', '🔗': 'link', '💰': 'money',
    '💵': 'money', '⭐': 'star', '❤️': 'heart', '🗑️': 'trash', '📍': 'pin', '▶️': 'play', 'ℹ️': 'info', '🤔': 'think',
    '💡': 'think', '⚙️': 'gear', '⚙': 'gear', '✏': 'pencil', '🖐️': 'wave', '🖐': 'wave', '🤚': 'wave', '✋': 'wave', '⌨️': 'keyboard', '⌨': 'keyboard',
    '🌙': 'moon', '☀️': 'sun', '🌤️': 'sun', '⛅': 'cloud', '☁️': 'cloud', '🌥️': 'cloud', '🌧️': 'rain', '🌦️': 'rain', '⛈️': 'rain',
  };
  // Longest first, so a two-character emoji is matched before its first half.
  const KEYS = Object.keys(MAP).sort((a, b) => b.length - a.length);
  const RE = new RegExp(KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

  function svg(emoji, size) {
    const name = MAP[emoji] || (P[emoji] ? emoji : null);
    if (!name) return '';
    const s = size || 16;
    return '<svg class="cico" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[name] + '</svg>';
  }

  // Swap emoji in text nodes only - never inside code, inputs or SVG.
  function swap(el) {
    if (!el || !el.ownerDocument) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest('code, pre, textarea, input, svg, .katex, [data-no-icons]')) return NodeFilter.FILTER_REJECT;
        RE.lastIndex = 0;
        return RE.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const hits = [];
    while (walker.nextNode()) hits.push(walker.currentNode);
    for (const n of hits) {
      const frag = document.createDocumentFragment();
      let last = 0; const text = n.nodeValue; RE.lastIndex = 0; let m;
      while ((m = RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const span = document.createElement('span');
        span.className = 'cico-wrap';
        span.innerHTML = svg(m[0]);
        frag.appendChild(span);
        // The space after a leading emoji stays; the variation selector goes.
        last = m.index + m[0].length;
        if (text.charCodeAt(last) === 0xFE0F) last++;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    }
  }

  const css = document.createElement('style');
  css.textContent = '.cico-wrap{display:inline-flex;vertical-align:-0.18em;margin-right:.15em;color:currentColor;opacity:.92}.cico{display:block}';
  document.head.appendChild(css);

  // Watch where Callisto writes: the chat and the side card's stack.
  function watch(sel) {
    const target = document.querySelector(sel);
    if (!target) return;
    swap(target);
    new MutationObserver((list) => {
      for (const m of list) {
        m.addedNodes.forEach((n) => { if (n.nodeType === 1) swap(n); else if (n.nodeType === 3 && n.parentElement) swap(n.parentElement); });
        if (m.type === 'characterData' && m.target.parentElement) swap(m.target.parentElement);
      }
    }).observe(target, { childList: true, subtree: true, characterData: true });
  }
  function boot() {
    // The emoji built into the screen itself - buttons, labels, panels - once.
    swap(document.body);
    ['#chat', '#chatContainer', '#messages', '#stack', '#hudWeather'].forEach(watch);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.CallistoIcons = { svg, swap, has: (e) => !!MAP[e] };
})();
