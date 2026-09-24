// Home page hero: an interactive 3D globe showing Lionheart's trade routes
// (China -> Dubai -> West Africa) with cargo moving along the lanes.
import * as THREE from '/vendor/three/three.module.js';

const mount = document.getElementById('hero-globe');
const gsap = window.gsap;

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

if (mount && webglAvailable()) init();

function init() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const GOLD = new THREE.Color('#e0b93a');
  const NAVY = new THREE.Color('#3f74a8'); // shader output is linear, so this renders as a deep navy
  const R = 2;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0.35, 7.4);

  const world = new THREE.Group(); // tilt/parallax
  const globe = new THREE.Group(); // spins
  world.add(globe);
  scene.add(world);

  // --- Globe body with a soft fresnel rim ---
  const bodyMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uColor: { value: NAVY }, uRim: { value: GOLD }, uOpacity: { value: 1 } },
    vertexShader: `
      varying vec3 vNormal; varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform vec3 uRim; uniform float uOpacity;
      varying vec3 vNormal; varying vec3 vView;
      void main() {
        float f = pow(1.0 - max(dot(vNormal, vView), 0.0), 3.0);
        vec3 col = mix(uColor * 0.95, uRim, f * 0.45);
        gl_FragColor = vec4(col, (0.92 + f * 0.08) * uOpacity);
      }`,
  });
  globe.add(new THREE.Mesh(new THREE.SphereGeometry(R, 64, 64), bodyMat));

  // Outer atmosphere glow
  const glowMat = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: { uColor: { value: GOLD }, uOpacity: { value: 1 } },
    vertexShader: `
      varying vec3 vNormal;
      void main() { vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity; varying vec3 vNormal;
      void main() { float i = pow(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0); gl_FragColor = vec4(uColor, clamp(i, 0.0, 1.0) * 0.5 * uOpacity); }`,
  });
  const glow = new THREE.Mesh(new THREE.SphereGeometry(R * 1.14, 48, 48), glowMat);
  world.add(glow);

  // --- Dotted surface (fibonacci sphere) ---
  const DOTS = 2600;
  const dotPos = new Float32Array(DOTS * 3);
  for (let i = 0; i < DOTS; i++) {
    const y = 1 - (i / (DOTS - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = i * Math.PI * (3 - Math.sqrt(5));
    dotPos.set([Math.cos(t) * r * R * 1.005, y * R * 1.005, Math.sin(t) * r * R * 1.005], i * 3);
  }
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.BufferAttribute(dotPos, 3));
  const dotMat = new THREE.PointsMaterial({ color: 0xb8cbe0, size: 0.026, transparent: true, opacity: 0.7, depthWrite: false });
  globe.add(new THREE.Points(dotGeo, dotMat));

  // Latitude / longitude rings
  const ringMat = new THREE.LineBasicMaterial({ color: 0x3a5a7e, transparent: true, opacity: 0.35 });
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = [];
    for (let lon = 0; lon <= 360; lon += 4) pts.push(toVec(lat, lon, R * 1.002));
    globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
  }
  for (let lon = 0; lon < 180; lon += 30) {
    const pts = [];
    for (let lat = -90; lat <= 270; lat += 4) pts.push(toVec(lat, lon, R * 1.002));
    globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
  }

  function toVec(lat, lon, radius = R) {
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon + 180);
    return new THREE.Vector3(-radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
  }

  // --- Hubs & routes ---
  const HUBS = {
    guangzhou: [23.13, 113.26],
    yiwu: [29.31, 120.07],
    dubai: [25.2, 55.27],
    monrovia: [6.3, -10.8],
    lagos: [6.52, 3.38],
    accra: [5.6, -0.19],
    freetown: [8.48, -13.23],
    mombasa: [-4.04, 39.67],
  };
  const MAIN = ['guangzhou', 'dubai', 'monrovia'];
  const ROUTES = [
    ['guangzhou', 'dubai', 1],
    ['dubai', 'monrovia', 1],
    ['guangzhou', 'monrovia', 0.55],
    ['yiwu', 'dubai', 0.5],
    ['dubai', 'lagos', 0.5],
    ['dubai', 'accra', 0.5],
    ['guangzhou', 'mombasa', 0.5],
    ['dubai', 'freetown', 0.45],
  ];

  const markers = [];
  const pulseGeo = new THREE.RingGeometry(0.05, 0.065, 40);
  Object.entries(HUBS).forEach(([key, [lat, lon]]) => {
    const main = MAIN.includes(key);
    const pos = toVec(lat, lon, R * 1.01);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(main ? 0.045 : 0.028, 16, 16), new THREE.MeshBasicMaterial({ color: main ? GOLD : 0xffffff }));
    dot.position.copy(pos);
    globe.add(dot);
    const ring = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: main ? 0.9 : 0.5, side: THREE.DoubleSide, depthWrite: false }));
    ring.position.copy(pos);
    ring.lookAt(pos.clone().multiplyScalar(2));
    ring.userData.phase = Math.random();
    ring.userData.scale = main ? 1.4 : 0.8;
    globe.add(ring);
    markers.push(ring);
  });

  const routes = [];
  const SEGMENTS = 120;
  ROUTES.forEach(([a, b, weight]) => {
    const start = toVec(...HUBS[a]);
    const end = toVec(...HUBS[b]);
    const dist = start.distanceTo(end);
    const mid = start.clone().add(end).multiplyScalar(0.5).normalize().multiplyScalar(R + dist * 0.42);
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(SEGMENTS));
    geo.setDrawRange(0, reduceMotion ? SEGMENTS + 1 : 0);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.35 + weight * 0.5 }));
    globe.add(line);

    // Cargo pulses travelling along the route
    const cargo = [];
    const count = weight >= 1 ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(weight >= 1 ? 0.032 : 0.022, 12, 12), new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0 }));
      m.userData.t = i / count;
      globe.add(m);
      cargo.push(m);
    }
    routes.push({ geo, curve, cargo, speed: 0.05 + weight * 0.03, drawn: { v: reduceMotion ? 1 : 0 } });
  });

  // --- Background star dust ---
  const STARS = 700;
  const starPos = new Float32Array(STARS * 3);
  for (let i = 0; i < STARS; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(9 + Math.random() * 10);
    starPos.set([v.x, v.y, v.z - 6], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xc9d4e2, size: 0.03, transparent: true, opacity: 0.6, depthWrite: false }));
  scene.add(stars);

  // Face the globe towards the China -> Africa corridor
  // A rotation of -(lon + 90) degrees brings that longitude to the front.
  globe.rotation.y = THREE.MathUtils.degToRad(-(50 + 90));
  world.rotation.x = 0.28;
  world.rotation.z = -0.08;
  const baseRotY = globe.rotation.y;
  const spin = { v: 0 };

  // --- Sizing ---
  function resize() {
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w / h < 0.9 ? 8.6 : 7.4;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(mount);
  resize();

  // --- Pointer parallax ---
  const target = { x: 0, y: 0 };
  if (!reduceMotion) {
    window.addEventListener('pointermove', (e) => {
      target.x = (e.clientX / window.innerWidth - 0.5) * 2;
      target.y = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });
  }

  // --- Intro animation ---
  if (gsap && !reduceMotion) {
    world.scale.setScalar(0.7);
    bodyMat.uniforms.uOpacity.value = 0;
    glowMat.uniforms.uOpacity.value = 0;
    dotMat.opacity = 0;
    const tl = gsap.timeline({ delay: 0.15 });
    tl.to(world.scale, { x: 1, y: 1, z: 1, duration: 1.8, ease: 'expo.out' }, 0)
      .to(bodyMat.uniforms.uOpacity, { value: 1, duration: 1.2, ease: 'power2.out' }, 0)
      .to(glowMat.uniforms.uOpacity, { value: 1, duration: 1.6, ease: 'power2.out' }, 0.3)
      .to(dotMat, { opacity: 0.7, duration: 1.4 }, 0.2)
      .from(spin, { v: -1.4, duration: 2.6, ease: 'expo.out' }, 0);
    routes.forEach((r, i) => {
      tl.to(r.drawn, { v: 1, duration: 1.3, ease: 'power2.inOut', onUpdate: () => r.geo.setDrawRange(0, Math.floor(r.drawn.v * (SEGMENTS + 1))) }, 0.8 + i * 0.15);
    });
  }

  // --- Render loop (paused when off-screen) ---
  const clock = new THREE.Clock();
  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(mount);

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    if (!reduceMotion) {
      // Sway around the trade corridor instead of spinning it out of view.
      globe.rotation.y = baseRotY + spin.v + Math.sin(t * 0.12) * 0.35;
      world.rotation.x += (0.28 + target.y * 0.12 - world.rotation.x) * 0.04;
      world.rotation.y += (target.x * 0.25 - world.rotation.y) * 0.04;
      stars.rotation.y = t * 0.01;

      markers.forEach((m) => {
        const p = (t * 0.6 + m.userData.phase) % 1;
        m.scale.setScalar(1 + p * 1.3 * m.userData.scale);
        m.material.opacity = (1 - p) * 0.9;
      });

      routes.forEach((r) => {
        r.cargo.forEach((c) => {
          if (r.drawn.v < 1) return;
          c.userData.t = (c.userData.t + dt * r.speed) % 1;
          c.position.copy(r.curve.getPoint(c.userData.t));
          c.material.opacity = Math.sin(c.userData.t * Math.PI);
        });
      });
    }
    renderer.render(scene, camera);
  }

  if (reduceMotion) {
    frame();
    new ResizeObserver(() => frame()).observe(mount);
  } else {
    renderer.setAnimationLoop(() => { if (visible) frame(); });
  }
  mount.classList.add('is-ready');
}
