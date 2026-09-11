import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { TUNING as T, hash32, mulberry32, wrapAngle } from "game/Tuning"
import { ROAD_LIFT } from "game/Roads"

// Boost pads on the road. Placed deterministically from the road pieces a tile already carries (seeded by the tile
// key and the road), so every client sees the same pads without any tile rebuild and the spacing stays live-tunable.
// A pad is a glowing ring with a light beam; driving through one fills the nitro meter and gives a short kick. Taken
// pads respawn locally after a while (a pacing tool, not a contested resource — server authority can come later using
// the same ids).
const ringGeo = (() => {
  const ring = new THREE.RingGeometry(0.55, 1.15, 24); ring.rotateX(-Math.PI / 2); ring.translate(0, 0.03, 0)
  const beam = new THREE.CylinderGeometry(0.12, 0.3, 3.2, 8, 1, true); beam.translate(0, 1.6, 0)
  const g = mergeGeometries([ring.toNonIndexed(), beam.toNonIndexed()], false)
  g.deleteAttribute("normal"); g.__shared = true
  return g
})()
const padMat = Object.assign(new THREE.MeshBasicMaterial({ color: 0x4fd2ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), { __shared: true })
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _v = new THREE.Vector3(), _zero = new THREE.Matrix4().makeScale(0, 0, 0)
const _up = new THREE.Vector3(0, 1, 0)

// pure function of one tile's roads: [{ id, x, y, z, yaw }]
export function placePads(tileKey, roads, terrainAt, P = T.pickups) {
  const pads = []
  for (const road of roads ?? []) {
    if (!P.kinds.includes(road.kind) || road.pts.length < 2) continue
    const p0 = road.pts[0]
    const rnd = mulberry32(hash32(`${tileKey}|${road.kind}|${road.name ?? ""}|${p0[0]},${p0[1]}|${road.pts.length}`))
    const total = arcLength(road.pts)
    let next = P.firstOffset + rnd() * (P.spacingMax - P.spacingMin), i = 0
    while (next < total - P.minStraight / 2) {
      const p = pointAt(road.pts, next)
      const bend = Math.abs(wrapAngle(headingAt(road.pts, next + P.minStraight / 2) - headingAt(road.pts, next - P.minStraight / 2)))
      if (bend < P.maxBend && !p.bridge) {
        const side = road.width >= 5.5 && !road.oneway ? (rnd() < 0.5 ? -1 : 1) * road.width / 4 : 0
        const x = p.x + p.rx * side, z = p.z + p.rz * side
        pads.push({ id: `${tileKey}:${i++}:${Math.round(x)}:${Math.round(z)}`, x, y: Math.max(p.y, terrainAt ? terrainAt(x, z) : p.y) + ROAD_LIFT, z, yaw: p.yaw })
      }
      next += P.spacingMin + rnd() * (P.spacingMax - P.spacingMin)
    }
  }
  return pads
}

export class Pickups {
  constructor() { this.tiles = new Map(); this.time = 0 }   // key → { mesh, pads: [{…, taken}] }

  // called with a ChunkManager tile entry once it is built
  addTile(tile) {
    const pads = placePads(tile.key, tile.roads, (x, z) => tile.terrain.heightAt(x, z))
    if (!pads.length) return
    const mesh = new THREE.InstancedMesh(ringGeo, padMat, pads.length)
    mesh.frustumCulled = false
    pads.forEach((p, i) => { p.taken = 0; p.index = i; this.matrix(p, 0); mesh.setMatrixAt(i, _m) })
    mesh.instanceMatrix.needsUpdate = true
    tile.group.add(mesh)
    this.tiles.set(tile.key, { mesh, pads })
  }

  dropTile(tile) { this.tiles.delete(tile.key) }   // the mesh goes with the tile group

  matrix(p, spin) {
    _q.setFromAxisAngle(_up, p.yaw + spin)
    _v.set(p.x, p.y + 0.02 * Math.sin(this.time * 2 + p.x), p.z)
    return _m.compose(_v, _q, _s)
  }

  // spin, pulse and respawn
  update(dt) {
    this.time += dt
    padMat.opacity = 0.62 + 0.2 * Math.sin(this.time * 3)
    const spin = this.time * 1.2
    for (const t of this.tiles.values()) {
      let dirty = false
      for (const p of t.pads) {
        if (p.taken > 0) { p.taken -= dt; if (p.taken > 0) continue; p.taken = 0 }
        t.mesh.setMatrixAt(p.index, this.matrix(p, spin)); dirty = true
      }
      if (dirty) t.mesh.instanceMatrix.needsUpdate = true
    }
  }

  // pads within reach of the car: returns the number collected (their effect is applied by the caller via onPickup)
  collect(car, tileIndex, onPickup) {
    const [cx, cy] = tileIndex(car.x, car.z)
    const r2 = T.pickups.radius * T.pickups.radius
    let n = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = this.tiles.get(`${cx + dx}_${cy + dy}`)
      if (!t) continue
      for (const p of t.pads) {
        if (p.taken > 0) continue
        const ddx = p.x - car.x, ddz = p.z - car.z
        if (ddx * ddx + ddz * ddz > r2 || Math.abs(p.y - car.y) > 2) continue
        p.taken = T.pickups.respawn
        t.mesh.setMatrixAt(p.index, _zero); t.mesh.instanceMatrix.needsUpdate = true
        onPickup?.(p); n++
      }
    }
    return n
  }
}

function arcLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s }

// point `d` metres along the polyline: x, z, y, yaw (heading, game convention), right vector, bridge flag
function pointAt(pts, d) {
  let s = 0
  for (let i = 1; i < pts.length; i++) {
    const [ax, az, ay, ab] = pts[i - 1], [bx, bz, by, bb] = pts[i]
    const len = Math.hypot(bx - ax, bz - az)
    if (s + len >= d || i === pts.length - 1) {
      const t = len ? Math.min(1, Math.max(0, (d - s) / len)) : 0
      const dx = (bx - ax) / (len || 1), dz = (bz - az) / (len || 1)
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, y: ay + (by - ay) * t, yaw: Math.atan2(-dx, -dz), rx: -dz, rz: dx, bridge: ab === 1 || bb === 1 }
    }
    s += len
  }
  return null
}

function headingAt(pts, d) {
  const p = pointAt(pts, Math.min(Math.max(d, 0), arcLength(pts)))
  return p ? p.yaw : 0
}
