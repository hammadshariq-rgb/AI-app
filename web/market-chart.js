/* ─────────────────────────────────────────────────────────────────────────────
   Market charts

   Four numbers read aloud are four numbers nobody remembers. The same four
   drawn are a shape you can argue with - which is the point when somebody is
   deciding whether to enter a market.

   The one rule this file enforces: a chart says where its numbers came from.
   Anything the model worked out rather than measured is stamped ESTIMATE, in
   the picture itself, so a guess cannot be screenshotted into a pitch deck
   and mistaken later for research. That matters more here than it looks: the
   people using this are putting these numbers in front of investors.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var W = 640, H = 260, PAD_L = 56, PAD_R = 18, PAD_T = 18, PAD_B = 34;
  var COLOURS = ['#4D8DFF', '#FF8A5B', '#49D6A0', '#C78BFF'];

  function styles() {
    if (document.getElementById('mcStyles')) return;
    var s = document.createElement('style');
    s.id = 'mcStyles';
    s.textContent = [
      '.mc-card{margin:10px 0 4px;padding:15px 16px 13px;border-radius:14px;',
      '  background:linear-gradient(180deg,rgba(18,26,46,.92),rgba(10,15,28,.92));',
      '  border:1px solid rgba(120,160,255,.17)}',
      '.mc-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:11px}',
      '.mc-title{font-size:13.5px;font-weight:650;color:#e9f1ff}',
      '.mc-badge{font-size:8.5px;letter-spacing:1.4px;font-weight:700;padding:3px 7px;border-radius:5px}',
      '.mc-badge.est{background:rgba(255,176,80,.16);color:#ffc478;border:1px solid rgba(255,176,80,.3)}',
      '.mc-badge.meas{background:rgba(73,214,160,.14);color:#6fe0ad;border:1px solid rgba(73,214,160,.28)}',
      '.mc-svg{width:100%;height:auto;display:block;overflow:visible}',
      '.mc-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:9px}',
      '.mc-leg{display:flex;align-items:center;gap:6px;font-size:11px;color:rgba(185,208,250,.85)}',
      '.mc-dot{width:9px;height:9px;border-radius:3px;flex-shrink:0}',
      '.mc-note{margin-top:9px;font-size:11px;line-height:1.6;color:rgba(160,185,225,.72)}',
      '.mc-axis{font-size:9.5px;fill:rgba(165,190,235,.6)}',
      '.mc-grid{stroke:rgba(140,170,220,.12);stroke-width:1}'
    ].join('');
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 1200 -> "1.2k", 3400000 -> "3.4M". Axis labels have to be short or they
  // collide with each other and the chart stops being readable.
  function short(n) {
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    if (a < 1 && a > 0) return String(Math.round(n * 100) / 100);
    return String(Math.round(n));
  }

  // A chart whose axis does not reach its own tallest bar is a broken chart,
  // so the top of the scale is always at or above the largest value.
  function scale(values) {
    var max = Math.max.apply(null, values);
    var min = Math.min.apply(null, values);
    if (!isFinite(max)) { max = 1; min = 0; }
    if (min > 0) min = 0;                       // bars grow from zero or it lies
    if (max === min) max = min + 1;
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / 3 || 1)));
    var nice = [1, 2, 2.5, 5, 10];
    var chosen = step;
    for (var i = 0; i < nice.length; i++) {
      if (span / (step * nice[i]) <= 4) { chosen = step * nice[i]; break; }
    }
    var top = Math.ceil(max / chosen) * chosen;
    var bottom = Math.floor(min / chosen) * chosen;
    var ticks = [];
    for (var v = bottom; v <= top + 1e-9; v += chosen) ticks.push(v);
    return { top: top, bottom: bottom, ticks: ticks.slice(0, 6) };
  }

  function build(spec) {
    if (!spec || typeof spec !== 'object') return null;
    var series = (spec.series || [])
      .filter(function (s) { return s && Array.isArray(s.points) && s.points.length; })
      .slice(0, 4);
    if (!series.length) return null;

    // Every y across every series, for one shared scale - two lines on
    // different scales in one picture is a lie by drawing.
    var ys = [];
    series.forEach(function (s) {
      s.points.forEach(function (p) {
        var v = Number(p && p.y);
        if (isFinite(v)) ys.push(v);
      });
    });
    if (!ys.length) return null;

    var sc = scale(ys);
    var labels = series[0].points.map(function (p) { return String(p && p.x != null ? p.x : ''); });
    var plotW = W - PAD_L - PAD_R;
    var plotH = H - PAD_T - PAD_B;
    var yOf = function (v) {
      return PAD_T + plotH - ((v - sc.bottom) / (sc.top - sc.bottom)) * plotH;
    };

    var parts = [];

    // Gridlines and the y axis.
    sc.ticks.forEach(function (t) {
      var y = yOf(t);
      parts.push('<line class="mc-grid" x1="' + PAD_L + '" y1="' + y.toFixed(1) +
                 '" x2="' + (W - PAD_R) + '" y2="' + y.toFixed(1) + '"/>');
      parts.push('<text class="mc-axis" x="' + (PAD_L - 8) + '" y="' + (y + 3.5).toFixed(1) +
                 '" text-anchor="end">' + esc((spec.unit === '%' ? '' : spec.unit || '') + short(t)) +
                 (spec.unit === '%' ? '%' : '') + '</text>');
    });

    var n = labels.length;
    if (spec.kind === 'bar') {
      var groupW = plotW / Math.max(1, n);
      var barW = Math.min(44, (groupW * 0.64) / series.length);
      series.forEach(function (s, si) {
        s.points.forEach(function (p, i) {
          var v = Number(p.y) || 0;
          var cx = PAD_L + groupW * i + groupW / 2;
          var x = cx - (barW * series.length) / 2 + barW * si;
          var y = yOf(v), base = yOf(Math.max(0, sc.bottom));
          var h = Math.max(1, Math.abs(base - y));
          parts.push('<rect x="' + x.toFixed(1) + '" y="' + Math.min(y, base).toFixed(1) +
                     '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) +
                     '" rx="3" fill="' + COLOURS[si % COLOURS.length] + '" opacity="0.9"/>');
        });
      });
    } else {
      series.forEach(function (s, si) {
        var colour = COLOURS[si % COLOURS.length];
        var pts = s.points.map(function (p, i) {
          var x = n === 1 ? PAD_L + plotW / 2 : PAD_L + (plotW * i) / (n - 1);
          return [x, yOf(Number(p.y) || 0)];
        });
        var d = pts.map(function (q, i) {
          return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1);
        }).join(' ');
        // A soft fill under the first series only; two filled areas muddy it.
        if (si === 0) {
          var base = yOf(Math.max(0, sc.bottom));
          parts.push('<path d="' + d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + base.toFixed(1) +
                     ' L' + pts[0][0].toFixed(1) + ' ' + base.toFixed(1) + ' Z" fill="' + colour + '" opacity="0.1"/>');
        }
        parts.push('<path d="' + d + '" fill="none" stroke="' + colour +
                   '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>');
        pts.forEach(function (q) {
          parts.push('<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) +
                     '" r="3" fill="' + colour + '"/>');
        });
      });
    }

    // Bottom labels, thinned so they never overlap.
    var every = Math.ceil(n / 7);
    labels.forEach(function (lab, i) {
      if (i % every) return;
      var x = spec.kind === 'bar'
        ? PAD_L + (plotW / Math.max(1, n)) * i + (plotW / Math.max(1, n)) / 2
        : (n === 1 ? PAD_L + plotW / 2 : PAD_L + (plotW * i) / (n - 1));
      parts.push('<text class="mc-axis" x="' + x.toFixed(1) + '" y="' + (H - PAD_B + 17) +
                 '" text-anchor="middle">' + esc(lab.slice(0, 12)) + '</text>');
    });

    var measured = spec.basis === 'measured';
    var legend = series.length > 1
      ? '<div class="mc-legend">' + series.map(function (s, i) {
          return '<span class="mc-leg"><span class="mc-dot" style="background:' +
                 COLOURS[i % COLOURS.length] + '"></span>' + esc(s.label || '') + '</span>';
        }).join('') + '</div>'
      : '';

    return '<div class="mc-card">' +
      '<div class="mc-head"><span class="mc-title">' + esc(spec.title || 'Chart') + '</span>' +
      '<span class="mc-badge ' + (measured ? 'meas' : 'est') + '">' +
      (measured ? 'YOUR DATA' : 'ESTIMATE') + '</span></div>' +
      '<svg class="mc-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      esc(spec.title || 'chart') + '">' + parts.join('') + '</svg>' +
      legend +
      (spec.note ? '<div class="mc-note">' + esc(spec.note) + '</div>'
                 : (measured ? '' : '<div class="mc-note">Worked out, not measured — check it before you rely on it.</div>')) +
      '</div>';
  }

  // Drops the chart into the message that is being written.
  function render(spec, intoEl) {
    styles();
    var html = build(spec || {});
    if (!html) return false;
    var host = intoEl || document.querySelector('#messages .message:last-child .message-content');
    if (!host) return false;
    var box = document.createElement('div');
    box.innerHTML = html;
    host.appendChild(box.firstChild);
    return true;
  }

  window.CallistoMarketChart = { render: render, build: build };
})();
