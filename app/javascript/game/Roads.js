import * as THREE from "three"
import { pbr, weathered } from "game/Textures"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// Procedural roads. Tile entries carry ready-made 3D centrelines (RoadBuilder: smoothed, junction-pinned, seated in
// the terrain) as pts [x, z, y] where y IS the road surface level; the terrain bed under a road is at that level and
// the verge beside it a curb higher. Each road becomes a flat ribbon lifted ROAD_LIFT (a z-fighting epsilon) above
// the higher of its own level and the terrain under each vertex — the 10 m height grid smears the curb step across the
// ribbon edge, so ribbons follow the terrain wherever it pokes above them. Style comes from class, width, surface and
// whether the tile is built-up: procedural textures provide asphalt, klinkers, gravel, red cycle asphalt and the lane
// markings (edge lines, centre dashes, lane dashes); town streets get raised sidewalks a CURB above the road.
// Junctions (three or more roads) are covered by a plain patch so markings stop short of the crossing. Bridges get
// parapets and pillars.
export const ROAD_LIFT = 0.05
export const CURB = 0.12
const LIFT = ROAD_LIFT, TEX_LEN = 24, SIDEWALK = 1.7
const URBAN = new Set(["stad", "woonwijk", "dorp"])

// Surfaces are photo materials (ambientCG, CC0; game/Textures.pbr) with UVs in metres: u across the ribbon, v along
// it. Lane markings are a separate thin layer painted on a transparent canvas with 0..1 UVs, so the paint repeats
// every TEX_LEN metres whatever the asphalt does. Until the photos arrive the flat colours below are what you see.
const SURFACES = {
  asphalt: { set: "asphalt", color: 0x3b3c40, size: 4 },
  cycle:   { set: "asphalt", color: 0x8a3d34, tint: 0xd8806c, size: 4 },   // red asphalt: the photo tinted
  gravel:  { set: "gravel", color: 0x9c8d72, size: 3 },
  klinker: { set: "klinker", color: 0x7a6459, size: 2 },
  pavers:  { set: "pavers", color: 0xa9a29a, size: 2 },
}
const weathering = new WeakSet()
function surface(name) {
  const s = SURFACES[name] ?? SURFACES.asphalt
  const m = pbr(s.set, { color: s.color, tint: s.tint, size: s.size, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1 })
  if (!weathering.has(m)) { weathering.add(m); weathered(m, { wet: s.set === "asphalt" ? 0.5 : 0.3 }) }   // wet patches catch the sky
  return m
}
const junctionMat = weathered(pbr("asphalt", { color: 0x3b3c40, size: 4, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -3 }), { wet: 0.5 })
const concrete = weathered(pbr("concrete", { color: 0x9a9892, size: 3 }), { wet: 0.25 })

// lane markings: transparent canvas, white paint only, one texture per marking pattern
const markTextures = {}
function markTexture(name) {
  if (markTextures[name]) return markTextures[name]
  const c = document.createElement("canvas"); c.width = 256; c.height = 512
  const ctx = c.getContext("2d")
  ctx.clearRect(0, 0, 256, 512)
  const white = "#e8e8e2"
  const edge = () => { ctx.fillStyle = white; ctx.fillRect(8, 0, 5, 512); ctx.fillRect(243, 0, 5, 512) }
  const dashes = (x, on = 3, off = 9) => { ctx.fillStyle = white; for (let y = 0; y < 512; y += (on + off) * (512 / TEX_LEN)) ctx.fillRect(x - 2, y, 5, on * (512 / TEX_LEN)) }
  if (name === "edge-centre") { edge(); dashes(128) }
  if (name === "centre") dashes(128)
  if (name.startsWith("lanes-")) { edge(); const lanes = Number(name.split("-")[1]); for (let i = 1; i < lanes; i++) dashes(256 * i / lanes, 3, 6) }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
  markTextures[name] = tex
  return tex
}
const markMaterials = {}
function markMaterial(name) {
  return markMaterials[name] ??= Object.assign(new THREE.MeshStandardMaterial({ map: markTexture(name), roughness: 0.6, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2 }), { __shared: true })
}

// which surface and which markings for a road: class, width, surface and whether the tile is built-up decide
export function styleOf(road, urban) {
  const k = road.kind, s = road.surface ?? ""
  if (k === "cycleway") return { surface: "cycle", marks: null }
  if (k === "track" || /unpaved|gravel|ground|dirt|compacted|fine_gravel/.test(s)) return { surface: "gravel", marks: null }
  if (k === "living_street" || /paving_stones|sett|cobblestone/.test(s)) return { surface: "klinker", marks: null }
  if (k === "motorway" || k === "trunk") return { surface: "asphalt", marks: `lanes-${Math.min(4, Math.max(2, road.lanes ?? 2))}` }
  if (k === "motorway_link" || k === "trunk_link" || k === "service") return { surface: "asphalt", marks: null }
  if (k === "primary" || k === "secondary") return { surface: "asphalt", marks: urban ? "centre" : "edge-centre" }
  if (k === "tertiary" || k === "unclassified") return { surface: "asphalt", marks: !urban && road.width >= 5.5 ? "centre" : null }
  return { surface: "asphalt", marks: null }          // residential and the rest: no markings
}
// raised sidewalks along neighbourhood streets in built-up tiles; through roads have their own BGT footways and cycle paths
const sidewalks = (road, urban) => urban && !road.oneway && ["residential", "living_street", "unclassified"].includes(road.kind)

// terrainAt(x, z) is the tile's terrain height; ribbons and patches never sink below it
export function buildRoads(roads, junctions, biome, terrainAt = null) {
  const urban = URBAN.has(biome)
  const byMat = new Map()
  const add = (mat, geo) => { if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push(geo) }
  for (const road of roads) {
    if (road.pts.length < 2) continue
    const style = styleOf(road, urban)
    add(surface(style.surface), ribbon(road.pts, road.width / 2, LIFT, "metres", 0, null, terrainAt))
    if (style.marks) add(markMaterial(style.marks), ribbon(road.pts, road.width / 2, LIFT + 0.01, "unit", 0, null, terrainAt))
    if (sidewalks(road, urban)) {
      for (const side of [-1, 1]) add(surface("pavers"), ribbon(road.pts, SIDEWALK / 2, LIFT + CURB, "metres", side * (road.width / 2 + SIDEWALK / 2), null, terrainAt))
    }
    for (const span of bridgeRuns(road.pts)) {
      for (const side of [-1, 1]) add(concrete, ribbon(span, 0.15, LIFT + 0.9, "metres", side * (road.width / 2 + 0.15), LIFT))
      add(concrete, pillars(span, road, roads))
    }
  }
  for (const [x, z, y, r] of junctions ?? []) {
    const g = new THREE.CircleGeometry(r, 16).toNonIndexed()
    g.rotateX(-Math.PI / 2); g.translate(x, 0, z)
    const pos = g.attributes.position                            // level with the ribbons, riding up over any terrain that pokes through
    for (let i = 0; i < pos.count; i++) pos.setY(i, Math.max(y, terrainAt ? terrainAt(pos.getX(i), pos.getZ(i)) : y) + LIFT + 0.01)
    g.deleteAttribute("normal")                 // ribbons carry position + uv only; normals are computed after merging
    const juv = new Float32Array(pos.count * 2)                  // planar world UVs in metres, like the ribbons
    for (let i = 0; i < pos.count; i++) { juv[2 * i] = pos.getX(i); juv[2 * i + 1] = pos.getZ(i) }
    g.deleteAttribute("uv"); g.setAttribute("uv", new THREE.Float32BufferAttribute(juv, 2))
    add(junctionMat, g)
  }
  if (!byMat.size) return null
  const group = new THREE.Group()
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false)
    geos.forEach((g) => g.dispose())
    merged.computeVertexNormals()
    group.add(new THREE.Mesh(merged, mat))
  }
  return group
}

// A flat ribbon along pts ([x, z, y]) of half-width hw, lifted by `lift`, shifted sideways by `offset` metres.
// uvMode "metres": u = 0..2hw across (or 0..wall height for parapets), v = metres along, for the photo materials;
// "unit": u = 0..1 across and v = along / TEX_LEN, for the painted markings.
// When `bottom` is given a vertical wall from bottom to lift is built instead (bridge parapets). With `ground`
// (terrain height function) each edge vertex is raised to ROAD_LIFT above the highest terrain at the vertex and
// halfway to its neighbours, so the bilinear terrain never pokes through the ribbon between two vertices.
export function ribbon(pts, hw, lift, uvMode = "metres", offset = 0, bottom = null, ground = null) {
  const verts = [], uvs = [], idx = []
  const edges = []                                            // [leftX, leftZ, rightX, rightZ] per point
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i]
    const [px, pz] = pts[Math.max(i - 1, 0)], [nx, nz] = pts[Math.min(i + 1, pts.length - 1)]
    let dx = nx - px, dz = nz - pz
    const len = Math.hypot(dx, dz) || 1
    dx /= len; dz /= len
    const lx = -dz, lz = dx                                   // left-hand unit vector
    const cx = x + lx * offset, cz = z + lz * offset
    edges.push([cx + lx * hw, cz + lz * hw, cx - lx * hw, cz - lz * hw, cx, cz])
  }
  const floor = (i, k) => {                                   // highest terrain at edge vertex k (0 left, 2 right) of point i and towards its neighbours
    const [ex, ez] = [edges[i][k], edges[i][k + 1]]
    let t = ground(ex, ez)
    for (const j of [i - 1, i + 1]) if (edges[j]) t = Math.max(t, ground((ex + edges[j][k]) / 2, (ez + edges[j][k + 1]) / 2))
    return t
  }
  let along = 0
  for (let i = 0; i < pts.length; i++) {
    const y = pts[i][2]
    if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])   // pts are [x, z, y]
    const [lxp, lzp, rxp, rzp, cx, cz] = edges[i]
    if (bottom === null) {
      const yl = ground ? Math.max(y + lift, floor(i, 0) + LIFT) : y + lift
      const yr = ground ? Math.max(y + lift, floor(i, 2) + LIFT) : y + lift
      verts.push(lxp, yl, lzp, rxp, yr, rzp)
    } else {
      verts.push(cx, y + bottom, cz, cx, y + lift, cz)
    }
    if (uvMode === "unit") uvs.push(0, along / TEX_LEN, 1, along / TEX_LEN)
    else { const across = bottom === null ? 2 * hw : lift - bottom; uvs.push(0, along, across, along) }
    if (i > 0) { const a = 2 * (i - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  return g.toNonIndexed()
}

// bridge pillars about every 25 m along the deck, from the deck down 40 m (the terrain or water cuts them off),
// turned to the deck heading; a pillar that would land on another road moves along the deck until it stands clear
function pillars(pts, road, roads) {
  const geos = []
  const across = Math.max(1.2, road.width * 0.35)
  let along = 0, last = -13
  for (let i = 1; i < pts.length; i++) {
    const [ax, az, ay] = pts[i - 1], [bx, bz, by] = pts[i]
    const seg = Math.hypot(bx - ax, bz - az)
    for (let d = 0; d < seg; d += 2) {
      if (along + d - last < 25) continue
      const t = d / seg, x = ax + (bx - ax) * t, z = az + (bz - az) * t
      if (!clearOfRoads(x, z, roads, road, across / 2 + 1)) continue
      const g = new THREE.BoxGeometry(1.2, 40, across)
      g.rotateY(-Math.atan2(bz - az, bx - ax))
      g.translate(x, ay + (by - ay) * t - 20 + LIFT, z)
      const ng = g.toNonIndexed()
      ng.deleteAttribute("normal")
      const pp = ng.attributes.position, puv = new Float32Array(pp.count * 2)     // u along the world diagonal, v up: metres
      for (let k = 0; k < pp.count; k++) { puv[2 * k] = pp.getX(k) + pp.getZ(k); puv[2 * k + 1] = pp.getY(k) }
      ng.deleteAttribute("uv"); ng.setAttribute("uv", new THREE.Float32BufferAttribute(puv, 2))
      geos.push(ng)
      last = along + d
    }
    along += seg
  }
  if (!geos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([], 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute([], 2)); return g }
  const merged = mergeGeometries(geos, false); geos.forEach((g) => g.dispose()); return merged
}

// whether (x, z) keeps `margin` metres between itself and the ribbon of every road but `own`
function clearOfRoads(x, z, roads, own, margin) {
  for (const r of roads) {
    if (r === own) continue
    const reach = r.width / 2 + margin
    for (let i = 1; i < r.pts.length; i++) {
      const [ax, az] = r.pts[i - 1], [bx, bz] = r.pts[i]
      const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz
      const t = len2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < reach) return false
    }
  }
  return true
}

// consecutive runs of bridge points ([x, z, y, 1]), each at least two points long
function bridgeRuns(pts) {
  const runs = []
  let run = []
  for (const p of pts) { if (p[3] === 1) run.push(p); else { if (run.length > 1) runs.push(run); run = [] } }
  if (run.length > 1) runs.push(run)
  return runs
}
