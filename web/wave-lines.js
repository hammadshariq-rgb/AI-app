// ── The big line wave under the orb ──────────────────────────────────────────
// Lifted whole from the desktop app, where it runs alongside the dot field
// rather than instead of it: the dots sit behind, these strands sweep across.
// The site only had the dots, which is why it still looked wrong.
(function initShaderBackground() {
  const canvas = document.getElementById('shaderBg');
  if (!canvas) return;
  const gl = canvas.getContext('webgl');
  if (!gl) return;

  const vsSource = `
    attribute vec4 aVertexPosition;
    void main() { gl_Position = aVertexPosition; }
  `;

  const fsSource = `
    precision highp float;
    uniform vec2 iResolution;
    uniform float iTime;
    uniform float uGlow;

    uniform vec3 uLineColor;
    const float overallSpeed = 0.15;
    const float gridSmoothWidth = 0.015;
    const float scale = 5.0;
    const float minLineWidth = 0.008;
    const float maxLineWidth = 0.10;
    const float lineSpeed = 1.0 * overallSpeed;
    const float lineAmplitude = 0.38;
    const float lineFrequency = 0.2;
    const float warpSpeed = 0.2 * overallSpeed;
    const float warpFrequency = 0.5;
    const float warpAmplitude = 0.3;
    const float offsetFrequency = 0.5;
    const float offsetSpeed = 1.33 * overallSpeed;
    const float minOffsetSpread = 0.2;
    const float maxOffsetSpread = 0.8;
    const int linesPerGroup = 12;

    #define drawCircle(pos, radius, coord) smoothstep(radius + gridSmoothWidth, radius, length(coord - (pos)))
    #define drawSmoothLine(pos, halfWidth, t) smoothstep(halfWidth, 0.0, abs(pos - (t)))
    #define drawCrispLine(pos, halfWidth, t) smoothstep(halfWidth + gridSmoothWidth, halfWidth, abs(pos - (t)))

    float random(float t) {
      return (cos(t) + cos(t * 1.3 + 1.3) + cos(t * 1.4 + 1.4)) / 3.0;
    }

    float getPlasmaY(float x, float hFade, float offset) {
      return random(x * lineFrequency + iTime * lineSpeed) * hFade * lineAmplitude + offset;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / iResolution.xy;
      vec2 space = (gl_FragCoord.xy - iResolution.xy / 2.0) / iResolution.x * 2.0 * scale;

      float hFade = 1.0 - (cos(uv.x * 6.28) * 0.5 + 0.5);
      float vFade = 1.0 - (cos(uv.y * 6.28) * 0.5 + 0.5);

      space.y += random(space.x * warpFrequency + iTime * warpSpeed) * warpAmplitude * (0.5 + hFade);
      space.x += random(space.y * warpFrequency + iTime * warpSpeed + 2.0) * warpAmplitude * hFade;

      vec4 lines = vec4(0.0);

      for (int l = 0; l < linesPerGroup; l++) {
        float nli = float(l) / float(linesPerGroup);
        float offsetTime = iTime * offsetSpeed;
        float offsetPos = float(l) + space.x * offsetFrequency;
        float rand = random(offsetPos + offsetTime) * 0.5 + 0.5;
        float halfWidth = mix(minLineWidth, maxLineWidth, rand * hFade) / 2.0;
        float offset = random(offsetPos + offsetTime * (1.0 + nli)) * mix(minOffsetSpread, maxOffsetSpread, hFade);
        float linePos = getPlasmaY(space.x, hFade, offset);
        float line = drawSmoothLine(linePos, halfWidth, space.y) / 2.0
                   + drawCrispLine(linePos, halfWidth * 0.15, space.y);
        float cx = mod(float(l) + iTime * lineSpeed, 25.0) - 12.0;
        vec2 cp = vec2(cx, getPlasmaY(cx, hFade, offset));
        float circle = drawCircle(cp, 0.01, space) * 4.0;
        lines += (line + circle) * vec4(uLineColor, 1.0) * rand;
      }

      // Restrict waves to vertical center band so they don't reach text areas
      float centerFade = smoothstep(0.0, 0.18, uv.y) * smoothstep(1.0, 0.82, uv.y);

      vec4 col = mix(vec4(0.0, 0.02, 0.07, 1.0), vec4(0.0, 0.04, 0.13, 1.0), uv.x);
      col *= vFade;
      col.a = 1.0;
      col += lines * centerFade * (0.6 + uGlow * 0.5);
      gl_FragColor = col;
    }
  `;

  function loadShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
    return shader;
  }

  const program = gl.createProgram();
  gl.attachShader(program, loadShader(gl, gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, loadShader(gl, gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  const attribPos    = gl.getAttribLocation(program, 'aVertexPosition');
  const uResolution  = gl.getUniformLocation(program, 'iResolution');
  const uTime        = gl.getUniformLocation(program, 'iTime');
  const uGlowLoc     = gl.getUniformLocation(program, 'uGlow');
  const uLineColorLoc= gl.getUniformLocation(program, 'uLineColor');
  window._shaderGlow = 0.0;
  // Default cyan line colour
  gl.useProgram(program);
  gl.uniform3fv(uLineColorLoc, [0.0, 0.72, 1.0]);
  window._shaderBg = { setColor(rgb) { gl.useProgram(program); gl.uniform3fv(uLineColorLoc, rgb); } };

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);
  resize();

  const t0 = Date.now();
  function render() {
    const t = (Date.now() - t0) / 1000;
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uGlowLoc, window._shaderGlow || 0.0);
    if (window._shaderLineColor) gl.uniform3fv(uLineColorLoc, window._shaderLineColor);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(attribPos, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(attribPos);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
})();
