import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 })
material.__shared = true

const palette = {
  church: 0x8c8378, cathedral: 0x8c8378,
  industrial: 0x9aa0a6, warehouse: 0x9aa0a6, retail: 0xb8a48c, commercial: 0xb8a48c,
  apartments: 0xc9b39a, office: 0xa9b3bd, school: 0xd4b489,
  default: 0xd9c4a5,        // Limburg brick-ish
}

// Footprints (game x/z) → extruded boxes sitting on the terrain, merged into one mesh per tile.
export function buildBuildings(buildings) {
  const geos = []
  const color = new THREE.Color()
  for (const b of buildings) {
    if (b.footprint.length < 3) continue
    const shape = new THREE.Shape(b.footprint.map(([x, z]) => new THREE.Vector2(x, -z)))
    const g = new THREE.ExtrudeGeometry(shape, { depth: b.height + 0.5, bevelEnabled: false })
    g.rotateX(-Math.PI / 2)                       // extrude along +Y; shape y → -z
    g.translate(0, b.base - 0.5, 0)               // sink slightly so slopes don't show gaps

    color.setHex(palette[b.kind] ?? palette.default)
    const tint = 0.9 + Math.random() * 0.2
    const cols = new Float32Array(g.attributes.position.count * 3)
    for (let i = 0; i < cols.length; i += 3) { cols[i] = color.r * tint; cols[i + 1] = color.g * tint; cols[i + 2] = color.b * tint }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3))
    g.deleteAttribute("uv")
    geos.push(g)
  }
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  return new THREE.Mesh(merged, material)
}
