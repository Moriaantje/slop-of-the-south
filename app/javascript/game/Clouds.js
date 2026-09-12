import * as THREE from "three"

// The sky's weather, in one draw call. A cloud deck is the cheapest thing in a game that says "this is a real
// place": it gives the sky a scale, it parallaxes as you drive so the ground feels large, and it is the only part
// of the frame that moves while you stand still. Doing it with geometry (a volume, or stacked billboards) costs
// hundreds of draw calls and a ruinous amount of overdraw, so this is the flat-deck cheat instead: one shell around
// the camera, and for every pixel of sky the view ray is intersected analytically with two infinite horizontal
// planes — cumulus at 1500 m, cirrus at 7000 m. Because the intersection is done in world coordinates the clouds
// stay put over the landscape and slide past with proper perspective, and because it is one shell there is exactly
// one draw call no matter how much sky is on screen.
//
// The shell is a sphere cap rather than the old horizontal quad. A quad large enough to reach the horizon would run
// past the camera's far plane and be clipped; a cap inside the far plane cannot be, and the ray maths does not care
// what surface it was fired from. Fragments below the horizon are covered by terrain and die on the depth test.
//
// What makes the clouds read as clouds rather than as noise is the lighting, not the shape. Density comes from two
// taps of one tiling fbm texture; the alpha is Beer-Lambert on that density, which gives wispy edges for free; and
// the shading marches three more taps towards the sun and attenuates by Beer's law again, so a bank of cumulus
// shadows its own underside and the tops stay bright. A Henyey-Greenstein forward lobe adds the silver lining on
// the rims facing the sun, which is the detail the eye actually recognises. Eight texture reads per sky pixel, all
// from one 256 px canvas texture made once at load.
const CUMULUS_H = 1500, CIRRUS_H = 7000          // m above the player: the two decks
const CUMULUS_M = 1 / 7000                       // uv per metre on the cumulus deck (one tile ≈ 7 km)
const BREAK_M = 0.373                            // the second tap's scale, as a fraction of the first. A single
                                                 // tiling texture repeats visibly across a sky this wide, so the
                                                 // body is the product of two taps at an incommensurate ratio and a
                                                 // rotation between them: the pattern only truly repeats where both
                                                 // line up again, which is far past the horizon.
const CIRRUS_M = 1 / 9000                        // cirrus tiles far larger, as high thin sheets do
const CIRRUS_STRETCH = 0.22                      // squash across the wind: streaks, not blobs
const SHELL_R = 3300                             // m: inside the camera's far plane (4000)
const WIND_SPEED = 0.0016                        // uv per second: a tile drifts past in about ten minutes
const SHADOW_SPAN = 90                           // m: how far each self-shadow tap steps towards the sun. A cumulus
                                                 // blob here is about 870 m across, so the march has to stay well
                                                 // inside one to shadow it — a kilometre-long step lands in the next
                                                 // blob and reads as a second, unrelated noise field.
const ABSORB = 2.6                               // Beer coefficient for the self-shadow
const DENSITY = 14.0                             // Beer coefficient for the alpha: higher is a harder edge
const COVER_MIN = 0.30, COVER_MAX = 0.66         // the weather wanders between these over WEATHER_PERIOD
const WEATHER_PERIOD = 900                       // s of wall clock: everyone shares the same sky
const NOISE_N = 256

// One tiling RGBA noise: R the cumulus body, G a finer octave that erodes it, B the cirrus. Three bands of value
// noise summed per channel, each octave on its own periodic lattice so the texture wraps without a seam, and each
// channel stretched to the full 0..1 range so the coverage threshold means the same thing in all of them.
function noiseTexture() {
  const n = NOISE_N, c = document.createElement("canvas"); c.width = c.height = n
  const ctx = c.getContext("2d"), img = ctx.createImageData(n, n), d = img.data
  let s = 777
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const grid = (m) => { const g = new Float32Array(m * m); for (let i = 0; i < m * m; i++) g[i] = rnd(); return g }
  const sample = (g, m, x, y) => {
    const fx = x * m, fy = y * m, x0 = Math.floor(fx) % m, y0 = Math.floor(fy) % m, x1 = (x0 + 1) % m, y1 = (y0 + 1) % m
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy), sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    const a = g[y0 * m + x0], b = g[y0 * m + x1], cc = g[y1 * m + x0], dd = g[y1 * m + x1]
    return (a + (b - a) * sx) * (1 - sy) + (cc + (dd - cc) * sx) * sy
  }
  const bands = [
    [[3, 0.55], [6, 0.30], [12, 0.15], [24, 0.08]],      // R: the body
    [[10, 0.45], [20, 0.32], [40, 0.23]],                // G: erosion
    [[5, 0.5], [11, 0.3], [23, 0.2]],                    // B: cirrus
  ].map((band) => band.map(([m, w]) => [m, grid(m), w]))
  for (let ch = 0; ch < 3; ch++) {
    const buf = new Float32Array(n * n)
    let lo = Infinity, hi = -Infinity
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let v = 0
      for (const [m, g, w] of bands[ch]) v += w * sample(g, m, x / n, y / n)
      buf[y * n + x] = v
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    const k = 255 / Math.max(hi - lo, 1e-6)
    for (let i = 0; i < n * n; i++) d[i * 4 + ch] = Math.round((buf[i] - lo) * k)
  }
  for (let i = 0; i < n * n; i++) d[i * 4 + 3] = 255
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

const CLOUD_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`

const CLOUD_FRAG = /* glsl */`
  uniform sampler2D uNoise;
  uniform vec2 uDrift, uWind, uSunStep;
  uniform vec3 uSunCol, uSkyCol, uHazeCol, uSunDir;
  uniform float uCover, uCirrus, uDark;
  varying vec3 vDir;

  // the world XZ where this view ray meets a deck h metres above the camera
  vec2 deck(vec3 d, float h) { return cameraPosition.xz + d.xz * (h / max(d.y, 0.02)); }

  // the rotation that puts the second tap off the first one's grid (about 31 degrees)
  const mat2 BREAK_ROT = mat2(0.857, -0.515, 0.515, 0.857);
  float body(vec2 uv) {
    float a = texture2D(uNoise, uv).r;
    float b = texture2D(uNoise, BREAK_ROT * uv * ${BREAK_M.toFixed(4)} + vec2(0.21, 0.63)).r;
    float erode = texture2D(uNoise, uv * 3.1 + vec2(0.37, 0.13)).g;
    return (a * 0.62 + b * 0.55) * 0.86 + erode * 0.26;
  }
  // the shadow march only needs to know where the blobs are, not their eroded edges: two taps instead of three
  float bodyLite(vec2 uv) {
    float a = texture2D(uNoise, uv).r;
    float b = texture2D(uNoise, BREAK_ROT * uv * ${BREAK_M.toFixed(4)} + vec2(0.21, 0.63)).r;
    return (a * 0.62 + b * 0.55) * 0.86 + 0.13;
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = smoothstep(0.020, 0.13, d.y);                 // the deck thins away into the haze at the horizon
    if (up <= 0.001) discard;

    // ---- cumulus: density, Beer-Lambert alpha, three taps of self-shadow towards the sun
    vec2 uv = deck(d, ${CUMULUS_H}.0) * ${CUMULUS_M.toFixed(8)} + uDrift;
    float thr = mix(0.74, 0.28, uCover);
    float dens = max(body(uv) - thr, 0.0);
    float alpha = 1.0 - exp(-dens * ${DENSITY.toFixed(1)});
    // the self-shadow marches the same field, not just its first octave, or the shadow lands on the wrong blobs
    float occ = max(bodyLite(uv + uSunStep) * 0.95 - thr, 0.0)
              + max(bodyLite(uv + uSunStep * 2.3) * 0.95 - thr, 0.0) * 0.7
              + max(bodyLite(uv + uSunStep * 4.2) * 0.95 - thr, 0.0) * 0.4;
    float beer = exp(-occ * ${ABSORB.toFixed(1)});
    // Henyey-Greenstein, g = 0.72: the rim between cloud and sky glows when you look through it at the sun. The
    // lobe runs to twenty-odd at zero scattering angle, which would be a white hole, so it is clamped as three's
    // own Sky does.
    float ct = dot(d, uSunDir);
    float hg = clamp(0.4816 / pow(max(1.5184 - 1.44 * ct, 0.02), 1.5), 0.0, 3.0);
    float rim = alpha * (1.0 - alpha) * 4.0;
    vec3 cumCol = mix(uSkyCol * 0.65, uSunCol, 0.25 + 0.75 * beer) + uSunCol * hg * rim * 0.22;

    // ---- cirrus: the same field read on a far larger, wind-stretched scale, seven kilometres up
    vec2 cp = deck(d, ${CIRRUS_H}.0);
    vec2 w = uWind, perp = vec2(-uWind.y, uWind.x);
    vec2 cuv = vec2(dot(cp, w) * ${CIRRUS_STRETCH.toFixed(2)}, dot(cp, perp)) * ${CIRRUS_M.toFixed(8)} + uDrift * 0.35;
    float cir = smoothstep(0.48, 0.92, texture2D(uNoise, cuv).b) * uCirrus;
    vec3 cirCol = mix(uSkyCol, uSunCol, clamp(0.5 + 0.14 * hg, 0.0, 1.0)) * 1.05;

    // ---- composite, cirrus behind cumulus, both dissolving into the horizon haze
    vec3 pre = cirCol * cir;
    float a = cir;
    pre = cumCol * alpha + pre * (1.0 - alpha);
    a = alpha + a * (1.0 - alpha);
    vec3 col = pre / max(a, 0.001);
    col = mix(uHazeCol, col, smoothstep(0.02, 0.40, d.y));
    col = mix(col, col * vec3(0.18, 0.21, 0.30), uDark);
    gl_FragColor = vec4(col, a * up * 0.94);
  }`

export class Clouds {
  constructor(scene) {
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.BackSide,
      uniforms: {
        uNoise: { value: noiseTexture() },
        uDrift: { value: new THREE.Vector2() },              // how far the deck has blown, in uv
        uWind: { value: new THREE.Vector2(0.92, 0.39) },     // unit: west-south-west, the prevailing Dutch wind
        uSunStep: { value: new THREE.Vector2() },            // uv offset per self-shadow step, towards the sun
        uSunCol: { value: new THREE.Color(1, 1, 1) },
        uSkyCol: { value: new THREE.Color(0.6, 0.72, 0.9) },
        uHazeCol: { value: new THREE.Color(0.8, 0.85, 0.9) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uCover: { value: 0.5 }, uCirrus: { value: 0.35 }, uDark: { value: 0 },
      },
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
    })
    // an upper cap, not a whole sphere: the lower half would only ever be discarded or hidden by terrain
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SHELL_R, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), this.material)
    this.mesh.renderOrder = -5
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
    this._t = 0
    this._sun = new THREE.Vector3()
  }

  // env: DayNight.env (darkness, sunColor, discDir, sunElev, zenith, horizon); the shell rides with the camera
  update(dt, camera, env) {
    this._t += dt
    const u = this.material.uniforms
    const w = u.uWind.value
    u.uDrift.value.set(w.x * this._t * WIND_SPEED, w.y * this._t * WIND_SPEED)
    u.uCover.value = weatherCover(Date.now() / 1000)
    u.uCirrus.value = 0.22 + 0.28 * (1 - u.uCover.value)      // clear days are the ones with high cirrus on them
    u.uDark.value = env.darkness
    u.uSunDir.value.copy(env.discDir ?? env.sunDir)          // the silver lining has to ring the disc the player sees
    u.uSunCol.value.copy(env.sunColor).multiplyScalar(0.5).addScalar(0.5 * (1 - env.darkness))
    u.uSkyCol.value.copy(env.zenith).lerp(env.horizon, 0.45).multiplyScalar(1.35)
    u.uHazeCol.value.copy(env.horizon)
    // The self-shadow march walks towards the sun across the deck: a low sun means a long, raking offset. It takes
    // the disc's compass bearing but the sun's TRUE elevation, because the flattened arc the disc rides would have
    // a midday sky throwing the long shadows of a five-o'clock one.
    this._sun.set(u.uSunDir.value.x, env.sunElev ?? env.sunDir.y, u.uSunDir.value.z)
    u.uSunStep.value.copy(sunStep(this._sun))
    this.mesh.position.copy(camera.position)
  }
}

// Coverage on the wall clock, so every player is under the same sky. A sine is enough: the point is that the
// weather is somewhere different when you come back, not that it is meteorologically honest.
export function weatherCover(seconds) {
  const t = (Math.sin(seconds * (2 * Math.PI / WEATHER_PERIOD)) * 0.5 + 0.5)
  return COVER_MIN + (COVER_MAX - COVER_MIN) * t
}

// uv offset for one self-shadow step, given the sun direction. Straight down when the sun is overhead (no offset,
// so a cloud shadows only itself), raking out across the deck as it drops; clamped so a sun on the horizon does not
// send the march off into an unrelated tile.
const _step = new THREE.Vector2()
export function sunStep(sunDir) {
  const len = Math.hypot(sunDir.x, sunDir.z)
  if (len < 1e-5) return _step.set(0, 0)
  const reach = Math.min(SHADOW_SPAN / Math.max(sunDir.y, 0.18), SHADOW_SPAN * 4) * CUMULUS_M
  return _step.set((sunDir.x / len) * reach, (sunDir.z / len) * reach)
}
