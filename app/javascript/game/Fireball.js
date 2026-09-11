import * as THREE from "three"

// The fireball, as a shader rather than a sprite trail: a small sphere whose surface is displaced and coloured by
// three octaves of animated value noise in its own object space, so the flame churns and licks instead of pulsing.
// The noise is sampled through a domain warp (the noise offsets its own lookup), which is the standard trick for
// turning smooth blobs into flame; the result runs through a heat ramp (white core, yellow, orange, deep red) and
// fades out at the rim, so the ball has no silhouette edge. The mesh is stretched along the direction of travel
// into a teardrop with a tail, and the whole thing is additive, so the bloom pass turns the core into a glow.
// One shared material with one time uniform: any number of fireballs cost one small draw call each.
const geometry = new THREE.IcosahedronGeometry(1, 3)
geometry.__shared = true

const material = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uSeed: { value: 0 }, uHeat: { value: 1 }, uColor: { value: new THREE.Color(1, 0.45, 0.08) } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  vertexShader: /* glsl */`
    uniform float uTime, uSeed;
    varying vec3 vPos; varying vec3 vN; varying vec3 vView;
    // value noise in three dimensions, and the fbm the flame is made of
    float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float noise(vec3 p) {
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; } return v; }
    void main() {
      vPos = position;
      // the surface boils: displaced along the normal by noise drifting backwards down the tail
      float n = fbm(position * 2.4 + vec3(0.0, 0.0, uTime * 2.2) + uSeed);
      vec3 p = position * (0.78 + 0.42 * n);
      vN = normalize(normalMatrix * normal);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vView = -mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uSeed, uHeat; uniform vec3 uColor;
    varying vec3 vPos; varying vec3 vN; varying vec3 vView;
    float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float noise(vec3 p) {
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * noise(p); p *= 2.11; a *= 0.5; } return v; }
    void main() {
      vec3 q = vPos * 2.0 + uSeed;
      q.z += uTime * 2.6;                                            // the flame streams down the tail
      float warp = fbm(q * 0.9);                                     // domain warp: noise moves its own lookup
      float n = fbm(q + warp * 1.4);
      // the tail (negative z after the mesh is turned into the direction of travel) is cooler and more broken up
      float along = clamp(vPos.z * 0.5 + 0.5, 0.0, 1.0);
      float heat = clamp((n * 1.5 + along * 0.9 - 0.55) * uHeat, 0.0, 1.0);
      float rim = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vView))), 0.0, 1.0), 1.4);
      heat *= 1.0 - 0.55 * rim;                                      // the edge cools: no hard silhouette
      if (heat < 0.04) discard;
      // heat ramp: deep red → orange → yellow → white
      vec3 col = mix(vec3(0.35, 0.02, 0.0), uColor, smoothstep(0.0, 0.45, heat));
      col = mix(col, vec3(1.0, 0.88, 0.45), smoothstep(0.45, 0.75, heat));
      col = mix(col, vec3(1.0, 0.98, 0.92), smoothstep(0.78, 1.0, heat));
      gl_FragColor = vec4(col * (0.6 + 1.9 * heat), clamp(heat * 1.5, 0.0, 1.0));
    }`,
})
material.__shared = true

let seed = 0

// a fireball mesh; place it and call aim() with the velocity each frame
export function makeFireball(radius = 1.1) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.userData.radius = radius
  mesh.userData.seed = (seed = (seed + 7.13) % 100)
  mesh.renderOrder = 6
  mesh.frustumCulled = false
  return mesh
}

// point the teardrop down its flight path and stretch it into a tail
export function aimFireball(mesh, vx, vy, vz) {
  const r = mesh.userData.radius
  const len = Math.hypot(vx, vy, vz)
  if (len > 0.001) mesh.lookAt(mesh.position.x - vx / len, mesh.position.y - vy / len, mesh.position.z - vz / len)
  mesh.scale.set(r, r, r * 2.3)                    // local +z is the tail, since we look the other way
}

// once per frame for every fireball on screen
export function tickFireballs(dt) { material.uniforms.uTime.value += dt }
export const fireballMaterial = material
