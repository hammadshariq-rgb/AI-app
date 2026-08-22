(function () {
  const THREE = window.THREE;
  if (!THREE) { console.error('[hills] THREE not loaded'); return; }

  const canvas = document.getElementById('hillSurface');
  if (!canvas) { console.error('[hills] no canvas'); return; }

  const DARK_R = 0.05, DARK_G = 0.28, DARK_B = 0.80;
  const LITE_R = 0.35, LITE_G = 0.35, LITE_B = 0.37;

  const uniforms = {
    time:   { value: 0.0 },
    uColor: { value: new THREE.Vector3(DARK_R, DARK_G, DARK_B) },
    uAlpha: { value: 0.72 },
  };

  const vertexShader = `
    attribute vec3 position;
    uniform mat4 projectionMatrix;
    uniform mat4 modelViewMatrix;
    uniform float time;
    varying vec3 vPosition;

    mat4 rotX(float r){
      return mat4(1.,0.,0.,0., 0.,cos(r),-sin(r),0., 0.,sin(r),cos(r),0., 0.,0.,0.,1.);
    }

    vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
    vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
    vec4 perm(vec4 x){return m289(((x*34.)+1.)*x);}
    vec4 tiSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
    vec3 fade(vec3 t){return t*t*t*(t*(t*6.-15.)+10.);}

    float cnoise(vec3 P){
      vec3 Pi0=floor(P),Pi1=Pi0+1.;
      Pi0=m289(Pi0); Pi1=m289(Pi1);
      vec3 Pf0=fract(P),Pf1=Pf0-1.;
      vec4 ix=vec4(Pi0.x,Pi1.x,Pi0.x,Pi1.x);
      vec4 iy=vec4(Pi0.yy,Pi1.yy);
      vec4 ixy=perm(perm(ix)+iy);
      vec4 ixy0=perm(ixy+Pi0.zzzz),ixy1=perm(ixy+Pi1.zzzz);
      vec4 gx0=ixy0*(1./7.),gy0=fract(floor(gx0)*(1./7.))-.5;
      gx0=fract(gx0);
      vec4 gz0=vec4(.5)-abs(gx0)-abs(gy0),sz0=step(gz0,vec4(0.));
      gx0-=sz0*(step(0.,gx0)-.5); gy0-=sz0*(step(0.,gy0)-.5);
      vec4 gx1=ixy1*(1./7.),gy1=fract(floor(gx1)*(1./7.))-.5;
      gx1=fract(gx1);
      vec4 gz1=vec4(.5)-abs(gx1)-abs(gy1),sz1=step(gz1,vec4(0.));
      gx1-=sz1*(step(0.,gx1)-.5); gy1-=sz1*(step(0.,gy1)-.5);
      vec3 g000=vec3(gx0.x,gy0.x,gz0.x),g100=vec3(gx0.y,gy0.y,gz0.y);
      vec3 g010=vec3(gx0.z,gy0.z,gz0.z),g110=vec3(gx0.w,gy0.w,gz0.w);
      vec3 g001=vec3(gx1.x,gy1.x,gz1.x),g101=vec3(gx1.y,gy1.y,gz1.y);
      vec3 g011=vec3(gx1.z,gy1.z,gz1.z),g111=vec3(gx1.w,gy1.w,gz1.w);
      vec4 n0=tiSqrt(vec4(dot(g000,g000),dot(g010,g010),dot(g100,g100),dot(g110,g110)));
      g000*=n0.x;g010*=n0.y;g100*=n0.z;g110*=n0.w;
      vec4 n1=tiSqrt(vec4(dot(g001,g001),dot(g011,g011),dot(g101,g101),dot(g111,g111)));
      g001*=n1.x;g011*=n1.y;g101*=n1.z;g111*=n1.w;
      float n000=dot(g000,Pf0),n100=dot(g100,vec3(Pf1.x,Pf0.yz));
      float n010=dot(g010,vec3(Pf0.x,Pf1.y,Pf0.z)),n110=dot(g110,vec3(Pf1.xy,Pf0.z));
      float n001=dot(g001,vec3(Pf0.xy,Pf1.z)),n101=dot(g101,vec3(Pf1.x,Pf0.y,Pf1.z));
      float n011=dot(g011,vec3(Pf0.x,Pf1.yz)),n111=dot(g111,Pf1);
      vec3 fxyz=fade(Pf0);
      vec4 nz=mix(vec4(n000,n100,n010,n110),vec4(n001,n101,n011,n111),fxyz.z);
      vec2 nyz=mix(nz.xy,nz.zw,fxyz.y);
      return 2.2*mix(nyz.x,nyz.y,fxyz.x);
    }

    void main(void){
      vec3 p=(rotX(radians(90.))*vec4(position,1.)).xyz;
      float s=sin(radians(p.x/128.*90.));
      vec3 np=p+vec3(0.,0.,time*-30.);
      float n1=cnoise(np*0.08),n2=cnoise(np*0.06),n3=cnoise(np*0.4);
      vec3 lp=p+vec3(0.,n1*s*8.+n2*s*8.+n3*(abs(s)*2.+.5)+pow(s,2.)*40.,0.);
      vPosition=lp;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(lp,1.);
    }
  `;

  const fragmentShader = `
    precision highp float;
    varying vec3 vPosition;
    uniform vec3 uColor;
    uniform float uAlpha;
    void main(void){
      float op=(96.-length(vPosition))/256.*0.65*uAlpha;
      gl_FragColor=vec4(uColor,max(op,0.));
    }
  `;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  camera.position.set(0, 16, 125);
  camera.lookAt(new THREE.Vector3(0, 28, 0));

  const mat = new THREE.RawShaderMaterial({ uniforms, vertexShader, fragmentShader, transparent: true });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(256, 256, 256, 256), mat);
  scene.add(mesh);

  let last = performance.now();

  function resize() {
    const W = window.innerWidth, H = window.innerHeight;
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    renderer.setSize(W, H);
  }

  function tick() {
    const now = performance.now();
    uniforms.time.value += (now - last) / 1000 * 0.5;
    last = now;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  let _customColor = null;

  function setTheme(isLight) {
    if (_customColor) {
      uniforms.uColor.value.set(_customColor[0], _customColor[1], _customColor[2]);
      uniforms.uAlpha.value = 0.72;
      return;
    }
    const r = isLight ? LITE_R : DARK_R;
    const g = isLight ? LITE_G : DARK_G;
    const b = isLight ? LITE_B : DARK_B;
    uniforms.uColor.value.set(r, g, b);
    uniforms.uAlpha.value = isLight ? 0.55 : 0.72;
  }

  function setColor(rgb) {
    _customColor = rgb;
    uniforms.uColor.value.set(rgb[0], rgb[1], rgb[2]);
    uniforms.uAlpha.value = 0.72;
  }

  window.addEventListener('resize', resize);
  resize();
  tick();

  // Show/hide on load based on current theme
  const isLight = document.body.classList.contains('light-mode');
  canvas.style.display = isLight ? '' : 'none';
  const dotCanvas = document.getElementById('dotSurface');
  if (dotCanvas) dotCanvas.style.display = isLight ? 'none' : '';
  setTheme(isLight);

  window._hills = { setTheme, setColor };
  console.log('[hills] running');
})();
