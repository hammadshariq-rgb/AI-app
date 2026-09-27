/* ─────────────────────────────────────────────────────────────────────────────
   The expanded analytics view

   The same move as the markets overlay: a panel that opens over everything,
   one platform at a time, with a smooth gradient area chart on top and the
   numbers that matter underneath, each with an arrow saying which way it went.

   Every platform renders through the same shell, so Stripe revenue, YouTube
   views and Instagram reach all read the same way and there is only one place
   to fix a layout problem.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var root = null, open = false, current = null;

  /* Each platform: what it's called, its colour, and how to pull a chart and a
     set of figures out of whatever its stats call returned. */
  var PLATFORMS = {
    stripe: {
      name: 'Revenue', sub: 'Stripe', accent: '#7ee8a6',
      chart: function (d) {
        return {
          label: 'Daily takings',
          points: (d.series || []).map(function (p) { return { x: p.date, y: p.value }; }),
          money: d.currency || ''
        };
      },
      metrics: function (d) {
        var cur = (d.currency || '') + ' ';
        var today = Number(d.today && d.today.revenue) || 0;
        var yest = Number(d.yesterday && d.yesterday.revenue) || 0;
        return [
          { label: 'Today', value: cur + money(today), delta: pct(today, yest), hint: 'against this time yesterday' },
          { label: 'Last 7 days', value: cur + money(Number(d.last7Days && d.last7Days.revenue) || 0),
            sub: (d.last7Days && d.last7Days.orders) + ' payments' },
          { label: 'Last 30 days', value: cur + money(Number(d.last30Days && d.last30Days.revenue) || 0),
            sub: (d.last30Days && d.last30Days.orders) + ' payments' },
          { label: 'Customers', value: String(d.totalCustomers || '—') }
        ];
      },
      list: function (d) {
        return { title: 'Recent payments', rows: (d.recentPayments || []).map(function (p) {
          return { left: p.description, right: p.amount, note: p.date };
        }) };
      }
    },

    youtube: {
      name: 'YouTube', sub: 'Studio', accent: '#ff6b6b',
      chart: function (d) { return { label: 'Views', points: seriesOf(d) }; },
      metrics: function (d) {
        return [
          { label: 'Subscribers', value: num(d.subscribers) },
          { label: 'Views, 28 days', value: num(d.views28 != null ? d.views28 : d.totalViews) },
          { label: 'Videos', value: num(d.videoCount) },
          { label: 'Watch time', value: d.watchTime != null ? num(d.watchTime) + ' hrs' : '—' }
        ];
      },
      list: function (d) {
        return { title: 'Recent videos', rows: (d.recentVideos || []).slice(0, 5).map(function (v) {
          return { left: v.title, right: v.views != null ? num(v.views) + ' views' : '', note: v.date || '' };
        }) };
      }
    },

    instagram: {
      name: 'Instagram', sub: '', accent: '#e1306c',
      chart: function (d) { return { label: 'Views', points: seriesOf(d) }; },
      metrics: function (d) {
        return [
          { label: 'Followers', value: num(d.followers) },
          { label: 'Views, 30 days', value: d.views30 != null ? num(d.views30) : '—' },
          { label: 'Reach, 30 days', value: d.reach30 != null ? num(d.reach30) : '—' },
          { label: 'Engagement', value: d.engagementRate != null ? d.engagementRate + '%' : '—' }
        ];
      },
      list: function (d) {
        return { title: 'Recent posts', rows: (d.recentPosts || []).slice(0, 5).map(function (p) {
          return { left: (p.caption || 'Post').slice(0, 60), right: num(p.likes) + ' likes', note: p.date || '' };
        }) };
      }
    },

    facebook: {
      name: 'Facebook', sub: 'Page', accent: '#4c8bf5',
      chart: function (d) { return { label: 'Reach', points: seriesOf(d) }; },
      metrics: function (d) {
        return [
          { label: 'Followers', value: num(d.followers) },
          { label: 'Reach', value: d.reach != null ? num(d.reach) : '—' },
          { label: 'Posts', value: num(d.posts) },
          { label: 'Engagement', value: d.engagementRate != null ? d.engagementRate + '%' : '—' }
        ];
      },
      list: function (d) {
        return { title: 'Recent posts', rows: (d.recentPosts || []).slice(0, 5).map(function (p) {
          return { left: (p.message || 'Post').slice(0, 60), right: num(p.likes) + ' likes', note: p.date || '' };
        }) };
      }
    },

    tiktok: {
      name: 'TikTok', sub: '', accent: '#25f4ee',
      chart: function (d) { return { label: 'Views', points: seriesOf(d) }; },
      metrics: function (d) {
        return [
          { label: 'Followers', value: num(d.followers) },
          { label: 'Likes', value: num(d.likes) },
          { label: 'Videos', value: num(d.videoCount) },
          { label: 'Views', value: d.views != null ? num(d.views) : '—' }
        ];
      },
      list: function (d) {
        return { title: 'Recent videos', rows: (d.recentVideos || []).slice(0, 5).map(function (v) {
          return { left: (v.title || 'Video').slice(0, 60), right: num(v.views) + ' views', note: v.date || '' };
        }) };
      }
    }
  };

  /* ── Small helpers ─────────────────────────────────────────────────────── */
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n.toLocaleString() : '—';
  }
  function money(v) {
    var n = Number(v) || 0;
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(now, before) {
    if (!before) return null;
    return Math.round(((now - before) / before) * 100);
  }
  // Not every platform hands back a time series; the chart is skipped when so.
  function seriesOf(d) {
    var s = d.series || d.daily || d.dailyViews;
    if (!Array.isArray(s)) return [];
    return s.map(function (p) {
      return { x: p.date || p.day || p.key, y: Number(p.value != null ? p.value : p.views) || 0 };
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  /* ── The chart ─────────────────────────────────────────────────────────────
     A smooth line with a gradient beneath it, drawn straight into SVG. The
     curve is a Catmull-Rom spline converted to cubic béziers, which is what
     makes it read as a smooth line rather than a sequence of corners. */
  function chartSvg(points, accent, moneyPrefix) {
    var W = 660, H = 190, PAD_L = 8, PAD_R = 8, PAD_T = 14, PAD_B = 26;
    if (!points.length) return '';

    var ys = points.map(function (p) { return p.y; });
    var max = Math.max.apply(null, ys);
    var min = Math.min.apply(null, ys.concat([0]));
    if (max === min) max = min + 1;

    var iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
    var xs = function (i) { return PAD_L + (i / Math.max(1, points.length - 1)) * iw; };
    var yv = function (v) { return PAD_T + ih - ((v - min) / (max - min)) * ih; };

    var pts = points.map(function (p, i) { return [xs(i), yv(p.y)]; });

    var d = 'M' + pts[0][0] + ',' + pts[0][1];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ' C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + p2[0] + ',' + p2[1];
    }
    var area = d + ' L' + pts[pts.length - 1][0] + ',' + (PAD_T + ih) + ' L' + pts[0][0] + ',' + (PAD_T + ih) + ' Z';

    // Four gridlines, and a label on the highest so the scale is readable.
    var grid = '';
    for (var g = 0; g <= 3; g++) {
      var gy = PAD_T + (ih / 3) * g;
      grid += '<line x1="' + PAD_L + '" y1="' + gy + '" x2="' + (W - PAD_R) + '" y2="' + gy + '" class="ao-grid"/>';
    }

    var first = points[0].x, last = points[points.length - 1].x;
    var id = 'aoGrad' + Math.random().toString(36).slice(2, 7);
    var end = pts[pts.length - 1];

    return '<svg class="ao-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" ' +
      'aria-label="' + esc(points.length) + ' day trend">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + accent + '" stop-opacity="0.38"/>' +
        '<stop offset="100%" stop-color="' + accent + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      grid +
      '<path d="' + area + '" fill="url(#' + id + ')"/>' +
      '<path d="' + d + '" fill="none" stroke="' + accent + '" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + end[0] + '" cy="' + end[1] + '" r="4" fill="' + accent + '"/>' +
      '<text class="ao-axis" x="' + PAD_L + '" y="' + (H - 8) + '">' + esc(shortDate(first)) + '</text>' +
      '<text class="ao-axis ao-axis-end" x="' + (W - PAD_R) + '" y="' + (H - 8) + '">' + esc(shortDate(last)) + '</text>' +
      '<text class="ao-axis" x="' + PAD_L + '" y="' + (PAD_T - 3) + '">' +
        esc((moneyPrefix ? moneyPrefix + ' ' : '') + num(Math.round(max))) + '</text>' +
      '</svg>';
  }

  function shortDate(v) {
    var d = new Date(v);
    if (isNaN(d)) return String(v || '');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /* ── The panel ─────────────────────────────────────────────────────────── */
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'analyticsOverlay';
    root.className = 'ao hidden';
    root.innerHTML = '<div class="ao-sheet" role="dialog" aria-modal="true" aria-label="Analytics">' +
      '<div class="ao-body" id="aoBody"></div></div>';
    document.body.appendChild(root);

    root.addEventListener('click', function (e) { if (e.target === root) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) close(); });
  }

  function trend(delta) {
    if (delta == null || !isFinite(delta)) return '';
    var up = delta >= 0;
    var cls = up ? 'ao-up' : 'ao-down';
    var arrow = up
      ? '<path d="M9.5 12.6L14 8.2l4.5 4.4M14 8.2V19.8"/>'
      : '<path d="M18.5 15.4L14 19.8l-4.5-4.4M14 19.8V8.2"/>';
    return '<span class="ao-trend ' + cls + '">' +
      '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square">' +
      arrow + '</svg>' + Math.abs(delta) + '%</span>';
  }

  function render(key, data) {
    var p = PLATFORMS[key];
    if (!p) return;
    var chart = p.chart ? p.chart(data) : null;
    var metrics = p.metrics ? p.metrics(data) : [];
    var list = p.list ? p.list(data) : null;

    var head = '<div class="ao-head">' +
      '<div class="ao-title"><span class="ao-dot" style="background:' + p.accent + '"></span>' +
        '<span>' + esc(p.name) + '</span>' +
        (p.sub ? '<span class="ao-sub">' + esc(p.sub) + '</span>' : '') + '</div>' +
      '<button class="ao-x" id="aoClose" aria-label="Close">✕</button></div>';

    var chartBlock = chart && chart.points.length
      ? '<div class="ao-chart-wrap">' +
          '<div class="ao-legend"><span class="ao-key" style="background:' + p.accent + '"></span>' +
            esc(chart.label) + ' · last ' + chart.points.length + ' days</div>' +
          chartSvg(chart.points, p.accent, chart.money) +
        '</div>'
      : '<div class="ao-nochart">Day-by-day figures aren’t available for ' + esc(p.name) + ' yet.</div>';

    var metricBlock = '<div class="ao-metrics">' + metrics.map(function (m) {
      return '<div class="ao-metric">' +
        '<div class="ao-m-label">' + esc(m.label) + '</div>' +
        '<div class="ao-m-value">' + esc(m.value) + trend(m.delta) + '</div>' +
        (m.sub || m.hint ? '<div class="ao-m-sub">' + esc(m.sub || m.hint) + '</div>' : '') +
      '</div>';
    }).join('') + '</div>';

    var listBlock = list && list.rows.length
      ? '<div class="ao-list"><div class="ao-list-title">' + esc(list.title) + '</div>' +
        list.rows.map(function (r) {
          return '<div class="ao-row"><span class="ao-row-l">' + esc(r.left) + '</span>' +
            (r.note ? '<span class="ao-row-n">' + esc(r.note) + '</span>' : '') +
            '<span class="ao-row-r">' + esc(r.right) + '</span></div>';
        }).join('') + '</div>'
      : '';

    root.querySelector('#aoBody').innerHTML = head + chartBlock + metricBlock + listBlock;
    root.querySelector('#aoClose').addEventListener('click', close);
  }

  async function show(key) {
    build();
    var p = PLATFORMS[key];
    if (!p) return;
    current = key;
    root.classList.remove('hidden');
    open = true;
    root.querySelector('#aoBody').innerHTML =
      '<div class="ao-head"><div class="ao-title"><span class="ao-dot" style="background:' + p.accent + '"></span>' +
      esc(p.name) + '</div><button class="ao-x" id="aoClose" aria-label="Close">✕</button></div>' +
      '<div class="ao-loading">Fetching your numbers…</div>';
    root.querySelector('#aoClose').addEventListener('click', close);
    requestAnimationFrame(function () { root.classList.add('ao-in'); });

    var data = null;
    try { data = await window.jarvis.analyticsGet(key); } catch (_) {}
    // analyticsGet may answer with everything, or with just this platform.
    if (data && data[key]) data = data[key];
    if (!open || current !== key) return;

    if (!data) {
      root.querySelector('#aoBody').innerHTML =
        '<div class="ao-head"><div class="ao-title"><span class="ao-dot" style="background:' + p.accent + '"></span>' +
        esc(p.name) + '</div><button class="ao-x" id="aoClose" aria-label="Close">✕</button></div>' +
        '<div class="ao-loading">' + esc(p.name) + ' isn’t connected yet. Open Connectors to link it.</div>';
      root.querySelector('#aoClose').addEventListener('click', close);
      return;
    }
    render(key, data);
  }

  function close() {
    if (!root) return;
    root.classList.remove('ao-in');
    open = false;
    current = null;
    setTimeout(function () { if (!open) root.classList.add('hidden'); }, 240);
  }

  window.CallistoAnalyticsOverlay = {
    show: show,
    close: close,
    isOpen: function () { return open; },
    platforms: Object.keys(PLATFORMS)
  };
})();
