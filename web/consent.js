/* Cookie consent for callistoai.net.
   Google Analytics sets tracking cookies, so it is loaded only after the
   visitor says yes. Declining keeps the site fully working with no tracking
   cookies at all. The choice is kept in this browser and can be changed any
   time from "Cookie settings" in the footer (window.CallistoCookies.open()). */
(function () {
  'use strict';
  var GA_ID = 'G-HQFT54DL2X';
  var KEY = 'callisto_cookie_consent';   // 'yes' | 'no'

  // gtag() is always defined, so anything on the page that records an event
  // works whether or not analytics ever loads; calls just wait in dataLayer.
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  function read() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (_) {} }

  var loaded = false;
  function loadAnalytics() {
    if (loaded) return;
    loaded = true;
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  // Google's own cookies, removed when someone changes their mind to "no".
  function clearAnalyticsCookies() {
    var host = location.hostname.replace(/^www\./, '');
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (!/^_ga|^_gid|^_gat/.test(name)) return;
      ['', '; domain=' + host, '; domain=.' + host].forEach(function (d) {
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d;
      });
    });
  }

  var css = ''
    + '#ckBar{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483000;max-width:560px;margin:0 auto;'
    + 'background:rgba(13,20,33,.96);color:#e8eefc;border:1px solid rgba(79,142,247,.28);border-radius:14px;'
    + 'box-shadow:0 18px 50px rgba(0,0,0,.45);padding:16px 18px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;'
    + 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);animation:ckIn .28s ease-out}'
    + '#ckBar p{margin:0 0 12px;color:rgba(214,226,250,.86)}#ckBar a{color:#7fb0ff}'
    + '#ckBar .ck-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}'
    + '#ckBar button{font:inherit;font-weight:600;border-radius:999px;padding:8px 18px;cursor:pointer;min-height:38px}'
    + '#ckBar .ck-no{background:transparent;color:#d6e2fa;border:1px solid rgba(214,226,250,.28)}'
    + '#ckBar .ck-yes{background:#3d5cff;color:#fff;border:1px solid #3d5cff}'
    + '#ckBar button:focus-visible{outline:2px solid #7fb0ff;outline-offset:2px}'
    + '@keyframes ckIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}'
    + '@media (prefers-reduced-motion:reduce){#ckBar{animation:none}}';

  function show() {
    if (document.getElementById('ckBar')) return;
    if (!document.getElementById('ckStyle')) {
      var st = document.createElement('style'); st.id = 'ckStyle'; st.textContent = css; document.head.appendChild(st);
    }
    var bar = document.createElement('div');
    bar.id = 'ckBar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie choice');
    bar.innerHTML = '<p>We use Google Analytics cookies to count visits and see which pages help. They are only set if you allow them, and the site works the same either way. <a href="/privacy.html#cookies">Learn more</a></p>'
      + '<div class="ck-row"><button type="button" class="ck-no">Decline</button><button type="button" class="ck-yes">Accept</button></div>';
    document.body.appendChild(bar);
    bar.querySelector('.ck-yes').addEventListener('click', function () { write('yes'); bar.remove(); loadAnalytics(); });
    bar.querySelector('.ck-no').addEventListener('click', function () { write('no'); bar.remove(); clearAnalyticsCookies(); });
  }

  window.CallistoCookies = {
    open: function () { show(); },
    choice: function () { return read(); },
  };

  var choice = read();
  if (choice === 'yes') loadAnalytics();
  else if (choice !== 'no') {
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
  }

  // Any element with data-cookie-settings reopens the choice.
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[data-cookie-settings]');
    if (t) { e.preventDefault(); show(); }
  });
})();
