/* ─────────────────────────────────────────────────────────────────────────────
   Charts in the chat

   One look for every chart Callisto draws: line, bar and candlestick. A card
   with the headline figure and its change, dashed grid, dotted fill under
   lines, a pulsing marker on the latest value, a draw-in on arrival, and a
   crosshair with a tooltip on hover or the arrow keys. Legend entries switch
   their series on and off.

   The one rule this file enforces: a chart says where its numbers came from.
   Anything the model worked out rather than measured is stamped ESTIMATE in
   the picture itself, so a guess cannot be screenshotted into a pitch deck and
   mistaken later for research.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var W = 640, H = 250, PAD_L = 58, PAD_R = 18, PAD_T = 16, PAD_B = 32;
  // Callisto's blues first, then the accents used across the app.
  var COLOURS = ['#4D8DFF', '#35C9FF', '#FF8A5B', '#49D6A0', '#C78BFF'];
  var UP = '#3DDC97', DOWN = '#FF5C6C', EST = '#FFC478';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function styles() {
    if (document.getElementById('mcStyles')) return;
    var s = document.createElement('style');
    s.id = 'mcStyles';
    s.textContent = [
      ".mc-card{position:relative;margin:12px 0 4px;padding:16px 16px 14px;border-radius:16px;font-family:'Plus Jakarta Sans','Segoe UI',sans-serif;",
      '  background:linear-gradient(180deg,rgba(18,26,48,.94),rgba(9,14,28,.94));border:1px solid rgba(120,160,255,.18);box-shadow:0 18px 40px -22px rgba(0,0,0,.7)}',
      '.mc-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}',
      '.mc-glyph{flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;color:#bfe0ff;',
      '  background:linear-gradient(135deg,rgba(77,141,255,.25),rgba(53,201,255,.14));border:1px solid rgba(77,141,255,.3)}',
      '.mc-titles{min-width:0;flex:1}',
      '.mc-title{display:block;font-size:13.5px;font-weight:650;color:#e9f1ff;text-wrap:balance}',
      '.mc-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}',
      '.mc-badge{font-size:8.5px;letter-spacing:1.3px;font-weight:700;padding:3px 7px;border-radius:5px}',
      '.mc-badge.est{background:rgba(255,176,80,.14);color:#ffc478;border:1px solid rgba(255,176,80,.3)}',
      '.mc-badge.meas{background:rgba(61,220,151,.12);color:#6fe0ad;border:1px solid rgba(61,220,151,.28)}',
      '.mc-fig{text-align:right;flex:none}',
      '.mc-dl{position:absolute;top:12px;right:12px;z-index:3;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;cursor:pointer;',
      '  color:#cfe0ff;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);opacity:0;transition:opacity .15s,background .15s}',
      '.mc-card:hover .mc-dl,.mc-dl:focus-visible{opacity:1}',
      '.mc-dl:hover{background:rgba(77,141,255,.22)}',
      '.mc-dl:focus-visible{outline:2px solid #4D8DFF;outline-offset:2px}',
      '.mc-card:not(.mc-bare) .mc-fig{margin-right:38px}',
      '.mc-card.mc-bare .mc-dl{top:-36px;right:0}',
      ".mc-val{display:block;font-family:'Rajdhani',sans-serif;font-weight:700;font-size:24px;line-height:1;color:#fff;font-variant-numeric:tabular-nums}",
      '.mc-delta{display:inline-block;margin-top:5px;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;font-variant-numeric:tabular-nums}',
      '.mc-delta.up{color:#3ddc97;background:rgba(61,220,151,.12);border:1px solid rgba(61,220,151,.3)}',
      '.mc-delta.down{color:#ff6b7a;background:rgba(255,92,108,.12);border:1px solid rgba(255,92,108,.3)}',
      '.mc-plot{position:relative;outline:none;border-radius:8px;touch-action:pan-y}',
      '.mc-plot:focus-visible{box-shadow:0 0 0 2px #4D8DFF}',
      '.mc-svg{width:100%;height:auto;display:block;overflow:visible}',
      '.mc-axis{font-size:10.5px;fill:rgba(170,195,240,.62);font-variant-numeric:tabular-nums}',
      '.mc-grid{stroke:rgba(140,170,230,.14);stroke-width:1;stroke-dasharray:3 4}',
      '.mc-line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}',
      '.mc-draw{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:mcDraw 1.1s cubic-bezier(.65,0,.35,1) forwards}',
      '@keyframes mcDraw{to{stroke-dashoffset:0}}',
      '.mc-fade{opacity:0;animation:mcFade .6s ease-out .35s forwards}',
      '@keyframes mcFade{to{opacity:1}}',
      '.mc-grow{transform-box:fill-box;transform-origin:bottom;transform:scaleY(0);animation:mcGrow .7s cubic-bezier(.2,.8,.2,1) forwards}',
      '@keyframes mcGrow{to{transform:scaleY(1)}}',
      '.mc-pulse{transform-box:fill-box;transform-origin:center;animation:mcPulse 1.8s ease-out 1.2s infinite;opacity:0}',
      '@keyframes mcPulse{0%{transform:scale(1);opacity:.4}100%{transform:scale(2.6);opacity:0}}',
      '.mc-off{opacity:.12!important}',
      '.mc-cross{pointer-events:none;opacity:0;transition:opacity .12s}',
      '.mc-tip{position:absolute;pointer-events:none;opacity:0;transform:translate(-50%,-100%);transition:opacity .12s;z-index:2;',
      '  min-width:120px;padding:8px 10px;border-radius:10px;background:rgba(8,13,28,.96);border:1px solid rgba(120,160,255,.28);box-shadow:0 10px 26px rgba(0,0,0,.5)}',
      '.mc-tip b{display:block;font-size:11px;color:#cfe0ff;margin-bottom:4px;font-weight:650}',
      '.mc-tip span{display:flex;align-items:center;gap:6px;font-size:11.5px;color:rgba(205,220,250,.85);white-space:nowrap}',
      '.mc-tip i{width:8px;height:8px;border-radius:2px;flex:none}',
      '.mc-tip em{margin-left:auto;padding-left:10px;font-style:normal;font-weight:700;color:#fff;font-variant-numeric:tabular-nums}',
      '.mc-legend{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.mc-leg{display:flex;align-items:center;gap:6px;font:inherit;font-size:11px;color:rgba(195,215,250,.88);padding:4px 9px;border-radius:99px;cursor:pointer;',
      '  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}',
      '.mc-leg[aria-pressed="false"]{opacity:.45}',
      '.mc-leg:focus-visible{outline:2px solid #4D8DFF;outline-offset:2px}',
      '.mc-dot{width:9px;height:9px;border-radius:3px;flex-shrink:0}',
      '.mc-card.mc-bare{margin:0;padding:0;background:none;border:0;box-shadow:none}',
      ".mc-barval{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:13px;fill:#fff;font-variant-numeric:tabular-nums}",
      '.mc-take{margin:-2px 0 12px;padding:9px 12px;border-radius:10px;font-size:12.5px;line-height:1.55;color:#dbe6ff;',
      '  background:rgba(77,141,255,.08);border:1px solid rgba(77,141,255,.18)}',
      '.mc-take b{color:#fff;font-weight:650}',
      '.mc-key{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:rgba(195,215,250,.85)}',
      '.mc-key span{display:inline-flex;align-items:center;gap:6px}',
      '.mc-key i{width:10px;height:10px;border-radius:3px;flex:none}',
      '.mc-hint{margin-top:8px;font-size:10.5px;color:rgba(160,185,225,.5)}',
      ".mc-tag{font:600 10.5px 'Plus Jakarta Sans','Segoe UI',sans-serif;fill:#fff}",
      '.mc-tagbg{fill:rgba(8,13,28,.85);stroke:rgba(255,255,255,.18)}',
      '.mc-read{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:start;margin-top:12px;padding:12px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(140,170,255,.12)}',
      '.mc-read h4{margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:rgba(170,190,230,.65)}',
      '.mc-read ul{margin:0;padding-left:16px;font-size:12.5px;line-height:1.55;color:#dbe6ff}',
      '.mc-read li{margin:3px 0}',
      '.mc-read li::marker{color:#7fa8ff}',
      '.mc-anatomy{width:118px;height:auto;display:block}',
      ".mc-anatomy text{font:600 9.5px 'Plus Jakarta Sans','Segoe UI',sans-serif;fill:rgba(205,220,250,.8)}",
      '@media (max-width:520px){.mc-read{grid-template-columns:1fr}}',
      '.mc-note{margin-top:10px;font-size:11px;line-height:1.6;color:rgba(160,185,225,.72)}',
      '@media (prefers-reduced-motion:reduce){.mc-draw,.mc-fade,.mc-grow,.mc-pulse{animation:none!important;stroke-dashoffset:0;opacity:1;transform:none}}'
    ].join('');
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 1200 -> "1.2k", 3400000 -> "3.4M". Axis labels have to be short.
  function short(n) {
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    if (a < 1 && a > 0) return String(Math.round(n * 100) / 100);
    return String(Math.round(n * 100) / 100);
  }
  function full(n) {
    var a = Math.abs(n);
    if (a >= 1e6) return short(n);
    if (a >= 100) return Math.round(n).toLocaleString('en-US');
    return String(Math.round(n * 100) / 100);
  }
  function withUnit(spec, v, compact) {
    var u = spec.unit || '';
    var t = compact ? short(v) : full(v);
    return u === '%' ? t + '%' : (u.length <= 3 && !/^[a-z]/i.test(u) ? u + t : t + (u ? ' ' + u : ''));
  }

  // The axis always reaches past the largest value: a chart whose scale stops
  // short of its own tallest bar is a broken chart.
  function scale(values, fromZero) {
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values);
    if (!isFinite(max)) { max = 1; min = 0; }
    if (fromZero && min > 0) min = 0;
    if (max === min) max = min + 1;
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / 3 || 1)));
    var nice = [1, 2, 2.5, 5, 10], chosen = step;
    for (var i = 0; i < nice.length; i++) { if (span / (step * nice[i]) <= 4) { chosen = step * nice[i]; break; } }
    var top = Math.ceil(max / chosen) * chosen, bottom = Math.floor(min / chosen) * chosen;
    var ticks = [];
    for (var v = bottom; v <= top + 1e-9; v += chosen) ticks.push(Math.round(v * 1e6) / 1e6);
    return { top: top, bottom: bottom, ticks: ticks.slice(0, 6) };
  }

  // Smooth line through the points (Catmull-Rom as cubic Beziers).
  function smooth(pts) {
    if (!pts.length) return '';
    var d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) + ' ' +
        (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) + ' ' +
        p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return d;
  }

  var GLYPH_LINE = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11.5 6 7.5l3 3 5-6"/></svg>';
  var GLYPH_BAR = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 13V8M8 13V3M13 13V6"/></svg>';
  var GLYPH_CANDLE = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 2v12M12 3v11"/><rect x="2.5" y="5" width="3" height="5" rx=".6"/><rect x="10.5" y="6" width="3" height="4" rx=".6"/></svg>';

  function head(spec, glyph, value, delta, badges) {
    var d = isFinite(delta) ? '<span class="mc-delta ' + (delta >= 0 ? 'up' : 'down') + '">' + (delta >= 0 ? '▲ +' : '▼ ') + Math.abs(delta).toFixed(1) + '%</span>' : '';
    return '<div class="mc-head"><span class="mc-glyph" aria-hidden="true">' + glyph + '</span>' +
      '<div class="mc-titles"><span class="mc-title">' + esc(spec.title || 'Chart') + '</span><div class="mc-badges">' + badges + '</div></div>' +
      (value != null ? '<div class="mc-fig"><span class="mc-val">' + esc(value) + '</span>' + d + '</div>' : '') + '</div>';
  }
  function basisBadge(spec) {
    return spec.basis === 'measured' ? '<span class="mc-badge meas">YOUR DATA</span>' : '<span class="mc-badge est">ESTIMATE</span>';
  }

  // A plain-English line under the title, so the chart can be read without
  // studying it: what changed, from what to what, and what stands out.
  function pct(a, b) { return a ? ((b - a) / Math.abs(a)) * 100 : NaN; }
  function trendWord(d) { return !isFinite(d) ? 'changed' : Math.abs(d) < 1 ? 'held steady' : d > 0 ? 'rose ' + Math.abs(d).toFixed(0) + '%' : 'fell ' + Math.abs(d).toFixed(0) + '%'; }
  function lineTakeaway(spec, series, labels) {
    var out = [];
    series.slice(0, 2).forEach(function (s) {
      var pts = s.points, a = Number(pts[0].y), z = Number(pts[pts.length - 1].y);
      var hi = 0;
      pts.forEach(function (p, i) { if (Number(p.y) > Number(pts[hi].y)) hi = i; });
      var name = s.label || 'It';
      out.push('<b>' + esc(name) + '</b> ' + trendWord(pct(a, z)) + ', from ' + esc(withUnit(spec, a, true)) + ' in ' + esc(labels[0]) + ' to ' + esc(withUnit(spec, z, true)) + ' in ' + esc(labels[labels.length - 1]) +
        (hi !== pts.length - 1 && hi !== 0 ? ', peaking at ' + esc(withUnit(spec, Number(pts[hi].y), true)) + ' in ' + esc(labels[hi]) : '') + '.');
    });
    if (series.length === 2) {
      var A = series[0], B = series[1], above = A.points.every(function (p, i) { return B.points[i] && Number(p.y) >= Number(B.points[i].y); });
      var below = A.points.every(function (p, i) { return B.points[i] && Number(p.y) <= Number(B.points[i].y); });
      if (above || below) out.push(esc(A.label || 'The first') + ' stayed ' + (above ? 'above ' : 'below ') + esc(B.label || 'the second') + ' the whole time.');
    }
    return out.join(' ');
  }
  function barTakeaway(spec, series) {
    var pts = series[0].points.map(function (p) { return { x: String(p.x), y: Number(p.y) || 0 }; }).sort(function (a, b) { return b.y - a.y; });
    if (!pts.length) return '';
    var t = '<b>' + esc(pts[0].x) + '</b> is highest at ' + esc(withUnit(spec, pts[0].y, true));
    if (pts[1]) {
      var times = pts[1].y > 0 ? pts[0].y / pts[1].y : 0;
      t += times >= 1.5 ? ', about ' + times.toFixed(times >= 10 ? 0 : 1) + ' times ' + esc(pts[1].x) + ' (' + esc(withUnit(spec, pts[1].y, true)) + ')' : ', just ahead of ' + esc(pts[1].x) + ' (' + esc(withUnit(spec, pts[1].y, true)) + ')';
    }
    if (pts.length > 2) t += '. <b>' + esc(pts[pts.length - 1].x) + '</b> is lowest at ' + esc(withUnit(spec, pts[pts.length - 1].y, true));
    return t + '.';
  }
  // A labelled marker on the highest and lowest point of a line.
  function tag(x, y, text, above) {
    var w = text.length * 6.2 + 12, ty = above ? y - 14 : y + 14;
    var tx = Math.min(Math.max(x, PAD_L + w / 2), W - PAD_R - w / 2);
    return '<g class="mc-fade" style="animation-delay:1s"><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.5" fill="#fff"/>' +
      '<rect class="mc-tagbg" x="' + (tx - w / 2).toFixed(1) + '" y="' + (ty - 9).toFixed(1) + '" width="' + w.toFixed(1) + '" height="17" rx="5"/>' +
      '<text class="mc-tag" x="' + tx.toFixed(1) + '" y="' + (ty + 3.5).toFixed(1) + '" text-anchor="middle">' + esc(text) + '</text></g>';
  }
  var HINT = '<div class="mc-hint">Move across the chart, or use the arrow keys, to read each exact value.</div>';

  // ── Line and bar ──────────────────────────────────────────────────────────
  function buildSeries(spec) {
    var series = (spec.series || []).filter(function (s) { return s && Array.isArray(s.points) && s.points.length; }).slice(0, 5);
    if (!series.length) return null;
    var ys = [];
    series.forEach(function (s) { s.points.forEach(function (p) { var v = Number(p && p.y); if (isFinite(v)) ys.push(v); }); });
    if (!ys.length) return null;
    var isBar = spec.kind === 'bar';
    var pal = spec.colour ? [spec.colour].concat(COLOURS) : COLOURS;
    var sc = scale(ys, true);
    var labels = series[0].points.map(function (p) { return String(p && p.x != null ? p.x : ''); });
    var n = labels.length, plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    var yOf = function (v) { return PAD_T + plotH - ((v - sc.bottom) / (sc.top - sc.bottom)) * plotH; };
    var xOf = isBar
      ? function (i) { return PAD_L + (plotW / n) * i + plotW / n / 2; }
      : function (i) { return n === 1 ? PAD_L + plotW / 2 : PAD_L + (plotW * i) / (n - 1); };
    var uid = 'mc' + Math.random().toString(36).slice(2, 8);
    var parts = [], later = [], defs = '';

    sc.ticks.forEach(function (t) {
      var y = yOf(t);
      parts.push('<line class="mc-grid" x1="' + PAD_L + '" y1="' + y.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + y.toFixed(1) + '"/>');
      parts.push('<text class="mc-axis mc-fade" x="' + (PAD_L - 9) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + esc(withUnit(spec, t, true)) + '</text>');
    });

    var base = yOf(Math.max(0, sc.bottom));
    series.forEach(function (s, si) {
      var col = pal[si % pal.length];
      if (isBar) {
        var groupW = plotW / n, bw = Math.min(40, (groupW * 0.62) / series.length);
        var g = '<g data-s="' + si + '">';
        s.points.forEach(function (p, i) {
          var v = Number(p.y) || 0, cx = xOf(i), x = cx - (bw * series.length) / 2 + bw * si, y = yOf(v);
          g += '<rect class="mc-grow" style="animation-delay:' + (i * 0.04).toFixed(2) + 's" data-i="' + i + '" x="' + x.toFixed(1) + '" y="' + Math.min(y, base).toFixed(1) +
            '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, Math.abs(base - y)).toFixed(1) + '" rx="4" fill="url(#' + uid + 'b' + si + ')"/>';
          if (series.length === 1 && n <= 12) g += '<text class="mc-fade mc-barval" x="' + (x + bw / 2).toFixed(1) + '" y="' + (Math.min(y, base) - 7).toFixed(1) + '" text-anchor="middle">' + esc(withUnit(spec, v, true)) + '</text>';
        });
        parts.push(g + '</g>');
        defs += '<linearGradient id="' + uid + 'b' + si + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + col + '"/><stop offset="1" stop-color="' + col + '" stop-opacity=".35"/></linearGradient>';
      } else {
        var pts = s.points.map(function (p, i) { return [xOf(i), yOf(Number(p.y) || 0)]; });
        var line = smooth(pts);
        defs += '<pattern id="' + uid + 'd' + si + '" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1.25" cy="1.25" r="1.05" fill="' + col + '"/><circle cx="3.75" cy="3.75" r="1.05" fill="' + col + '"/></pattern>';
        var g2 = '<g data-s="' + si + '">';
        g2 += '<path class="mc-fade mc-area" d="' + line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + base.toFixed(1) + ' L' + pts[0][0].toFixed(1) + ' ' + base.toFixed(1) +
          ' Z" fill="url(#' + uid + 'd' + si + ')" opacity="' + (si === 0 ? 0.32 : 0.16) + '"/>';
        parts.push(g2 + '</g>'); g2 = '<g data-s="' + si + '">';
        g2 += '<path class="mc-line mc-draw" pathLength="1000" style="--len:1000" d="' + line + '" stroke="' + col + '"/>';
        if (si === 0) {
          var e = pts[pts.length - 1];
          g2 += '<circle class="mc-pulse" cx="' + e[0].toFixed(1) + '" cy="' + e[1].toFixed(1) + '" r="7" fill="' + col + '"/>' +
            '<circle class="mc-fade" cx="' + e[0].toFixed(1) + '" cy="' + e[1].toFixed(1) + '" r="7.5" fill="#0b1224"/>' +
            '<circle class="mc-fade" cx="' + e[0].toFixed(1) + '" cy="' + e[1].toFixed(1) + '" r="4.5" fill="' + col + '"/>';
        }
        later.push(g2 + '</g>');
      }
    });

    if (!isBar && series.length === 1 && n >= 4) {
      var sp = series[0].points, hiI = 0, loI = 0;
      sp.forEach(function (p, i) { if (Number(p.y) > Number(sp[hiI].y)) hiI = i; if (Number(p.y) < Number(sp[loI].y)) loI = i; });
      if (hiI !== n - 1) later.push(tag(xOf(hiI), yOf(Number(sp[hiI].y)), 'High ' + withUnit(spec, Number(sp[hiI].y), true), true));
      if (loI !== hiI && loI !== n - 1) later.push(tag(xOf(loI), yOf(Number(sp[loI].y)), 'Low ' + withUnit(spec, Number(sp[loI].y), true), false));
    }
    parts = parts.concat(later);
    var every = Math.max(1, Math.ceil(n / 7));
    labels.forEach(function (lab, i) {
      if (i % every) return;
      parts.push('<text class="mc-axis mc-fade" x="' + xOf(i).toFixed(1) + '" y="' + (H - PAD_B + 19) + '" text-anchor="middle">' + esc(lab.slice(0, 12)) + '</text>');
    });

    var first = series[0].points, v0 = Number(first[0].y), v1 = Number(first[first.length - 1].y);
    var delta = first.length > 1 && v0 ? ((v1 - v0) / Math.abs(v0)) * 100 : NaN;
    var take = isBar ? barTakeaway(spec, series) : lineTakeaway(spec, series, labels);
    var legend = series.length > 1 ? '<div class="mc-legend">' + series.map(function (s, i) {
      return '<button type="button" class="mc-leg" aria-pressed="true" data-s="' + i + '"><span class="mc-dot" style="background:' + pal[i % pal.length] + '"></span>' + esc(s.label || 'Series ' + (i + 1)) + '</button>';
    }).join('') + '</div>' : '';

    var model = {
      n: n, labels: labels, xOf: xOf,
      rows: function (i, off) {
        return series.map(function (s, si) {
          if (off[si] || !s.points[i]) return null;
          return { label: s.label || 'Value', colour: pal[si % pal.length], value: withUnit(spec, Number(s.points[i].y) || 0) };
        }).filter(Boolean);
      },
      top: function (i) { return Math.min.apply(null, series.map(function (s) { return s.points[i] ? yOf(Number(s.points[i].y) || 0) : H; })); }
    };

    if (spec.bare) return { html: '<div class="mc-card mc-bare">' + plot(uid, defs, parts, spec.title) + legend + '</div>', model: model };
    var key1 = series.length === 1 ? '<div class="mc-key"><span><i style="background:' + pal[0] + '"></i>' + esc(series[0].label || spec.title || 'Value') + (spec.unit ? ' (' + esc(spec.unit) + ')' : '') + '</span></div>' : '';
    var html = '<div class="mc-card">' + head(spec, isBar ? GLYPH_BAR : GLYPH_LINE, isBar ? null : withUnit(spec, v1), isBar ? NaN : delta, basisBadge(spec)) +
      (take ? '<div class="mc-take">' + take + '</div>' : '') +
      plot(uid, defs, parts, spec.title) + legend + key1 + HINT +
      (spec.note ? '<div class="mc-note">' + esc(spec.note) + '</div>'
        : (spec.basis === 'measured' ? '' : '<div class="mc-note">Worked out, not measured - check it before you rely on it.</div>')) + '</div>';
    return { html: html, model: model };
  }

  function plot(uid, defs, parts, title) {
    return '<div class="mc-plot" tabindex="0" role="group" aria-label="' + esc(title || 'Chart') + '. Use the arrow keys to read each value.">' +
      '<svg class="mc-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img"><defs>' + defs + '</defs>' + parts.join('') +
      '<line class="mc-cross" x1="0" x2="0" y1="' + (PAD_T - 4) + '" y2="' + (H - PAD_B) + '" stroke="#cfe0ff" stroke-opacity=".35" stroke-dasharray="3 3"/></svg>' +
      '<div class="mc-tip"></div></div>';
  }

  // What the candles are saying, in plain words: the latest run of days, where
  // the price sits against its own recent average, and the biggest single
  // move. Read from the real candles, never guessed.
  function candleReading(cs, fmt, unitDay) {
    var out = [], n = cs.length, last = cs[n - 1];
    var dir = last.c >= last.o, run = 0;
    for (var i = n - 1; i >= 0 && (cs[i].c >= cs[i].o) === dir; i--) run++;
    if (run >= 2) out.push('<b>' + run + ' ' + unitDay + 's in a row closed ' + (dir ? 'higher' : 'lower') + '</b> (' + (dir ? 'green' : 'red') + ' candles): ' + (dir ? 'buyers have been in control lately.' : 'sellers have been in control lately.'));
    else out.push('The latest ' + unitDay + ' closed <b>' + (dir ? 'higher' : 'lower') + '</b> than it opened, after a ' + (dir ? 'lower' : 'higher') + ' ' + unitDay + ', so the direction is mixed.');
    var k = Math.min(20, n), avg = 0;
    for (var j = n - k; j < n; j++) avg += cs[j].c;
    avg /= k;
    var gap = ((last.c - avg) / avg) * 100;
    out.push('The price is <b>' + Math.abs(gap).toFixed(1) + '% ' + (gap >= 0 ? 'above' : 'below') + '</b> its ' + k + '-' + unitDay + ' average of ' + fmt(avg) + (Math.abs(gap) < 1 ? ', so it is sitting close to normal.' : gap > 0 ? ', which usually means an upward trend.' : ', which usually means a downward trend.'));
    var big = 0;
    for (var b = 1; b < n; b++) if (Math.abs(cs[b].c - cs[b - 1].c) / cs[b - 1].c > Math.abs(cs[big].c - (cs[big - 1] || cs[big]).c) / (cs[big - 1] || cs[big]).c) big = b;
    if (big > 0) {
      var mv = ((cs[big].c - cs[big - 1].c) / cs[big - 1].c) * 100;
      var d = new Date(cs[big].t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      out.push('Biggest move: <b>' + (mv >= 0 ? '+' : '') + mv.toFixed(1) + '% on ' + d + '</b>. A long candle like that usually follows news.');
    }
    var wick = last.h - last.l, body = Math.abs(last.c - last.o);
    if (wick > 0 && body / wick < 0.25) out.push('The latest candle has a <b>small body and long wicks</b>: the price swung both ways and ended near where it started, a sign of indecision.');
    return out;
  }
  // A labelled drawing of one candle, so the chart can be read by anyone.
  var ANATOMY = '<svg class="mc-anatomy" viewBox="0 0 118 112" role="img" aria-label="How to read a candle">'
    + '<line x1="22" y1="8" x2="22" y2="104" stroke="#3DDC97" stroke-width="1.6"/><rect x="13" y="30" width="18" height="48" rx="2" fill="#3DDC97"/>'
    + '<line x1="34" y1="8" x2="44" y2="8" stroke="rgba(205,220,250,.4)"/><text x="47" y="11">High</text>'
    + '<line x1="34" y1="30" x2="44" y2="30" stroke="rgba(205,220,250,.4)"/><text x="47" y="33">Close</text>'
    + '<line x1="34" y1="78" x2="44" y2="78" stroke="rgba(205,220,250,.4)"/><text x="47" y="81">Open</text>'
    + '<line x1="34" y1="104" x2="44" y2="104" stroke="rgba(205,220,250,.4)"/><text x="47" y="107">Low</text>'
    + '<text x="47" y="56" style="fill:#3DDC97">Green: up</text><text x="47" y="68" style="fill:#FF5C6C">Red: down</text></svg>';

  // ── Candles, then a shaded range for the days ahead ──────────────────────
  // The range is drawn as a fan, never as candles: invented candles would look
  // like data.
  function buildCandle(spec) {
    var cs = (spec.candles || []).filter(function (c) { return c && isFinite(c.o) && isFinite(c.h) && isFinite(c.l) && isFinite(c.c); });
    if (cs.length < 2) return null;
    var pr = (spec.projection || []).filter(function (p) { return p && isFinite(p.lo) && isFinite(p.hi); });
    var lows = cs.map(function (c) { return c.l; }).concat(pr.map(function (p) { return p.lo; }));
    var highs = cs.map(function (c) { return c.h; }).concat(pr.map(function (p) { return p.hi; }));
    var min = Math.min.apply(null, lows), max = Math.max.apply(null, highs);
    var pad = (max - min) * 0.06 || max * 0.02 || 1; min -= pad; max += pad;
    var plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    var total = cs.length + pr.length;
    var slot = plotW / total, bw = Math.max(1.5, Math.min(9, slot * 0.62));
    var xOf = function (i) { return PAD_L + slot * i + slot / 2; };
    var yOf = function (v) { return PAD_T + plotH - ((v - min) / (max - min)) * plotH; };
    var unit = spec.unit || '';
    var fmt = function (v) { return unit + (v >= 1000 ? (v >= 1e5 ? short(v) : Math.round(v).toLocaleString('en-US')) : v >= 1 ? v.toFixed(2) : v.toPrecision(3)); };
    var uid = 'mc' + Math.random().toString(36).slice(2, 8);
    var parts = [];
    for (var g = 0; g <= 4; g++) {
      var gv = min + ((max - min) * g) / 4, gy = yOf(gv);
      parts.push('<line class="mc-grid" x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) + '"/>');
      parts.push('<text class="mc-axis mc-fade" x="' + (PAD_L - 9) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end">' + esc(fmt(gv)) + '</text>');
    }
    if (pr.length) {
      var x0 = xOf(cs.length - 1), lastC = cs[cs.length - 1].c;
      var top = 'M' + x0.toFixed(1) + ' ' + yOf(lastC).toFixed(1), bot = '';
      pr.forEach(function (p, k) { top += ' L' + xOf(cs.length + k).toFixed(1) + ' ' + yOf(p.hi).toFixed(1); });
      for (var k = pr.length - 1; k >= 0; k--) bot += ' L' + xOf(cs.length + k).toFixed(1) + ' ' + yOf(pr[k].lo).toFixed(1);
      parts.push('<defs><pattern id="' + uid + 'p" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1.25" cy="1.25" r="1" fill="' + EST + '"/><circle cx="3.75" cy="3.75" r="1" fill="' + EST + '"/></pattern></defs>');
      parts.push('<path class="mc-fade" d="' + top + bot + ' Z" fill="url(#' + uid + 'p)" opacity=".45"/>');
      var mid = 'M' + x0.toFixed(1) + ' ' + yOf(lastC).toFixed(1);
      pr.forEach(function (p, k) { mid += ' L' + xOf(cs.length + k).toFixed(1) + ' ' + yOf(p.base).toFixed(1); });
      parts.push('<path class="mc-fade" d="' + mid + '" fill="none" stroke="' + EST + '" stroke-width="1.8" stroke-dasharray="4 4"/>');
      var xd = (x0 + slot / 2).toFixed(1);
      parts.push('<line x1="' + xd + '" y1="' + PAD_T + '" x2="' + xd + '" y2="' + (PAD_T + plotH) + '" stroke="rgba(255,196,120,.35)" stroke-dasharray="2 4"/>');
      parts.push('<text class="mc-axis mc-fade" x="' + (W - PAD_R) + '" y="' + (PAD_T + 10) + '" text-anchor="end" style="fill:' + EST + '">Projected</text>');
      var e = pr[pr.length - 1], xe = xOf(total - 1);
      parts.push('<text class="mc-axis mc-fade" x="' + xe.toFixed(1) + '" y="' + (yOf(e.hi) - 6).toFixed(1) + '" text-anchor="end" style="fill:' + EST + '">' + esc(fmt(e.hi)) + '</text>');
      parts.push('<text class="mc-axis mc-fade" x="' + xe.toFixed(1) + '" y="' + (yOf(e.lo) + 13).toFixed(1) + '" text-anchor="end" style="fill:' + EST + '">' + esc(fmt(e.lo)) + '</text>');
    }
    cs.forEach(function (c, i) {
      var up = c.c >= c.o, col = up ? UP : DOWN, x = xOf(i);
      var yt = yOf(Math.max(c.o, c.c)), yb = yOf(Math.min(c.o, c.c));
      var delay = 'style="animation-delay:' + (i / cs.length * 0.6).toFixed(2) + 's"';
      parts.push('<g class="mc-grow" ' + delay + '><line x1="' + x.toFixed(1) + '" y1="' + yOf(c.h).toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + yOf(c.l).toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>' +
        '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + yt.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, yb - yt).toFixed(1) + '" fill="' + col + '" rx="1"/></g>');
    });
    var lastIdx = cs.length - 1, lc = cs[lastIdx];
    parts.push('<circle class="mc-pulse" cx="' + xOf(lastIdx).toFixed(1) + '" cy="' + yOf(lc.c).toFixed(1) + '" r="6" fill="' + (lc.c >= lc.o ? UP : DOWN) + '"/>');
    var daily = spec.interval !== '1h';
    var lab = function (t) { var d = new Date(t); return daily ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
    var every = Math.ceil(cs.length / 6);
    cs.forEach(function (c, i) {
      if (i % every) return;
      parts.push('<text class="mc-axis mc-fade" x="' + xOf(i).toFixed(1) + '" y="' + (H - PAD_B + 19) + '" text-anchor="middle">' + esc(lab(c.t)) + '</text>');
    });
    var first = cs[0], chg = ((lc.c - first.c) / first.c) * 100;
    var model = {
      n: total, xOf: xOf,
      rows: function (i) {
        if (i < cs.length) {
          var c = cs[i];
          return [{ label: 'Open', colour: '#8fa8d8', value: fmt(c.o) }, { label: 'High', colour: UP, value: fmt(c.h) },
            { label: 'Low', colour: DOWN, value: fmt(c.l) }, { label: 'Close', colour: c.c >= c.o ? UP : DOWN, value: fmt(c.c) }];
        }
        var p = pr[i - cs.length];
        return [{ label: 'Likely middle', colour: EST, value: fmt(p.base) }, { label: 'Range', colour: EST, value: fmt(p.lo) + ' to ' + fmt(p.hi) }];
      },
      title: function (i) { return i < cs.length ? lab(cs[i].t) : 'Estimate · ' + lab(pr[i - cs.length].t); },
      top: function (i) { return i < cs.length ? yOf(cs[i].h) : yOf(pr[i - cs.length].hi); }
    };
    var unitWord = spec.interval === '1h' ? 'hours' : spec.interval === '1wk' ? 'weeks' : 'trading days';
    var ctake = '<b>' + (Math.abs(chg) < 1 ? 'Roughly flat' : (chg > 0 ? 'Up ' : 'Down ') + Math.abs(chg).toFixed(1) + '%') + '</b> since ' + esc(lab(first.t)) + ', now ' + esc(fmt(lc.c)) + '.' +
      (pr.length ? ' The orange fan shows where the price could be over the next ' + pr.length + ' ' + unitWord + ': about 8 times in 10, it lands between <b>' + esc(fmt(pr[pr.length - 1].lo)) + '</b> and <b>' + esc(fmt(pr[pr.length - 1].hi)) + '</b>.' : '');
    var ckey = '<div class="mc-key"><span><i style="background:' + UP + '"></i>Closed higher that ' + (spec.interval === '1h' ? 'hour' : spec.interval === '1wk' ? 'week' : 'day') + '</span>' +
      '<span><i style="background:' + DOWN + '"></i>Closed lower</span>' +
      (pr.length ? '<span><i style="background:' + EST + ';opacity:.7"></i>Likely range ahead (estimate)</span>' : '') + '</div>';
    var html = '<div class="mc-card">' +
      head(spec, GLYPH_CANDLE, fmt(lc.c), chg, '<span class="mc-badge meas">LIVE PRICES</span>' + (pr.length ? '<span class="mc-badge est">RANGE IS AN ESTIMATE</span>' : '')) +
      '<div class="mc-take">' + ctake + '</div>' +
      plot(uid, '', parts, spec.title) + ckey +
      '<div class="mc-read"><div>' + ANATOMY + '</div><div><h4>What the candles show</h4><ul>' +
        candleReading(cs, fmt, spec.interval === '1h' ? 'hour' : spec.interval === '1wk' ? 'week' : 'day').map(function (x) { return '<li>' + x + '</li>'; }).join('') +
        '</ul></div></div>' + HINT +
      (spec.note ? '<div class="mc-note">' + esc(spec.note) + '</div>' : '') + '</div>';
    return { html: html, model: model };
  }

  function build(spec) {
    if (!spec || typeof spec !== 'object') return null;
    var b = spec.kind === 'candle' ? buildCandle(spec) : buildSeries(spec);
    return b ? b.html : null;
  }

  // Crosshair, tooltip, arrow keys and legend toggles.
  var DL_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';

  // The chart as a PNG: the picture itself on Callisto's dark card, with the
  // title and badge text drawn above it, at twice the size for sharpness.
  function download(card, spec) {
    var svg = card.querySelector('.mc-svg');
    if (!svg) return;
    var clone = svg.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('.mc-cross,.mc-pulse'), function (n) { n.remove(); });
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', W); clone.setAttribute('height', H);
    var st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = ".mc-axis{font:10.5px 'Plus Jakarta Sans','Segoe UI',sans-serif;fill:rgba(170,195,240,.75)}" +
      '.mc-grid{stroke:rgba(140,170,230,.18);stroke-width:1;stroke-dasharray:3 4}' +
      '.mc-line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}' +
      ".mc-barval{font:700 13px 'Rajdhani','Segoe UI',sans-serif;fill:#fff}" +
      '.mc-off{opacity:.12}';
    clone.insertBefore(st, clone.firstChild);
    var data = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    var img = new Image();
    img.onload = function () {
      var S = 2, padX = 24, top = 70, bottom = 34;
      var cw = W + padX * 2, ch = H + top + bottom;
      var c = document.createElement('canvas');
      c.width = cw * S; c.height = ch * S;
      var x = c.getContext('2d');
      x.scale(S, S);
      var g = x.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, '#121a30'); g.addColorStop(1, '#090e1c');
      x.fillStyle = g; x.fillRect(0, 0, cw, ch);
      x.fillStyle = '#e9f1ff'; x.font = "650 17px 'Plus Jakarta Sans','Segoe UI',sans-serif";
      x.fillText(String(spec.title || 'Chart').slice(0, 70), padX, 34);
      var val = card.querySelector('.mc-val'), del = card.querySelector('.mc-delta');
      if (val) {
        x.textAlign = 'right'; x.fillStyle = '#ffffff'; x.font = "700 24px 'Rajdhani','Segoe UI',sans-serif";
        x.fillText(val.textContent, cw - padX, 36);
        if (del) { x.font = "700 12px 'Plus Jakarta Sans','Segoe UI',sans-serif"; x.fillStyle = del.classList.contains('up') ? UP : DOWN; x.fillText(del.textContent, cw - padX, 56); }
        x.textAlign = 'left';
      }
      var badges = Array.prototype.map.call(card.querySelectorAll('.mc-badge'), function (b) { return b.textContent; }).join('  ·  ');
      if (badges) { x.font = "700 10px 'Plus Jakarta Sans','Segoe UI',sans-serif"; x.fillStyle = '#ffc478'; x.fillText(badges, padX, 54); }
      x.drawImage(img, padX, top, W, H);
      x.font = "500 10px 'Plus Jakarta Sans','Segoe UI',sans-serif"; x.fillStyle = 'rgba(160,185,225,.6)';
      x.fillText('Made with Callisto AI', padX, ch - 12);
      c.toBlob(function (blob) {
        if (!blob) return;
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (String(spec.title || 'chart').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'chart') + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      }, 'image/png');
    };
    img.src = data;
  }

  function wire(card, model) {
    var plotEl = card.querySelector('.mc-plot'), svg = card.querySelector('.mc-svg');
    var cross = card.querySelector('.mc-cross'), tip = card.querySelector('.mc-tip');
    if (!plotEl || !svg || !model) return;
    var off = {}, active = null;
    function show(i) {
      active = i;
      if (i == null) { cross.style.opacity = 0; tip.style.opacity = 0; return; }
      var x = model.xOf(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.opacity = 1;
      var rows = model.rows(i, off);
      if (!rows.length) { tip.style.opacity = 0; return; }
      var title = model.title ? model.title(i) : model.labels[i];
      tip.innerHTML = '<b>' + esc(title) + '</b>' + rows.map(function (r) {
        return '<span><i style="background:' + r.colour + '"></i>' + esc(r.label) + '<em>' + esc(r.value) + '</em></span>';
      }).join('');
      var box = svg.getBoundingClientRect(), k = box.width / W;
      var left = Math.min(Math.max(x * k, 70), box.width - 70);
      var top = Math.max(model.top(i) * (box.height / H) - 10, 60);
      tip.style.left = left + 'px'; tip.style.top = top + 'px'; tip.style.opacity = 1;
    }
    function indexAt(clientX) {
      var box = svg.getBoundingClientRect(), x = (clientX - box.left) * (W / box.width), best = 0, bd = Infinity;
      for (var i = 0; i < model.n; i++) { var d = Math.abs(model.xOf(i) - x); if (d < bd) { bd = d; best = i; } }
      return best;
    }
    plotEl.addEventListener('pointermove', function (e) { show(indexAt(e.clientX)); });
    plotEl.addEventListener('pointerleave', function () { show(null); });
    plotEl.addEventListener('blur', function () { show(null); });
    plotEl.addEventListener('keydown', function (e) {
      var n = model.n, next = null;
      if (e.key === 'ArrowRight') next = active == null ? 0 : Math.min(n - 1, active + 1);
      else if (e.key === 'ArrowLeft') next = active == null ? n - 1 : Math.max(0, active - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = n - 1;
      else if (e.key === 'Escape') { show(null); return; }
      else return;
      e.preventDefault(); show(next);
    });
    Array.prototype.forEach.call(card.querySelectorAll('.mc-leg'), function (btn) {
      btn.addEventListener('click', function () {
        var s = btn.getAttribute('data-s'), on = btn.getAttribute('aria-pressed') !== 'false';
        btn.setAttribute('aria-pressed', on ? 'false' : 'true');
        off[s] = on;
        Array.prototype.forEach.call(svg.querySelectorAll('g[data-s="' + s + '"]'), function (g) { g.classList.toggle('mc-off', on); });
        if (active != null) show(active);
      });
    });
  }

  // Drops the chart into the message it belongs to.
  function render(spec, intoEl) {
    styles();
    if (!spec || typeof spec !== 'object') return false;
    var b = spec.kind === 'candle' ? buildCandle(spec) : buildSeries(spec);
    if (!b) return false;
    var host = intoEl || document.querySelector('#messages .message:last-child .message-content');
    if (!host) return false;
    var box = document.createElement('div');
    box.innerHTML = b.html;
    var card = box.firstChild;
    host.appendChild(card);
    if (reduced) card.classList.add('mc-still');
    wire(card, b.model);
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'mc-dl';
    btn.setAttribute('aria-label', 'Download chart as an image'); btn.title = 'Download chart';
    btn.innerHTML = DL_ICON;
    btn.addEventListener('click', function (e) { e.stopPropagation(); download(card, spec); });
    card.appendChild(btn);
    return true;
  }

  // Fills every chart slot inside root: <div class="mc-slot" data-spec="...">.
  function hydrate(root) {
    styles();
    Array.prototype.forEach.call((root || document).querySelectorAll('.mc-slot:not([data-done])'), function (slot) {
      slot.setAttribute('data-done', '1');
      try { render(JSON.parse(slot.getAttribute('data-spec')), slot); } catch (_) {}
    });
  }
  function slot(spec) {
    return '<div class="mc-slot" data-spec="' + esc(JSON.stringify(spec)) + '"></div>';
  }

  window.CallistoMarketChart = { render: render, build: build, hydrate: hydrate, slot: slot };
})();
