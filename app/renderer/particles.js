(function () {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:1;';
  const ctx = canvas.getContext('2d');

  let W, H, animId, active = false;
  let mouseX = -9999, mouseY = -9999;
  const COUNT = 120;
  const pts = [];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function init() {
    pts.length = 0;
    for (let i = 0; i < COUNT; i++) {
      pts.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 0.7 + Math.random() * 1.0,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        a: 0.06 + Math.random() * 0.10,
      });
    }
  }

  function tick() {
    animId = requestAnimationFrame(tick);
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < COUNT; i++) {
      const p = pts[i];
      const dx = p.x - mouseX, dy = p.y - mouseY;
      const d2 = dx * dx + dy * dy;
      if (d2 < 14400) {                        // 120px radius
        const d = Math.sqrt(d2) || 1;
        const f = (120 - d) / 120 * 0.7;
        p.vx += dx / d * f;
        p.vy += dy / d * f;
      }
      p.vx *= 0.96; p.vy *= 0.96;
      p.x += p.vx;  p.y += p.vy;
      if (p.x < 0) p.x = W; else if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; else if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 6.2832);
      ctx.fillStyle = `rgba(0,0,0,${p.a})`;
      ctx.fill();
    }
  }

  function start() {
    if (active) return;
    active = true;
    resize();
    init();
    document.body.appendChild(canvas);
    window.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });
    window.addEventListener('resize', () => { resize(); init(); });
    tick();
  }

  function stop() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(animId);
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  window._particles = { start, stop };
  if (document.body.classList.contains('light-mode')) start();
})();
