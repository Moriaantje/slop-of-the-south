import { flag } from "game/Flags"
import { loadBitmap, bitmapTexture, disposeTexture } from "game/Textures"

// Aerial photographs on the terrain: PDOK's Luchtfoto (Beeldmateriaal Nederland, 25 cm, CC BY 4.0), one WMS GetMap per
// 500 m tile with the tile's own RD envelope as the bbox, so the image drops straight onto the tile's 0..1 UVs.
// Loads run in the background, at most a few at a time, nearest tile first, and are aborted when a tile is dropped;
// one arrived image is applied per frame so the upload never lands in the same frame as a tile build. The 3×3 tiles
// around the player get 1024 px, the rest 512 (upgraded when you come closer). A prefetched copy under public/ortho
// is tried first when the server has one; ?ortho=0 disables, ?ortho=512 lowers the near size.
const WMS = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?request=GetMap&service=WMS&version=1.3.0&layers=Actueel_ortho25&styles=&crs=EPSG:28992&format=image/jpeg"
const TILE = 500
export const wmsUrl = (tx, ty, n) => `${WMS}&bbox=${tx * TILE},${ty * TILE},${(tx + 1) * TILE},${(ty + 1) * TILE}&width=${n}&height=${n}`

export class Ortho {
  constructor(cfg, { maxInflight = 4 } = {}) {
    const f = flag("ortho")
    this.enabled = f !== "0"
    this.near = f && f !== "0" && Number.isFinite(Number(f)) ? Number(f) : 1024
    this.far = Math.min(512, this.near)
    this.local = !!cfg.ortho?.local
    this.live = cfg.ortho?.live !== false
    this.version = cfg.ortho?.version ?? 0
    this.maxInflight = maxInflight
    this.entries = new Map()          // tile key → { tile, want, have, ctrl, triedLocal, failed }
    this.arrived = []                 // decoded bitmaps waiting to be applied
    this.inflight = 0
    this.cx = 0; this.cy = 0
    this.stats = { ready: 0, failed: 0, loads: 0 }
  }

  // tile: { key, tx, ty, terrain } once its terrain mesh exists
  request(tile) {
    if (!this.enabled) return
    this.entries.set(tile.key, { tile, want: 0, have: 0, ctrl: null, triedLocal: false, failed: 0 })
  }

  cancel(key) {
    const e = this.entries.get(key)
    if (!e) return
    e.ctrl?.abort()
    this.entries.delete(key)
  }

  // once per frame with the player's tile indices
  update(cx, cy) {
    if (!this.enabled) return
    this.cx = cx; this.cy = cy
    const a = this.arrived.shift()
    if (a) {
      const e = this.entries.get(a.key)
      if (e && a.size > e.have) { e.have = a.size; e.tile.terrain.setMap(bitmapTexture(a.bitmap)); this.stats.ready++ }
      else if (a.bitmap.src?.startsWith("blob:")) URL.revokeObjectURL(a.bitmap.src)
    }
    if (this.inflight >= this.maxInflight) return
    const cands = []
    for (const e of this.entries.values()) {
      const d = Math.max(Math.abs(e.tile.tx - cx), Math.abs(e.tile.ty - cy))
      e.want = d <= 1 ? this.near : this.far
      if (!e.ctrl && e.have < e.want && e.failed < 2) cands.push([d, e])
    }
    cands.sort((p, q) => p[0] - q[0])
    for (const [, e] of cands) { if (this.inflight >= this.maxInflight) break; this.start(e) }
  }

  start(e) {
    const { tx, ty, key } = e.tile, size = e.want
    const useLocal = this.local && !e.triedLocal
    const url = useLocal ? `/ortho/${tx}_${ty}.jpg?v=${this.version}` : this.live ? wmsUrl(tx, ty, size) : null
    if (!url) { e.failed = 9; return }
    e.triedLocal = true
    e.ctrl = new AbortController()
    this.inflight++; this.stats.loads++
    loadBitmap(url, { signal: e.ctrl.signal })
      .then((bitmap) => this.arrived.push({ key, size, bitmap }))
      .catch((err) => { if (err?.name !== "AbortError" && !useLocal) { e.failed++; this.stats.failed++ } })
      .finally(() => { this.inflight--; e.ctrl = null })
  }

  dispose() {
    for (const e of this.entries.values()) e.ctrl?.abort()
    this.entries.clear()
    for (const a of this.arrived) if (a.bitmap.src?.startsWith("blob:")) URL.revokeObjectURL(a.bitmap.src)
    this.arrived.length = 0
  }
}

export { disposeTexture }
