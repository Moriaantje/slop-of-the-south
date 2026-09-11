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

// Streams 500 m tiles in a square around the player and disposes the ones left behind. Every destructible object a
// tile builds is registered on the tile entry; hooks.onTile / hooks.onDrop hand them to the Destructibles index.
export class ChunkManager {
  constructor(scene, config, hooks = {}, radius = 2) {
    this.scene = scene
    this.cfg = config
    this.hooks = hooks
    this.radius = radius
    this.tiles = new Map()     // key "tx_ty" → { group, terrain, roads, biome, objects } or { loading: true }
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
  }

  // drop every loaded tile so the next update streams pristine copies (a new round restores the world)
  reload() {
    for (const [key, t] of this.tiles) if (!t.loading) { this.dispose(t); this.tiles.delete(key) }
  }

  ready(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    return !!(t && !t.loading)
  }

  // Height under (x, z): the road surface when on a road (blended to the terrain over the ribbon edge), else the terrain.
  heightAt(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    if (!t || t.loading) return 0
    return roadHeight(t.roads, t.junctions, x, z, t.terrain)
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

      const objects = new Map(), reg = (key, handle) => objects.set(key, handle)
      const terrain = new TerrainTile(data, this.cfg, data.cover?.length ? paintCover(data.cover) : null)
      const group = new THREE.Group()
      group.add(terrain.mesh)
      const water = buildWater(data.cover ?? [], (x, z) => terrain.heightAt(x, z), data.origin)
      if (water) group.add(water)
      const roads = buildRoads(data.roads, data.junctions, data.biome, (x, z) => terrain.heightAt(x, z))
      if (roads) group.add(roads)
      const buildings = buildBuildings(data.buildings, reg)
      if (buildings) group.add(buildings)
      const meshes = buildBuildingMeshes(data.meshes, reg)
      if (meshes) group.add(meshes)
      const trees = buildTrees(data.trees, (x, z) => terrain.heightAt(x, z), reg)
      if (trees) group.add(trees)
      if (data.furniture) {                                       // lamp posts, traffic lights, traffic signs
        const ground = (x, z) => roadHeight(data.roads, data.junctions, x, z, terrain)
        for (const part of [buildLamps(data.furniture.lamps, ground, reg), buildSignals(data.furniture.signals, ground, reg), buildSigns(data.furniture.signs, ground, reg)]) if (part) group.add(part)
      }
      this.scene.add(group)
      const tile = { key, tx, ty, group, terrain, roads: data.roads, junctions: data.junctions ?? [], biome: data.biome, objects }
      this.tiles.set(key, tile)
      this.hooks.onTile?.(tile)
    } catch (e) {
      console.warn(e)
      this.tiles.delete(key)
    }
  }

  dispose(t) {
    this.hooks.onDrop?.(t)
    this.scene.remove(t.group)
    t.group.traverse((o) => {
      o.userData.onDispose?.()                                             // e.g. traffic lights leave the animation set
      if (o.isInstancedMesh) o.dispose()                                   // instance buffers
      if (o.geometry && !o.geometry.__shared) o.geometry.dispose()
      if (o.material && !o.material.__shared) { o.material.map?.dispose(); o.material.dispose() }
    })
  }
}

// Ground height at (x, z): on a road ribbon or junction patch it is the surface the client draws (the road level or the
// terrain, whichever is higher, plus ROAD_LIFT); across a band of ±EDGE around the ribbon edge it blends smoothly into
// the terrain so wheels roll over the curb instead of snapping. Continuous in (x, z), so per-wheel probing never jitters.
const EDGE = 0.3
function roadHeight(roads, junctions, x, z, terrain) {
  const ground = terrain.heightAt(x, z)
  let best = null, bestOut = Infinity                       // distance outside the ribbon edge (negative inside)
  for (const road of roads ?? []) {
    const hw = road.width / 2, pts = road.pts
    for (let i = 1; i < pts.length; i++) {
      const [ax, az, ay] = pts[i - 1], [bx, bz, by] = pts[i]
      const dx = bx - ax, dz = bz - az
      const len2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2))
      const out = Math.hypot(ax + dx * t - x, az + dz * t - z) - hw
      if (out <= EDGE && out < bestOut) { bestOut = out; best = ay + (by - ay) * t }
    }
  }
  for (const [jx, jz, jy, r] of junctions ?? []) {
    const out = Math.hypot(jx - x, jz - z) - r
    if (out <= EDGE && out < bestOut) { bestOut = out; best = jy }
  }
  if (best === null) return ground
  const on = Math.max(best, ground) + ROAD_LIFT
  if (bestOut <= -EDGE) return on
  const s = (bestOut + EDGE) / (2 * EDGE), k = s * s * (3 - 2 * s)   // smoothstep over the curb band
  return on + (ground - on) * k
}
