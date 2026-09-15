/* ─────────────────────────────────────────────────────────────────────────────
   Callisto 3D model viewer

   Full-screen overlay that loads a .glb/.gltf and lets you spin it in real time,
   the same way the black-hole demo feels: grab it and it moves with you.

   Orbit is hand-written rather than THREE.OrbitControls because the bundled
   three.global.js ships neither OrbitControls nor GLTFLoader, and because it has
   to take input from three sources — mouse, touch, and Callisto's hand cursor.

   Public API:
     CallistoModelViewer.open(url, { title, subtitle })
     CallistoModelViewer.showLoading({ title })   // while a model generates
     CallistoModelViewer.fail(message)
     CallistoModelViewer.close()
     CallistoModelViewer.isOpen()
     CallistoModelViewer.handInput({ x, y, pinching })   // normalised 0..1
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const GLTF_CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/js/loaders/GLTFLoader.js';

  let root = null, canvas = null, titleEl = null, subEl = null, statusEl = null;
  let renderer = null, scene = null, camera = null, modelRoot = null;
  let rafId = null, open = false, loaderReady = null;

  // Camera orbit state. Spherical around the model's centre.
  const cam = { theta: 0.6, phi: 1.15, radius: 3.2, targetRadius: 3.2 };
  // Damped values so motion glides instead of snapping
  const smooth = { theta: 0.6, phi: 1.15, radius: 3.2 };
  let autoSpin = true;

  const drag = { active: false, lastX: 0, lastY: 0, source: null };

  const reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── DOM ───────────────────────────────────────────────────────────────────
  function build() {
    if (root) return;

    root = document.createElement('div');
    root.id = 'modelViewerOverlay';
    root.className = 'mv-overlay hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '3D model viewer');
    root.innerHTML = `
      <div class="mv-backdrop"></div>
      <div class="mv-stage">
        <div class="mv-head">
          <div class="mv-titles">
            <div class="mv-title" id="mvTitle">3D Model</div>
            <div class="mv-sub" id="mvSub"></div>
          </div>
          <button class="mv-close" id="mvClose" aria-label="Close 3D viewer">✕</button>
        </div>
        <canvas class="mv-canvas" id="mvCanvas"></canvas>
        <div class="mv-status" id="mvStatus"></div>
        <div class="mv-hint">Drag to rotate · scroll to zoom · pinch with your hand to grab</div>
      </div>`;
    document.body.appendChild(root);

    canvas   = root.querySelector('#mvCanvas');
    titleEl  = root.querySelector('#mvTitle');
    subEl    = root.querySelector('#mvSub');
    statusEl = root.querySelector('#mvStatus');

    root.querySelector('#mvClose').addEventListener('click', close);
    root.querySelector('.mv-backdrop').addEventListener('click', close);

    bindPointer();
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  function bindPointer() {
    canvas.addEventListener('pointerdown', (e) => {
      drag.active = true; drag.source = 'pointer';
      drag.lastX = e.clientX; drag.lastY = e.clientY;
      autoSpin = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag.active || drag.source !== 'pointer') return;
      orbitBy(e.clientX - drag.lastX, e.clientY - drag.lastY);
      drag.lastX = e.clientX; drag.lastY = e.clientY;
    });
    const release = (e) => {
      if (drag.source !== 'pointer') return;
      drag.active = false; drag.source = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      autoSpin = false;
      cam.targetRadius = clamp(cam.targetRadius * (1 + Math.sign(e.deltaY) * 0.12), 1.1, 9);
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      if (open && e.key === 'Escape') close();
    });
  }

  // Drag deltas in px → orbit angles. Phi is clamped so the model never flips.
  function orbitBy(dx, dy) {
    cam.theta -= dx * 0.008;
    cam.phi    = clamp(cam.phi - dy * 0.008, 0.18, Math.PI - 0.18);
  }

  // Called by the gesture loop. Pinch acts as mouse-down, so a pinched hand
  // drags the model exactly like a held mouse button.
  function handInput(state) {
    if (!open || !state) return;
    const px = state.x * window.innerWidth;
    const py = state.y * window.innerHeight;

    if (state.pinching) {
      if (!drag.active) {
        drag.active = true; drag.source = 'hand';
        drag.lastX = px; drag.lastY = py;
        autoSpin = false;
      } else if (drag.source === 'hand') {
        orbitBy(px - drag.lastX, py - drag.lastY);
        drag.lastX = px; drag.lastY = py;
      }
    } else if (drag.source === 'hand') {
      drag.active = false; drag.source = null;
    }
  }

  // ── three.js ──────────────────────────────────────────────────────────────
  function initScene() {
    const THREE = window.THREE;
    if (!THREE) throw new Error('three.js not loaded');
    if (renderer) return;

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

    // Three-point-ish lighting so an untextured mesh still reads as a solid object,
    // with Callisto's crimson as the rim so it belongs to the app.
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x140a12, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(3, 5, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0x88b8ff, 0.7); fill.position.set(-4, 1, 3); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xff3b5c, 1.5); rim.position.set(-2, 2, -5); scene.add(rim);

    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!renderer || !open) return;
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!renderer || !scene) return;

    if (autoSpin && !reduceMotion) cam.theta += 0.0016;

    // Critically damped-ish easing — the glide is what makes it feel physical
    smooth.theta  += (cam.theta - smooth.theta) * 0.16;
    smooth.phi    += (cam.phi - smooth.phi) * 0.16;
    cam.radius    += (cam.targetRadius - cam.radius) * 0.12;
    smooth.radius += (cam.radius - smooth.radius) * 0.18;

    const r = smooth.radius;
    camera.position.set(
      r * Math.sin(smooth.phi) * Math.sin(smooth.theta),
      r * Math.cos(smooth.phi),
      r * Math.sin(smooth.phi) * Math.cos(smooth.theta)
    );
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }

  // GLTFLoader isn't in the bundled three build, so pull it once through the
  // main process (the renderer sandbox can't fetch it directly).
  function ensureLoader() {
    if (window.THREE && window.THREE.GLTFLoader) return Promise.resolve(true);
    if (loaderReady) return loaderReady;
    loaderReady = (async () => {
      try {
        const src = await window.jarvis.fetchCdnScript(GLTF_CDN);
        if (!src) return false;
        // The example build attaches itself to the THREE global
        (0, eval)(src);
        return !!(window.THREE && window.THREE.GLTFLoader);
      } catch (_) { return false; }
    })();
    return loaderReady;
  }

  function clearModel() {
    if (!modelRoot || !scene) return;
    scene.remove(modelRoot);
    modelRoot.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          Object.keys(m).forEach((k) => { if (m[k] && m[k].isTexture) m[k].dispose(); });
          m.dispose();
        });
      }
    });
    modelRoot = null;
  }

  // Scale and centre whatever comes back so every model arrives framed the same,
  // regardless of the units the generator used.
  function frameModel(obj) {
    const THREE = window.THREE;
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 1.6 / maxDim;
    obj.scale.setScalar(scale);
    obj.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);
    cam.targetRadius = 3.2; cam.radius = 4.2;
  }

  // ── Public ────────────────────────────────────────────────────────────────
  function show(title, subtitle) {
    build();
    titleEl.textContent = title || '3D Model';
    subEl.textContent = subtitle || '';
    root.classList.remove('hidden');
    open = true;
    document.body.classList.add('mv-open');
    initScene();
    requestAnimationFrame(() => { resize(); });
    if (!rafId) tick();
  }

  function showLoading(opts = {}) {
    show(opts.title || 'Building your model', opts.subtitle || '');
    setStatus('loading', 'Generating — this usually takes a minute…');
  }

  function setStatus(kind, text) {
    if (!statusEl) return;
    statusEl.className = 'mv-status' + (kind ? ' mv-' + kind : '');
    statusEl.textContent = text || '';
    statusEl.style.display = text ? '' : 'none';
  }

  async function openModel(url, opts = {}) {
    show(opts.title || '3D Model', opts.subtitle || '');
    setStatus('loading', 'Loading model…');

    const ok = await ensureLoader();
    if (!ok) { setStatus('error', "Couldn't load the 3D engine. Check your connection."); return false; }

    return new Promise((resolve) => {
      const loader = new window.THREE.GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          clearModel();
          modelRoot = gltf.scene || gltf.scenes?.[0];
          if (!modelRoot) { setStatus('error', 'That model came back empty.'); return resolve(false); }
          frameModel(modelRoot);
          scene.add(modelRoot);
          autoSpin = !reduceMotion;
          setStatus('', '');
          resolve(true);
        },
        undefined,
        () => { setStatus('error', "Couldn't load that model file."); resolve(false); }
      );
    });
  }

  function fail(message) {
    build();
    setStatus('error', message || 'Something went wrong building that model.');
  }

  function close() {
    if (!open) return;
    open = false;
    drag.active = false; drag.source = null;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    clearModel();
    if (root) root.classList.add('hidden');
    document.body.classList.remove('mv-open');
  }

  window.CallistoModelViewer = {
    open: openModel,
    showLoading,
    fail,
    close,
    isOpen: () => open,
    handInput,
  };
})();
