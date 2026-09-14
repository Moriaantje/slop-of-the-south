import * as THREE from "three"
import { noAO } from "game/Layers"
import { NOISE3, flavour } from "game/Fireball"

// A dragon's breath, built to read as a jet with a hot core rather than a cloud of noise pulled over a cone.
//
// The trouble with one hollow cone is that every fragment of it sits on the skin, so there is no way to ask "how far
// from the axis am I?" and therefore no way to make the middle hotter than the edge — you get a bright rim and a
// hollow middle, which is the opposite of fire. So the breath is three nested cones instead, a thin one on the axis,
// a middle one, and the full-width skin, each carrying its own distance-from-the-axis as a vertex attribute. They
// are additive, so along the axis all three add up into a white-hot line and out at the skin only the sparse outer
// tongues survive. That also gives the flame real depth: you see the core through the ragged outer sheet.
//
// The noise is the same field the fireballs are made of (game/Fireball exports it), sampled in the cone's own space
// and dragged back down the axis, so the jet streams outward from the lips and frays as it goes. Everything that
// varies per dragon — how open the throat is, how bright, and what colour this lair's fire burns — is pushed into
// the one shared material from `onBeforeRender`, which Three.js calls on each mesh immediately before its own draw.
// Three cones of an eighth of a thousand triangles, drawn only while something is actually breathing.
const LENGTH = 60, RADIUS = 8
const SHELLS = [0.30, 0.62, 1.0]                 // the fraction of the full radius each nested cone sits at

const geometries = SHELLS.map((frac) => {
  const g = new THREE.ConeGeometry(RADIUS * frac, LENGTH, 20, 8, true)
  g.rotateX(Math.PI / 2)                         // the apex was at +y; now it is at +z
  g.translate(0, 0, -LENGTH / 2)                 // apex at the origin (the lips), base 60 m ahead down -z
  const n = g.attributes.position.count
  g.setAttribute("shell", new THREE.BufferAttribute(new Float32Array(n).fill(frac), 1))
  g.__shared = true
  return g
})

const material = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
  uniforms: {
    uTime: { value: 0 }, uSeed: { value: 0 }, uStrength: { value: 0 }, uCharge: { value: 0 }, uLength: { value: LENGTH },
    uColor: { value: new THREE.Color(1, 0.4, 0.05) }, uCool: { value: new THREE.Color(0.34, 0.03, 0) },
  },
  vertexShader: /* glsl */`
    attribute float shell;
    varying vec3 vPos; varying float vShell;
    void main() {
      vPos = position; vShell = shell;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uSeed, uStrength, uCharge, uLength;
    uniform vec3 uColor, uCool;
    varying vec3 vPos; varying float vShell;
    ${NOISE3}
    void main() {
      float along = clamp(-vPos.z / uLength, 0.0, 1.0);              // 0 at the lips, 1 sixty metres out
      float core = 1.0 - vShell;                                     // 1 on the axis, 0 on the skin
      // the field is dragged back down the axis, so the jet streams out of the mouth and frays with distance
      vec3 q = vec3(vPos.x, vPos.y, vPos.z * 0.3) * 0.20 + vec3(0.0, 0.0, uTime * 5.5) + uSeed;
      float n = fbm3(q);
      float n2 = fbm3(q * 2.9 + 13.0);
      // the outer shells break up sooner and die sooner: the inner jet outruns them
      float flame = smoothstep(0.10, 0.82, (n * 0.80 + n2 * 0.50) - along * (0.30 + 0.80 * vShell) + 0.20 * core);
      vec3 col = mix(uCool, uColor, smoothstep(0.0, 0.50, flame));
      col = mix(col, vec3(1.0, 0.95, 0.80), pow(core, 2.0) * (1.0 - along * 0.7) * smoothstep(0.25, 0.90, flame));
      float alpha = flame * (0.50 + 0.50 * core) * (1.0 - along * 0.55);
      // the wind-up: a gob of light gathering at the lips before any of this comes out. The ramp runs the low edge
      // first — smoothstep with its edges the wrong way round is undefined, however forgiving the driver is.
      float gob = uCharge * (1.0 - smoothstep(0.0, 0.26, along)) * (0.55 + 0.45 * n) * (0.3 + 0.7 * core);
      col += mix(uColor, vec3(1.0, 0.9, 0.6), 0.5) * gob * 1.6;
      alpha = clamp(alpha + gob, 0.0, 0.97) * uStrength;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(col, alpha);
    }`,
})
material.__shared = true

function pushConeUniforms(_renderer, _scene, _camera, _geometry, mat) {
  const c = this.userData.cone, u = mat.uniforms
  u.uSeed.value = c.seed
  u.uStrength.value = c.strength
  u.uCharge.value = c.charge
  u.uColor.value.copy(c.color)
  u.uCool.value.copy(c.cool)
}

let clock = 0
let seeds = 0

export class FireCone {
  // parent: the mouth group, facing -z. kind: the lair kind, which decides what colour this dragon burns.
  constructor(parent, kind = "castle") {
    const f = flavour(kind)
    this.seed = (seeds = (seeds + 13.7) % 100)
    this.color = f.color
    this.cool = f.cool
    this.k = 0                  // how far open the breath is
    this.c = 0                  // how bright the wind-up gob is
    this.strength = 0
    this.charge = 0
    this.group = new THREE.Group()
    this.group.visible = false
    this.meshes = geometries.map((g) => {
      const m = noAO(new THREE.Mesh(g, material))
      m.userData.cone = this
      m.onBeforeRender = pushConeUniforms
      m.renderOrder = 8
      m.frustumCulled = false
      this.group.add(m)
      return m
    })
    parent.add(this.group)
  }

  // `charging` is the tell before a breath, `breathing` the breath itself; both ease, so nothing snaps on
  set({ breathing = false, charging = false }, dt) {
    const rate = Math.min(1, dt * 8)
    this.k += ((breathing ? 1 : 0) - this.k) * rate
    this.c += ((charging ? 1 : 0) - this.c) * Math.min(1, dt * 6)
    this.strength = Math.max(this.k, this.c * 0.9)
    this.charge = this.c
    const visible = this.strength > 0.02
    this.group.visible = visible
    if (!visible) return
    // during the wind-up it is a gob at the lips; the throat opens as the breath comes
    const len = Math.max(0.08, this.k)
    this.group.scale.set(0.35 + 0.65 * this.k, 0.35 + 0.65 * this.k, len)
  }

  // once per frame for all cones: the shared flicker clock
  static tick(dt) { clock += dt; material.uniforms.uTime.value = clock }

  dispose() { this.group.parent?.remove(this.group) }
}
