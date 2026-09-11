import * as THREE from "three"
import { makeBeacon, placeBeacon, showBeacon } from "game/Beacon"

// The nuke carrier: a flatbed with a bomb on a straight line across the arena. Its position is a pure function of
// the server clock (Round.carrierAt), so every client sees the same truck without any messages. A red ribbon on the
// ground marks the whole path, a beacon in the sky marks the truck.
const RIBBON_STEP = 10, RIBBON_HW = 1.5, RIBBON_LIFT = 0.3
const ribbonMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 })
ribbonMat.__shared = true

export class Carrier {
  constructor(scene) {
    this.scene = scene
    this.mesh = makeCarrierMesh()
    this.beacon = makeBeacon(scene, 0xff3b1f)
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), ribbonMat)
    this.ribbon.frustumCulled = false
    scene.add(this.mesh, this.ribbon)
    this.state = null
    this.y = 0
    this.ribbonTimer = 1
    this.show(false)
  }

  // state: the Round instance; the truck waits at the start during the intermission and disappears once the round is over
  setRound(state) {
    this.state = state
    const r = state.round
    if (r && r.id !== this.roundId) { this.roundId = r.id; this.buildRibbon(r.path); this.ribbonTimer = 1 }
    this.show(!!r && r.status !== "ended")
  }

  show(visible) {
    this.mesh.visible = this.ribbon.visible = visible
    showBeacon(this.beacon, visible)
  }

  hide() { this.show(false) }

  update(now, dt, chunks, local, camera) {
    if (!this.mesh.visible) return
    const [x, z] = this.state.carrierAt(now)
    if (chunks.ready(x, z)) this.y += (chunks.heightAt(x, z) - this.y) * Math.min(1, dt * 8)   // onto the ground once its tile is in
    this.mesh.position.set(x, this.y, z)
    this.mesh.rotation.y = this.state.heading
    this.mesh.userData.light.emissiveIntensity = 1.5 + 1.5 * Math.sin(now / 150)
    placeBeacon(this.beacon, x, this.y, z, "Kernkop", local, camera)
    if ((this.ribbonTimer += dt) > 1) { this.ribbonTimer = 0; this.updateRibbon(chunks) }
  }

  // a flat strip along the path, RIBBON_STEP metres per segment; y is filled in from the loaded tiles
  buildRibbon(path) {
    const n = Math.ceil(path.length / RIBBON_STEP)
    const dx = (path.x1 - path.x0) / n, dz = (path.z1 - path.z0) / n
    const len = Math.hypot(dx, dz) || 1, lx = -dz / len * RIBBON_HW, lz = dx / len * RIBBON_HW
    const pos = new Float32Array((n + 1) * 6), idx = []
    for (let i = 0; i <= n; i++) {
      const x = path.x0 + dx * i, z = path.z0 + dz * i
      pos.set([x + lx, 0, z + lz, x - lx, 0, z - lz], i * 6)
      if (i) { const a = 2 * (i - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
    }
    this.ribbon.geometry.dispose()
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    this.ribbon.geometry = g
    this.ribbonKnown = new Uint8Array(n + 1)
  }

  // ground the strip where tiles are loaded; the rest keeps the truck's height until its tile comes in
  updateRibbon(chunks) {
    const pos = this.ribbon.geometry.attributes.position
    for (let i = 0; i < pos.count / 2; i++) {
      const x = (pos.getX(2 * i) + pos.getX(2 * i + 1)) / 2, z = (pos.getZ(2 * i) + pos.getZ(2 * i + 1)) / 2
      let y
      if (chunks.ready(x, z)) { y = chunks.heightAt(x, z) + RIBBON_LIFT; this.ribbonKnown[i] = 1 }
      else if (!this.ribbonKnown[i]) y = this.y + RIBBON_LIFT
      else continue
      pos.setY(2 * i, y); pos.setY(2 * i + 1, y)
    }
    pos.needsUpdate = true
  }
}

// a yellow cab, a flatbed with a finned bomb on it, six wheels and a red rotating light on the roof
function makeCarrierMesh() {
  const g = new THREE.Group()
  const paint = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 0.3, roughness: 0.5 })
  const dark  = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 })
  const steel = new THREE.MeshStandardMaterial({ color: 0x5b6068, metalness: 0.6, roughness: 0.4 })
  const warn  = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 })
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; g.add(m); return m }
  add(new THREE.BoxGeometry(3.4, 0.4, 8.6), steel, 0, 1.0, 1.5)          // flatbed
  add(new THREE.BoxGeometry(3.2, 2.2, 2.8), paint, 0, 1.9, -4.4)         // cab
  add(new THREE.BoxGeometry(3.0, 0.9, 0.2), dark, 0, 2.3, -5.7)          // windscreen
  add(new THREE.CylinderGeometry(1.1, 1.1, 5.2, 16), steel, 0, 2.3, 1.6, Math.PI / 2)   // the bomb
  add(new THREE.ConeGeometry(1.1, 1.6, 16), steel, 0, 2.3, -1.8, -Math.PI / 2)
  for (const [x, y] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) add(new THREE.BoxGeometry(x ? 1.2 : 0.15, y ? 1.2 : 0.15, 1.2), steel, x * 1.2, 2.3 + y * 1.2, 4.6)
  for (const z of [-2.2, 0.6, 3.4]) add(new THREE.BoxGeometry(3.6, 0.25, 0.25), warn, 0, 1.25, z)   // black straps over the bed
  const wheel = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14); wheel.rotateZ(Math.PI / 2)
  for (const z of [-4.2, 1.2, 3.6]) for (const x of [-1.5, 1.5]) add(wheel, dark, x, 0.55, z)
  const head = new THREE.MeshStandardMaterial({ color: 0xfff8e6, emissive: 0xfff3cc, emissiveIntensity: 0.6 })
  const tail = new THREE.MeshStandardMaterial({ color: 0x7a1010, emissive: 0xff1a12, emissiveIntensity: 0.4 })
  for (const x of [-1.2, 1.2]) { add(new THREE.BoxGeometry(0.4, 0.2, 0.06), head, x, 1.4, -5.83); add(new THREE.BoxGeometry(0.4, 0.2, 0.06), tail, x, 1.1, 5.83) }
  const light = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 2 })
  add(new THREE.BoxGeometry(0.5, 0.35, 0.5), light, 0, 3.2, -4.4)
  g.userData.light = light
  g.userData.lights = { head, tail }
  return g
}
