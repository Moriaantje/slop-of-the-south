import * as THREE from "three"
import { collapseRange, scaleRange, hullXZ, buildingHp } from "game/Destructibles"

// 3D BAG LoD2.2 buildings: faces (roof planes and walls) triangulated here with earcut and merged into one
// flat-shaded, vertex-coloured mesh per tile. Tile format per building: { id, roof, o: [x, y, z], f: [[label, outer, hole, ...], ...] }
// where rings are flat centimetre offsets [dx, dy, dz, ...] from o. Label 1 = roof, 2 = wall. `fp` holds the ground
// outline as flat [x, z, ...] rings in game units. With `reg` every building registers a destructible handle: its
// vertex range in the merged geometry, collapsed when it falls.
const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide })
material.__shared = true

const WALLS = [0xd9c4a5, 0xcdb597, 0xb99c7a, 0xa8836a, 0xe3d6c3, 0xc9c1b4, 0x9c7b66, 0xdccbb6]  // brick, plaster, dark brick
const PITCHED = [0x6e3d33, 0x5a3a35, 0x4b4548, 0x7a4a3c, 0x3f3b3d, 0x8a5646]                   // tiles: terracotta to anthracite
const FLAT = [0x6f6c68, 0x7d7a74, 0x5e5c59]                                                      // bitumen / gravel

export function buildBuildingMeshes(meshes, reg) {
  if (!meshes?.length) return null
  const pos = [], col = [], handles = []
  const color = new THREE.Color()
  const pts3 = [], pts2 = []
  const normal = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)

  for (const b of meshes) {
    const h = hash(b.id)
    const wall = WALLS[h % WALLS.length]
    const roof = b.roof === "horizontal" ? FLAT[h % FLAT.length] : PITCHED[(h >> 3) % PITCHED.length]
    const [ox, oy, oz] = b.o
    const start = pos.length / 3, xz = []
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = -Infinity
    for (const face of b.f) {
      const label = face[0]
      // rings → arrays of Vector3 (outer first, then holes)
      const rings = []
      for (let r = 1; r < face.length; r++) {
        const flat = face[r], ring = []
        for (let i = 0; i + 2 < flat.length; i += 3) {
          const p = new THREE.Vector3(ox + flat[i] / 100, oy + flat[i + 1] / 100, oz + flat[i + 2] / 100)
          ring.push(p)
          if (reg) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); top = Math.max(top, p.y); if (!b.fp) xz.push(p.x, p.z) }
        }
        if (ring.length >= 3) rings.push(ring)
      }
      if (!rings.length) continue
      newell(rings[0], normal)
      if (normal.lengthSq() < 1e-12) continue
      normal.normalize()
      // 2D basis in the face plane for earcut
      u.copy(Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up).cross(normal).normalize()
      v.crossVectors(normal, u)
      pts3.length = 0; pts2.length = 0
      const contour = [], holes = []
      for (let r = 0; r < rings.length; r++) {
        const target = r === 0 ? contour : []
        for (const p of rings[r]) { pts3.push(p); target.push(new THREE.Vector2(p.dot(u), p.dot(v))) }
        if (r > 0) holes.push(target)
      }
      let tris
      try { tris = THREE.ShapeUtils.triangulateShape(contour, holes) } catch { continue }
      // flat colour per face: slight per-face tint so adjacent walls read as separate planes
      const tint = 0.92 + ((h ^ (face.length * 7919)) % 17) / 100
      color.setHex(label === 1 ? roof : wall)
      const shade = label === 1 ? 1 : 0.85 + 0.15 * Math.abs(normal.x)     // walls: fake directional light
      const r = color.r * tint * shade, g = color.g * tint * shade, bl = color.b * tint * shade
      for (const [a, b2, c] of tris) {
        for (const i of [a, b2, c]) { const p = pts3[i]; pos.push(p.x, p.y, p.z); col.push(r, g, bl) }
      }
    }
    const count = pos.length / 3 - start
    if (reg && count) {
      const rings = b.fp ?? [hullXZ(xz)]
      handles.push({ key: `m:${b.id}`, kind: "m", rings, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, h: top - oy, max: buildingHp(rings), start, count })
    }
  }
  if (!pos.length) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3))
  geo.computeVertexNormals()          // non-indexed → one normal per triangle = flat shading
  for (const h of handles) reg(h.key, { ...h, remove: () => collapseRange(geo.attributes.position, h.start, h.count), tint: (k) => scaleRange(geo.attributes.color, h.start, h.count, k) })
  return new THREE.Mesh(geo, material)
}

// Newell's method: robust polygon normal for concave / slightly non-planar rings
function newell(ring, out) {
  out.set(0, 0, 0)
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    out.x += (p.y - q.y) * (p.z + q.z)
    out.y += (p.z - q.z) * (p.x + q.x)
    out.z += (p.x - q.x) * (p.y + q.y)
  }
  return out
}

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
