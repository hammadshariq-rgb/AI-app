/* Soft moving beams behind every section below the hero. The hero covers them
   with its own background, so they only run once it has started to scroll away.
   Drawn small and scaled up: the blur hides the difference and it costs a
   sixteenth of the pixels. */
(function () {
  'use strict';
  const canvas = document.createElement('canvas');
  canvas.id = 'beamsBg';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const COUNT = 30, RES = 0.25, INTENSITY = 0.85;
  const hero = document.getElementById('hero');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let W = 0, H = 0, beams = [], raf = 0;

  function make() {
    return {
      x: Math.random() * W * 1.5 - W * 0.25,
      y: Math.random() * H * 1.5 - H * 0.25,
      width: 30 + Math.random() * 60,
      length: H * 2.5,
      angle: -35 + Math.random() * 10,
      speed: 0.6 + Math.random() * 1.2,
      opacity: 0.12 + Math.random() * 0.16,
      hue: 190 + Math.random() * 70,
      pulse: Math.random() * Math.PI * 2,
      pulseSpeed: 0.02 + Math.random() * 0.03,
    };
  }
  function recycle(b, i) {
    const spacing = W / 3;
    b.y = H + 100;
    b.x = (i % 3) * spacing + spacing / 2 + (Math.random() - 0.5) * spacing * 0.5;
    b.width = 100 + Math.random() * 100;
    b.speed = 0.5 + Math.random() * 0.4;
    b.hue = 190 + (i * 70) / COUNT;
    b.opacity = 0.2 + Math.random() * 0.1;
  }
  function draw() {
    ctx.setTransform(RES, 0, 0, RES, 0, 0);
    ctx.clearRect(0, 0, W, H);
    beams.forEach((b) => {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate((b.angle * Math.PI) / 180);
      const o = b.opacity * (0.8 + Math.sin(b.pulse) * 0.2) * INTENSITY;
      const c = (a) => `hsla(${b.hue},85%,65%,${a})`;
      const g = ctx.createLinearGradient(0, 0, 0, b.length);
      g.addColorStop(0, c(0)); g.addColorStop(0.1, c(o * 0.5)); g.addColorStop(0.4, c(o));
      g.addColorStop(0.6, c(o)); g.addColorStop(0.9, c(o * 0.5)); g.addColorStop(1, c(0));
      ctx.fillStyle = g;
      ctx.fillRect(-b.width / 2, 0, b.width, b.length);
      ctx.restore();
    });
  }
  function frame() {
    raf = 0;
    if (!wanted()) return;
    beams.forEach((b, i) => {
      b.y -= b.speed;
      b.pulse += b.pulseSpeed;
      if (b.y + b.length < -100) recycle(b, i);
    });
    draw();
    raf = requestAnimationFrame(frame);
  }
  const wanted = () => !document.hidden && !still.matches && (!hero || hero.getBoundingClientRect().bottom < innerHeight);
  const wake = () => { if (!raf && wanted()) raf = requestAnimationFrame(frame); };
  function resize() {
    W = innerWidth; H = innerHeight;
    canvas.width = Math.ceil(W * RES); canvas.height = Math.ceil(H * RES);
    beams = Array.from({ length: COUNT }, make);
    draw();
    wake();
  }
  addEventListener('resize', resize);
  addEventListener('scroll', wake, { passive: true });
  document.addEventListener('visibilitychange', wake);
  still.addEventListener('change', wake);
  resize();
})();
