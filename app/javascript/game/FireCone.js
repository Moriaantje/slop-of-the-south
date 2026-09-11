import * as THREE from "three"

// A dragon's breath: an animated cone of fire from the mouth forward, the FlameWall shader folded around a cone.
// One shared material (time uniform), one shared geometry: the cone points down -z from its apex at the origin so
// it can be parented to the head and aimed by the parent. `set(on, dt)` fades it in and out.
const LENGTH = 60, RADIUS = 8
const geo = (() => {
  const g = new THREE.ConeGeometry(RADIUS, LENGTH, 24, 6, true)
  g.rotateX(-Math.PI / 2)                    // axis along -z … the cone's apex was at +y
  g.translate(0, 0, -LENGTH / 2)             // apex at the origin, base 40 m ahead
  g.__shared = true
  return g
})()
const material = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  uniforms: { time: { value: 0 }, strength: { value: 0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float time, strength;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; } return v; }
    void main() {
      // vUv.x runs around the cone, vUv.y from the base (0, far) to the apex (1, the mouth)
      float along = 1.0 - vUv.y;                                                   // 0 at the mouth, 1 at the far end
      float n = fbm(vec2(vUv.x * 6.0, along * 4.0 - time * 3.5));
      float n2 = fbm(vec2(vUv.x * 14.0 + 3.0, along * 9.0 - time * 6.0));
      float flame = smoothstep(0.15, 0.9, (n * 0.8 + n2 * 0.5) - along * 0.6 + 0.2);
      vec3 color = mix(vec3(0.9, 0.15, 0.0), vec3(1.0, 0.6, 0.08), flame);
      color = mix(color, vec3(1.0, 0.95, 0.5), pow(flame, 3.0) * (1.0 - along));
      float alpha = clamp(flame * (1.1 - along * 0.9) + 0.15 * (1.0 - along), 0.0, 0.95) * strength;
      gl_FragColor = vec4(color * strength, alpha);
    }`
})
material.__shared = true
let t = 0

export class FireCone {
  constructor(parent) {
    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.renderOrder = 8
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.k = 0
    parent.add(this.mesh)
  }

  set(on, dt) {
    this.k += ((on ? 1 : 0) - this.k) * Math.min(1, dt * 8)
    this.mesh.visible = this.k > 0.02
    this.mesh.scale.set(1, 1, 0.3 + 0.7 * this.k)
  }

  // once per frame for all cones: the shared flicker clock and the strongest cone's strength
  static tick(dt, strength) { t += dt; material.uniforms.time.value = t; material.uniforms.strength.value = strength }

  dispose() { this.mesh.parent?.remove(this.mesh) }
}
