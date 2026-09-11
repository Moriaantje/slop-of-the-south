import * as THREE from "three"
import { nearRoad, insideRing, insideAny, inBuilding, hash } from "game/Placement"

// The world between the roads and the houses: what a Limburg landscape is actually full of. The BGT land cover
// already says where every meadow, field, wood, orchard and yard lies, so the props go where they belong —
// hedgerows and fence posts along the field boundaries (the hedge banks that divide the whole province), hay bales
// and a cart on the arable land, bushes and boulders in the woods and verges, barrels, crates and planters in the
// farmyards, benches and flowers in the urban green. Placement is deterministic per tile (a hash of the position),
// computed once when the tile arrives, and the props are drawn from global instanced pools that are refilled only
// when the loaded tiles change: a thousand barrels cost one draw call. Boulders are generated here; the rest are
// the CC0 kit models (Assets.MODELS, public/models/props).
//
// cover entries are [code, ring, hole, ...] with rings as flat decimetres from the tile's north-west corner;
// codes: 1/2 grass, 3 urban green, 4 arable, 5 orchard, 6 tree nursery, 7 wood, 20 yard.
const AREA = [
  // code            prop        per hectare   scale       reach (m)  tilt
  { codes: [4],      prop: "hay",     n: 0.9,  s: [0.9, 1.4], far: 320, spin: true },
  { codes: [4],      prop: "cart",    n: 0.08, s: [0.9, 1.1], far: 280, spin: true },
  { codes: [7],      prop: "bush",    n: 6.0,  s: [0.8, 1.6], far: 300, spin: true },
  { codes: [7],      prop: "rock",    n: 1.6,  s: [0.5, 1.5], far: 300, spin: true },
  { codes: [1, 2],   prop: "rock",    n: 0.35, s: [0.5, 1.3], far: 320, spin: true },
  { codes: [1, 2],   prop: "bush",    n: 0.5,  s: [0.8, 1.3], far: 300, spin: true },
  { codes: [3],      prop: "planter", n: 1.2,  s: [0.9, 1.2], far: 220, spin: true },
  { codes: [3],      prop: "bench",   n: 0.8,  s: [1.0, 1.0], far: 220, spin: true },
  { codes: [3],      prop: "bush",    n: 4.0,  s: [0.7, 1.2], far: 250, spin: true },
  { codes: [20],     prop: "barrel",  n: 3.0,  s: [0.85, 1.15], far: 200, spin: true },
  { codes: [20],     prop: "crate",   n: 2.5,  s: [0.8, 1.3], far: 200, spin: true },
  { codes: [20],     prop: "hay",     n: 1.2,  s: [0.9, 1.2], far: 220, spin: true },
  { codes: [20],     prop: "planter", n: 1.5,  s: [0.9, 1.2], far: 200, spin: true },
  { codes: [5, 6],   prop: "crate",   n: 0.8,  s: [0.9, 1.2], far: 220, spin: true },
]
// Along the boundary of a cover polygon: the hedge banks, fences and field trees that draw the Limburg grid.
// `ring` is the chance that a given boundary gets this treatment at all (not every field is hedged, not every yard
// fenced), `chance` the chance per step along it, and `min` the shortest edge worth dressing.
const EDGE = [
  { codes: [1, 2],  prop: "bush",  gap: 2.6,  chance: 0.95, ring: 0.45, min: 14, s: [1.0, 1.7], far: 340, out: 1.0 },   // hedgerow: nearly continuous
  { codes: [1, 2],  prop: "fence", gap: 3.2,  chance: 0.8,  ring: 0.22, min: 28, s: [1.0, 1.0], far: 260, out: 0.4 },
  { codes: [4],     prop: "bush",  gap: 6.0,  chance: 0.6,  ring: 0.45, min: 18, s: [1.0, 1.6], far: 340, out: 1.2 },
  { codes: [4],     prop: "tree",  gap: 26.0, chance: 0.6,  ring: 0.45, min: 30, s: [0.8, 1.4], far: 400, out: 1.5 },   // pollard willows on the field edge
  { codes: [20],    prop: "fence", gap: 3.0,  chance: 0.8,  ring: 0.3,  min: 16, s: [1.0, 1.0], far: 220, out: 0.3 },
  { codes: [7],     prop: "bush",  gap: 3.0,  chance: 0.8,  ring: 0.7,  min: 14, s: [1.0, 1.8], far: 320, out: 0.8 },   // woodland fringe
]
const MAX_PER_PROP = 800

// ---- the boulders: a squashed icosahedron pushed about by noise, flat shaded ---------------------------------------
const rockGeos = Array.from({ length: 3 }, (_, v) => {
  const g = new THREE.IcosahedronGeometry(0.5, 1).toNonIndexed()
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
    const n = 0.72 + 0.42 * hash(Math.round(x * 37 + y * 11 + z * 23 + v * 131) * 0.5)
    p.setXYZ(i, x * n * 1.25, y * n * 0.72, z * n * 1.1)
  }
  g.computeVertexNormals()
  g.__shared = true
  return g
})
const rockMat = new THREE.MeshStandardMaterial({ color: 0x8d8a83, roughness: 0.95, flatShading: true })
rockMat.__shared = true

export class Scatter {
  constructor({ scene, assets, heightAt }) {
    this.scene = scene; this.assets = assets; this.heightAt = heightAt
    this.plans = new Map()       // tile key → { prop → [x, y, z, yaw, scale, ...] }
    this.pools = new Map()       // prop → [{ mesh }]
    this.ready = new Map()       // prop → [{ geometry, material }] once baked
    this.signature = ""
    for (const prop of new Set([...AREA, ...EDGE].map((r) => r.prop))) this.prepare(prop)
  }

  prepare(prop) {
    if (prop === "rock") { this.ready.set(prop, rockGeos.map((geometry) => ({ geometry, material: rockMat }))); return }
    this.assets.instanced(prop).then((groups) => { if (groups.length) { this.ready.set(prop, groups); this.signature = "" } })
  }

  // tiles: ChunkManager's map; (px, pz): the player, who decides what is close enough to draw
  update(tiles, px, pz) {
    for (const t of tiles.values()) if (!t.loading && !this.plans.has(t.key)) this.plan(t)
    for (const key of [...this.plans.keys()]) if (!tiles.has(key)) this.plans.delete(key)
    // refill when the tile set changes or the player has moved a good way (the reach tests depend on distance)
    const sig = `${[...this.plans.keys()].sort().join()}|${Math.round(px / 60)},${Math.round(pz / 60)}|${this.ready.size}`
    if (sig === this.signature) return
    this.signature = sig
    this.fill(px, pz)
  }

  // every placement of the loaded tiles, by prop
  fill(px, pz) {
    const want = new Map()
    for (const plan of this.plans.values()) {
      for (const [prop, list] of plan) {
        if (!this.ready.has(prop)) continue
        let out = want.get(prop)
        if (!out) { out = []; want.set(prop, out) }
        for (let i = 0; i < list.length; i += 6) {
          const d = Math.hypot(list[i] - px, list[i + 2] - pz)
          if (d > list[i + 5]) continue                                   // beyond this prop's reach
          out.push(list[i], list[i + 1], list[i + 2], list[i + 3], list[i + 4], d)
        }
      }
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    for (const [prop, groups] of this.ready) {
      let list = want.get(prop) ?? []
      if (list.length / 6 > MAX_PER_PROP) {                               // too many: keep the nearest
        const rows = []
        for (let i = 0; i < list.length; i += 6) rows.push(list.slice(i, i + 6))
        rows.sort((a, b) => a[5] - b[5])
        list = rows.slice(0, MAX_PER_PROP).flat()
      }
      const count = list.length / 6
      let pool = this.pools.get(prop)
      if (!pool || pool.capacity < count || pool.meshes.length !== groups.length) {
        if (pool) for (const mesh of pool.meshes) { this.scene.remove(mesh); mesh.dispose() }
        const capacity = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(count, 1))))
        pool = { capacity, meshes: groups.map(({ geometry, material }) => {
          const mesh = new THREE.InstancedMesh(geometry, material, capacity)
          mesh.castShadow = mesh.receiveShadow = true
          mesh.frustumCulled = false
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
          this.scene.add(mesh)
          return mesh
        }) }
        this.pools.set(prop, pool)
      }
      for (let i = 0; i < count; i++) {
        const b = i * 6
        q.setFromAxisAngle(up, list[b + 3])
        m.compose(p.set(list[b], list[b + 1], list[b + 2]), q, s.setScalar(list[b + 4]))
        for (const mesh of pool.meshes) mesh.setMatrixAt(i, m)
      }
      for (const mesh of pool.meshes) { mesh.count = count; mesh.instanceMatrix.needsUpdate = true }
    }
  }

  // ---- planning one tile -------------------------------------------------------------------------------------------
  plan(t) {
    const plan = new Map()
    const add = (prop, x, z, yaw, scale, far) => {
      let list = plan.get(prop)
      if (!list) { list = []; plan.set(prop, list) }
      list.push(x, this.heightAt(x, z), z, yaw, scale, far)
    }
    const free = (x, z, margin = 3.5) => !nearRoad(t.roadIndex, x, z, margin) && !insideAny(t.water, x, z) && !inBuilding(t.objects, x, z)
    const [ox, oz] = t.terrain ? [t.terrain.ox, t.terrain.oz] : [0, 0]
    for (const entry of t.cover ?? []) {
      const code = entry[0]
      if (code === 30) continue                                              // water
      const first = Array.isArray(entry[1]) ? 1 : 2                          // water entries carry a level; others do not
      const rings = []
      for (let r = first; r < entry.length; r++) {
        const flat = entry[r]
        if (!flat || flat.length < 6) continue
        const ring = new Array(flat.length)
        for (let i = 0; i + 1 < flat.length; i += 2) { ring[i] = ox + flat[i] / 10; ring[i + 1] = oz + flat[i + 1] / 10 }
        rings.push(ring)
      }
      if (!rings.length) continue
      for (const rule of AREA) if (rule.codes.includes(code)) this.area(rule, rings, add, free)
      for (const rule of EDGE) if (rule.codes.includes(code)) this.edge(rule, rings, add, free)
    }
    this.plans.set(t.key, plan)
  }

  // a jittered grid over the polygon's box, kept inside the outer ring and outside the holes
  area(rule, rings, add, free) {
    const outer = rings[0], holes = rings.slice(1)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i < outer.length; i += 2) {
      minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i])
      minZ = Math.min(minZ, outer[i + 1]); maxZ = Math.max(maxZ, outer[i + 1])
    }
    const step = Math.sqrt(10000 / rule.n)                                   // metres between candidates for n per hectare
    if (!Number.isFinite(step) || step < 1) return
    for (let z = minZ + step * 0.5; z < maxZ; z += step) {
      for (let x = minX + step * 0.5; x < maxX; x += step) {
        const h1 = hash(x * 1.7 + z * 3.1), h2 = hash(x * 5.3 - z * 2.9), h3 = hash(x * 0.7 + z * 9.1)
        const px = x + (h1 - 0.5) * step * 0.9, pz = z + (h2 - 0.5) * step * 0.9
        if (!insideRing(px, pz, outer)) continue
        let inHole = false
        for (const hole of holes) if (insideRing(px, pz, hole)) { inHole = true; break }
        if (inHole || !free(px, pz)) continue
        add(rule.prop, px, pz, rule.spin ? h3 * Math.PI * 2 : 0, rule.s[0] + h3 * (rule.s[1] - rule.s[0]), rule.far)
      }
    }
  }

  // along every ring edge, stepped, pushed `out` metres inward so hedges sit on the boundary, not over it
  edge(rule, rings, add, free) {
    for (const ring of rings) {
      const n = ring.length / 2
      if (n < 3) continue
      if (hash(ring[0] * 3.7 + ring[1] * 1.3 + rule.gap * 97) > (rule.ring ?? 1)) continue   // this boundary is left bare
      let carry = 0
      for (let i = 0; i < n; i++) {
        const ax = ring[i * 2], az = ring[i * 2 + 1]
        const j = (i + 1) % n, bx = ring[j * 2], bz = ring[j * 2 + 1]
        const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
        if (len < (rule.min ?? 12)) { carry = 0; continue }                  // skip the little jagged bits
        const ux = dx / len, uz = dz / len
        const nx = -uz, nz = ux                                              // the ring winds clockwise in game units: inward
        for (let d = carry; d < len; d += rule.gap) {
          const t = d / len
          const h1 = hash(ax * 2.3 + az * 1.9 + d * 7.7), h2 = hash(ax * 0.9 - az * 4.1 + d * 3.3)
          if (h1 > rule.chance) continue
          const px = ax + dx * t + nx * rule.out, pz = az + dz * t + nz * rule.out
          if (!free(px, pz, 2.5)) continue
          const yaw = Math.atan2(ux, uz) + (h2 - 0.5) * 0.3                  // aligned with the boundary
          add(rule.prop, px, pz, yaw, rule.s[0] + h2 * (rule.s[1] - rule.s[0]), rule.far)
        }
        carry = (carry - len) % rule.gap
        if (carry < 0) carry += rule.gap
      }
    }
  }
}
