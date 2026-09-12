import * as THREE from "three"
import { pointKey, hideInstance, showInstance } from "game/Destructibles"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// Street furniture: lamp posts (BGT lichtmast) and traffic lights (BGT signal poles, or one pole per approach at an
// OSM traffic_signals node). Tile entries: lamps [x, z, dir, h] with dir the compass direction of the arm, signals
// [x, z, face, group] with face the compass direction the head looks in and group the intersection. Traffic lights
// run a fixed cycle on the wall clock, so every player sees the same colours, phased by the head's axis.
//
// Both are instanced, so their geometry is free in draw calls and almost free in memory: a lamp post is drawn once
// and stamped three hundred times per town tile. That is the argument for spending triangles on it. A cylinder on a
// stick reads as a placeholder from any distance; a Dutch lichtmast is a tapered aluminium mast on a cast plinth
// with a swept arm and a flat luminaire hanging off the end of it, and every one of those parts is a silhouette the
// sky cuts into, which is what makes a street of them look like a street. The whole mast merges into one geometry
// and the lens into a second, so the extra shape costs two draw calls per height class, the same as before.
//
// At night the lens turns emissive (the bloom in Post.js does the rest) and a gradient disc fades in on the ground
// under it, stretched along the arm the way a real luminaire's throw is. A disc is a lie a spotlight would tell
// honestly, but a spotlight costs a shadow map and a light slot each, and there are three hundred of them.
const LAMP_TILT = 0.10          // rad: the luminaire hangs a little nose-down, like a real one
const ARM = 1.45                // metres the arm reaches out over the carriageway
const POOL_ALONG = 1.30         // the light pool is longer along the road than it is across it
const POOL_ACROSS = 0.85

const mast = Object.assign(new THREE.MeshStandardMaterial({ color: 0x9b9ea1, roughness: 0.45, metalness: 0.45 }), { __shared: true })
const lens = Object.assign(new THREE.MeshStandardMaterial({ color: 0xe8e4d4, emissive: 0xffe2a8, emissiveIntensity: 0.55, roughness: 0.25, metalness: 0.1 }), { __shared: true })
const housing = Object.assign(new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.62, metalness: 0.25 }), { __shared: true })
const lightMat = Object.assign(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), { __shared: true })

// the light on the ground under a lamp: a radial gradient disc, additive, faded in with the darkness. The hot core
// is small and the falloff long, because that is what the inverse square of a 6 m luminaire actually looks like.
const poolTexture = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128
  const ctx = c.getContext("2d"), g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.18, "rgba(255,255,255,0.72)")
  g.addColorStop(0.45, "rgba(255,255,255,0.28)"); g.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
})()
const poolMat = { 6: 0xffa54a, 9: 0xd8e4ff }                                   // sodium orange on streets, LED white on main roads
for (const h of Object.keys(poolMat)) poolMat[h] = Object.assign(new THREE.MeshBasicMaterial({ map: poolTexture, color: poolMat[h], transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), { __shared: true })
const poolGeometry = new THREE.CircleGeometry(1, 16); poolGeometry.rotateX(-Math.PI / 2); poolGeometry.__shared = true

// darkness 0 (day) … 1 (night): lamp lenses light up and the ground pools appear. By day the pools (≈300 additive
// discs per tile) are hidden outright: an opacity-0 transparent mesh is still sorted and blended.
const poolMeshes = new Set()
let poolsVisible = true
export function setNightLevel(d) {
  lens.emissiveIntensity = 0.08 + 2.2 * d
  for (const m of Object.values(poolMat)) m.opacity = 0.95 * d * d
  const visible = d > 0.02
  if (visible !== poolsVisible) { poolsVisible = visible; for (const mesh of poolMeshes) mesh.visible = visible }
}

// A box whose top face is pulled in by `pinch` on both horizontal axes: the cheapest way to a moulded shape, and the
// difference between a luminaire and a brick.
function taperedBox(w, h, d, pinch) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) <= 0) continue
    p.setX(i, p.getX(i) * (1 - pinch)); p.setZ(i, p.getZ(i) * (1 - pinch))
  }
  g.computeVertexNormals()
  return g
}

// The arm: a swept tube leaving the mast vertically, bending over a metre of radius and running out level. A curve
// rather than a rotated box, because the bend is the part of a lamp post the eye recognises.
function armTube(h) {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, h - 0.55, 0),
    new THREE.Vector3(0, h - 0.06, -0.10),
    new THREE.Vector3(0, h + 0.16, -0.52),
    new THREE.Vector3(0, h + 0.22, -1.02),
    new THREE.Vector3(0, h + 0.21, -ARM),
  ])
  return new THREE.TubeGeometry(curve, 7, 0.045, 5, false)
}

const lampGeometry = {}, lampLensGeometry = {}
function lampParts(h) {
  if (!lampGeometry[h]) {
    const plinth = new THREE.CylinderGeometry(0.125, 0.165, 0.3, 6); plinth.translate(0, 0.15, 0)
    const pole = new THREE.CylinderGeometry(0.062, 0.105, h - 0.3, 8, 1, true); pole.translate(0, 0.3 + (h - 0.3) / 2, 0)
    const arm = armTube(h)
    const shell = taperedBox(0.30, 0.13, 0.60, 0.30)
    shell.rotateX(LAMP_TILT); shell.translate(0, h + 0.255, -ARM - 0.16)
    // the tapered shell is flat-shaded and so already non-indexed: mergeGeometries wants all of them the same way
    const parts = [plinth, pole, arm].map((g) => { const n = g.toNonIndexed(); g.dispose(); return n })
    parts.push(shell)
    lampGeometry[h] = mergeGeometries(parts, false)
    const glass = new THREE.BoxGeometry(0.235, 0.035, 0.50)
    glass.rotateX(LAMP_TILT); glass.translate(0, h + 0.185, -ARM - 0.16)
    lampLensGeometry[h] = glass
    parts.forEach((g) => g.dispose())
  }
  return [lampGeometry[h], lampLensGeometry[h]]
}

export function buildLamps(lamps, heightAt, reg) {
  if (!lamps?.length) return null
  const group = new THREE.Group()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const byHeight = Map.groupBy(lamps, (l) => l[3] ?? 6)
  for (const [h, list] of byHeight) {
    const [poleGeo, lensGeo] = lampParts(h)
    const poles = new THREE.InstancedMesh(poleGeo, mast, list.length), heads = new THREE.InstancedMesh(lensGeo, lens, list.length)
    const pools = new THREE.InstancedMesh(poolGeometry, poolMat[h] ?? poolMat[6], list.length)
    const reach = h * 0.95, ps = new THREE.Vector3(reach * POOL_ACROSS, 1, reach * POOL_ALONG)
    list.forEach(([x, z, dir], i) => {
      q.setFromAxisAngle(up, -dir * Math.PI / 180)                       // forward (-z) → compass dir
      m.compose(p.set(x, heightAt(x, z) - 0.1, z), q, s)
      poles.setMatrixAt(i, m); heads.setMatrixAt(i, m)
      const hx = x + Math.sin(dir * Math.PI / 180) * ARM, hz = z - Math.cos(dir * Math.PI / 180) * ARM   // under the luminaire
      pools.setMatrixAt(i, m.compose(p.set(hx, heightAt(hx, hz) + 0.22, hz), q, ps))   // the throw follows the arm
      reg?.(pointKey("l", x, z), { kind: "l", x, z, r: 0.25, h, max: 12, remove: () => { hideInstance(poles, i); hideInstance(heads, i); hideInstance(pools, i) }, restore: () => { showInstance(poles, i); showInstance(heads, i); showInstance(pools, i) } })
    })
    poles.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = pools.instanceMatrix.needsUpdate = true
    poles.geometry.__shared = heads.geometry.__shared = true
    pools.renderOrder = 2
    pools.visible = poolsVisible
    poolMeshes.add(pools)
    group.add(poles, heads, pools)
  }
  group.userData.onDispose = () => { for (const o of group.children) poolMeshes.delete(o) }
  return group
}

// ---- traffic lights ---------------------------------------------------------------------------------------------

const CYCLE = 40                                            // seconds
// The lit colours are deliberately hotter than the sheeting they sit behind: they are the brightest thing in a
// street at dusk, and the bloom threshold in Post.js only catches them if they are.
const LIT = [new THREE.Color(0xff4a22), new THREE.Color(0xffc63a), new THREE.Color(0x4dff86)]
const DARK = [new THREE.Color(0x3a1210), new THREE.Color(0x3a2a0a), new THREE.Color(0x0d3318)]
const active = new Set()
let lastTick = -1

const HEAD_Y = 3.3                                          // metres: the centre of the signal head

// A hood over each lens: half an open cylinder lying on its side, which is exactly the pressed-metal visor a
// verkeerslicht has so that the sun cannot be mistaken for a green.
function visor(y) {
  const g = new THREE.CylinderGeometry(0.145, 0.145, 0.15, 10, 1, true, 0, Math.PI)
  g.rotateZ(Math.PI / 2); g.rotateY(Math.PI / 2)            // axis along z, the open half facing down
  g.translate(0, y, -0.40)
  return g
}

const signalPole = mergeGeometries([
  (() => { const g = new THREE.CylinderGeometry(0.14, 0.17, 0.22, 6); g.translate(0, 0.11, 0); return g })(),
  (() => { const g = new THREE.CylinderGeometry(0.055, 0.078, 3.6, 8, 1, true); g.translate(0, 1.9, 0); return g })(),
  (() => { const g = new THREE.BoxGeometry(0.08, 0.08, 0.3); g.translate(0, HEAD_Y, -0.15); return g })(),
], false)
const signalHousing = mergeGeometries([
  (() => { const g = new THREE.BoxGeometry(0.60, 1.40, 0.02); g.translate(0, HEAD_Y, -0.14); return g })(),    // the black backboard
  (() => { const g = new THREE.BoxGeometry(0.34, 1.08, 0.26); g.translate(0, HEAD_Y, -0.30); return g })(),
  visor(HEAD_Y + 0.36), visor(HEAD_Y), visor(HEAD_Y - 0.36),
], false)
const signalLight = (() => { const g = new THREE.CircleGeometry(0.105, 12); g.translate(0, 0, -0.44); return g })()
signalPole.__shared = signalHousing.__shared = signalLight.__shared = true

export function buildSignals(signals, heightAt, reg) {
  if (!signals?.length) return null
  const group = new THREE.Group()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const poles = new THREE.InstancedMesh(signalPole, mast, signals.length)
  const heads = new THREE.InstancedMesh(signalHousing, housing, signals.length)
  const lights = new THREE.InstancedMesh(signalLight, lightMat, signals.length * 3)
  const entries = []
  signals.forEach(([x, z, face, groupId], i) => {
    const y = heightAt(x, z) - 0.05
    q.setFromAxisAngle(up, -face * Math.PI / 180)
    m.compose(p.set(x, y, z), q, s)
    poles.setMatrixAt(i, m); heads.setMatrixAt(i, m)
    for (let k = 0; k < 3; k++) { m.compose(p.set(x, y + HEAD_Y + 0.36 - k * 0.36, z), q, s); lights.setMatrixAt(i * 3 + k, m); lights.setColorAt(i * 3 + k, DARK[k]) }
    entries.push({ i, phase: Math.round(face / 90) % 2, offset: (groupId * 7919) % CYCLE })
    reg?.(pointKey("g", x, z), { kind: "g", x, z, r: 0.25, h: 3.7, max: 20, remove: () => { hideInstance(poles, i); hideInstance(heads, i); for (let k = 0; k < 3; k++) hideInstance(lights, i * 3 + k) }, restore: () => { showInstance(poles, i); showInstance(heads, i); for (let k = 0; k < 3; k++) showInstance(lights, i * 3 + k) } })
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
