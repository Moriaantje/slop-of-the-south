import { buildParts } from "game/BuildingMeshes"
import { pointInPolygon } from "game/Destructibles"

// The fallback for buildings without a 3D BAG model: an OSM footprint and a height, which used to become a
// flat-coloured extruded box. Across the German border that is most of what there is, so a box there against a
// modelled village here read as two different games. Instead of drawing them itself, this module now turns each
// footprint into the same part format BuildingMeshes eats — walls as quads round the ring, a roof on top — and hands
// it over, so a fallback building gets the photo brick, the painted windows with their reveals, the overhanging
// eaves, the gutter, the chimney and the destructible handle that a modelled one gets, for the price of the same
// merged geometry it cost before.
//
// The roof is the one thing a footprint does not carry, so it is invented: the ring is offset inwards by a fixed
// distance with a mitre at every corner, and each edge becomes a slope up to that inner ring — a hip roof, which is
// what most of these houses actually have. The offset is the honest way this can fail (a concave or spiky footprint
// folds itself inside out), so the result is checked three ways — no corner too sharp to mitre, every inner vertex
// still inside the original ring, and the inner ring still holding a decent share of the area — and anything that
// fails falls back to a flat deck, which BuildingMeshes then fences in with a parapet. Neither outcome is a box.
const SINK = 0.5             // m the walls continue below the terrain, so a slope never opens a gap under a wall
const PITCH = 0.72           // m of rise per m of inset ≈ 36°, the common Dutch pitch
const INSET_MIN = 0.8, INSET_MAX = 2.4         // m the hip roof steps in from the eave
const INSET_SHARE = 0.28     // of the shorter side of the footprint's bounding box
const MAX_RING = 14          // a footprint with more corners than this gets a flat deck: the mitre rarely survives
const MITRE_MIN = 0.35       // 1 + n·n at a corner; below this the corner is too sharp to offset safely
const INSET_TRIES = [1, 0.6, 0.35]     // the offset distance is retried shorter when a footprint refuses the first
const AREA_MIN = 0.12        // the inner ring has to keep this share of the footprint's area
const WELD = 0.4             // m: OSM footprints are full of near-duplicate corners, and they wreck the mitre
const STRAIGHT = 0.09        // sin of the turn below which a corner is really a straight run and is dropped

// Roof types and material slots per OSM kind, so a church still reads as marl stone and a shed as hard brick.
// The slot indexes BuildingMeshes' WALL_SETS / WALL_STYLE pair; anything not listed takes the id hash's pick.
const FLAT_KINDS = new Set(["industrial", "warehouse", "retail", "commercial", "office"])
const KIND_SLOT = { church: 7, cathedral: 7, industrial: 2, warehouse: 2, retail: 3, commercial: 3, office: 3, apartments: 0, school: 1 }

// Footprints (game x/z) → the same merged, textured meshes the 3D BAG buildings get. With `reg` every building
// registers a destructible handle over its vertex ranges, collapsed when it falls.
// The parts of the fallback footprints, without building them: ChunkManager hands these to buildBuildingMeshes
// along with the BAG meshes, so a tile merges ONE group over the shared materials instead of two.
export function footprintParts(buildings) {
  const parts = []
  for (const b of buildings ?? []) {
    if (!b.footprint || b.footprint.length < 3) continue
    const p = footprintPart(b)
    if (p) { p.prefix = "b:"; p.kind = "b"; parts.push(p) }
  }
  return parts
}

export function buildBuildings(buildings, reg) {
  const parts = []
  for (const b of buildings ?? []) {
    if (!b.footprint || b.footprint.length < 3) continue
    const part = footprintPart(b)
    if (part) parts.push(part)
  }
  if (!parts.length) return null
  return buildParts(parts, reg, "b:", "b")
}

// One footprint as a BuildingMeshes part: rings in metres (`s: 1`) offset from the ring's first corner at ground
// level, walls first and then either a hip roof or a flat deck.
export function footprintPart(b) {
  const ring = cwRing(b.footprint)
  const n = ring.length / 2
  if (n < 3) return null
  const ox = ring[0], oz = ring[1]
  const top = Math.max(2.5, b.height ?? 3)
  const faces = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const x0 = ring[i * 2] - ox, z0 = ring[i * 2 + 1] - oz, x1 = ring[j * 2] - ox, z1 = ring[j * 2 + 1] - oz
    // bottom edge first, then up: that winding puts the wall's normal on the outside of a clockwise ring
    faces.push([2, [x0, -SINK, z0, x1, -SINK, z1, x1, top, z1, x0, top, z0]])
  }
  const wantsFlat = FLAT_KINDS.has(b.kind) || b.roof === "horizontal" || b.roof === "multiple horizontal"
  const hip = wantsFlat ? null : hipRoof(ring)
  if (hip) {
    const { q, rise } = hip
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      faces.push([1, [ring[i * 2] - ox, top, ring[i * 2 + 1] - oz, ring[j * 2] - ox, top, ring[j * 2 + 1] - oz,
                      q[j * 2] - ox, top + rise, q[j * 2 + 1] - oz, q[i * 2] - ox, top + rise, q[i * 2 + 1] - oz]])
    }
    const cap = []
    for (let i = 0; i < n; i++) cap.push(q[i * 2] - ox, top + rise, q[i * 2 + 1] - oz)
    faces.push([1, cap])
  } else {
    const cap = []
    for (let i = 0; i < n; i++) cap.push(ring[i * 2] - ox, top, ring[i * 2 + 1] - oz)
    faces.push([1, cap])
  }
  return { id: b.id, roof: hip ? "slanted" : "horizontal", o: [ox, b.base ?? 0, oz], s: 1,
           slot: KIND_SLOT[b.kind], fp: [b.footprint.flat()], f: faces }
}

// The ring as a flat [x, z, ...] wound clockwise in the x/z map, which is the winding BuildingMeshes' quads assume:
// the outward side of an edge is then its left, and a polygon traversed this way has an upward normal.
export function cwRing(footprint) {
  const raw = []
  for (const [x, z] of footprint) raw.push(x, z)
  const flat = cleanRing(raw)
  if (shoelace(flat) <= 0) return flat
  const out = []
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1])
  return out
}

// A surveyed footprint traced from an aerial photo carries corners a builder never laid: two points 5 cm apart, or
// three in a row on the same line. They cost a wall quad each and, worse, the roof's mitre folds itself inside out on
// them, so the ring is welded and straightened before anything is built from it. The destructible handle keeps the
// original outline, so collisions are unaffected.
export function cleanRing(raw) {
  let ring = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = ring.length
    if (k >= 2 && Math.hypot(raw[i] - ring[k - 2], raw[i + 1] - ring[k - 1]) < WELD) continue
    ring.push(raw[i], raw[i + 1])
  }
  while (ring.length >= 8 && Math.hypot(ring[0] - ring[ring.length - 2], ring[1] - ring[ring.length - 1]) < WELD) ring.length -= 2
  for (let pass = 0; pass < 3; pass++) {
    const n = ring.length / 2
    if (n <= 4) break
    const out = []
    for (let i = 0; i < n; i++) {
      const h = (i + n - 1) % n, j = (i + 1) % n
      const ax = ring[i * 2] - ring[h * 2], az = ring[i * 2 + 1] - ring[h * 2 + 1]
      const bx = ring[j * 2] - ring[i * 2], bz = ring[j * 2 + 1] - ring[i * 2 + 1]
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1
      if (Math.abs((ax * bz - az * bx) / (la * lb)) > STRAIGHT || out.length / 2 + (n - i - 1) < 4) out.push(ring[i * 2], ring[i * 2 + 1])
    }
    if (out.length === ring.length) break
    ring = out
  }
  return ring
}

export function shoelace(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  return a / 2
}

// The inner ring of a hip roof: every edge moved inwards by the same distance, corners mitred. A plain mitre offset
// is only correct while no edge collapses, which on a concave footprint happens well before the offset reaches the
// middle, so the distance is tried three times over, each shorter than the last, and the first one that survives
// every check wins. Returns null when even the shortest fails, and the caller puts a flat deck on instead.
export function hipRoof(ring) {
  const n = ring.length / 2
  if (n < 3 || n > MAX_RING) return null
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i])
    minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1])
  }
  const span = Math.min(maxX - minX, maxZ - minZ)
  if (span < 2 * INSET_MIN) return null
  const want = Math.min(INSET_MAX, Math.max(INSET_MIN, span * INSET_SHARE))
  for (const scale of INSET_TRIES) {
    const d = want * scale
    if (d < INSET_MIN * 0.5) break
    const q = inset(ring, d)
    if (q) return { q, rise: d * PITCH }
  }
  return null
}

// One mitre offset, or null when it cannot be trusted: a corner too sharp to mitre, a new vertex outside the old
// outline, an edge that flipped end for end (the offset ate it), or a ring that lost nearly all its area.
export function inset(ring, d) {
  const n = ring.length / 2
  const nx = new Float64Array(n), nz = new Float64Array(n)     // inward unit normal per edge: outward is its left
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const ex = ring[j * 2] - ring[i * 2], ez = ring[j * 2 + 1] - ring[i * 2 + 1]
    const len = Math.hypot(ex, ez)
    if (len < 1e-4) return null
    nx[i] = ez / len; nz[i] = -ex / len
  }
  const q = new Array(n * 2)
  for (let i = 0; i < n; i++) {
    const k = (i + n - 1) % n
    // the point d from both edge lines sits along the sum of their normals, scaled by 1 / (1 + cos of the corner)
    const dot = nx[k] * nx[i] + nz[k] * nz[i]
    if (1 + dot < MITRE_MIN) return null
    const t = d / (1 + dot)
    const qx = ring[i * 2] + (nx[k] + nx[i]) * t, qz = ring[i * 2 + 1] + (nz[k] + nz[i]) * t
    if (!pointInPolygon(qx, qz, ring)) return null
    q[i * 2] = qx; q[i * 2 + 1] = qz
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const ex = ring[j * 2] - ring[i * 2], ez = ring[j * 2 + 1] - ring[i * 2 + 1]
    const fx = q[j * 2] - q[i * 2], fz = q[j * 2 + 1] - q[i * 2 + 1]
    if (ex * fx + ez * fz <= 0) return null                    // the offset consumed this edge and turned it round
  }
  const a0 = shoelace(ring), a1 = shoelace(q)
  if (a1 * a0 <= 0 || Math.abs(a1) < AREA_MIN * Math.abs(a0)) return null
  return q
}
