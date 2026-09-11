import * as THREE from "three"
import { TerrainTile } from "game/TerrainTile"
import { buildRoads } from "game/Roads"
import { buildBuildings } from "game/Buildings"
import { buildBuildingMeshes } from "game/BuildingMeshes"
import { buildTrees } from "game/Trees"
import { buildLamps, buildSignals } from "game/Furniture"
import { buildSigns } from "game/Signs"
import { paintCover, buildWater } from "game/Cover"
import { ROAD_LIFT } from "game/Roads"
import { Ortho } from "game/Ortho"
import { waterPolys } from "game/Cover"

// Streams 500 m tiles in a square around the player and disposes the ones left behind. Tile JSON is fetched in the
// background; building the meshes is synchronous and heavy (a dense town tile is ~1 MB with 60k building vertices), so
// fetched tiles wait in a queue and at most one is built per frame — crossing a tile edge queues five at once, and
// building them all in one frame was a visible hitch. Every destructible object a tile builds is registered on the
// tile entry; hooks.onTile / hooks.onDrop hand them to the Destructibles index.
export class ChunkManager {
  constructor(scene, config, hooks = {}, radius = 2) {
    this.scene = scene
    this.cfg = config
    this.hooks = hooks
    this.radius = radius
    this.tiles = new Map()     // key "tx_ty" → { key, group, terrain, roads, roadIndex, junctions, biome, objects } or { loading: true }
    this.queue = []            // fetched tile data waiting to be built
    this.ortho = new Ortho(config)   // aerial photos for the terrain, streamed in the background
  }

  // game coords → tile indices (RD metres / tile size)
  tileIndex(x, z) {
    const s = this.cfg.tile_size
    return [Math.floor((x + this.cfg.origin.x) / s), Math.floor((this.cfg.origin.y - z) / s)]
  }

  update(x, z) {
    const [cx, cy] = this.tileIndex(x, z)
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
    // build one queued tile per frame, the one under the player first
    if (this.queue.length) {
      const here = `${cx}_${cy}`
      const i = Math.max(0, this.queue.findIndex((q) => q.key === here))
      const [q] = this.queue.splice(i, 1)
      if (this.tiles.get(q.key)?.loading) this.build(q.tx, q.ty, q.key, q.data)
    }
  }

  // drop every loaded tile so the next update streams pristine copies (a new round restores the world)
  reload() {
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

  build(tx, ty, key, data) {
    try {
      const objects = new Map(), reg = (key, handle) => objects.set(key, handle)
      const paint = data.cover?.length ? paintCover(data.cover) : null
      const terrain = new TerrainTile(data, this.cfg, paint)
      const coverClass = paint ? classifyCover(paint.image) : null          // where grass may grow (Grass.js)
      this.ortho.request({ key, tx, ty, terrain })
      const group = new THREE.Group()
      group.add(terrain.mesh)
      const water = buildWater(data.cover ?? [], (x, z) => terrain.heightAt(x, z), data.origin)
      if (water) group.add(water)
      const roads = buildRoads(data.roads, data.junctions, data.biome, (x, z) => terrain.heightAt(x, z))
      if (roads) group.add(roads)
      const roadIndex = indexRoads(data.roads, data.junctions ?? [])
      const buildings = buildBuildings(withoutMeshed(data.buildings, data.meshes), reg)
      if (buildings) group.add(buildings)
      const meshes = buildBuildingMeshes(data.meshes, reg)
      if (meshes) group.add(meshes)
      const trees = buildTrees(data.trees, (x, z) => terrain.heightAt(x, z), reg)
      if (trees) group.add(trees)
      if (data.furniture) {                                       // lamp posts, traffic lights, traffic signs
        const ground = (x, z) => roadHeight(roadIndex, x, z, terrain)
        for (const part of [buildLamps(data.furniture.lamps, ground, reg), buildSignals(data.furniture.signals, ground, reg), buildSigns(data.furniture.signs, ground, reg)]) if (part) group.add(part)
      }
      // shadows: the ground and the roads receive, everything standing casts and receives
      terrain.mesh.receiveShadow = true
      if (roads) roads.traverse((o) => { if (o.isMesh) o.receiveShadow = true })
      for (const g of [buildings, meshes, trees]) g?.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
      this.scene.add(group)
      const tile = { key, tx, ty, group, terrain, roads: data.roads, roadIndex, junctions: data.junctions ?? [], biome: data.biome, objects, water: waterPolys(data.cover ?? [], data.origin), coverClass, cover: data.cover ?? [] }
      this.tiles.set(key, tile)
      this.hooks.onTile?.(tile)
    } catch (e) {
      console.warn(e)
      this.tiles.delete(key)
    }
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
