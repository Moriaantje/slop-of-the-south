import * as THREE from "three"
import { noAO } from "game/Layers"

// Every piece of loose fire in the world is the same substance: a small sphere whose surface is displaced and
// coloured by three octaves of animated value noise in its own object space, so the flame churns and licks instead
// of pulsing. The noise is sampled through a domain warp (the noise offsets its own lookup), which is the standard
// trick for turning smooth blobs into flame; the result runs through a heat ramp and fades out at the rim, so the
// ball has no silhouette edge. The mesh is stretched along the direction of travel into a teardrop with a tail, and
// the whole thing is additive, so the bloom pass turns the core into a glow.
//
// One shared material and one shared geometry, because a fight can have a dozen of these in the air at once and a
// material each would be a program each. What varies per ball — its seed, how hot it burns, what colour it is, and
// which way the hot end points — is pushed into the shared uniforms from `onBeforeRender`, which Three.js calls on
// the object immediately before the draw that uses them. That is the documented order and it is what lets a wizard's
// orange bolt, a Chemelot dragon's blue-white shell and a patch of burning grass share one draw path.
//
// The noise itself is exported as a string so the dragon's breath can be built out of exactly the same field. Two
// shaders, one fire: when the cone and the ball overlap they read as one thing rather than two effects.
export const NOISE3 = /* glsl */`
  float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * noise3(p); p *= 2.09; a *= 0.5; } return v; }
`

// What each owner's fire looks like: the body colour and the dull colour its embers cool to. The lairs are told
// apart at a glance — a green witchfire falling on you means the ruins dragon has found you, and you fight it
// differently from the one that throws blue-white chemical shells.
export const FLAVOURS = {
  player:     { color: new THREE.Color(1.00, 0.45, 0.08), cool: new THREE.Color(0.35, 0.02, 0.00) },
  castle:     { color: new THREE.Color(1.00, 0.40, 0.05), cool: new THREE.Color(0.34, 0.03, 0.00) },
  ruins:      { color: new THREE.Color(0.55, 1.00, 0.30), cool: new THREE.Color(0.06, 0.24, 0.04) },
  stadium:    { color: new THREE.Color(1.00, 0.74, 0.16), cool: new THREE.Color(0.32, 0.12, 0.00) },
  industrial: { color: new THREE.Color(0.48, 0.74, 1.00), cool: new THREE.Color(0.04, 0.12, 0.30) },
}
export function flavour(name) { return FLAVOURS[name] ?? FLAVOURS.player }

const geometry = new THREE.IcosahedronGeometry(1, 3)
geometry.__shared = true

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 }, uSeed: { value: 0 }, uHeat: { value: 1 },
    uColor: { value: new THREE.Color(1, 0.45, 0.08) }, uCool: { value: new THREE.Color(0.35, 0.02, 0) },
    uAlong: { value: new THREE.Vector3(0, 0, 1) },
  },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  vertexShader: /* glsl */`
    uniform float uTime, uSeed;
    varying vec3 vPos; varying vec3 vN; varying vec3 vView;
    ${NOISE3}
    void main() {
      vPos = position;
      // the surface boils: displaced along the normal by noise drifting backwards down the tail
      float n = fbm3(position * 2.4 + vec3(0.0, 0.0, uTime * 2.2) + uSeed);
      vec3 p = position * (0.78 + 0.42 * n);
      vN = normalize(normalMatrix * normal);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vView = -mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uSeed, uHeat; uniform vec3 uColor, uCool, uAlong;
    varying vec3 vPos; varying vec3 vN; varying vec3 vView;
    ${NOISE3}
    void main() {
      vec3 q = vPos * 2.0 + uSeed;
      q.z += uTime * 2.6;                                            // the flame streams down the tail
      float warp = fbm3(q * 0.9);                                    // domain warp: noise moves its own lookup
      float n = fbm3(q + warp * 1.4);
      // uAlong points at the hot end: the nose of a flying ball, straight down for a fire sitting on the ground
      float along = clamp(dot(vPos, uAlong) * 0.5 + 0.5, 0.0, 1.0);
      float heat = clamp((n * 1.5 + along * 0.9 - 0.55) * uHeat, 0.0, 1.0);
      float rim = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vView))), 0.0, 1.0), 1.4);
      heat *= 1.0 - 0.55 * rim;                                      // the edge cools: no hard silhouette
      if (heat < 0.04) discard;
      // heat ramp: the ember colour → the body colour → yellow → white
      vec3 col = mix(uCool, uColor, smoothstep(0.0, 0.45, heat));
      col = mix(col, mix(uColor, vec3(1.0, 0.92, 0.6), 0.7), smoothstep(0.45, 0.75, heat));
      col = mix(col, vec3(1.0, 0.98, 0.92), smoothstep(0.78, 1.0, heat));
      gl_FragColor = vec4(col * (0.6 + 1.9 * heat), clamp(heat * 1.5, 0.0, 1.0));
    }`,
})
material.__shared = true

let seed = 0

// Three.js hands the object its own material here, right before the draw call that reads these uniforms, so every
// flame in the frame gets its own look out of one program. Bound to nothing: `this` is the mesh Three.js calls it on.
function pushFlameUniforms(_renderer, _scene, _camera, _geometry, mat) {
  const d = this.userData, u = mat.uniforms
  u.uSeed.value = d.seed
  u.uHeat.value = d.heat
  u.uColor.value.copy(d.color)
  u.uCool.value.copy(d.cool)
  u.uAlong.value.copy(d.along)
}

const NOSE = new THREE.Vector3(0, 0, 1), DOWN = new THREE.Vector3(0, -1, 0)

// a flame mesh; `along` says which local direction is the hot end. Additive and cut out, so it claims the alpha
// layer: the ambient-occlusion pre-pass would otherwise draw it as a solid box and hang a dark square off it.
export function makeFlame(radius, { heat = 1, kind = "player", along = NOSE } = {}) {
  const mesh = noAO(new THREE.Mesh(geometry, material))
  const f = flavour(kind)
  mesh.userData = { radius, seed: (seed = (seed + 7.13) % 100), heat, color: f.color, cool: f.cool, along }
  mesh.onBeforeRender = pushFlameUniforms
  mesh.renderOrder = 6
  mesh.frustumCulled = false
  mesh.scale.setScalar(radius)
  return mesh
}

// a fireball; place it and call aimFireball() with the velocity each frame
export function makeFireball(radius = 1.1, kind = "player") { return makeFlame(radius, { kind }) }

// a squat dome of flame for ground that is alight: the hot end points down, into the grass it is eating
export function makeGroundFire(radius, kind = "player") {
  const mesh = makeFlame(radius, { kind, heat: 0.85, along: DOWN })
  mesh.scale.set(radius, radius * 0.6, radius)
  return mesh
}

// point the teardrop down its flight path and stretch it into a tail
export function aimFireball(mesh, vx, vy, vz) {
  const r = mesh.userData.radius
  const len = Math.hypot(vx, vy, vz)
  if (len > 0.001) mesh.lookAt(mesh.position.x - vx / len, mesh.position.y - vy / len, mesh.position.z - vz / len)
  mesh.scale.set(r, r, r * 2.3)                    // local +z is the tail, since we look the other way
}

// once per frame for every flame on screen
export function tickFireballs(dt) { material.uniforms.uTime.value += dt }
export const fireballMaterial = material
