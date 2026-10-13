// ── Animated 3-D dot surface (dark mode) ──────────────────────────────────
// Lifted whole from the desktop app. The site had been drawing a different
// thing entirely - first a 2D canvas, then the app's light-mode line shader -
// while the app's dark mode shows this: a 3D dot surface rolling in
// perspective. That is the wave people actually see in the product.
(function initDotSurface() {
  const canvas = document.getElementById('waveCanvas');
  if (!canvas) return;

  const AMOUNTX = 55, AMOUNTY = 80, SEP = 85, TOTAL = AMOUNTX * AMOUNTY;

  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) return;

  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const VS = `
    attribute vec3 aPos;
    uniform mat4 uMVP;
    varying float vW;
    void main() {
      vec4 clip    = uMVP * vec4(aPos, 1.0);
      gl_Position  = clip;
      gl_PointSize = clamp(3800.0 / clip.w, 1.0, 6.0);
      vW = clip.w;
    }
  `;
  const FS = `
    precision mediump float;
    uniform vec3  uColor;
    uniform float uAlpha;
    varying float vW;
    void main() {
      vec2  c = 2.0 * gl_PointCoord - 1.0;
      float r = dot(c, c);
      if (r > 1.0) discard;
      if (r < 0.18) discard;
      float edge = 1.0 - smoothstep(0.55, 1.0, r);
      float fog  = 1.0 - smoothstep(1800.0, 5000.0, vW);
      gl_FragColor = vec4(uColor, uAlpha * edge * fog);
    }
  `;

  function mkShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s); return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, mkShader(gl.VERTEX_SHADER,   VS));
  gl.attachShader(prog, mkShader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const aPosLoc   = gl.getAttribLocation(prog,  'aPos');
  const uMVPLoc   = gl.getUniformLocation(prog, 'uMVP');
  const uColLoc   = gl.getUniformLocation(prog, 'uColor');
  const uAlphaLoc = gl.getUniformLocation(prog, 'uAlpha');

  // Precompute static XZ grid
  const xz = new Float32Array(TOTAL * 2);
  for (let ix = 0; ix < AMOUNTX; ix++)
    for (let iy = 0; iy < AMOUNTY; iy++) {
      const i = ix * AMOUNTY + iy;
      xz[i*2]   = ix * SEP - (AMOUNTX * SEP) / 2;
      xz[i*2+1] = iy * SEP - (AMOUNTY * SEP) / 2;
    }
  const posData = new Float32Array(TOTAL * 3);
  const buf = gl.createBuffer();

  // ── Matrix helpers ──────────────────────────────────────────────────
  function perspective(fovY, asp, n, f) {
    const t = 1 / Math.tan(fovY / 2), m = new Float32Array(16);
    m[0] = t/asp; m[5] = t;
    m[10] = (f+n)/(n-f); m[11] = -1; m[14] = 2*f*n/(n-f);
    return m;
  }
  function lookAt(ex, ey, ez, tx, ty, tz) {
    let zx=ex-tx, zy=ey-ty, zz=ez-tz;
    let l = Math.hypot(zx,zy,zz); zx/=l; zy/=l; zz/=l;
    // right = cross(up=(0,1,0), z)
    let xx=zz, xy=0, xz2=-zx;
    l = Math.hypot(xx,xy,xz2); xx/=l; xy/=l; xz2/=l;
    // up' = cross(z, right)
    const yx=zy*xz2-zz*xy, yy=zz*xx-zx*xz2, yz=zx*xy-zy*xx;
    const m = new Float32Array(16);
    m[0]=xx;  m[4]=xy;  m[8] =xz2; m[12]=-(xx*ex +xy*ey +xz2*ez);
    m[1]=yx;  m[5]=yy;  m[9] =yz;  m[13]=-(yx*ex +yy*ey +yz*ez);
    m[2]=zx;  m[6]=zy;  m[10]=zz;  m[14]=-(zx*ex +zy*ey +zz*ez);
    m[15]=1; return m;
  }
  function mul4(a, b) {
    const m = new Float32Array(16);
    for (let i=0;i<4;i++) for (let j=0;j<4;j++) {
      let s=0; for (let k=0;k<4;k++) s += a[i+k*4]*b[k+j*4]; m[i+j*4]=s;
    }
    return m;
  }

  function resize() {
    const el = canvas.parentElement || document.body;
    // The canvas is absolute/inset-0, so its own box is the reliable one. The
    // hero measures 0 while it is still laying out, and the original bailed on
    // that and never came back - leaving the buffer at the 300x150 default and
    // a tiny stretched picture.
    const w  = canvas.clientWidth  || el.clientWidth  || window.innerWidth;
    const h  = canvas.clientHeight || el.clientHeight || window.innerHeight;
    if (!w || !h) return;
    canvas.width = w; canvas.height = h;
    gl.viewport(0, 0, w, h);
    const P   = perspective(60 * Math.PI / 180, w / h, 1, 10000);
    const V   = lookAt(0, 355, 1220, 0, 0, 0);
    const mvp = mul4(P, V);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(uMVPLoc, false, mvp);
  }
  window.addEventListener('resize', resize);
  resize();
  // Keep asking until the page has actually laid out and the buffer is real.
  (function settle(tries) {
    resize();
    if (canvas.width > 320 || tries > 60) return;
    requestAnimationFrame(() => settle(tries + 1));
  })(0);
  window.addEventListener('load', resize);
  // The polling above still raced the first layout on a cold load, leaving the
  // buffer at its default. An observer just waits to be told.
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);

  // Initial colour from saved theme
  const _isLight = document.body.classList.contains('light-mode');
  gl.uniform3fv(uColLoc, _isLight ? [0, 0, 0] : [0.0, 0.55, 1.0]);
  gl.uniform1f(uAlphaLoc, _isLight ? 0.38 : 0.72);

  let t = 0, dsRAF = null;
  function frame() {
    dsRAF = requestAnimationFrame(frame);
    for (let ix = 0; ix < AMOUNTX; ix++)
      for (let iy = 0; iy < AMOUNTY; iy++) {
        const i = ix * AMOUNTY + iy;
        posData[i*3]   = xz[i*2];
        posData[i*3+1] = Math.sin((ix + t) * 0.3) * 50 + Math.sin((iy + t) * 0.5) * 50;
        posData[i*3+2] = xz[i*2+1];
      }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, false, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, TOTAL);
    t += 0.1;
  }
  frame();

  window._dotSurface = {
    setColor(rgb, alpha) {
      gl.useProgram(prog);
      gl.uniform3fv(uColLoc, rgb);
      gl.uniform1f(uAlphaLoc, alpha !== undefined ? alpha : 0.72);
    }
  };
})();
