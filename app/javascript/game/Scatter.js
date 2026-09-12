import * as THREE from "three"
import { nearRoad, insideRing, insideAny, inBuilding, hash } from "game/Placement"
import { noAO } from "game/Layers"
import { noiseTexture } from "game/Textures"
import { KIT, kitPiece, kitStoneMaterial } from "game/Kit"

// The world between the roads and the houses: what a Limburg landscape is actually full of. The BGT land cover
// already says where every meadow, field, wood, orchard and yard lies, so the props go where they belong — hedge
// banks and fence posts along the field boundaries that divide the whole province, hay bales and a cart on the
// arable, brambles, stumps and cordwood in the woods, molehills and wild flowers in the meadows, reed beds along
// every watercourse, dry-stone walls on the Zuid-Limburg banks and a five-bar gate where a hedge breaks for a track.
// Placement is deterministic per tile (a hash of the position), computed once when the tile arrives, and the props
// are drawn from global instanced pools refilled only when the loaded tiles change: a thousand barrels cost one
// draw call. Most of the pieces are generated in Kit.js, which means most of them cannot fail to load; the rest are
// the CC0 kit models (Assets.MODELS, public/models/props) and those get the weathering pass below.
//
// Weathering is the difference between a kit and a place. A flat-coloured barrel is a toy; the same barrel with a
// slow tint that varies over tens of metres, a fine grain over centimetres, dirt gathered at its foot and moss
// creeping up the shaded side is a barrel that has stood in a yard. It is all done in the fragment shader from one
// shared noise texture, and it reads the world position through the instance matrix so that no two of a thousand
// instances come out the same — which is exactly the trick a per-object texture could never afford.
//
// cover entries are [code, ring, hole, ...] with rings as flat decimetres from the tile's north-west corner;
// codes: 1/2 grass, 3 urban green, 4 arable, 5 orchard, 6 tree nursery, 7 wood, 20 yard, 30 water.
const AREA = [
  // code            prop          per hectare  scale          reach (m)  tilt
  { codes: [4],      prop: "hay",      n: 0.9,  s: [0.9, 1.4],  far: 320, spin: true },
  { codes: [4],      prop: "cart",     n: 0.08, s: [0.9, 1.1],  far: 280, spin: true },
  { codes: [4],      prop: "molehill", n: 2.0,  s: [0.7, 1.3],  far: 95,  spin: true },
  { codes: [7],      prop: "bush",     n: 4.0,  s: [0.8, 1.6],  far: 300, spin: true },
  { codes: [7],      prop: "bramble",  n: 3.2,  s: [0.8, 1.7],  far: 190, spin: true },
  { codes: [7],      prop: "stump",    n: 0.9,  s: [0.7, 1.6],  far: 170, spin: true },
  { codes: [7],      prop: "rock",     n: 1.6,  s: [0.5, 1.5],  far: 300, spin: true },
  { codes: [7],      prop: "logpile",  n: 0.12, s: [0.9, 1.2],  far: 210, spin: true },
  { codes: [1, 2],   prop: "rock",     n: 0.35, s: [0.5, 1.3],  far: 320, spin: true },
  { codes: [1, 2],   prop: "bush",     n: 0.4,  s: [0.8, 1.3],  far: 300, spin: true },
  { codes: [1, 2],   prop: "molehill", n: 4.0,  s: [0.7, 1.4],  far: 95,  spin: true },
  { codes: [1, 2],   prop: "flowers",  n: 12.0, s: [0.8, 1.5],  far: 115, spin: true },
  { codes: [3],      prop: "planter",  n: 1.2,  s: [0.9, 1.2],  far: 220, spin: true },
  { codes: [3],      prop: "bench",    n: 0.8,  s: [1.0, 1.0],  far: 220, spin: true },
  { codes: [3],      prop: "bush",     n: 3.0,  s: [0.7, 1.2],  far: 250, spin: true },
  { codes: [3],      prop: "flowers",  n: 6.0,  s: [0.8, 1.3],  far: 115, spin: true },
  { codes: [20],     prop: "barrel",   n: 3.0,  s: [0.85, 1.15], far: 200, spin: true },
  { codes: [20],     prop: "crate",    n: 2.5,  s: [0.8, 1.3],  far: 200, spin: true },
  { codes: [20],     prop: "hay",      n: 1.2,  s: [0.9, 1.2],  far: 220, spin: true },
  { codes: [20],     prop: "planter",  n: 1.5,  s: [0.9, 1.2],  far: 200, spin: true },
  { codes: [20],     prop: "logpile",  n: 0.9,  s: [0.9, 1.2],  far: 210, spin: true },
  { codes: [5, 6],   prop: "crate",    n: 0.8,  s: [0.9, 1.2],  far: 220, spin: true },
  { codes: [5, 6],   prop: "flowers",  n: 5.0,  s: [0.8, 1.3],  far: 115, spin: true },
]
// Along the boundary of a cover polygon: the hedge banks, walls, gates and field trees that draw the Limburg grid.
// `ring` is the chance that a given boundary gets this treatment at all (not every field is hedged, not every yard
// fenced), `chance` the chance per step along it, `min` the shortest edge worth dressing, and `out` how far inward
// the piece is pushed so it sits on the boundary rather than over it — negative to sit outside, which is how the
// reeds end up on the bank of a watercourse instead of in the middle of it.
const EDGE = [
  { codes: [1, 2],  prop: "hedge",    gap: 1.25, chance: 0.97, ring: 0.42, min: 14, s: [0.95, 1.30], far: 330, out: 0.9 },
  { codes: [1, 2],  prop: "fence",    gap: 3.2,  chance: 0.80, ring: 0.22, min: 28, s: [1.0, 1.0],   far: 260, out: 0.4 },
  { codes: [1, 2],  prop: "drystone", gap: 1.85, chance: 0.95, ring: 0.10, min: 26, s: [0.95, 1.15], far: 250, out: 0.5 },
  { codes: [1, 2],  prop: "gate",     gap: 95,   chance: 0.55, ring: 0.35, min: 44, s: [0.95, 1.10], far: 210, out: 0.9 },
  { codes: [4],     prop: "hedge",    gap: 1.45, chance: 0.72, ring: 0.40, min: 18, s: [1.0, 1.40],  far: 330, out: 1.2 },
  { codes: [4],     prop: "pollard",  gap: 23.0, chance: 0.65, ring: 0.45, min: 30, s: [6.0, 9.5],   far: 340, out: 1.5, spin: true },
  { codes: [20],    prop: "fence",    gap: 3.0,  chance: 0.80, ring: 0.30, min: 16, s: [1.0, 1.0],   far: 220, out: 0.3 },
  { codes: [20],    prop: "gate",     gap: 70,   chance: 0.60, ring: 0.40, min: 22, s: [0.95, 1.10], far: 210, out: 0.4 },
  { codes: [7],     prop: "hedge",    gap: 1.50, chance: 0.85, ring: 0.65, min: 14, s: [1.10, 1.65], far: 320, out: 0.8 },
  { codes: [7],     prop: "bramble",  gap: 3.4,  chance: 0.60, ring: 0.50, min: 14, s: [0.9, 1.5],   far: 200, out: 1.6 },
  { codes: [30],    prop: "reed",     gap: 1.3,  chance: 0.85, ring: 0.80, min: 8,  s: [0.7, 1.3],   far: 190, out: -0.9, water: true, spin: true },
]
// how many of a prop may stand at once; the nearest survive when a landscape asks for more
const MAX_PER_PROP = 800
const CAP = { hedge: 2200, reed: 900, flowers: 700, molehill: 520, drystone: 900, bramble: 500, pollard: 220 }
const WATER_CODE = 30

// ---- the boulders: a squashed icosahedron pushed about by noise, mottled per face, flat shaded ------------------
const rockGeos = Array.from({ length: 3 }, (_, v) => {
  const g = new THREE.IcosahedronGeometry(0.5, 1)   // polyhedra come non-indexed already
  const p = g.attributes.position
  const col = new Float32Array(p.count * 3)
  const tint = new THREE.Color()
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
    const n = 0.72 + 0.42 * hash(Math.round(x * 37 + y * 11 + z * 23 + v * 131) * 0.5)
    p.setXYZ(i, x * n * 1.25, y * n * 0.72, z * n * 1.1)
    // grey shot through with a little ochre and a little green, so no two faces are the same stone
    const k = hash(Math.floor(i / 3) * 7.3 + v * 11.1)
    tint.setRGB(0.52 + k * 0.20, 0.51 + k * 0.19, 0.47 + k * 0.15)
    col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  g.__shared = true
  return g
})

// Dirt, damp and the slow drift of tone that keeps a thousand copies of one model from looking like a thousand
// copies of one model. The world position is read through the instance matrix, which is the whole point: read it off
// the model matrix instead and every instance of the pool gets the same patch of noise.
export function weatherProp(m) {
  if (!m || m.userData.__weathered) return m
  m.userData.__weathered = true
  // these may be three's own prototype methods, which read `this`: bind before wrapping
  const prev = m.onBeforeCompile.bind(m)
  const prevKey = m.customProgramCacheKey.bind(m)
  m.onBeforeCompile = (shader) => {
    prev(shader)
    shader.uniforms.uNoise = { value: noiseTexture() }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vPropW;\nvarying float vPropY;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
\t{
\t\t#ifdef USE_INSTANCING
\t\tvPropW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
\t\t#else
\t\tvPropW = (modelMatrix * vec4(transformed, 1.0)).xyz;
\t\t#endif
\t\tvPropY = transformed.y;
\t}`)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uNoise;\nvarying vec3 vPropW;\nvarying float vPropY;\nfloat propGrain;")
      .replace("#include <map_fragment>", `#include <map_fragment>
\t{
\t\tfloat macro = texture2D(uNoise, vPropW.xz * 0.0031).r;
\t\tpropGrain = texture2D(uNoise, vPropW.xz * 0.75 + vPropW.y * 0.21).r;
\t\tdiffuseColor.rgb *= (0.80 + 0.36 * macro) * (0.88 + 0.24 * propGrain);
\t\tfloat foot = 1.0 - smoothstep(0.0, 0.55, vPropY);
\t\tdiffuseColor.rgb *= mix(1.0, 0.66, foot * 0.85);
\t\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.19, 0.26, 0.10), foot * smoothstep(0.60, 0.86, propGrain) * 0.55);
\t}`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = clamp(roughnessFactor + 0.22 - 0.34 * propGrain, 0.12, 1.0);")
  }
  m.customProgramCacheKey = () => `${prevKey()}|prop-weathered`
  m.needsUpdate = true
  return m
}

export class Scatter {
  constructor({ scene, assets, heightAt }) {
    this.scene = scene; this.assets = assets; this.heightAt = heightAt
    this.plans = new Map()       // tile key → { prop → [x, y, z, yaw, scale, far] }
    this.pools = new Map()       // prop → { capacity, meshes }
    this.ready = new Map()       // prop → [{ geometry, material }] once baked
    this.signature = ""
    for (const prop of new Set([...AREA, ...EDGE].map((r) => r.prop))) this.prepare(prop)
  }

  prepare(prop) {
    if (prop === "rock") { this.ready.set(prop, rockGeos.map((geometry) => ({ geometry, material: weatherProp(kitStoneMaterial()) }))); return }
    if (KIT.includes(prop)) { this.ready.set(prop, kitPiece(prop)); return }
    this.assets.instanced(prop).then((groups) => {
      if (!groups.length) return
      for (const g of groups) weatherProp(g.material)
      this.ready.set(prop, groups)
      this.signature = ""
    })
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
      const cap = CAP[prop] ?? MAX_PER_PROP
      if (list.length / 6 > cap) {                                        // too many: keep the nearest
        const rows = []
        for (let i = 0; i < list.length; i += 6) rows.push(list.slice(i, i + 6))
        rows.sort((a, b) => a[5] - b[5])
        list = rows.slice(0, cap).flat()
      }
      const count = list.length / 6
      let pool = this.pools.get(prop)
      if (!pool || pool.capacity < count || pool.meshes.length !== groups.length) {
        if (pool) for (const mesh of pool.meshes) { this.scene.remove(mesh); mesh.dispose() }
        const capacity = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(count, 1))))
        pool = { capacity, meshes: groups.map(({ geometry, material }) => {
          const mesh = new THREE.InstancedMesh(geometry, material, capacity)
          if (material.alphaTest > 0 || material.transparent) noAO(mesh)   // a card would occlude as its whole quad
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
      for (const mesh of pool.meshes) { mesh.count = count; mesh.instanceMatrix.needsUpdate = true; mesh.visible = count > 0 }
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
      // nothing stands on open water; only the boundary rules that ask for it dress a watercourse, from the bank
      if (code !== WATER_CODE) for (const rule of AREA) if (rule.codes.includes(code)) this.area(rule, rings, add, free)
      // A boundary gets at most ONE treatment. Rolling each rule's own dice independently let a hedgerow, a post
      // fence and a dry-stone wall all win the same field edge, drawn straight into one another: a wooden fence with
      // a stone wall standing inside it. The rules that apply to this cover class are weighted by their own `ring`
      // chance and one is drawn per ring; the rest of the weight leaves that boundary bare.
      const applicable = EDGE.filter((r) => r.codes.includes(code) && (code !== WATER_CODE || r.water))
      if (applicable.length) for (const ring of rings) {
        const rule = pickEdge(applicable, ring)
        if (rule) this.edge(rule, [ring], add, free)
      }
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
          const yaw = rule.spin ? h1 * Math.PI * 2 : Math.atan2(ux, uz) + (h2 - 0.5) * 0.3   // aligned with the boundary
          add(rule.prop, px, pz, yaw, rule.s[0] + h2 * (rule.s[1] - rule.s[0]), rule.far)
        }
        carry = (carry - len) % rule.gap
        if (carry < 0) carry += rule.gap
      }
    }
  }
}

// Which treatment a boundary gets, if any. The rules' `ring` chances are laid end to end and one hash of the ring's
// first vertex picks a point along that line; past the end of the last rule the boundary is left bare. Deterministic,
// so a field looks the same every time you drive past it.
function pickEdge(rules, ring) {
  const roll = hash(ring[0] * 3.7 + ring[1] * 1.3 + 97)
  let at = 0
  for (const rule of rules) {
    at += rule.ring ?? 1
    if (roll < at) return rule
  }
  return null
}
