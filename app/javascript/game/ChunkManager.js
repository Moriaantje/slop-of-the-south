import * as THREE from "three"
import { TerrainTile } from "game/TerrainTile"
import { buildRoads } from "game/Roads"
import { buildBuildings } from "game/Buildings"

// Streams 500 m tiles in a square around the player and disposes the ones left behind.
export class ChunkManager {
  constructor(scene, config, radius = 2) {
    this.scene = scene
    this.cfg = config
    this.radius = radius
    this.tiles = new Map()     // key "tx_ty" → { group, terrain } or { loading: true }
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

  ready(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    return !!(t && !t.loading)
  }

  heightAt(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    return t && !t.loading ? t.terrain.heightAt(x, z) : 0
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
      let res = await fetch(`/tiles/${tx}_${ty}.json`)          // pre-built static tile
      if (!res.ok) res = await fetch(`/api/tiles/${tx}/${ty}`)  // build on demand
      if (!res.ok) throw new Error(`tile ${key}: ${res.status}`)
      const data = await res.json()
      if (!this.tiles.has(key)) return                          // player already moved away

      const terrain = new TerrainTile(data, this.cfg)
      const group = new THREE.Group()
      group.add(terrain.mesh)
      const roads = buildRoads(data.roads, (x, z) => terrain.heightAt(x, z))
      if (roads) group.add(roads)
      const buildings = buildBuildings(data.buildings)
      if (buildings) group.add(buildings)
      this.scene.add(group)
      this.tiles.set(key, { group, terrain, roads: data.roads })
    } catch (e) {
      console.warn(e)
      this.tiles.delete(key)
    }
  }

  dispose(t) {
    this.scene.remove(t.group)
    t.group.traverse((o) => { o.geometry?.dispose(); if (o.material && !o.material.__shared) o.material.dispose() })
  }
}
