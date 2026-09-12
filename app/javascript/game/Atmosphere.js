import * as THREE from "three"
import { TUNING as T } from "game/Tuning"

// Two atmospheric cheats that cost one draw call each and do more for depth than any amount of geometry.
//
// Sun shafts: a screen-space radial glow around the visible sun disc, drawn on a full-screen quad after the world
// with additive blending, masked by how much of the screen the sun is on and how low it sits. The real technique
// (Mitchell, GPU Gems 3, 2007) blurs the framebuffer radially along the light vector; this is the cheap sibling, a
// smooth radial falloff broken up by angular noise so it reads as light raking through haze rather than as a lens
// flare. It is centred on env.discDir, the flattened arc the sun sprite rides, not on the true sun direction, so
// the rays actually come out of the disc the player can see. Because it is drawn inside the render pass rather than
// after it, the bloom pass picks it up and softens it, which is most of what sells the effect.
//
// Ground mist: three horizontal sheets that sit at a fixed altitude, not at a fixed height above the player. That is
// the whole point. Limburg runs from about 50 m NAP in the valleys near the spawn to 113 m on the plateaus, so a
// sheet parked on the valley floor drowns the low ground and leaves the hills standing out of it, and from a hilltop
// you look down on a valley full of haze, which is the one view that tells you the terrain is real. Sheets that
// follow the camera's own height can never do that, however thick you make them, because they are always at your
// feet. The altitude cannot be a hard-coded height above sea level either, because the province's floor varies by
// sixty metres; instead the ground height under the player is rounded to MIST_STEP, so the sheets hold still while
// you drive along a valley and only step when the land genuinely changes level.
//
// The sheets only supply visible, moving volume near the player. The part that actually makes distance read is the
// exponential height fog in HeightFog.js, which modulates the scene fog per fragment by world altitude and so
// applies to every material at every range for the price of one exp().
const SHAFT_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.999, 1.0); }`     // fixed to the near plane, behind nothing
const SHAFT_FRAG = /* glsl */`
  uniform vec2 uSun; uniform float uStrength, uAspect, uTime;
  uniform vec3 uColor;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
    float r = length(d);
    float core = exp(-r * 6.0) * 1.1;                             // the haze glow hugging the disc
    float ang = atan(d.y, d.x);
    // Rays: three octaves of noise in the angle, each drifting at its own rate so the fan breathes instead of
    // spinning, and each with its own reach so the long ones read as shafts and the short ones as glare.
    float n1 = noise(vec2(ang * 2.0, uTime * 0.035));
    float n2 = noise(vec2(ang * 6.0 + 4.0, uTime * 0.055));
    float n3 = noise(vec2(ang * 17.0 + 11.0, uTime * 0.08));
    float longRays = smoothstep(0.40, 0.95, n1 * 0.65 + n2 * 0.35) * exp(-r * 1.15);
    float fineRays = smoothstep(0.55, 1.00, n2 * 0.5 + n3 * 0.5) * exp(-r * 2.6);
    // the beam has to leave the disc before it can be seen: nothing inside the first few per cent of the radius
    float out_ = smoothstep(0.0, 0.10, r);
    gl_FragColor = vec4(uColor * (core + (longRays * 0.85 + fineRays * 0.5) * out_) * uStrength, 1.0);
  }`

const MIST_LEVELS = [3, 10, 18]         // m above the valley floor near the player, quantised (see below)
const MIST_STEP = 25                    // m: the floor is rounded to this, so the sheets stay put while you drive
                                        // along a valley and only step when the land really changes level
const MIST_SIZE = 3400                  // m: wide enough to reach the fog wall in every direction
const MIST_FADE_EYE = 7                 // m: a sheet within this of eye height is invisible, or it shows as a hard line
const MIST_NEAR = 22, MIST_FULL = 110   // m: nothing right on top of the camera, full strength by here
const MIST_FAR_IN = 900, MIST_FAR_OUT = 1700   // m: the sheets hand over to the scene's height fog across this band
const MIST_SCALE = 1 / 260              // world metres → noise uv: wisps a couple of hundred metres across
const MIST_WIND = 0.9                   // m/s the wisps drift

export class Atmosphere {
  constructor(world) {
    this.world = world
    this.shaft = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { uSun: { value: new THREE.Vector2(0.5, 0.5) }, uStrength: { value: 0 }, uAspect: { value: 1 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(1, 0.85, 0.6) } },
      vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false,
    }))
    this.shaft.renderOrder = 999
    this.shaft.frustumCulled = false
    this.shaft.visible = false
    world.scene.add(this.shaft)

    // the mist sheets: one shared material, three planes at fixed altitudes. The noise is keyed to world position,
    // so the wisps stay put over the ground instead of sliding along with the car.
    this.mistMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0 }, uColor: { value: new THREE.Color(0.82, 0.86, 0.92) } },
      vertexShader: /* glsl */`
        varying vec2 vWorld; varying float vDist; varying float vY;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xz;
          vDist = length(wp.xz - cameraPosition.xz);
          vY = wp.y - cameraPosition.y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uStrength; uniform vec3 uColor;
        varying vec2 vWorld; varying float vDist; varying float vY;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          vec2 uv = vWorld * ${MIST_SCALE.toFixed(8)};
          vec2 drift = vec2(uTime * ${(MIST_WIND * MIST_SCALE).toFixed(8)}, uTime * ${(MIST_WIND * MIST_SCALE * 0.4).toFixed(8)});
          float n = noise(uv + drift) * 0.62 + noise(uv * 2.7 - drift * 1.9) * 0.38;
          float body = smoothstep(0.40, 0.84, n);
          float near = smoothstep(${MIST_NEAR}.0, ${MIST_FULL}.0, vDist);
          float far = 1.0 - smoothstep(${MIST_FAR_IN}.0, ${MIST_FAR_OUT}.0, vDist);
          // a sheet crossing eye height would draw a knife edge across the screen: fade it out as it passes through
          float eye = smoothstep(0.0, ${MIST_FADE_EYE}.0, abs(vY));
          // and it is far denser looked down through than looked up at, because that is the longer path. The
          // edges of every smoothstep here go low to high: GLSL leaves a reversed pair undefined.
          float above = mix(1.0, 0.55, smoothstep(-8.0, 2.0, vY));
          gl_FragColor = vec4(uColor, body * near * far * eye * above * uStrength);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    })
    this.mist = new THREE.Group()
    for (let i = 0; i < MIST_LEVELS.length; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(MIST_SIZE, MIST_SIZE, 1, 1), this.mistMat)
      p.rotation.x = -Math.PI / 2
      p.position.y = MIST_LEVELS[i]                       // update() slides the group up to the valley floor
      p.renderOrder = 7
      p.frustumCulled = false
      this.mist.add(p)
    }
    this.mist.visible = false
    world.scene.add(this.mist)
    this._v = new THREE.Vector3()
    this._white = new THREE.Color(1, 1, 1)
  }

  // env: DayNight.env; groundY: the terrain height under the player (kept in the signature for callers)
  update(dt, camera, env, groundY) {
    const t = performance.now() * 0.001
    // ---- shafts: project the visible disc into screen space; only when it is in front of the camera and low
    const u = this.shaft.material.uniforms
    this._v.copy(env.discDir ?? env.sunDir).multiplyScalar(1000).add(camera.position)
    this._v.project(camera)
    const elev = env.sunElev ?? env.sunDir.y        // the true elevation: sunDir swings to the moon after sunset
    const facing = this._v.z < 1 && Math.abs(this._v.x) < 1.6 && Math.abs(this._v.y) < 1.6
    const low = 1 - THREE.MathUtils.smoothstep(elev, 0.12, 0.70)              // strongest near the horizon
    const strength = T.look.shafts * low * (1 - env.darkness) * (facing ? 1 : 0)
    this.shaft.visible = strength > 0.01
    if (this.shaft.visible) {
      u.uSun.value.set(this._v.x * 0.5 + 0.5, this._v.y * 0.5 + 0.5)
      u.uStrength.value = strength * (1 - 0.6 * Math.max(Math.abs(this._v.x), Math.abs(this._v.y)))
      u.uAspect.value = camera.aspect
      u.uTime.value = t
      u.uColor.value.copy(env.sunColor).multiplyScalar(0.45).addScalar(0.35)
    }
    // ---- mist: thickest in the hour around sunrise and sunset and through the night, thin at noon
    const dawn = 1 - THREE.MathUtils.smoothstep(Math.abs(elev), 0.03, 0.30)
    const m = this.mistMat.uniforms
    m.uStrength.value = T.look.mist * Math.min(0.16 + 0.62 * dawn + 0.30 * env.darkness, 1)
    m.uTime.value = t
    m.uColor.value.copy(env.horizon).lerp(this._white, 0.3 * (1 - env.darkness))
    this.mist.visible = m.uStrength.value > 0.02
    // the sheets follow in XZ, and in Y only in MIST_STEP jumps: a continuous follow would glue the haze to the car
    const floorY = Math.round((groundY ?? 0) / MIST_STEP) * MIST_STEP
    this.mist.position.set(camera.position.x, floorY, camera.position.z)
  }
}
