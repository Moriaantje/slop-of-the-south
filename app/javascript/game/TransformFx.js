import * as THREE from "three"
import { softTexture } from "game/Effects"

// The light show around the transformation in Avatar.js. Four pieces, each chosen because it sells a different part
// of the beat: a gathering glow that swells while the machine folds, so the fold reads as powered rather than as a
// shrink; a flat shockwave ring on the ground at the swap, which is the cheapest possible way to put the event in
// the world rather than on the screen (one quad, one shader, no geometry that expands); a short energy column that
// shoots up through the machine and covers the frame where one body is exchanged for the other; and a handful of
// sparks thrown outward. Everything is additive with depth writes off so the bloom pass picks it up, and every
// object is allocated once on the first transformation and reused, because a transformation happens often enough
// that per-burst allocation would show up as a hitch.
const RING_R = 9.0             // metres: the radius the shockwave reaches
const RING_LIFE = 0.55         // seconds
const COLUMN_R = 1.5           // metres
const COLUMN_H = 9.0           // metres
const COLUMN_LIFE = 0.40       // seconds
const FLASH_R = 7.0            // metres at its widest
const FLASH_LIFE = 0.30        // seconds
const SPARKS = 18
const SPARK_LIFE = 0.65        // seconds
const SPARK_SPEED = 9.0        // m/s outward
const SPARK_RISE = 7.0         // m/s up
const SPARK_GRAVITY = 16       // m/s²
const CHARGE_R = 3.4           // metres: the gathering glow at full fold

const RING_VERT = /* glsl */`
  varying vec2 vRingUv;
  void main() {
    vRingUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`
const RING_FRAG = /* glsl */`
  uniform float uK;
  uniform float uFade;
  uniform vec3 uColor;
  varying vec2 vRingUv;
  void main() {
    float d = length(vRingUv - vec2(0.5)) * 2.0;
    float w = 0.05 + 0.20 * uK;
    float t = (d - uK) / w;
    float ring = exp(-t * t);
    float inner = (1.0 - smoothstep(uK - 0.30, uK, d)) * 0.22;
    float a = (ring + inner) * uFade;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * (0.55 + 1.7 * ring), a);
  }`

const COLUMN_VERT = /* glsl */`
  varying float vColH;
  void main() {
    vColH = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`
const COLUMN_FRAG = /* glsl */`
  uniform float uK;
  uniform vec3 uColor;
  varying float vColH;
  void main() {
    float front = 1.0 - smoothstep(uK * 1.6, uK * 1.6 + 0.30, vColH);
    float a = front * (1.0 - vColH) * (1.0 - uK) * (1.0 - uK) * 0.9;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * (0.8 + 1.5 * (1.0 - vColH)), a);
  }`

export class TransformFx {
  constructor(scene) {
    this.scene = scene
    this.built = false
    this.ringT = -1
    this.columnT = -1
    this.flashT = -1
    this.sparks = []
    this.colour = new THREE.Color(0xffd39a)
  }

  build() {
    if (this.built) return
    this.built = true
    const map = softTexture()

    const plane = new THREE.PlaneGeometry(1, 1)
    plane.rotateX(-Math.PI / 2)
    this.ringMat = new THREE.ShaderMaterial({ uniforms: { uK: { value: 0 }, uFade: { value: 0 }, uColor: { value: this.colour.clone() } },
      vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
    this.ring = new THREE.Mesh(plane, this.ringMat)
    this.ring.scale.setScalar(RING_R * 2)
    this.ring.renderOrder = 6
    this.ring.visible = false
    this.scene.add(this.ring)

    const tube = new THREE.CylinderGeometry(COLUMN_R * 0.55, COLUMN_R, COLUMN_H, 16, 1, true)
    tube.translate(0, COLUMN_H / 2, 0)
    this.columnMat = new THREE.ShaderMaterial({ uniforms: { uK: { value: 0 }, uColor: { value: this.colour.clone() } },
      vertexShader: COLUMN_VERT, fragmentShader: COLUMN_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false })
    this.column = new THREE.Mesh(tube, this.columnMat)
    this.column.renderOrder = 6
    this.column.visible = false
    this.scene.add(this.column)

    this.flashMat = new THREE.SpriteMaterial({ map, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    this.flash = new THREE.Sprite(this.flashMat)
    this.flash.visible = false
    this.scene.add(this.flash)

    this.chargeMat = new THREE.SpriteMaterial({ map, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    this.chargeSprite = new THREE.Sprite(this.chargeMat)
    this.chargeSprite.visible = false
    this.scene.add(this.chargeSprite)

    for (let i = 0; i < SPARKS; i++) {
      const mat = new THREE.SpriteMaterial({ map, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      const sprite = new THREE.Sprite(mat)
      sprite.visible = false
      this.scene.add(sprite)
      this.sparks.push({ sprite, mat, t: 0, life: 0, vx: 0, vy: 0, vz: 0 })
    }
  }

  // the gathering glow while the machine folds; k is the fold progress 0..1
  charge(x, y, z, k, colour) {
    this.build()
    this.colour.set(colour)
    const s = this.chargeSprite
    s.visible = k > 0.02
    s.position.set(x, y + 1.0, z)
    s.scale.setScalar(CHARGE_R * (0.15 + 0.85 * k * k))
    this.chargeMat.color.copy(this.colour).lerp(WHITE, 0.35 * k)
    this.chargeMat.opacity = 0.75 * k * k
  }

  // the swap itself: the ring, the column, the flash and the sparks all start here
  burst(x, y, z, colour) {
    this.build()
    this.colour.set(colour)
    this.chargeSprite.visible = false
    this.ring.position.set(x, y + 0.08, z)
    this.ringMat.uniforms.uColor.value.copy(this.colour)
    this.ringT = 0
    this.column.position.set(x, y, z)
    this.columnMat.uniforms.uColor.value.copy(this.colour)
    this.columnT = 0
    this.flash.position.set(x, y + 1.4, z)
    this.flashMat.color.copy(this.colour).lerp(WHITE, 0.6)
    this.flashT = 0
    for (const s of this.sparks) {
      const a = Math.random() * Math.PI * 2, spread = 0.5 + Math.random() * 0.9
      s.sprite.position.set(x, y + 0.9, z)
      s.vx = Math.cos(a) * SPARK_SPEED * spread
      s.vz = Math.sin(a) * SPARK_SPEED * spread
      s.vy = SPARK_RISE * (0.5 + Math.random())
      s.life = SPARK_LIFE * (0.7 + Math.random() * 0.6)
      s.t = 0
      s.mat.color.copy(this.colour).lerp(WHITE, Math.random() * 0.5)
      s.sprite.visible = true
    }
  }

  update(dt) {
    if (!this.built) return
    if (this.ringT >= 0) {
      this.ringT += dt
      const k = this.ringT / RING_LIFE
      this.ring.visible = k < 1
      if (k >= 1) this.ringT = -1
      else { this.ringMat.uniforms.uK.value = k; this.ringMat.uniforms.uFade.value = (1 - k) * (1 - k) }
    }
    if (this.columnT >= 0) {
      this.columnT += dt
      const k = this.columnT / COLUMN_LIFE
      this.column.visible = k < 1
      if (k >= 1) this.columnT = -1
      else { this.columnMat.uniforms.uK.value = k; this.column.rotation.y += dt * 6 }
    }
    if (this.flashT >= 0) {
      this.flashT += dt
      const k = this.flashT / FLASH_LIFE
      this.flash.visible = k < 1
      if (k >= 1) this.flashT = -1
      else { this.flash.scale.setScalar(FLASH_R * (0.25 + 0.75 * k)); this.flashMat.opacity = (1 - k) * (1 - k) }
    }
    for (const s of this.sparks) {
      if (!s.sprite.visible) continue
      s.t += dt
      if (s.t >= s.life) { s.sprite.visible = false; continue }
      const k = s.t / s.life
      s.vy -= SPARK_GRAVITY * dt
      s.sprite.position.x += s.vx * dt; s.sprite.position.y += s.vy * dt; s.sprite.position.z += s.vz * dt
      s.vx *= 1 - 1.8 * dt; s.vz *= 1 - 1.8 * dt
      s.sprite.scale.setScalar(0.9 * (1 - k) + 0.15)
      s.mat.opacity = (1 - k) * (1 - k)
    }
  }

  dispose() {
    if (!this.built) return
    for (const o of [this.ring, this.column, this.flash, this.chargeSprite, ...this.sparks.map((s) => s.sprite)]) {
      this.scene.remove(o)
      o.material.dispose()
    }
    this.ring.geometry.dispose(); this.column.geometry.dispose()
    this.built = false
    this.sparks.length = 0
  }
  // A morph can end without ever reaching burst(): reset() and setMode() both call finishMorph() straight from the
  // fold-in. Without this the gathering glow stays on screen for the rest of the session.
  clear() { if (this.built) this.chargeSprite.visible = false }

}

const WHITE = new THREE.Color(0xffffff)
