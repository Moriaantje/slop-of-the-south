import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// Procedural roads. Tile entries carry ready-made 3D centrelines (RoadBuilder: smoothed, junction-pinned, above the
// terrain) as pts [x, z, y]. Each road becomes a flat ribbon with a style chosen from its class, width, surface and
// whether the tile is built-up: procedural textures provide asphalt, klinkers, gravel, red cycle asphalt and the lane
// markings (edge lines, centre dashes, lane dashes); town streets get raised sidewalks. Junctions (three or more
// roads) are covered by a plain patch so markings stop short of the crossing. Bridges get parapets and pillars.
export const ROAD_LIFT = 0.15
const LIFT = ROAD_LIFT, TEX_LEN = 24, SIDEWALK = 1.7, CURB = 0.12
const URBAN = new Set(["stad", "woonwijk", "dorp"])

const textures = {}
function texture(name) {
  if (textures[name]) return textures[name]
  const c = document.createElement("canvas"); c.width = 256; c.height = 512
  const ctx = c.getContext("2d")
  const base = { cycle: "#8a3d34", gravel: "#9c8d72", klinker: "#7a6459", pavers: "#a9a29a" }[name.split("-")[0]] ?? "#3b3c40"
  ctx.fillStyle = base; ctx.fillRect(0, 0, 256, 512)
  // speckle
  const rnd = mulberry32(7)
  ctx.globalAlpha = 0.18
  for (let i = 0; i < 1800; i++) { ctx.fillStyle = rnd() > 0.5 ? "#000" : "#fff"; ctx.fillRect(rnd() * 256, rnd() * 512, 2, 2) }
  ctx.globalAlpha = 1
  if (name === "klinker") {                     // brick bond
    ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 2
    for (let y = 0; y < 512; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke()
      for (let x = (y / 20) % 2 ? 0 : 12; x < 256; x += 24) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 20); ctx.stroke() } }
  }
  if (name === "pavers") {
    ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 2
    for (let y = 0; y < 512; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke() }
    for (let x = 0; x < 256; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke() }
  }
  const white = "#e8e8e2"
  const edge = () => { ctx.fillStyle = white; ctx.fillRect(8, 0, 5, 512); ctx.fillRect(243, 0, 5, 512) }
  const dashes = (x, on = 3, off = 9) => { ctx.fillStyle = white; for (let y = 0; y < 512; y += (on + off) * (512 / TEX_LEN)) ctx.fillRect(x - 2, y, 5, on * (512 / TEX_LEN)) }
  if (name === "asphalt-edge-centre") { edge(); dashes(128) }
  if (name === "asphalt-centre") dashes(128)
  if (name.startsWith("asphalt-lanes-")) { edge(); const lanes = Number(name.split("-")[2]); for (let i = 1; i < lanes; i++) dashes(256 * i / lanes, 3, 6) }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
  textures[name] = tex
  return tex
}

const materials = {}
function material(name) {
  return materials[name] ??= Object.assign(new THREE.MeshStandardMaterial({ map: texture(name), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1 }), { __shared: true })
}
const junctionMat = Object.assign(new THREE.MeshStandardMaterial({ map: texture("asphalt"), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3 }), { __shared: true })
const concrete = Object.assign(new THREE.MeshStandardMaterial({ color: 0x9a9892, roughness: 0.9 }), { __shared: true })

// which texture for a road: class, width, surface and whether the tile is built-up decide
function styleOf(road, urban) {
  const k = road.kind, s = road.surface ?? ""
  if (k === "cycleway") return "cycle"
  if (k === "track" || /unpaved|gravel|ground|dirt|compacted|fine_gravel/.test(s)) return "gravel"
  if (k === "living_street" || /paving_stones|sett|cobblestone/.test(s)) return "klinker"
  if (k === "motorway" || k === "trunk") return `asphalt-lanes-${Math.min(4, Math.max(2, road.lanes ?? 2))}`
  if (k === "motorway_link" || k === "trunk_link" || k === "service") return "asphalt"
  if (k === "primary" || k === "secondary") return urban ? "asphalt-centre" : "asphalt-edge-centre"
  if (k === "tertiary" || k === "unclassified") return urban ? "asphalt" : (road.width >= 5.5 ? "asphalt-centre" : "asphalt")
  return "asphalt"                                    // residential and the rest: no markings
}
// raised sidewalks along neighbourhood streets in built-up tiles; through roads have their own BGT footways and cycle paths
const sidewalks = (road, urban) => urban && !road.oneway && ["residential", "living_street", "unclassified"].includes(road.kind)

export function buildRoads(roads, junctions, biome) {
  const urban = URBAN.has(biome)
  const byMat = new Map()
  const add = (mat, geo) => { if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push(geo) }
  for (const road of roads) {
    if (road.pts.length < 2) continue
    add(material(styleOf(road, urban)), ribbon(road.pts, road.width / 2, LIFT, true))
    if (sidewalks(road, urban)) {
      for (const side of [-1, 1]) add(material("pavers"), ribbon(road.pts, SIDEWALK / 2, LIFT + CURB, true, side * (road.width / 2 + SIDEWALK / 2)))
    }
    for (const span of bridgeRuns(road.pts)) {
      for (const side of [-1, 1]) add(concrete, ribbon(span, 0.15, LIFT + 0.9, false, side * (road.width / 2 + 0.15), LIFT))
      add(concrete, pillars(span, road.width))
    }
  }
  for (const [x, z, y, r] of junctions ?? []) {
    const g = new THREE.CircleGeometry(r, 16).toNonIndexed()
    g.rotateX(-Math.PI / 2); g.translate(x, y + 0.01, z)
    g.deleteAttribute("normal")                 // ribbons carry position + uv only; normals are computed after merging
    g.deleteAttribute("uv"); g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2).fill(0.5), 2))
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
// When `bottom` is given a vertical wall from bottom to lift is built instead (bridge parapets).
function ribbon(pts, hw, lift, textured, offset = 0, bottom = null) {
  const verts = [], uvs = [], idx = []
  let along = 0
  for (let i = 0; i < pts.length; i++) {
    const [x, z, y] = pts[i]
    const [px, pz] = pts[Math.max(i - 1, 0)], [nx, nz] = pts[Math.min(i + 1, pts.length - 1)]
    let dx = nx - px, dz = nz - pz
    const len = Math.hypot(dx, dz) || 1
    dx /= len; dz /= len
    const lx = -dz, lz = dx                                   // left-hand unit vector
    if (i > 0) along += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][2])
    const cx = x + lx * offset, cz = z + lz * offset
    if (bottom === null) {
      verts.push(cx + lx * hw, y + lift, cz + lz * hw, cx - lx * hw, y + lift, cz - lz * hw)
    } else {
      verts.push(cx, y + bottom, cz, cx, y + lift, cz)
    }
    uvs.push(0, along / TEX_LEN, 1, along / TEX_LEN)
    if (i > 0) { const a = 2 * (i - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  return g.toNonIndexed()
}

// bridge pillars every ~25 m, from the deck down 40 m (the terrain or water cuts them off)
function pillars(pts, width) {
  const geos = []
  let along = 0, next = 12
  for (let i = 1; i < pts.length; i++) {
    const [ax, az, ay] = pts[i - 1], [bx, bz, by] = pts[i]
    const seg = Math.hypot(bx - ax, bz - az)
    while (next <= along + seg && seg > 0) {
      const t = (next - along) / seg
      const g = new THREE.BoxGeometry(Math.max(1.2, width * 0.35), 40, 1.2)
      g.translate(ax + (bx - ax) * t, ay + (by - ay) * t - 20 + LIFT, az + (bz - az) * t)
      const ng = g.toNonIndexed()
      ng.deleteAttribute("normal")
      ng.deleteAttribute("uv"); ng.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2))
      geos.push(ng)
      next += 25
    }
    along += seg
  }
  if (!geos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([], 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute([], 2)); return g }
  const merged = mergeGeometries(geos, false); geos.forEach((g) => g.dispose()); return merged
}

// consecutive runs of bridge points ([x, z, y, 1]), each at least two points long
function bridgeRuns(pts) {
  const runs = []
  let run = []
  for (const p of pts) { if (p[3] === 1) run.push(p); else { if (run.length > 1) runs.push(run); run = [] } }
  if (run.length > 1) runs.push(run)
  return runs
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
