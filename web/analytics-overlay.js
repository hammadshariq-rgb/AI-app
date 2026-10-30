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

    googleAnalytics: { name: 'Website', sub: 'Google Analytics', accent: '#f5b84b' },
    shopify: { name: 'Shopify', sub: 'Store', accent: '#95bf47' },
    squarespace: { name: 'Squarespace', sub: 'Store', accent: '#c9d4ea' },

    tiktok: {
      name: 'TikTok', sub: '', accent: '#25f4ee',
      chart: function (d) { return { label: 'Views', points: seriesOf(d) }; },
      metrics: function (d) {
        return [
          { label: 'Followers', value: num(d.followers) },
          { label: 'Likes', value: num(d.totalLikes != null ? d.totalLikes : d.likes) },
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

  /* ── Every platform: the same grid of tiles ─────────────────────────────────
     A headline figure, two supporting figures, then two wide tiles: a chart and
     a list. Each platform only says what goes where. Views are added up from
     the posts when a platform doesn't give an account total. */
  var ICON = {
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    money: '<circle cx="12" cy="12" r="9"/><path d="M15 9c-.6-1.2-1.7-1.8-3-1.8-1.8 0-3 1-3 2.3 0 3.2 6 1.6 6 4.9 0 1.3-1.3 2.4-3 2.4-1.4 0-2.6-.7-3.1-1.9M12 5.5v13"/>',
    bag: '<path d="M6 8h12l1 12H5zM9 8V6a3 3 0 0 1 6 0v2"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 5a3.5 3.5 0 0 1 0 6.5M18 14.5c2 .8 3 2.8 3 5.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  function rowsFrom(list, map) { return (list || []).slice(0, 6).map(map); }
  function barsFrom(list, valueOf, labelOf) {
    return (list || []).filter(function (x) { return valueOf(x) != null; }).slice(0, 12).reverse()
      .map(function (x) { return { y: Number(valueOf(x)) || 0, label: String(labelOf(x) || '').slice(0, 40) }; });
  }
  function sumOf(list, f) {
    var have = (list || []).filter(function (x) { return f(x) != null; });
    return have.length ? have.reduce(function (s, x) { return s + Number(f(x)); }, 0) : null;
  }
  function dur(sec) { var s = Number(sec) || 0; return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
  function moneyTile(cur, v) { return (cur ? cur + ' ' : '') + money(Number(v) || 0); }
  function viewsOf(x) { return x.views; }

  var TILES = {
    stripe: function (d) {
      var cur = d.currency || (d.last30Days && d.last30Days.currency) || '';
      var today = Number(d.today && d.today.revenue) || 0, yest = Number(d.yesterday && d.yesterday.revenue) || 0;
      var delta = pct(today, yest);
      return {
        hero: { value: moneyTile(cur, d.last30Days && d.last30Days.revenue), label: 'Last 30 days' },
        a: { icon: 'money', value: moneyTile(cur, today), label: 'Today', sub: delta != null ? (delta >= 0 ? '+' : '') + delta + '% on yesterday' : '' },
        b: { icon: 'users', value: num(d.totalCustomers || 0), label: 'Customers', sub: moneyTile(cur, d.last7Days && d.last7Days.revenue) + ' this week' },
        chart: { label: 'Daily takings', series: (d.series || []).map(function (p) { return { x: p.date, y: p.value }; }), money: cur },
        list: { title: 'Recent payments', empty: 'No payments yet.', rows: rowsFrom(d.recentPayments, function (p) { return { t: p.description || 'Payment', main: p.amount, sub: '' }; }) }
      };
    },
    youtube: function (d) {
      return {
        handle: d.channelName,
        hero: { value: compact(d.subscribers), label: 'Subscribers' },
        a: { icon: 'eye', value: num(d.views28 != null ? d.views28 : d.totalViews), label: d.views28 != null ? 'Views · 28 days' : 'Total views' },
        b: { icon: 'clock', value: d.watchTime != null ? num(d.watchTime) + ' hrs' : num(d.videoCount), label: d.watchTime != null ? 'Watch time' : 'Videos' },
        chart: { label: 'Views', series: seriesOf(d), bars: barsFrom(d.recentVideos, viewsOf, function (v) { return v.title; }), barLabel: 'Views per video' },
        list: { title: 'Recent videos', empty: 'No videos yet.', rows: rowsFrom(d.recentVideos, function (v) { return { t: v.title || 'Video', main: v.views != null ? compact(v.views) + ' views' : '', sub: v.likes != null ? compact(v.likes) + ' likes' : '' }; }) }
      };
    },
    instagram: function (d) {
      var total = d.views30 != null ? d.views30 : sumOf(d.recentPosts, viewsOf);
      return {
        handle: d.username ? '@' + d.username : '',
        hero: { value: compact(d.followers), label: 'Followers' },
        a: { icon: 'eye', value: total != null ? num(total) : '—', label: d.views30 != null ? 'Views · 30 days' : 'Views · recent posts' },
        b: { icon: 'heart', value: d.reach30 != null ? num(d.reach30) : num(sumOf(d.recentPosts, function (p) { return p.likes; }) || 0), label: d.reach30 != null ? 'Reach · 30 days' : 'Likes · recent posts', sub: d.engagementRate != null ? d.engagementRate + '% engagement' : '' },
        chart: { label: 'Views', series: seriesOf(d), bars: barsFrom(d.recentPosts, viewsOf, function (p) { return p.caption; }), barLabel: 'Views per post' },
        list: { title: 'Recent posts', empty: 'No posts yet.', rows: rowsFrom(d.recentPosts, function (p) { return { t: p.caption || 'Post', main: p.views != null ? compact(p.views) + ' views' : '', sub: p.likes != null ? compact(p.likes) + ' likes' : '' }; }) }
      };
    },
    tiktok: function (d) {
      var total = d.views != null ? d.views : sumOf(d.recentVideos, viewsOf);
      return {
        handle: d.username,
        hero: { value: compact(d.followers), label: 'Followers' },
        a: { icon: 'eye', value: total != null ? num(total) : '—', label: 'Views · recent videos' },
        b: { icon: 'heart', value: num(d.totalLikes != null ? d.totalLikes : d.likes), label: 'Likes', sub: d.videoCount != null ? num(d.videoCount) + ' videos' : '' },
        chart: { label: 'Views', series: seriesOf(d), bars: barsFrom(d.recentVideos, viewsOf, function (v) { return v.title; }), barLabel: 'Views per video' },
        list: { title: 'Recent videos', empty: 'No videos yet.', rows: rowsFrom(d.recentVideos, function (v) { return { t: v.title || 'Video', main: v.views != null ? compact(v.views) + ' views' : '', sub: v.likes != null ? compact(v.likes) + ' likes' : '' }; }) }
      };
    },
    facebook: function (d) {
      return {
        hero: { value: compact(d.followers), label: 'Followers' },
        a: { icon: 'eye', value: d.reach != null ? num(d.reach) : '—', label: 'Reach' },
        b: { icon: 'heart', value: d.engagementRate != null ? d.engagementRate + '%' : '—', label: 'Engagement', sub: d.posts != null ? num(d.posts) + ' posts' : '' },
        chart: { label: 'Reach', series: seriesOf(d) },
        list: { title: 'Recent posts', empty: 'No posts yet.', rows: rowsFrom(d.recentPosts, function (p) { return { t: p.message || 'Post', main: p.likes != null ? compact(p.likes) + ' likes' : '', sub: '' }; }) }
      };
    },
    googleAnalytics: function (d) {
      var m = d.last30Days || {}, w = d.last7Days || {};
      return {
        handle: d.siteName,
        hero: { value: compact(m.users), label: 'Visitors · 30 days' },
        a: { icon: 'eye', value: num(m.pageViews), label: 'Page views · 30 days', sub: num(m.sessions) + ' sessions' },
        b: { icon: 'clock', value: m.avgSessionSec != null ? dur(m.avgSessionSec) : '—', label: 'Average visit', sub: w.users != null ? num(w.users) + ' visitors this week' : '' },
        chart: { label: 'Visitors', series: seriesOf(d), bars: barsFrom(d.topPages, viewsOf, function (p) { return p.path; }), barLabel: 'Views per page' },
        list: { title: 'Top pages', empty: 'No visits yet.', rows: rowsFrom(d.topPages, function (p) { return { t: p.path, main: compact(p.views) + ' views', sub: '' }; }) }
      };
    },
    shopify: function (d) { return shopTiles(d, d.shopName); },
    squarespace: function (d) { return shopTiles(d, d.siteName || d.shopName); }
  };
  function shopTiles(d, handle) {
    var m = d.last30Days || {}, cur = m.currency || d.currency || '';
    return {
      handle: handle,
      hero: { value: moneyTile(cur, m.revenue), label: 'Sales · 30 days' },
      a: { icon: 'bag', value: num(m.orders || 0), label: 'Orders · 30 days', sub: m.paidOrders != null ? num(m.paidOrders) + ' paid' : '' },
      b: { icon: 'users', value: d.totalCustomers != null ? num(d.totalCustomers) : '—', label: 'Customers' },
      chart: { label: 'Daily sales', series: (d.series || []).map(function (p) { return { x: p.date, y: p.value }; }), money: cur },
      list: { title: 'Recent orders', empty: 'No orders to show yet.', rows: rowsFrom(d.recentOrders, function (o) { return { t: 'Order ' + (o.orderNumber || ''), main: o.total || '', sub: o.status ? String(o.status).toLowerCase() : '' }; }) }
    };
  }

  function barsSvg(items, accent) {
    var W = 660, H = 190, PAD_T = 18, PAD_B = 26, PAD_X = 8;
    var max = Math.max.apply(null, items.map(function (i) { return i.y; }).concat([1]));
    var n = items.length, gap = 10;
    var bw = Math.max(6, (W - PAD_X * 2 - gap * (n - 1)) / n);
    var ih = H - PAD_T - PAD_B, id = 'aobG' + Math.random().toString(36).slice(2, 7);
    var bars = items.map(function (it, i) {
      var h = Math.max(2, (it.y / max) * ih), x = PAD_X + i * (bw + gap), y = PAD_T + ih - h;
      return '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="4" fill="url(#' + id + ')">' +
        '<title>' + esc(it.label) + ': ' + num(it.y) + '</title></rect>' +
        (n <= 12 ? '<text class="ao-axis" text-anchor="middle" x="' + (x + bw / 2) + '" y="' + (y - 5) + '">' + esc(compact(it.y)) + '</text>' : '');
    }).join('');
    var grid = '';
    for (var g = 0; g <= 3; g++) {
      var gy = PAD_T + (ih / 3) * g;
      grid += '<line x1="' + PAD_X + '" y1="' + gy + '" x2="' + (W - PAD_X) + '" y2="' + gy + '" class="ao-grid"/>';
    }
    return '<svg class="ao-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Bar chart">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + accent + '" stop-opacity="0.95"/>' +
      '<stop offset="100%" stop-color="#0f37b4" stop-opacity="0.35"/></linearGradient></defs>' +
      grid + bars + '</svg>';
  }

  function compact(v) {
    var n = Number(v) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
    return String(n);
  }

  function small(tile) {
    return '<div class="aob-tile"><div class="aob-ico"><svg viewBox="0 0 24 24">' + ICON[tile.icon] + '</svg></div>' +
      '<div class="aob-num">' + esc(tile.value) + '</div><div class="aob-cap">' + esc(tile.label) + '</div>' +
      (tile.sub ? '<div class="aob-subcap">' + esc(tile.sub) + '</div>' : '') + '</div>';
  }

  function render(key, d) {
    var p = PLATFORMS[key];
    var t = TILES[key] && TILES[key](d);
    if (!p || !t) return;
    var c = t.chart || {}, series = c.series || [], bars = c.bars || [], chartTile;
    var legend = function (text) { return '<div class="aob-legend"><span class="ao-key" style="background:' + p.accent + '"></span>' + esc(text) + '</div>'; };
    if (series.length) chartTile = legend(c.label + ' · last ' + series.length + ' days') + chartSvg(series, p.accent, c.money);
    else if (bars.length) chartTile = legend(c.barLabel + ' · latest ' + bars.length) + barsSvg(bars, p.accent);
    else chartTile = legend(c.label || 'Trend') + '<div class="aob-empty">Nothing to chart yet. It fills in as ' + esc(p.name) + ' reports new figures.</div>';

    var rows = (t.list.rows || []).map(function (r) {
      return '<div class="aob-row"><span class="aob-row-t">' + esc(String(r.t || '').slice(0, 64)) + '</span>' +
        '<span class="aob-row-s">' + (r.main ? '<b>' + esc(r.main) + '</b>' : '') + (r.sub ? '<i>' + esc(r.sub) + '</i>' : '') + '</span></div>';
    }).join('') || '<div class="aob-empty">' + esc(t.list.empty) + '</div>';

    var ring = '<svg class="aob-ring" viewBox="0 0 254 104" aria-hidden="true"><ellipse cx="127" cy="52" rx="122" ry="46"/><ellipse cx="127" cy="52" rx="108" ry="38"/></svg>';
    var longHero = String(t.hero.value).length > 8;

    root.querySelector('#aoBody').innerHTML =
      '<div class="ao-head"><div class="ao-title"><span class="ao-dot" style="background:' + p.accent + '"></span>' +
        '<span>' + esc(p.name) + '</span>' + (t.handle || p.sub ? '<span class="ao-sub">' + esc(t.handle || p.sub) + '</span>' : '') + '</div>' +
        '<button class="ao-x" id="aoClose" aria-label="Close">✕</button></div>' +
      '<div class="aob" style="--acc:' + p.accent + '">' +
        '<div class="aob-tile aob-hero">' + ring + '<div class="aob-big' + (longHero ? ' aob-big-long' : '') + '">' + esc(t.hero.value) + '</div><div class="aob-cap">' + esc(t.hero.label) + '</div></div>' +
        small(t.a) + small(t.b) +
        '<div class="aob-tile aob-wide">' + chartTile + '</div>' +
        '<div class="aob-tile aob-wide"><div class="aob-legend">' + esc(t.list.title) + '</div>' + rows + '</div>' +
      '</div>';
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
    try { data = await (window.CallistoAnalyticsApi || window.jarvis).analyticsGet(key); } catch (_) {}
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
