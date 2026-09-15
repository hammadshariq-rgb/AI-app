/* ─────────────────────────────────────────────────────────────────────────────
   Callisto 3D Studio — model viewer + editor

   Full-screen overlay that loads a .glb and lets people spin, zoom, select an
   area of the model and reshape / recolour it, then download the result.

   Input comes from three sources through one path: mouse/trackpad, touch, and
   Callisto's hand cursor (pinch = grab, pinch + move toward the camera = zoom,
   quick pinch = select, pinch on a slider = drag it).

   Generated models are usually a single merged mesh, so "parts" are selected as
   an area: click a point and everything within the brush radius is selected,
   with a soft falloff so reshaping blends into the surrounding surface. Colour
   is painted into the model's own texture, so what you see is what downloads.

   Public API:
     open(url, { title, taskId, prompt })        → Promise<boolean>
     showLoading({ title, jobKey })
     setProgress(jobKey, pct, label)
     loadingJobKey()                               → key of the job on screen
     fail(message)
     close(), isOpen()
     handInput({ x, y, pinching, handSize })       // x/y normalised 0..1
     onCommand(fn)                                 // fn(text) from the command bar
     setBusy(label | null)                         // repaint in progress etc.
     info()                                        → { title, taskId, prompt }
     hasSelection()
     editSelection({ color, scale, inflate })      // used by typed/voice commands
     notify({ title, text, action, onAction })     // top-of-screen notice
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const GLTF_CDN = 'https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/loaders/GLTFLoader.js';

  const SWATCHES = [
    ['Crimson', '#c8102e'], ['Gold', '#d4a537'], ['Silver', '#c9ced6'], ['Black', '#111114'],
    ['White', '#f2f2f2'], ['Blue', '#1f5fd6'], ['Green', '#1f9d55'], ['Purple', '#7b3fe4'],
  ];

  let root, canvas, titleEl, statusEl, ringEl, ringPct, ringLabel, inspector, cmdInput, busyEl, dlBtn;
  let renderer = null, scene = null, camera = null, modelRoot = null, brushMesh = null;
  let rafId = null, open = false, loaderReady = null;
  let raycaster = null;

  let current = { title: '', taskId: null, prompt: '', bytes: null, edited: false };
  let loadingKey = null;
  let commandHandler = null;

  // Camera orbit state. Spherical around the model's centre.
  const cam = { theta: 0.6, phi: 1.2, radius: 3.2, targetRadius: 3.2 };
  const smooth = { theta: 0.6, phi: 1.2, radius: 3.2 };
  let autoSpin = true;

  const drag = { active: false, lastX: 0, lastY: 0, source: null, downX: 0, downY: 0, downAt: 0, moved: 0 };
  const hand = { zoomBase: 0, radiusBase: 0, sizeEma: 0, slider: null };

  const reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ── DOM ───────────────────────────────────────────────────────────────────
  function build() {
    if (root) return;

    root = document.createElement('div');
    root.id = 'modelViewerOverlay';
    root.className = 'mv-overlay hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '3D model studio');
    root.innerHTML = `
      <div class="mv-backdrop"></div>
      <div class="mv-stage">
        <div class="mv-glow" aria-hidden="true"></div>
        <canvas class="mv-canvas" id="mvCanvas"></canvas>

        <header class="mv-head">
          <div class="mv-titles">
            <div class="mv-eyebrow"><span class="mv-dot"></span>CALLISTO · 3D STUDIO</div>
            <h2 class="mv-title" id="mvTitle">3D Model</h2>
          </div>
          <div class="mv-actions">
            <button class="mv-btn mv-btn-primary" id="mvDownload" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16"/></svg>
              <span>Download</span>
            </button>
            <button class="mv-icon-btn" id="mvClose" aria-label="Close — keeps building in the background">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
        </header>

        <div class="mv-status" id="mvStatus"></div>

        <div class="mv-ring" id="mvRing" hidden>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle class="mv-ring-track" cx="60" cy="60" r="52"/>
            <circle class="mv-ring-fill" id="mvRingFill" cx="60" cy="60" r="52"/>
          </svg>
          <div class="mv-ring-text">
            <div class="mv-ring-pct" id="mvRingPct">0%</div>
            <div class="mv-ring-label" id="mvRingLabel">Queued</div>
          </div>
          <div class="mv-ring-note">You can close this — Callisto keeps building and lets you know when it's ready.</div>
        </div>

        <div class="mv-busy" id="mvBusy" hidden></div>

        <nav class="mv-dock" aria-label="View controls">
          <button class="mv-dock-btn" data-act="zoom-in"  aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
          <button class="mv-dock-btn" data-act="zoom-out" aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
          <span class="mv-dock-sep"></span>
          <button class="mv-dock-btn" data-act="up"   aria-label="Tilt up"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
          <button class="mv-dock-btn" data-act="down" aria-label="Tilt down"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
          <span class="mv-dock-sep"></span>
          <button class="mv-dock-btn" data-act="spin"  aria-label="Toggle auto-rotate" aria-pressed="true"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg></button>
          <button class="mv-dock-btn" data-act="reset" aria-label="Reset view"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 8-8M4 4v5h5"/></svg></button>
        </nav>

        <aside class="mv-inspector" id="mvInspector" hidden aria-label="Edit selected area">
          <div class="mv-insp-head">
            <div>
              <div class="mv-eyebrow">SELECTED AREA</div>
              <div class="mv-insp-title">Edit this part</div>
            </div>
            <button class="mv-icon-btn mv-icon-sm" id="mvDeselect" aria-label="Deselect"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>

          <label class="mv-field">
            <span class="mv-field-row"><span>Selection size</span><output id="mvBrushOut">18%</output></span>
            <input type="range" id="mvBrush" min="3" max="45" value="18">
          </label>

          <div class="mv-field">
            <span class="mv-field-row"><span>Colour</span></span>
            <div class="mv-swatches" id="mvSwatches">
              ${SWATCHES.map(([n, c]) => `<button class="mv-swatch" style="--sw:${c}" data-color="${c}" aria-label="${n}" title="${n}"></button>`).join('')}
              <label class="mv-swatch mv-swatch-custom" title="Custom colour"><input type="color" id="mvColor" value="#c8102e" aria-label="Custom colour"></label>
            </div>
          </div>
          <label class="mv-field">
            <span class="mv-field-row"><span>Colour strength</span><output id="mvStrengthOut">0%</output></span>
            <input type="range" id="mvStrength" min="0" max="100" value="0">
          </label>

          <label class="mv-field">
            <span class="mv-field-row"><span>Size</span><output id="mvScaleOut">100%</output></span>
            <input type="range" id="mvScale" min="50" max="180" value="100">
          </label>
          <label class="mv-field">
            <span class="mv-field-row"><span>Shape</span><output id="mvInflateOut">Original</output></span>
            <input type="range" id="mvInflate" min="-100" max="100" value="0">
            <span class="mv-field-hint"><span>Flatten</span><span>Bulge</span></span>
          </label>

          <div class="mv-insp-foot">
            <button class="mv-btn mv-btn-ghost" id="mvResetArea">Undo changes here</button>
          </div>
        </aside>

        <form class="mv-command" id="mvCommand" autocomplete="off">
          <svg class="mv-command-spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>
          <input id="mvCmdInput" type="text" placeholder="Tell Callisto what to change — “make it black and silver”" aria-label="Tell Callisto what to change">
          <kbd class="mv-kbd">Ctrl Shift C</kbd>
          <button class="mv-btn mv-btn-primary mv-btn-sm" type="submit">Apply</button>
        </form>

        <div class="mv-hint">Drag to rotate · scroll to zoom · click a part to edit · hand: pinch to grab, pinch and move closer to zoom, quick pinch to select</div>
      </div>`;
    document.body.appendChild(root);

    canvas    = root.querySelector('#mvCanvas');
    titleEl   = root.querySelector('#mvTitle');
    statusEl  = root.querySelector('#mvStatus');
    ringEl    = root.querySelector('#mvRing');
    ringPct   = root.querySelector('#mvRingPct');
    ringLabel = root.querySelector('#mvRingLabel');
    inspector = root.querySelector('#mvInspector');
    cmdInput  = root.querySelector('#mvCmdInput');
    busyEl    = root.querySelector('#mvBusy');
    dlBtn     = root.querySelector('#mvDownload');

    root.querySelector('#mvClose').addEventListener('click', close);
    root.querySelector('.mv-backdrop').addEventListener('click', close);
    dlBtn.addEventListener('click', download);

    root.querySelector('.mv-dock').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act !== 'spin') autoSpin = false;
      if (act === 'zoom-in')  cam.targetRadius = clamp(cam.targetRadius * 0.8, 0.7, 9);
      if (act === 'zoom-out') cam.targetRadius = clamp(cam.targetRadius * 1.25, 0.7, 9);
      if (act === 'up')   cam.phi = clamp(cam.phi - 0.3, 0.12, Math.PI - 0.12);
      if (act === 'down') cam.phi = clamp(cam.phi + 0.3, 0.12, Math.PI - 0.12);
      if (act === 'reset') { cam.theta = 0.6; cam.phi = 1.2; cam.targetRadius = 3.2; }
      if (act === 'spin') autoSpin = !autoSpin;
      root.querySelector('[data-act="spin"]').setAttribute('aria-pressed', String(autoSpin));
    });

    root.querySelector('#mvCommand').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = cmdInput.value.trim();
      if (!text || !commandHandler) return;
      cmdInput.value = '';
      commandHandler(text);
    });

    bindInspector();
    bindPointer();
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  function bindPointer() {
    canvas.addEventListener('pointerdown', (e) => {
      drag.active = true; drag.source = 'pointer';
      drag.lastX = drag.downX = e.clientX; drag.lastY = drag.downY = e.clientY;
      drag.downAt = performance.now(); drag.moved = 0;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag.active || drag.source !== 'pointer') return;
      const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4) { autoSpin = false; orbitBy(dx, dy); }
      drag.lastX = e.clientX; drag.lastY = e.clientY;
    });
    const release = (e) => {
      if (drag.source !== 'pointer') return;
      const wasClick = drag.moved <= 4 && performance.now() - drag.downAt < 450;
      drag.active = false; drag.source = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      if (wasClick && e.type === 'pointerup') selectAt(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    // Trackpads send small fractional deltas; scale by magnitude so pinch-zoom
    // and two-finger scroll both feel proportional.
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      autoSpin = false;
      const k = clamp(e.deltaY, -60, 60) / 60;
      cam.targetRadius = clamp(cam.targetRadius * (1 + k * 0.14), 0.7, 9);
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      if (!open) return;
      const typing = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)
        && document.activeElement.type !== 'range';
      if (e.key === 'Escape') { if (hasSelection()) deselect(); else close(); return; }
      if (typing) return;
      const step = 0.12;
      if (e.key === 'ArrowLeft')  { autoSpin = false; cam.theta += step; }
      if (e.key === 'ArrowRight') { autoSpin = false; cam.theta -= step; }
      if (e.key === 'ArrowUp')    { autoSpin = false; cam.phi = clamp(cam.phi - step, 0.12, Math.PI - 0.12); }
      if (e.key === 'ArrowDown')  { autoSpin = false; cam.phi = clamp(cam.phi + step, 0.12, Math.PI - 0.12); }
      if (e.key === '+' || e.key === '=') cam.targetRadius = clamp(cam.targetRadius * 0.85, 0.7, 9);
      if (e.key === '-' || e.key === '_') cam.targetRadius = clamp(cam.targetRadius * 1.18, 0.7, 9);
    });
  }

  function orbitBy(dx, dy) {
    cam.theta -= dx * 0.009;
    cam.phi    = clamp(cam.phi - dy * 0.009, 0.12, Math.PI - 0.12);
  }

  // Hand cursor. Pinch over the model grabs it; moving the pinched hand toward
  // the camera zooms in. A quick pinch without moving selects. Pinch over a
  // slider drags the slider. Buttons are clicked by the gesture loop itself.
  function handInput(state) {
    if (!open || !state) return;
    const px = state.x * window.innerWidth;
    const py = state.y * window.innerHeight;
    const size = state.handSize || 0;
    if (size) hand.sizeEma = hand.sizeEma ? hand.sizeEma + (size - hand.sizeEma) * 0.25 : size;

    if (state.pinching) {
      if (drag.source !== 'hand' && !hand.slider) {
        const el = document.elementFromPoint(px, py);
        if (el && el.matches && el.matches('.mv-inspector input[type="range"]')) {
          hand.slider = el;
        } else if (el === canvas) {
          drag.active = true; drag.source = 'hand';
          drag.lastX = drag.downX = px; drag.lastY = drag.downY = py;
          drag.downAt = performance.now(); drag.moved = 0;
          hand.zoomBase = hand.sizeEma; hand.radiusBase = cam.targetRadius;
        }
      }
      if (hand.slider) {
        const r = hand.slider.getBoundingClientRect();
        const t = clamp((px - r.left) / r.width, 0, 1);
        const min = Number(hand.slider.min), max = Number(hand.slider.max);
        hand.slider.value = String(Math.round(min + t * (max - min)));
        hand.slider.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (drag.source === 'hand') {
        const dx = px - drag.lastX, dy = py - drag.lastY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        if (drag.moved > 14) { autoSpin = false; orbitBy(dx * 1.15, dy * 1.15); }
        drag.lastX = px; drag.lastY = py;

        // Depth zoom with a dead-band so ordinary pinching doesn't wobble the camera
        if (hand.zoomBase && hand.sizeEma) {
          const ratio = hand.sizeEma / hand.zoomBase;
          if (Math.abs(ratio - 1) > 0.08) {
            autoSpin = false;
            cam.targetRadius = clamp(hand.radiusBase / Math.pow(ratio, 1.6), 0.7, 9);
          }
        }
      }
    } else {
      if (drag.source === 'hand') {
        const wasTap = drag.moved <= 14 && performance.now() - drag.downAt < 380;
        drag.active = false; drag.source = null;
        if (wasTap) selectAt(drag.downX, drag.downY);
      }
      hand.slider = null;
    }
  }

  // ── three.js ──────────────────────────────────────────────────────────────
  function initScene() {
    const THREE = window.THREE;
    if (!THREE) throw new Error('three.js not loaded');
    if (renderer) return;

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
    raycaster = new THREE.Raycaster();

    // Studio lighting: soft key, cool fill, Callisto crimson rim.
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a0b12, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.3); key.position.set(3, 5, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0x8ec5ff, 0.6); fill.position.set(-4, 1, 3); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xff2d5c, 1.8); rim.position.set(-2, 2.5, -5); scene.add(rim);

    // Brush preview — a soft crimson shell showing what the selection covers.
    brushMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 20),
      new THREE.MeshBasicMaterial({ color: 0xff2d5c, transparent: true, opacity: 0.18, depthWrite: false })
    );
    const ring = new THREE.Mesh(
      new THREE.SphereGeometry(1.001, 24, 14),
      new THREE.MeshBasicMaterial({ color: 0x4de8ff, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false })
    );
    brushMesh.add(ring);
    brushMesh.visible = false;
    brushMesh.renderOrder = 10;
    scene.add(brushMesh);

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

    if (autoSpin && !reduceMotion && !hasSelection()) cam.theta += 0.0018;

    smooth.theta  += (cam.theta - smooth.theta) * 0.16;
    smooth.phi    += (cam.phi - smooth.phi) * 0.16;
    cam.radius    += (cam.targetRadius - cam.radius) * 0.14;
    smooth.radius += (cam.radius - smooth.radius) * 0.2;

    const r = smooth.radius;
    camera.position.set(
      r * Math.sin(smooth.phi) * Math.sin(smooth.theta),
      r * Math.cos(smooth.phi),
      r * Math.sin(smooth.phi) * Math.cos(smooth.theta)
    );
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }

  function ensureLoader() {
    if (window.THREE && window.THREE.GLTFLoader) return Promise.resolve(true);
    if (loaderReady) return loaderReady;
    loaderReady = (async () => {
      try {
        const src = await window.jarvis.fetchCdnScript(GLTF_CDN);
        if (!src) return false;
        (0, eval)(src);
        return !!(window.THREE && window.THREE.GLTFLoader);
      } catch (_) { return false; }
    })();
    return loaderReady;
  }

  function clearModel() {
    deselect();
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
    paintCache.clear();
  }

  function frameModel(obj) {
    const THREE = window.THREE;
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 1.6 / maxDim;
    obj.scale.setScalar(scale);
    obj.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);
    cam.targetRadius = 3.2; cam.radius = 4.4;
  }

  // Editing needs plain, writable attributes. Interleaved/quantised data from a
  // GLB is copied out into a normal Float32 attribute once.
  function plainAttr(geom, name, itemSize) {
    const THREE = window.THREE;
    const a = geom.getAttribute(name);
    if (!a) return null;
    if (!a.isInterleavedBufferAttribute && a.array instanceof Float32Array && !a.normalized) return a;
    const n = a.count, out = new Float32Array(n * itemSize);
    for (let i = 0; i < n; i++) {
      out[i * itemSize] = a.getX(i);
      if (itemSize > 1) out[i * itemSize + 1] = a.getY(i);
      if (itemSize > 2) out[i * itemSize + 2] = a.getZ(i);
    }
    const plain = new THREE.BufferAttribute(out, itemSize);
    geom.setAttribute(name, plain);
    return plain;
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  let sel = null;   // { mesh, idx:Int32Array, w:Float32Array, base:Float32Array, nrm:Float32Array, centroid:[x,y,z], radius, tris, paint }

  function hasSelection() { return !!sel; }

  function meshes() {
    const out = [];
    if (modelRoot) modelRoot.traverse((o) => { if (o.isMesh) out.push(o); });
    return out;
  }

  function brushWorldRadius() {
    const v = Number(root.querySelector('#mvBrush').value) / 100;   // fraction of model size
    return 1.6 * v * 0.5;
  }

  function selectAt(clientX, clientY) {
    if (!modelRoot || !raycaster) return;
    const THREE = window.THREE;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(meshes(), false)[0];
    if (!hit) { deselect(); return; }
    selectRegion(hit.object, hit.point);
  }

  function selectRegion(mesh, worldPoint) {
    const THREE = window.THREE;
    commitSelection();
    autoSpin = false;
    root.querySelector('[data-act="spin"]').setAttribute('aria-pressed', 'false');

    const geom = mesh.geometry;
    const pos = plainAttr(geom, 'position', 3);
    let nrmAttr = geom.getAttribute('normal');
    if (!nrmAttr) { geom.computeVertexNormals(); nrmAttr = geom.getAttribute('normal'); }
    nrmAttr = plainAttr(geom, 'normal', 3);

    mesh.updateMatrixWorld(true);
    const inv = mesh.matrixWorld.clone().invert();
    const local = worldPoint.clone().applyMatrix4(inv);
    const worldScale = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
    const radius = brushWorldRadius() / (Math.max(worldScale.x, worldScale.y, worldScale.z) || 1);

    const p = pos.array, n = pos.count, r2 = radius * radius;
    const idx = [], w = [];
    let cx = 0, cy = 0, cz = 0, ws = 0;
    for (let i = 0; i < n; i++) {
      const dx = p[i * 3] - local.x, dy = p[i * 3 + 1] - local.y, dz = p[i * 3 + 2] - local.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const t = Math.sqrt(d2) / radius;
      const weight = t < 0.55 ? 1 : 1 - smoothstep(0.55, 1, t);
      idx.push(i); w.push(weight);
      cx += p[i * 3] * weight; cy += p[i * 3 + 1] * weight; cz += p[i * 3 + 2] * weight; ws += weight;
    }
    if (!idx.length) { deselect(); return; }

    const I = Int32Array.from(idx), W = Float32Array.from(w);
    const base = new Float32Array(I.length * 3), nb = new Float32Array(I.length * 3);
    for (let k = 0; k < I.length; k++) {
      const i = I[k];
      base[k * 3] = p[i * 3]; base[k * 3 + 1] = p[i * 3 + 1]; base[k * 3 + 2] = p[i * 3 + 2];
      nb[k * 3] = nrmAttr.array[i * 3]; nb[k * 3 + 1] = nrmAttr.array[i * 3 + 1]; nb[k * 3 + 2] = nrmAttr.array[i * 3 + 2];
    }

    sel = {
      mesh, idx: I, w: W, base, nrm: nb, radius,
      centroid: [cx / ws, cy / ws, cz / ws],
      tris: selectedTriangles(geom, I, W),
      paint: null,
      edits: { color: root.querySelector('#mvColor').value, strength: 0, scale: 1, inflate: 0 },
    };

    brushMesh.position.copy(worldPoint);
    brushMesh.scale.setScalar(brushWorldRadius());
    brushMesh.visible = true;

    setInspectorValues(sel.edits);
    inspector.hidden = false;
    root.classList.add('mv-editing');
  }

  function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  // Triangles that are mostly inside the selection — these get painted.
  function selectedTriangles(geom, I, W) {
    const n = geom.getAttribute('position').count;
    const weight = new Float32Array(n);
    for (let k = 0; k < I.length; k++) weight[I[k]] = W[k];
    const tris = [];
    const index = geom.index;
    const triCount = index ? index.count / 3 : n / 3;
    for (let t = 0; t < triCount; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      if (weight[a] + weight[b] + weight[c] >= 1.5) tris.push(a, b, c);
    }
    return Int32Array.from(tris);
  }

  function commitSelection() {
    if (!sel) return;
    sel = null;
  }

  function deselect() {
    commitSelection();
    if (brushMesh) brushMesh.visible = false;
    if (inspector) inspector.hidden = true;
    if (root) root.classList.remove('mv-editing');
  }

  // ── Editing ───────────────────────────────────────────────────────────────
  function applyShape() {
    if (!sel) return;
    const { mesh, idx, w, base, nrm, centroid, radius, edits } = sel;
    const pos = mesh.geometry.getAttribute('position');
    const p = pos.array;
    const s = edits.scale - 1, inf = edits.inflate * radius * 0.35;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], wk = w[k];
      const bx = base[k * 3], by = base[k * 3 + 1], bz = base[k * 3 + 2];
      p[i * 3]     = bx + (bx - centroid[0]) * s * wk + nrm[k * 3]     * inf * wk;
      p[i * 3 + 1] = by + (by - centroid[1]) * s * wk + nrm[k * 3 + 1] * inf * wk;
      p[i * 3 + 2] = bz + (bz - centroid[2]) * s * wk + nrm[k * 3 + 2] * inf * wk;
    }
    pos.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
    mesh.geometry.computeBoundingBox();
    markEdited();
  }

  // Each material's base-colour texture is copied into a canvas once, so paint
  // lands in the real texture (and therefore in the downloaded file).
  const paintCache = new Map();   // material → { canvas, ctx, texture }

  function paintTarget(material) {
    const THREE = window.THREE;
    if (paintCache.has(material)) return paintCache.get(material);
    const map = material.map;
    let entry = null;
    if (map && map.image && (map.image.width || map.image.videoWidth)) {
      const img = map.image;
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.flipY = map.flipY; tex.colorSpace = map.colorSpace;
      tex.wrapS = map.wrapS; tex.wrapT = map.wrapT;
      tex.channel = map.channel; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      material.map = tex; material.needsUpdate = true;
      entry = { canvas: c, ctx, texture: tex, flipY: map.flipY };
      map.dispose();
    }
    paintCache.set(material, entry);
    return entry;
  }

  function applyColor() {
    if (!sel) return;
    const { mesh, tris, edits } = sel;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const uv = mesh.geometry.getAttribute('uv');
    const target = uv ? paintTarget(material) : null;

    if (!target) {
      // No texture to paint into: tint via vertex colours instead.
      applyVertexTint();
      return;
    }

    const { ctx, canvas: c, texture, flipY } = target;
    const W = c.width, H = c.height;

    // Snapshot the pixels under this selection once, so the strength slider is
    // absolute rather than stacking coats of paint.
    if (!sel.paint) {
      let minX = W, minY = H, maxX = 0, maxY = 0;
      const pts = new Float32Array(tris.length * 2);
      for (let k = 0; k < tris.length; k++) {
        const i = tris[k];
        let u = uv.getX(i) % 1, v = uv.getY(i) % 1;
        if (u < 0) u += 1; if (v < 0) v += 1;
        const x = u * W, y = (flipY ? 1 - v : v) * H;
        pts[k * 2] = x; pts[k * 2 + 1] = y;
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
      minX = Math.max(0, Math.floor(minX) - 2); minY = Math.max(0, Math.floor(minY) - 2);
      maxX = Math.min(W, Math.ceil(maxX) + 2); maxY = Math.min(H, Math.ceil(maxY) + 2);
      if (maxX <= minX || maxY <= minY) return;
      sel.paint = { pts, rect: [minX, minY, maxX - minX, maxY - minY],
        snapshot: ctx.getImageData(minX, minY, maxX - minX, maxY - minY) };
    }

    const { pts, rect, snapshot } = sel.paint;
    ctx.putImageData(snapshot, rect[0], rect[1]);

    if (edits.strength > 0) {
      const path = new Path2D();
      for (let k = 0; k < pts.length; k += 6) {
        // Skip triangles that wrap across the texture edge — they'd smear a band
        const ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3], cx = pts[k + 4], cy = pts[k + 5];
        if (Math.abs(ax - bx) > W / 2 || Math.abs(ax - cx) > W / 2 || Math.abs(ay - by) > H / 2 || Math.abs(ay - cy) > H / 2) continue;
        path.moveTo(ax, ay); path.lineTo(bx, by); path.lineTo(cx, cy); path.closePath();
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect[0], rect[1], rect[2], rect[3]);
      ctx.clip();
      ctx.fillStyle = edits.color;
      ctx.strokeStyle = edits.color;
      ctx.lineWidth = 1.5;
      // Hue pass keeps the surface detail; the cover pass moves brightness so
      // dark colours (black) and light ones (silver) actually read.
      ctx.globalCompositeOperation = 'color';
      ctx.globalAlpha = edits.strength;
      ctx.fill(path); ctx.stroke(path);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = edits.strength * 0.6;
      ctx.fill(path); ctx.stroke(path);
      ctx.restore();
    }
    texture.needsUpdate = true;
    markEdited();
  }

  function applyVertexTint() {
    const THREE = window.THREE;
    const { mesh, idx, w, edits } = sel;
    const geom = mesh.geometry;
    let col = geom.getAttribute('color');
    if (!col) {
      col = new THREE.BufferAttribute(new Float32Array(geom.getAttribute('position').count * 3).fill(1), 3);
      geom.setAttribute('color', col);
      const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      m.vertexColors = true; m.needsUpdate = true;
    }
    if (!sel.tintBase) {
      sel.tintBase = new Float32Array(idx.length * 3);
      for (let k = 0; k < idx.length; k++) for (let j = 0; j < 3; j++) sel.tintBase[k * 3 + j] = col.array[idx[k] * 3 + j];
    }
    const c = new THREE.Color(edits.color);
    for (let k = 0; k < idx.length; k++) {
      const a = edits.strength * w[k];
      col.array[idx[k] * 3]     = sel.tintBase[k * 3]     * (1 - a) + c.r * a;
      col.array[idx[k] * 3 + 1] = sel.tintBase[k * 3 + 1] * (1 - a) + c.g * a;
      col.array[idx[k] * 3 + 2] = sel.tintBase[k * 3 + 2] * (1 - a) + c.b * a;
    }
    col.needsUpdate = true;
    markEdited();
  }

  let pendingApply = 0;
  function scheduleApply(what) {
    pendingApply |= what;
    if (scheduleApply.raf) return;
    scheduleApply.raf = requestAnimationFrame(() => {
      scheduleApply.raf = 0;
      const w = pendingApply; pendingApply = 0;
      if (w & 1) applyShape();
      if (w & 2) applyColor();
    });
  }

  function setInspectorValues(e) {
    const q = (s) => root.querySelector(s);
    q('#mvStrength').value = Math.round(e.strength * 100);
    q('#mvScale').value = Math.round(e.scale * 100);
    q('#mvInflate').value = Math.round(e.inflate * 100);
    q('#mvColor').value = e.color;
    syncOutputs();
  }

  function syncOutputs() {
    const q = (s) => root.querySelector(s);
    q('#mvBrushOut').textContent = q('#mvBrush').value + '%';
    q('#mvStrengthOut').textContent = q('#mvStrength').value + '%';
    q('#mvScaleOut').textContent = q('#mvScale').value + '%';
    const inf = Number(q('#mvInflate').value);
    q('#mvInflateOut').textContent = inf === 0 ? 'Original' : inf > 0 ? `Bulge ${inf}%` : `Flatten ${-inf}%`;
    root.querySelectorAll('.mv-swatch[data-color]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.color.toLowerCase() === q('#mvColor').value.toLowerCase()));
    });
  }

  function bindInspector() {
    const q = (s) => root.querySelector(s);
    q('#mvDeselect').addEventListener('click', deselect);

    q('#mvBrush').addEventListener('input', () => {
      syncOutputs();
      if (sel && brushMesh.visible) {
        // Re-select at the same spot with the new size, keeping current edits
        const point = brushMesh.position.clone();
        const mesh = sel.mesh, edits = { ...sel.edits };
        resetArea(true);
        selectRegion(mesh, point);
        Object.assign(sel.edits, edits);
        setInspectorValues(sel.edits);
        scheduleApply(3);
      }
    });

    q('#mvSwatches').addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]'); if (!b || !sel) return;
      sel.edits.color = b.dataset.color;
      if (sel.edits.strength === 0) sel.edits.strength = 0.85;
      setInspectorValues(sel.edits);
      scheduleApply(2);
    });
    q('#mvColor').addEventListener('input', (e) => {
      if (!sel) return;
      sel.edits.color = e.target.value;
      if (sel.edits.strength === 0) sel.edits.strength = 0.85;
      setInspectorValues(sel.edits);
      scheduleApply(2);
    });
    q('#mvStrength').addEventListener('input', (e) => {
      syncOutputs(); if (!sel) return;
      sel.edits.strength = Number(e.target.value) / 100; scheduleApply(2);
    });
    q('#mvScale').addEventListener('input', (e) => {
      syncOutputs(); if (!sel) return;
      sel.edits.scale = Number(e.target.value) / 100; scheduleApply(1);
    });
    q('#mvInflate').addEventListener('input', (e) => {
      syncOutputs(); if (!sel) return;
      sel.edits.inflate = Number(e.target.value) / 100; scheduleApply(1);
    });
    q('#mvResetArea').addEventListener('click', () => resetArea(false));
  }

  function resetArea(silent) {
    if (!sel) return;
    sel.edits.scale = 1; sel.edits.inflate = 0; sel.edits.strength = 0;
    applyShape();
    if (sel.paint || sel.tintBase) applyColor();
    if (!silent) setInspectorValues(sel.edits);
  }

  // Programmatic edit for typed / spoken commands on the current selection.
  function editSelection(change) {
    if (!sel) return false;
    if (change.color) { sel.edits.color = change.color; sel.edits.strength = change.strength ?? Math.max(sel.edits.strength, 0.85); }
    if (typeof change.scale === 'number') sel.edits.scale = clamp(change.scale, 0.5, 1.8);
    if (typeof change.inflate === 'number') sel.edits.inflate = clamp(change.inflate, -1, 1);
    setInspectorValues(sel.edits);
    applyShape(); applyColor();
    return true;
  }

  function markEdited() {
    current.edited = true;
  }

  // ── Download ──────────────────────────────────────────────────────────────
  async function download() {
    if (!modelRoot) return;
    const label = dlBtn.querySelector('span');
    const prev = label.textContent;
    dlBtn.disabled = true; label.textContent = 'Preparing…';
    try {
      let bytes = current.bytes;
      if (current.edited || !bytes) {
        if (!window.THREE.GLTFExporter) throw new Error('Exporter unavailable');
        // Export in the model's own units, not the viewer's framing.
        const s = modelRoot.scale.clone(), p = modelRoot.position.clone();
        modelRoot.scale.set(1, 1, 1); modelRoot.position.set(0, 0, 0);
        modelRoot.updateMatrixWorld(true);
        try {
          const out = await new window.THREE.GLTFExporter().parseAsync(modelRoot, { binary: true });
          bytes = new Uint8Array(out);
        } finally {
          modelRoot.scale.copy(s); modelRoot.position.copy(p); modelRoot.updateMatrixWorld(true);
        }
      }
      const res = await window.jarvis.saveModelFile(bytes, current.title || 'callisto-model');
      if (res && res.ok) {
        label.textContent = 'Saved';
        setTimeout(() => { label.textContent = prev; }, 1800);
      } else {
        label.textContent = prev;
        if (res && res.error) toastInline(`Couldn't save: ${res.error}`);
      }
    } catch (err) {
      label.textContent = prev;
      toastInline(`Couldn't prepare the download: ${err.message}`);
    } finally {
      dlBtn.disabled = !modelRoot;
    }
  }

  function toastInline(text) {
    setStatus('error', text);
    setTimeout(() => { if (statusEl.classList.contains('mv-error')) setStatus('', ''); }, 4000);
  }

  // ── Public ────────────────────────────────────────────────────────────────
  function show(title) {
    build();
    titleEl.textContent = title || '3D Model';
    root.classList.remove('hidden');
    open = true;
    document.body.classList.add('mv-open');
    initScene();
    requestAnimationFrame(() => { resize(); });
    if (!rafId) tick();
  }

  function showLoading(opts = {}) {
    clearModel();
    show(opts.title || 'Building your model');
    loadingKey = opts.jobKey || null;
    current = { title: opts.title || '', taskId: null, prompt: opts.prompt || '', bytes: null, edited: false };
    dlBtn.disabled = true;
    setStatus('', '');
    ringEl.hidden = false;
    setProgress(loadingKey, opts.progress || 0, opts.label || 'Queued');
  }

  function setProgress(jobKey, pct, label) {
    if (!root || !open || jobKey !== loadingKey || ringEl.hidden) return;
    const v = clamp(Math.round(pct || 0), 0, 100);
    const C = 2 * Math.PI * 52;
    root.querySelector('#mvRingFill').style.strokeDasharray = `${(C * v) / 100} ${C}`;
    ringPct.textContent = `${v}%`;
    ringLabel.textContent = label || (v < 50 ? 'Sculpting the shape' : 'Painting the details');
  }

  function setStatus(kind, text) {
    if (!statusEl) return;
    statusEl.className = 'mv-status' + (kind ? ' mv-' + kind : '');
    statusEl.textContent = text || '';
    statusEl.style.display = text ? '' : 'none';
  }

  function setBusy(label) {
    build();
    busyEl.hidden = !label;
    busyEl.textContent = label || '';
  }

  async function openModel(url, opts = {}) {
    show(opts.title || current.title || '3D Model');
    loadingKey = null;
    ringEl.hidden = true;
    setStatus('loading', 'Loading model…');

    const ok = await ensureLoader();
    if (!ok) { setStatus('error', "Couldn't load the 3D engine. Check your connection."); return false; }

    let bytes = null;
    try {
      if (window.jarvis.fetchModelFile) bytes = await window.jarvis.fetchModelFile(url);
    } catch (_) { bytes = null; }

    return new Promise((resolve) => {
      const loader = new window.THREE.GLTFLoader();
      const onLoad = (gltf) => {
        clearModel();
        modelRoot = gltf.scene || gltf.scenes?.[0];
        if (!modelRoot) { setStatus('error', 'That model came back empty.'); return resolve(false); }
        frameModel(modelRoot);
        scene.add(modelRoot);
        autoSpin = !reduceMotion;
        current = {
          title: opts.title || current.title || '3D Model',
          taskId: opts.taskId || null,
          prompt: opts.prompt || current.prompt || '',
          bytes: bytes && bytes.byteLength ? bytes : null,
          edited: false,
        };
        titleEl.textContent = current.title;
        dlBtn.disabled = false;
        setStatus('', '');
        resolve(true);
      };
      const onError = () => { setStatus('error', "Couldn't load that model file."); resolve(false); };
      if (bytes && bytes.byteLength) {
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        loader.parse(buf, '', onLoad, onError);
      } else {
        loader.load(url, onLoad, undefined, onError);
      }
    });
  }

  function fail(message) {
    build();
    if (ringEl) ringEl.hidden = true;
    loadingKey = null;
    setStatus('error', message || 'Something went wrong building that model.');
  }

  function close() {
    if (!open) return;
    open = false;
    drag.active = false; drag.source = null; hand.slider = null;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    deselect();
    if (root) root.classList.add('hidden');
    document.body.classList.remove('mv-open');
    // A job that is still building carries on; the model on screen is dropped
    // (it can be reopened from the notification or chat).
    loadingKey = null;
    if (ringEl) ringEl.hidden = true;
    setBusy(null);
    clearModel();
  }

  // ── Top-of-screen notification ────────────────────────────────────────────
  function notify({ title, text, action, onAction, timeout = 15000 }) {
    let host = document.getElementById('mvNotify');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mvNotify';
      host.className = 'mv-notify-host';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const card = document.createElement('div');
    card.className = 'mv-notify';
    card.innerHTML = `
      <span class="mv-notify-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7z M12 22V12 M21 7l-9 5-9-5"/></svg></span>
      <span class="mv-notify-body"><strong></strong><span></span></span>
      ${action ? '<button class="mv-btn mv-btn-primary mv-btn-sm" data-go></button>' : ''}
      <button class="mv-icon-btn mv-icon-sm" data-x aria-label="Dismiss"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    card.querySelector('strong').textContent = title || '';
    card.querySelector('.mv-notify-body span').textContent = text || '';
    const dismiss = () => { card.classList.add('mv-out'); setTimeout(() => card.remove(), 220); };
    if (action) {
      const go = card.querySelector('[data-go]');
      go.textContent = action;
      go.addEventListener('click', () => { dismiss(); onAction && onAction(); });
    }
    card.querySelector('[data-x]').addEventListener('click', dismiss);
    host.appendChild(card);
    if (timeout) setTimeout(dismiss, timeout);
    return dismiss;
  }

  window.CallistoModelViewer = {
    open: openModel,
    showLoading,
    setProgress,
    loadingJobKey: () => loadingKey,
    fail,
    close,
    isOpen: () => open,
    handInput,
    onCommand: (fn) => { commandHandler = fn; },
    setBusy,
    info: () => ({ title: current.title, taskId: current.taskId, prompt: current.prompt, loaded: !!modelRoot }),
    hasSelection,
    editSelection,
    notify,
  };
})();
