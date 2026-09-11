import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// Street furniture: lamp posts (BGT lichtmast) and traffic lights (BGT signal poles, or one pole per approach at an
// OSM traffic_signals node). Tile entries: lamps [x, z, dir, h] with dir the compass direction of the arm, signals
// [x, z, face, group] with face the compass direction the head looks in and group the intersection. Traffic lights
// run a fixed cycle on the wall clock, so every player sees the same colours, phased by the head's axis.
const grey = Object.assign(new THREE.MeshStandardMaterial({ color: 0x8d9093, roughness: 0.6, metalness: 0.4 }), { __shared: true })
const lampHead = Object.assign(new THREE.MeshStandardMaterial({ color: 0xdedcd0, emissive: 0xfff1c4, emissiveIntensity: 0.55, roughness: 0.4 }), { __shared: true })
const housing = Object.assign(new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.7 }), { __shared: true })
const lightMat = Object.assign(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), { __shared: true })

// the light on the ground under a lamp: a radial gradient disc, additive, faded in with the darkness
const poolTexture = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128
  const ctx = c.getContext("2d"), g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(0.35, "rgba(255,255,255,0.45)"); g.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
})()
const poolMat = { 6: 0xffa54a, 9: 0xd8e4ff }                                   // sodium orange on streets, LED white on main roads
for (const h of Object.keys(poolMat)) poolMat[h] = Object.assign(new THREE.MeshBasicMaterial({ map: poolTexture, color: poolMat[h], transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), { __shared: true })
const poolGeometry = new THREE.CircleGeometry(1, 24); poolGeometry.rotateX(-Math.PI / 2); poolGeometry.__shared = true

// darkness 0 (day) … 1 (night): lamp heads light up and the ground pools appear
export function setNightLevel(d) {
  lampHead.emissiveIntensity = 0.1 + 1.8 * d
  for (const m of Object.values(poolMat)) m.opacity = 0.95 * d * d
}

const lampGeometry = {}, lampHeadGeometry = {}
function lampParts(h) {
  if (!lampGeometry[h]) {
    const pole = new THREE.CylinderGeometry(0.07, 0.11, h, 7); pole.translate(0, h / 2, 0)
    const arm = new THREE.BoxGeometry(0.09, 0.09, 1.5); arm.rotateX(0.12); arm.translate(0, h + 0.05, -0.72)
    lampGeometry[h] = mergeGeometries([pole, arm], false)
    lampHeadGeometry[h] = new THREE.BoxGeometry(0.28, 0.13, 0.6); lampHeadGeometry[h].translate(0, h + 0.12, -1.28)
    ;[pole, arm].forEach((g) => g.dispose())
  }
  return [lampGeometry[h], lampHeadGeometry[h]]
}

export function buildLamps(lamps, heightAt) {
  if (!lamps?.length) return null
  const group = new THREE.Group()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const byHeight = Map.groupBy(lamps, (l) => l[3] ?? 6)
  for (const [h, list] of byHeight) {
    const [poleGeo, headGeo] = lampParts(h)
    const poles = new THREE.InstancedMesh(poleGeo, grey, list.length), heads = new THREE.InstancedMesh(headGeo, lampHead, list.length)
    const pools = new THREE.InstancedMesh(poolGeometry, poolMat[h] ?? poolMat[6], list.length)
    const radius = h * 0.95, flat = new THREE.Quaternion(), ps = new THREE.Vector3(radius, 1, radius)
    list.forEach(([x, z, dir], i) => {
      q.setFromAxisAngle(up, -dir * Math.PI / 180)                       // forward (-z) → compass dir
      m.compose(p.set(x, heightAt(x, z) - 0.1, z), q, s)
      poles.setMatrixAt(i, m); heads.setMatrixAt(i, m)
      const hx = x + Math.sin(dir * Math.PI / 180) * 1.3, hz = z - Math.cos(dir * Math.PI / 180) * 1.3   // under the head
      pools.setMatrixAt(i, m.compose(p.set(hx, heightAt(hx, hz) + 0.2, hz), flat, ps))
    })
    poles.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = pools.instanceMatrix.needsUpdate = true
    poles.geometry.__shared = heads.geometry.__shared = true
    pools.renderOrder = 2
    group.add(poles, heads, pools)
  }
  return group
}

// ---- traffic lights ---------------------------------------------------------------------------------------------

const CYCLE = 40                                            // seconds
const LIT = [new THREE.Color(0xff2a1a), new THREE.Color(0xffb400), new THREE.Color(0x2ee85a)]
const DARK = [new THREE.Color(0x3a1210), new THREE.Color(0x3a2a0a), new THREE.Color(0x0d3318)]
const active = new Set()
let lastTick = -1

const signalPole = mergeGeometries([
  (() => { const g = new THREE.CylinderGeometry(0.07, 0.09, 3.7, 7); g.translate(0, 1.85, 0); return g })(),
  (() => { const g = new THREE.BoxGeometry(0.08, 0.08, 0.3); g.translate(0, 3.3, -0.15); return g })()
], false)
const signalHousing = (() => { const g = new THREE.BoxGeometry(0.34, 1.08, 0.26); g.translate(0, 3.3, -0.3); return g })()
const signalLight = (() => { const g = new THREE.CircleGeometry(0.11, 12); g.translate(0, 0, -0.435); return g })()
signalPole.__shared = signalHousing.__shared = signalLight.__shared = true

export function buildSignals(signals, heightAt) {
  if (!signals?.length) return null
  const group = new THREE.Group()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const poles = new THREE.InstancedMesh(signalPole, grey, signals.length)
  const heads = new THREE.InstancedMesh(signalHousing, housing, signals.length)
  const lights = new THREE.InstancedMesh(signalLight, lightMat, signals.length * 3)
  const entries = []
  signals.forEach(([x, z, face, groupId], i) => {
    const y = heightAt(x, z) - 0.05
    q.setFromAxisAngle(up, -face * Math.PI / 180)
    m.compose(p.set(x, y, z), q, s)
    poles.setMatrixAt(i, m); heads.setMatrixAt(i, m)
    for (let k = 0; k < 3; k++) { m.compose(p.set(x, y + 3.66 - k * 0.36, z), q, s); lights.setMatrixAt(i * 3 + k, m); lights.setColorAt(i * 3 + k, DARK[k]) }
    entries.push({ i, phase: Math.round(face / 90) % 2, offset: (groupId * 7919) % CYCLE })
  })
  poles.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = lights.instanceMatrix.needsUpdate = true
  const entry = { lights, entries, state: new Int8Array(signals.length).fill(-1) }
  active.add(entry)
  group.userData.onDispose = () => active.delete(entry)
  group.add(poles, heads, lights)
  paint(entry, Date.now() / 1000)
  return group
}

// 0 red, 1 amber, 2 green for a head in `phase` at cycle time u
function stateAt(u, phase) {
  if (phase === 0) return u < 16 ? 2 : u < 19 ? 1 : 0
  return u < 21 ? 0 : u < 37 ? 2 : 1
}

function paint(entry, t) {
  let changed = false
  for (const { i, phase, offset } of entry.entries) {
    const st = stateAt((t + offset) % CYCLE, phase)
    if (entry.state[i] === st) continue
    entry.state[i] = st; changed = true
    for (let k = 0; k < 3; k++) entry.lights.setColorAt(i * 3 + k, k === st ? LIT[k] : DARK[k])
  }
  if (changed) entry.lights.instanceColor.needsUpdate = true
}

// call once per frame; recolours the lamps of every loaded traffic light a few times a second
export function updateSignals() {
  const t = Date.now() / 1000
  const tick = Math.floor(t * 4)
  if (tick === lastTick) return
  lastTick = tick
  for (const entry of active) paint(entry, t)
}
