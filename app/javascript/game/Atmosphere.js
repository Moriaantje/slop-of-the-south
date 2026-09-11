import * as THREE from "three"
import { TUNING as T } from "game/Tuning"

// Two atmospheric cheats that cost one draw call each and do more for depth than any amount of geometry.
//
// Sun shafts: a screen-space radial glow around the sun's position, drawn on a full-screen quad after the world with
// additive blending, masked by how much of the screen the sun is on and how low it sits. The real technique (Mitchell
// 2007) blurs the framebuffer radially; this is the cheap sibling — a smooth radial falloff modulated by the same
// noise the clouds use, so it reads as light breaking through haze rather than a lens flare.
//
// Ground mist: three stacked horizontal sheets a few metres above the terrain that follow the player, fading with
// height and distance and scrolling slowly. Low ground fills with haze at dawn and dusk, which is what makes the
// Limburg valleys read as valleys instead of a tilted plane.
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
    float core = exp(-r * 5.0);                                   // the glow around the disc
    float ang = atan(d.y, d.x);
    // rays: noise in the angle, drifting, fading out with the radius
    float rays = noise(vec2(ang * 3.0, uTime * 0.05)) * 0.55 + noise(vec2(ang * 9.0 + 4.0, uTime * 0.09)) * 0.45;
    float shaft = smoothstep(0.35, 1.0, rays) * exp(-r * 1.6) * 0.8;
    gl_FragColor = vec4(uColor * (core * 1.2 + shaft) * uStrength, 1.0);
  }`

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

    // the mist sheets: one shared material, three planes at different heights and scroll speeds
    this.mistMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0 }, uColor: { value: new THREE.Color(0.82, 0.86, 0.92) }, uBase: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying float vDist; varying float vY;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vDist = length(wp.xz - cameraPosition.xz);
          vY = wp.y - cameraPosition.y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uStrength; uniform vec3 uColor;
        varying vec2 vUv; varying float vDist; varying float vY;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          float n = noise(vUv * 9.0 + vec2(uTime * 0.012, uTime * 0.008)) * 0.6 + noise(vUv * 21.0 - uTime * 0.02) * 0.4;
          float body = smoothstep(0.42, 0.85, n);
          float near = smoothstep(18.0, 90.0, vDist);                 // nothing right in front of the camera
          float far = 1.0 - smoothstep(700.0, 1400.0, vDist);
          float above = 1.0 - smoothstep(0.0, 14.0, vY);              // seen from above it thins out
          gl_FragColor = vec4(uColor, body * near * far * above * uStrength);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    })
    this.mist = new THREE.Group()
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000, 1, 1), this.mistMat)
      p.rotation.x = -Math.PI / 2
      p.position.y = 2 + i * 3.5
      p.renderOrder = 7
      p.frustumCulled = false
      this.mist.add(p)
    }
    this.mist.visible = false
    world.scene.add(this.mist)
    this._v = new THREE.Vector3()
  }

  // env: DayNight.env; groundY: the terrain height under the player
  update(dt, camera, env, groundY) {
    const t = performance.now() * 0.001
    // ---- shafts: project the sun into screen space; only when it is in front of the camera and low enough to matter
    const u = this.shaft.material.uniforms
    this._v.copy(env.sunDir).multiplyScalar(1000).add(camera.position)
    this._v.project(camera)
    const elev = env.sunDir.y
    const facing = this._v.z < 1 && Math.abs(this._v.x) < 1.6 && Math.abs(this._v.y) < 1.6
    const low = 1 - THREE.MathUtils.smoothstep(elev, 0.15, 0.75)              // strongest near the horizon
    const strength = T.look.shafts * low * (1 - env.darkness) * (facing ? 1 : 0)
    this.shaft.visible = strength > 0.01
    if (this.shaft.visible) {
      u.uSun.value.set(this._v.x * 0.5 + 0.5, this._v.y * 0.5 + 0.5)
      u.uStrength.value = strength * (1 - 0.6 * Math.max(Math.abs(this._v.x), Math.abs(this._v.y)))
      u.uAspect.value = camera.aspect
      u.uTime.value = t
      u.uColor.value.copy(env.sunColor).multiplyScalar(0.5).addScalar(0.4)
    }
    // ---- mist: thickest at dawn and dusk, hugging the low ground under the player
    const dawn = Math.max(0, 1 - Math.abs(elev) * 6) * (1 - env.darkness * 0.5)
    const m = this.mistMat.uniforms
    m.uStrength.value = T.look.mist * (0.15 + 0.85 * dawn)
    m.uTime.value = t
    m.uColor.value.copy(env.horizon).lerp(new THREE.Color(1, 1, 1), 0.35)
    this.mist.visible = m.uStrength.value > 0.02
    this.mist.position.set(camera.position.x, groundY, camera.position.z)
  }
}
