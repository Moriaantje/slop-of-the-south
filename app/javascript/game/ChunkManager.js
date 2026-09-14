import * as THREE from "three"
import { TerrainTile } from "game/TerrainTile"
import { buildRoads } from "game/Roads"
import { footprintParts } from "game/Buildings"
import { buildBuildingMeshes } from "game/BuildingMeshes"
import { buildTrees } from "game/Trees"
import { buildLamps, buildSignals } from "game/Furniture"
import { buildSigns } from "game/Signs"
import { paintCover, buildWater } from "game/Cover"
import { ROAD_LIFT } from "game/Roads"
import { Ortho } from "game/Ortho"
import { waterPolys } from "game/Cover"

// Streams 500 m tiles in a square around the player and disposes the ones left behind. Tile JSON is fetched in the
// background; building the meshes is synchronous and heavy (a dense town tile is ~1 MB with 60k building vertices),
// so fetched tiles wait in a queue. Every destructible object a tile builds is registered on the tile entry;
// hooks.onTile / hooks.onDrop hand them to the Destructibles index.
//
// Building one whole tile in one frame was the load hitch. Timed over the province's 409 real tiles, a build costs
// 8 ms for the median tile, 46 ms for the ninetieth percentile and 120 ms for the worst of them — a town tile with
// twelve hundred building parts — and crossing a tile edge queues five tiles at once. So the build is a generator
// that yields between its phases, and within the buildings phase, which is four fifths of the whole cost, between
// slices of a few hundred parts; the driver runs it for a few milliseconds a frame and then stops until the next.
// The tile still appears all at once, when its last phase has run: a house half-built in the middle of a field
// would be worse than waiting another frame for it.
//
// The slicing is not free. Each slice merges into its own set of meshes over the six shared building materials, so
// a tile cut into four slices draws four times as many building calls as one cut into one. Hence the cap: only
// tiles past a few hundred parts are sliced at all — three quarters of the province is one slice — and no tile is
// ever cut into more than a handful.
const BUILD_MS = 7             // ms per frame the builder may spend; the rest of the frame belongs to the game
const SLICE_PARTS = 260        // building parts per slice: about 16 ms of merging on this machine
const MAX_SLICES = 5           // …but a town tile's draw calls must not multiply out of hand either

export class ChunkManager {
  constructor(scene, config, hooks = {}, radius = 2) {
    this.scene = scene
    this.cfg = config
    this.hooks = hooks
    this.radius = radius
    this.tiles = new Map()     // key "tx_ty" → { key, group, terrain, roads, roadIndex, junctions, biome, objects } or { loading: true }
    this.queue = []            // fetched tile data waiting to be built
    this.job = null            // the tile being built right now, part-way through its generator
    this.cx = 0; this.cy = 0   // the player's tile, so the builder knows which queued tile to take first
    this.budgetMs = BUILD_MS
    this.ortho = new Ortho(config)   // aerial photos for the terrain, streamed in the background
  }

  // game coords → tile indices (RD metres / tile size)
  tileIndex(x, z) {
    const s = this.cfg.tile_size
    return [Math.floor((x + this.cfg.origin.x) / s), Math.floor((this.cfg.origin.y - z) / s)]
  }

  update(x, z) {
    const [cx, cy] = this.tileIndex(x, z)
    this.cx = cx; this.cy = cy
    const wanted = new Set()
    for (let dy = -this.radius; dy <= this.radius; dy++)
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const key = `${cx + dx}_${cy + dy}`
        wanted.add(key)
        if (!this.tiles.has(key)) this.load(cx + dx, cy + dy, key)
      }
    for (const [key, t] of this.tiles)
      if (!wanted.has(key) && !t.loading) { this.dispose(t); this.tiles.delete(key) }
    this.ortho.update(cx, cy)
    this.work(() => performance.now())
  }

  // Spends at most BUILD_MS on tile building, then leaves the rest of the frame alone. One step always runs, even
  // if the budget is already gone, so a slow machine still makes progress instead of never finishing a tile.
  // `now` is injected so the step machine can be driven deterministically from a test.
  work(now = () => performance.now()) {
    const deadline = now() + this.budgetMs
    do {
      if (!this.job) {
        if (!this.queue.length) return
        const here = `${this.cx}_${this.cy}`                       // the tile under the player is built first
        const i = Math.max(0, this.queue.findIndex((q) => q.key === here))
        const [q] = this.queue.splice(i, 1)
        if (!this.tiles.get(q.key)?.loading) continue              // the player moved away while it was in flight
        this.job = { key: q.key, steps: this.buildSteps(q.tx, q.ty, q.key, q.data), group: null }
      }
      if (!this.step()) return                                     // the job blew up: stop, try again next frame
    } while (now() < deadline)
  }

  // one step of the tile being built; false means the driver should stop for this frame
  step() {
    const job = this.job
    if (!this.tiles.get(job.key)?.loading) { this.abandon(job); this.job = null; return true }
    let out
    try {
      out = job.steps.next()
    } catch (e) {
      console.warn(e)
      this.abandon(job)
      this.tiles.delete(job.key)
      this.job = null
      return false
    }
    if (out.value?.group) job.group = out.value.group             // so an abandoned build can free what it made
    if (out.done) this.job = null
    return true
  }

  // a build that will never finish: free the geometry it managed to make before dropping it
  abandon(job) {
    if (!job.group) return
    job.group.traverse((o) => {
      o.userData.onDispose?.()
      if (o.isInstancedMesh) o.dispose()
      if (o.geometry && !o.geometry.__shared) o.geometry.dispose()
      if (o.material && !o.material.__shared) { o.material.map?.dispose(); o.material.dispose() }
    })
  }

  // drop every loaded tile so the next update streams pristine copies (a new round restores the world)
  reload() {
    if (this.job) { this.abandon(this.job); this.tiles.delete(this.job.key); this.job = null }
    for (const [key, t] of this.tiles) if (!t.loading) { this.dispose(t); this.tiles.delete(key) }
  }

  ready(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    return !!(t && !t.loading)
  }

  // share of the tiles around (x, z) that are in, for the loading screen
  readyFraction(x, z) {
    const [cx, cy] = this.tileIndex(x, z)
    let n = 0, total = 0
    for (let dy = -this.radius; dy <= this.radius; dy++)
      for (let dx = -this.radius; dx <= this.radius; dx++) { total++; const t = this.tiles.get(`${cx + dx}_${cy + dy}`); if (t && !t.loading) n++ }
    return n / total
  }

  // Height under (x, z): the road surface when on a road (blended to the terrain over the ribbon edge), else the terrain.
  // the surface level of the water at (x, z), or null on dry land (and over water whose level is unknown)
  waterLevelAt(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    if (!t || t.loading || !t.water?.length) return null
    for (const w of t.water) if (insideRing(x, z, w.ring)) return w.level
    return null
  }

  heightAt(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    if (!t || t.loading) return 0
    return roadHeight(t.roadIndex, x, z, t.terrain)
  }

  // Biome label of the tile under (x, z), for the HUD.
  biomeAt(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    return t && !t.loading ? t.biome : null
  }

  // Road polylines of the tile under (x, z) and its eight neighbours, for the street sign.
  roadsAround(x, z) {
    const [cx, cy] = this.tileIndex(x, z)
    const out = []
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const t = this.tiles.get(`${cx + dx}_${cy + dy}`)
        if (t && !t.loading) out.push(...t.roads)
      }
    return out
  }

  async load(tx, ty, key) {
    this.tiles.set(key, { loading: true })
    try {
      let res = await fetch(`/tiles/${tx}_${ty}.json?v=${this.cfg.tiles_version ?? 0}`)   // pre-built static tile; ?v busts the browser cache after a rebuild
      if (!res.ok) res = await fetch(`/api/tiles/${tx}/${ty}`)  // build on demand
      if (!res.ok) throw new Error(`tile ${key}: ${res.status}`)
      const data = await res.json()
      if (!this.tiles.has(key)) return                          // player already moved away
      this.queue.push({ tx, ty, key, data })
    } catch (e) {
      console.warn(e)
      this.tiles.delete(key)
    }
  }

  // The tile build, cut into steps. Everything between two `yield`s runs inside one frame, so the phases are sized
  // by what they measured at: terrain, water and roads are a couple of milliseconds each, the buildings are the
  // whole rest of the cost and get sliced, the trees are cheap until a tile happens to have four thousand of them.
  *buildSteps(tx, ty, key, data) {
    const objects = new Map(), reg = (k, handle) => objects.set(k, handle)
    const group = new THREE.Group()
    const paint = data.cover?.length ? paintCover(data.cover) : null
    const terrain = new TerrainTile(data, this.cfg, paint)
    terrain.mesh.receiveShadow = true                             // the ground receives; nothing about it casts
    group.add(terrain.mesh)
    this.ortho.request({ key, tx, ty, terrain })
    const height = (x, z) => terrain.heightAt(x, z)
    yield { group }                                               // hand the group over so an abandoned build frees it

    const coverClass = paint ? classifyCover(paint.image) : null  // where grass may grow (Grass.js)
    const water = buildWater(data.cover ?? [], height, data.origin)
    if (water) group.add(water)
    yield

    const roads = buildRoads(data.roads, data.junctions, data.biome, height)
    if (roads) { roads.traverse((o) => { if (o.isMesh) o.receiveShadow = true }); group.add(roads) }
    const roadIndex = indexRoads(data.roads, data.junctions ?? [])
    yield

    // One merged group for both kinds of building. The BAG meshes and the fallback footprints share the same six
    // materials, so building them separately merged each material twice and doubled a tile's building draw calls —
    // which is also why the slices below are as large as the frame budget will bear rather than as small as it likes.
    const parts = [...(data.meshes ?? []), ...footprintParts(withoutMeshed(data.buildings, data.meshes))]
    yield                                                         // withoutMeshed is quadratic in a dense tile: its own step

    for (const slice of sliceParts(parts)) {
      const meshes = buildBuildingMeshes(slice, reg)
      if (meshes) { meshes.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } }); group.add(meshes) }
      yield
    }

    const trees = buildTrees(data.trees, height, reg)
    if (trees) { trees.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } }); group.add(trees) }
    yield

    if (data.furniture) {                                         // lamp posts, traffic lights, traffic signs
      const ground = (x, z) => roadHeight(roadIndex, x, z, terrain)
      for (const part of [buildLamps(data.furniture.lamps, ground, reg), buildSignals(data.furniture.signals, ground, reg), buildSigns(data.furniture.signs, ground, reg)]) if (part) group.add(part)
    }
    this.scene.add(group)
    const tile = { key, tx, ty, group, terrain, roads: data.roads, roadIndex, junctions: data.junctions ?? [], biome: data.biome, objects, water: waterPolys(data.cover ?? [], data.origin), coverClass, cover: data.cover ?? [] }
    this.tiles.set(key, tile)
    this.hooks.onTile?.(tile)
  }

  dispose(t) {
    this.hooks.onDrop?.(t)
    this.ortho.cancel(t.key)
    this.scene.remove(t.group)
    t.group.traverse((o) => {
      o.userData.onDispose?.()                                             // e.g. traffic lights leave the animation set
      if (o.isInstancedMesh) o.dispose()                                   // instance buffers
      if (o.geometry && !o.geometry.__shared) o.geometry.dispose()
      if (o.material && !o.material.__shared) { o.material.map?.dispose(); o.material.dispose() }
    })
  }
}

// How a tile's building parts are cut up to fit the frame budget. Most tiles come back whole: the median tile in
// the province has 58 parts and only one in four has more than three hundred, so most of the province pays nothing
// for this at all. The cap is what stops the densest town tile — twelve hundred parts — buying its smooth arrival
// with five times the building draw calls it needs for the rest of its life on screen.
export function sliceParts(parts, per = SLICE_PARTS, max = MAX_SLICES) {
  if (!parts?.length) return []
  const n = Math.min(max, Math.max(1, Math.ceil(parts.length / per)))
  if (n === 1) return [parts]
  const size = Math.ceil(parts.length / n)
  const out = []
  for (let i = 0; i < parts.length; i += size) out.push(parts.slice(i, i + size))
  return out
}

// ---- road height lookup -----------------------------------------------------------------------------------------
// A uniform grid over the tile's road segments so a height query touches a handful of segments instead of all
// ~800 in a town tile: the suspension asks five times per frame, the camera once more.
const EDGE = 0.3                                          // blend band either side of the ribbon edge
const CELL = 25

function indexRoads(roads, junctions) {
  const segs = []                                         // [ax, az, ay, bx, bz, by, hw]
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, pad = EDGE
  for (const road of roads ?? []) {
    const hw = road.width / 2, pts = road.pts
    pad = Math.max(pad, hw + EDGE)
    for (let i = 1; i < pts.length; i++) {
      const [ax, az, ay] = pts[i - 1], [bx, bz, by] = pts[i]
      segs.push([ax, az, ay, bx, bz, by, hw])
      minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx); minZ = Math.min(minZ, az, bz); maxZ = Math.max(maxZ, az, bz)
    }
  }
  for (const [jx, jz, , r] of junctions) { pad = Math.max(pad, r + EDGE); minX = Math.min(minX, jx); maxX = Math.max(maxX, jx); minZ = Math.min(minZ, jz); maxZ = Math.max(maxZ, jz) }
  if (!segs.length && !junctions.length) return null
  const x0 = minX - pad, z0 = minZ - pad
  const nx = Math.ceil((maxX + pad - x0) / CELL) + 1, nz = Math.ceil((maxZ + pad - z0) / CELL) + 1
  const cells = new Array(nx * nz)
  const put = (bx0, bz0, bx1, bz1, item) => {
    const cx0 = Math.max(0, Math.floor((bx0 - x0) / CELL)), cx1 = Math.min(nx - 1, Math.floor((bx1 - x0) / CELL))
    const cz0 = Math.max(0, Math.floor((bz0 - z0) / CELL)), cz1 = Math.min(nz - 1, Math.floor((bz1 - z0) / CELL))
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) (cells[cz * nx + cx] ??= []).push(item)
  }
  for (const s of segs) {
    const r = s[6] + EDGE
    put(Math.min(s[0], s[3]) - r, Math.min(s[1], s[4]) - r, Math.max(s[0], s[3]) + r, Math.max(s[1], s[4]) + r, s)
  }
  for (const j of junctions) { const r = j[3] + EDGE; put(j[0] - r, j[1] - r, j[0] + r, j[1] + r, j) }   // junctions are 4-element arrays
  return { x0, z0, nx, nz, cells, cell: CELL }
}

// Ground height at (x, z): on a road ribbon or junction patch it is the surface the client draws (the road level or the
// terrain, whichever is higher, plus ROAD_LIFT); across a band of ±EDGE around the ribbon edge it blends smoothly into
// the terrain so wheels roll over the curb instead of snapping. Continuous in (x, z), so per-wheel probing never jitters.
function roadHeight(index, x, z, terrain) {
  const ground = terrain.heightAt(x, z)
  if (!index) return ground
  const cx = Math.floor((x - index.x0) / CELL), cz = Math.floor((z - index.z0) / CELL)
  if (cx < 0 || cz < 0 || cx >= index.nx || cz >= index.nz) return ground
  const items = index.cells[cz * index.nx + cx]
  if (!items) return ground
  let best = null, bestOut = Infinity                       // distance outside the ribbon edge (negative inside)
  for (const s of items) {
    let out, h
    if (s.length === 4) {                                   // junction disc [x, z, y, r]
      out = Math.hypot(s[0] - x, s[1] - z) - s[3]; h = s[2]
    } else {
      const dx = s[3] - s[0], dz = s[4] - s[1]
      const len2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / len2))
      out = Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z) - s[6]; h = s[2] + (s[5] - s[2]) * t
    }
    if (out <= EDGE && out < bestOut) { bestOut = out; best = h }
  }
  if (best === null) return ground
  const on = Math.max(best, ground) + ROAD_LIFT
  if (bestOut <= -EDGE) return on
  const k0 = (bestOut + EDGE) / (2 * EDGE), k = k0 * k0 * (3 - 2 * k0)   // smoothstep over the curb band
  return on + (ground - on) * k
}

// The fallback blocks (OSM footprints, LoD1.3 parts) that stand where a LoD2.2 mesh already stands: a few hundred per
// province slipped through the importer's bag3d-wins rule and rendered as a flat-coloured box through the textured
// house. Any footprint vertex or centroid inside a mesh footprint (or the other way round) drops the block.
function withoutMeshed(buildings, meshes) {
  if (!buildings?.length || !meshes?.length) return buildings ?? []
  const fps = []
  for (const m of meshes) for (const r of m.fp ?? []) if (r.length >= 6) fps.push(r)
  return buildings.filter((b) => {
    const fp = b.footprint
    if (!fp || fp.length < 3) return true
    let cx = 0, cz = 0
    for (const p of fp) { cx += p[0]; cz += p[1] }
    cx /= fp.length; cz /= fp.length
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const p of fp) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]) }
    const flat = fp.flat()
    for (const r of fps) {
      // cheap reject on the boxes first
      let rMinX = Infinity, rMaxX = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity
      for (let i = 0; i < r.length; i += 2) { rMinX = Math.min(rMinX, r[i]); rMaxX = Math.max(rMaxX, r[i]); rMinZ = Math.min(rMinZ, r[i + 1]); rMaxZ = Math.max(rMaxZ, r[i + 1]) }
      if (rMaxX < minX || rMinX > maxX || rMaxZ < minZ || rMinZ > maxZ) continue
      if (insideRing(cx, cz, r)) return false
      for (const p of fp) if (insideRing(p[0], p[1], r)) return false
      for (let i = 0; i < r.length; i += 2) if (insideRing(r[i], r[i + 1], flat)) return false
    }
    return true
  })
}

// the painted land cover shrunk to a 128 px class grid (RGBA, 1 byte per channel): green means grass may grow there
function classifyCover(canvas, n = 128) {
  const c = document.createElement("canvas"); c.width = c.height = n
  const ctx = c.getContext("2d", { willReadFrequently: true })
  ctx.drawImage(canvas, 0, 0, n, n)
  return { n, data: ctx.getImageData(0, 0, n, n).data }
}

// even-odd point-in-polygon over a flat [x, z, ...] ring
function insideRing(x, z, r) {
  let inside = false
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1]
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
