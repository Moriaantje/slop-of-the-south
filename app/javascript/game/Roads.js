import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

const asphalt = new THREE.MeshStandardMaterial({ color: 0x4b4b50, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1 })
asphalt.__shared = true
const LIFT = 0.25            // metres above terrain so roads never z-fight with the ground
const MAX_SEG = 8            // resample long segments so ribbons follow the terrain

// Polylines → one merged ribbon mesh draped over the heightmap.
export function buildRoads(roads, heightAt) {
  const geos = []
  for (const road of roads) {
    const pts = resample(road.pts)
    if (pts.length < 2) continue
    const hw = road.width / 2
    const verts = [], idx = []
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i]
      const [px, pz] = pts[Math.max(i - 1, 0)], [nx, nz] = pts[Math.min(i + 1, pts.length - 1)]
      let dx = nx - px, dz = nz - pz
      const len = Math.hypot(dx, dz) || 1
      dx /= len; dz /= len
      const lx = -dz * hw, lz = dx * hw            // left-hand offset
      verts.push(x + lx, heightAt(x + lx, z + lz) + LIFT, z + lz,
                 x - lx, heightAt(x - lx, z - lz) + LIFT, z - lz)
      if (i > 0) { const a = 2 * (i - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
    g.setIndex(idx)
    geos.push(g)
  }
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  merged.computeVertexNormals()
  return new THREE.Mesh(merged, asphalt)
}

function resample(pts) {
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
    const d = Math.hypot(bx - ax, bz - az)
    const n = Math.ceil(d / MAX_SEG)
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n])
  }
  return out
}
