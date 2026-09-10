import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// BGT land cover per tile: painted into a canvas texture that the terrain tile wears, plus draped water skins.
// Tile format: cover = [[code, outerRing, holeRing, ...], ...] with rings as flat decimetre offsets [dx, dz, ...]
// from the tile's north-west corner (0..5000). Codes match LandCover::CODES on the server.
export const TEXTURE_SIZE = 512
const BASE = "#7fa15a"
const COLORS = {
  1: ["#78a049", "#6f9a44", "#7ea64d"],                              // grasland agrarisch (meadow)
  2: ["#86a44f", "#7fa04a"],                                         // grasland overig
  3: ["#6e9448", "#739a4b"],                                         // groenvoorziening (urban green)
  4: ["#b69b63", "#c9b077", "#a48a58", "#9ea653", "#bfa76a", "#8d9b4c", "#d1b97d"],  // bouwland: soil, stubble, crops
  5: ["#7aa04a", "#74994a"],                                         // fruitteelt (orchard grass)
  6: ["#7f9d4f"],                                                    // boomteelt
  7: ["#4f7a38", "#557f3c"],                                         // bos floor
  8: ["#8b7d5b"], 9: ["#6d8b45"], 10: ["#88915a"], 11: ["#d8c8a2"], 12: ["#9a9468"],
  20: ["#b3a795", "#ada08d", "#b8ad9b"],                             // erf (yards)
  21: ["#5b5b5e"], 22: ["#8d7d72"], 23: ["#a89c86"], 24: ["#9d8b6c"],  // pavement grades
  30: ["#4d7ea6"]                                                    // water (also drawn as a skin)
}
const WATER = 30

export function paintCover(cover) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = TEXTURE_SIZE
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = BASE
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE)
  const k = TEXTURE_SIZE / 5000
  for (const entry of cover) {
    const palette = COLORS[entry[0]]
    if (!palette) continue
    ctx.fillStyle = palette[hash(entry[1]) % palette.length]     // stable per polygon: fields keep their colour
    ctx.beginPath()
    for (let r = 1; r < entry.length; r++) {
      const ring = entry[r]
      ctx.moveTo(ring[0] * k, ring[1] * k)
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] * k, ring[i + 1] * k)
      ctx.closePath()
    }
    ctx.fill("evenodd")
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

const waterMat = new THREE.MeshStandardMaterial({ color: 0x3f6f95, roughness: 0.25, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 })
waterMat.__shared = true
const LIFT = 0.12, MAX_EDGE = 40

// Water polygons → triangulated skins draped just above the terrain (the DEM is interpolated under water).
export function buildWater(cover, heightAt, origin) {
  const [ox, oz] = origin
  const geos = []
  for (const entry of cover) {
    if (entry[0] !== WATER) continue
    const rings = []
    for (let r = 1; r < entry.length; r++) {
      const flat = entry[r], ring = []
      for (let i = 0; i + 1 < flat.length; i += 2) ring.push(new THREE.Vector2(ox + flat[i] / 10, oz + flat[i + 1] / 10))
      if (ring.length >= 3) rings.push(ring)
    }
    if (!rings.length) continue
    let tris
    try { tris = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1)) } catch { continue }
    const pts = rings.flat()
    const verts = []
    const push = (p) => verts.push(p.x, heightAt(p.x, p.y) + LIFT, p.y)
    for (const [a, b, c] of tris) subdivide(pts[a], pts[b], pts[c], push, 0)
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
    geos.push(g)
  }
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  merged.computeVertexNormals()
  return new THREE.Mesh(merged, waterMat)
}

// split long triangles so wide water follows the terrain instead of cutting through it
function subdivide(a, b, c, push, depth) {
  const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a)
  const longest = Math.max(ab, bc, ca)
  if (longest < MAX_EDGE || depth > 6) { push(a); push(b); push(c); return }
  if (longest === ab) { const m = a.clone().lerp(b, 0.5); subdivide(a, m, c, push, depth + 1); subdivide(m, b, c, push, depth + 1) }
  else if (longest === bc) { const m = b.clone().lerp(c, 0.5); subdivide(a, b, m, push, depth + 1); subdivide(a, m, c, push, depth + 1) }
  else { const m = c.clone().lerp(a, 0.5); subdivide(a, b, m, push, depth + 1); subdivide(m, b, c, push, depth + 1) }
}

function hash(ring) {
  let h = 2166136261
  for (let i = 0; i < Math.min(ring.length, 12); i++) h = Math.imul(h ^ ring[i], 16777619)
  return h >>> 0
}
