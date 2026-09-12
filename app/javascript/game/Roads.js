import * as THREE from "three"
import { pbr, weathered } from "game/Textures"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { hash32, smoothstep } from "game/Tuning"
import { PART, PATTERN, NO_END, packCode, packPattern, roadSurface, markingMaterial } from "game/RoadShaders"

// Procedural roads. Tile entries carry ready-made 3D centrelines (RoadBuilder: smoothed, junction-pinned, seated in the
// terrain) as pts [x, z, y, bridge] where y IS the road surface level. A road used to be a two-vertex ribbon, which is
// why the streets read as grey tape: a flat plane has no camber, no kerb, no gutter and nothing for the light to catch.
// Every road is now extruded from a real cross section instead — a cambered carriageway, a dished gutter, a kerb stone
// with a battered face and a chamfered top, and the pavement behind it — so the street has an actual silhouette and
// the sun picks out the kerb line the whole length of it. The section is split into strips by material (asphalt or
// klinker, concrete kerb, paver pavement) which merge per tile into one mesh each; adjacent strips share their edge
// columns exactly, so there is no crack between them however the road twists.
//
// Three things used to make the ribbons come apart, and all three are fixed by how the cross section is seated:
// the edge of a ribbon is allowed to climb over terrain that pokes through it, but the climb is now one value per
// side per cross section, smoothed twice along the road and shaped smoothly across it, so a bank beside the road
// lifts the whole edge gently rather than spiking individual vertices into fins; that climb is faded to nothing over
// the last few metres of every piece, which is exactly where pieces meet — at a junction, where the mouth must sit at
// the road's own level for the junction patch to meet it, and at a tile boundary, where the neighbouring tile knows
// nothing about this tile's terrain and would otherwise compute a different climb for the very same vertex; and the
// junction patch is no longer a flat disc at the node height but a fan whose rim height is blended from the heights
// of the road mouths around it, so roads arriving at different levels are joined by a surface that meets all of them.
//
// Everything that makes the surface look used — wheel tracks, patches, manholes, gutter grit and puddles, mortar
// joints, moss — and all of the lane markings live in game/RoadShaders as fragment shaders driven by a road-local
// coordinate attribute. That is the cheap way to get detail: no extra geometry, no texture per road, and markings
// that stay crisp at any distance instead of blurring out of a 256x512 canvas.
export const ROAD_LIFT = 0.05          // metres: the z-fighting epsilon every road surface sits above its level
export const CURB = 0.12               // metres: kerb top above the carriageway edge (matches RoadBuilder::CURB)
const LIFT = ROAD_LIFT
const TEX_LEN = 24                     // metres: one repeat of a unit-UV ribbon (bridge parapets)
const SIDEWALK = 1.7                   // metres: clear pavement width behind the kerb
const MARK_LIFT = 0.012                // metres: the paint layer above the carriageway
const EDGE_RISE = 0.45                 // metres a ribbon edge may climb above the road level before it would be a fin
const END_FADE = 7.0                   // metres over which that climb fades to nothing at a piece end
const CROWN = 0.022                    // camber: the crown stands this fraction of the half width proud of the edges
const CROWN_MAX = 0.06                 // metres: never dome more than this, or the wheels visibly float on the crown
const PARAPET_H = 0.95                 // metres: the height of a bridge parapet above the deck
const PARAPET_W = 0.22                 // …and how thick it is
const URBAN = new Set(["stad", "woonwijk", "dorp"])

// The cross section of the carriageway as fractions of the half width, left (+) to right (−). Five columns is enough
// for a parabolic camber to read without banding and cheap enough to give every road in a tile.
const CARRIAGE = [1, 0.55, 0, -0.55, -1]

// The kerb and pavement profile, measured outward from the carriageway edge: [metres out, metres up]. The face is
// battered (it leans back 4 cm over its 9 cm) and topped with a chamfer, which is what a real betonnen band looks
// like and, more to the point, is what gives the kerb two lit facets instead of one flat wall.
const KERB = [
  [0.00, 0.000],                       // the asphalt edge: shared with the carriageway's outermost column
  [0.20, -0.030],                      // the goot, the dished channel water runs along
  [0.38, -0.010],                      // the foot of the stone
  [0.42, CURB - 0.030],                // the battered face
  [0.48, CURB],                        // the chamfer at the top
  [0.78, CURB + 0.012],                // the back of the stone: the pavement starts here, falling towards the gutter
  [0.78 + SIDEWALK, CURB + 0.055],     // the property line, a 2.5 % cross-fall away
]
const KERB_REACH = KERB[5][0]                       // metres from the asphalt edge to the back of the kerb stone
const WALK_REACH = KERB[6][0]                       // …and to the property line

// Surfaces are photo materials (ambientCG, CC0; game/Textures.pbr) with UVs in metres: u across the section, v along
// it. Every one of them carries the road-local detail shader and the weathering on top of the photograph.
const SURFACES = {
  asphalt: { set: "asphalt", color: 0x3b3c40, size: 4 },
  cycle:   { set: "asphalt", color: 0x8a3d34, tint: 0xd8806c, size: 4 },   // red asphalt: the photo tinted
  gravel:  { set: "gravel", color: 0x9c8d72, size: 3 },
  klinker: { set: "klinker", color: 0x7a6459, size: 2 },
  pavers:  { set: "pavers", color: 0xa9a29a, size: 2 },
}
const dressed = new WeakSet()
function dress(m, wet) {
  if (dressed.has(m)) return m
  dressed.add(m)
  roadSurface(m, { sidewalkWidth: SIDEWALK, kerbReach: KERB_REACH })
  return weathered(m, { wet })
}
function surface(name) {
  const s = SURFACES[name] ?? SURFACES.asphalt
  const m = pbr(s.set, { color: s.color, tint: s.tint, size: s.size, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1 })
  return dress(m, s.set === "asphalt" ? 0.5 : 0.3)
}
// the three materials that are not a road surface; built on first use so importing the module costs nothing
let junctionMat = null, concreteMat = null, markMat = null
const junction = () => (junctionMat ??= dress(pbr("asphalt", { color: 0x3b3c40, size: 4, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -3 }), 0.5))
const concrete = () => (concreteMat ??= dress(pbr("concrete", { color: 0x9a9892, size: 3, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1 }), 0.25))
const markings = () => (markMat ??= markingMaterial())

// which surface and which markings for a road: class, width, surface and whether the tile is built-up decide.
// Dutch 30 km/h zones are laid in brick, not asphalt, so a built-up tile's residential and service streets get the
// klinker photo — that one change is most of what makes a town centre stop looking like a motorway depot.
export function styleOf(road, urban) {
  const k = road.kind, s = road.surface ?? "", w = road.width ?? 4
  if (k === "cycleway") return { surface: "cycle", marks: w >= 3 ? PATTERN.CYCLE : PATTERN.NONE }
  if (k === "track" || /unpaved|gravel|ground|dirt|compacted|fine_gravel/.test(s)) return { surface: "gravel", marks: PATTERN.NONE }
  if (k === "living_street" || /paving_stones|sett|cobblestone/.test(s)) return { surface: "klinker", marks: PATTERN.NONE }
  if (k === "motorway" || k === "trunk") return { surface: "asphalt", marks: PATTERN.LANES }
  if (k === "motorway_link" || k === "trunk_link") return { surface: "asphalt", marks: PATTERN.NONE }
  if (k === "primary" || k === "secondary") return { surface: "asphalt", marks: urban ? PATTERN.CENTRE : PATTERN.EDGE_CENTRE }
  if (urban && (k === "residential" || k === "service") && w <= 6.5) return { surface: "klinker", marks: PATTERN.NONE }
  if (k === "service") return { surface: "asphalt", marks: PATTERN.NONE }
  if (k === "tertiary" || k === "unclassified") return { surface: "asphalt", marks: !urban && w >= 5.5 ? PATTERN.CENTRE : PATTERN.NONE }
  return { surface: "asphalt", marks: PATTERN.NONE }          // residential and the rest: no markings
}
// raised kerbs and pavements along neighbourhood streets in built-up tiles; through roads have their own BGT
// footways and cycle paths, and RoadBuilder already holds a 2.5 m verge at kerb level beside every road, which is
// exactly the band the section below fills.
const sidewalks = (road, urban) => urban && !road.oneway && ["residential", "living_street", "unclassified", "tertiary"].includes(road.kind)
// roads that must give way where they meet something wider: haaientanden get painted across the approach lane
const YIELDING = new Set(["residential", "service", "unclassified", "tertiary", "living_street"])

// terrainAt(x, z) is the tile's terrain height; ribbons and patches never sink below it
export function buildRoads(roads, junctions, biome, terrainAt = null) {
  const urban = URBAN.has(biome)
  const byMat = new Map()
  const add = (mat, geo) => { if (!geo) return; if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push(geo) }
  const markGeos = []
  for (const road of roads ?? []) {
    if (!road.pts || road.pts.length < 2) continue
    const hw = Math.max(0.8, (road.width ?? 4) / 2)
    const style = styleOf(road, urban)
    const kerbed = sidewalks(road, urban)
    const seed = seedOf(road)
    const outer = hw + (kerbed ? WALK_REACH : 0)
    const f = frames(road.pts, outer, LIFT, terrainAt, kerbed ? KERB[6][1] : 0)
    const carriage = CARRIAGE.map((t) => [t * hw, crown(hw) * (1 - t * t)])
    // an unkerbed road frays into its verge; a kerbed street ends where the kerb says it ends
    add(surface(style.surface), strip(f, carriage, 0, hw, packCode(PART.ROAD, seed), { soften: kerbed ? 0 : EDGE_WANDER }))
    if (kerbed) {
      const kerbCols = (sign) => KERB.slice(0, 6).map(([o, dy]) => [sign * (hw + o), dy])
      const walkCols = (sign) => KERB.slice(5).map(([o, dy]) => [sign * (hw + o), dy])
      const code = packCode(PART.KERB, seed), wcode = packCode(PART.WALK, seed)
      add(concrete(), strip(f, kerbCols(1).reverse(), 2 * hw, hw, code))
      add(concrete(), strip(f, kerbCols(-1), 2 * hw, hw, code))
      add(surface("pavers"), strip(f, walkCols(1).reverse(), 2 * hw + KERB_REACH, hw, wcode))
      add(surface("pavers"), strip(f, walkCols(-1), 2 * hw + KERB_REACH, hw, wcode))
    }
    if (style.marks !== PATTERN.NONE) {
      const lanes = style.marks === PATTERN.LANES ? Math.min(4, Math.max(2, road.lanes ?? 2)) : 0
      markGeos.push(strip(f, carriage, 0, hw, packPattern(style.marks, lanes), { dy: MARK_LIFT, ends: yieldEnds(road, junctions, f) }))
    }
    for (const span of bridgeRuns(road.pts)) {
      // A parapet used to be one zero-thickness ribbon, which disappears when you look along it and shows its back
      // face from the deck. Two faces and a coping on top cost three ribbons and give it a real edge against the sky.
      const rev = [...span].reverse()
      const wall = (offset, dir) => ribbon(dir > 0 ? span : rev, 0, LIFT + PARAPET_H, "metres", dir > 0 ? offset : -offset, LIFT)
      for (const side of [-1, 1]) {
        add(concrete(), tag(wall(side * (hw + 0.04 + PARAPET_W), side), PART.STRUCTURE, seed))       // the outer face
        add(concrete(), tag(wall(side * (hw + 0.04), -side), PART.STRUCTURE, seed))                  // …and the inner
        add(concrete(), tag(ribbon(span, PARAPET_W / 2, LIFT + PARAPET_H, "metres", side * (hw + 0.04 + PARAPET_W / 2)), PART.STRUCTURE, seed))
      }
      add(concrete(), tag(pillars(span, road, roads), PART.STRUCTURE, seed))
    }
  }
  for (const j of junctions ?? []) add(junction(), junctionPatch(j, roads ?? [], terrainAt))
  if (markGeos.length) byMat.set(markings(), markGeos.filter(Boolean))
  if (!byMat.size) return null
  const group = new THREE.Group()
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false)
    geos.forEach((g) => g.dispose())
    if (!merged) continue
    merged.computeVertexNormals()
    group.add(new THREE.Mesh(merged, mat))
  }
  return group
}

const EDGE_WANDER = 0.42        // m: how far the outer edge of an unkerbed road wanders in and out, and sinks

const crown = (hw) => Math.min(CROWN * hw, CROWN_MAX)
// a stable hash of a world position in [0, 1): two tiles asked about the same metre get the same answer
function edgeHash(x, z) { const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return v - Math.floor(v) }
const seedOf = (road) => (hash32(`${road.kind}:${Math.round(road.pts[0][0])}:${Math.round(road.pts[0][1])}`) % 1024) / 1024

// ---- the cross-section extruder -----------------------------------------------------------------------------------

// One frame per centreline point: the left-hand unit normal, the surface level, the chainage, and how far each side
// has to climb to stay above the terrain. Computing the climb once per side (rather than once per vertex) and
// smoothing it along the road is what stops the edges spiking; fading it to zero at both ends is what makes pieces
// meet exactly, whether they meet at a junction or across a tile boundary.
export function frames(pts, outer, lift, ground, outerDy = 0) {
  const n = pts.length
  const fx = new Float64Array(n), fz = new Float64Array(n), lx = new Float64Array(n), lz = new Float64Array(n)
  const ys = new Float64Array(n), alongs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const [x, z, y] = pts[i]
    const [px, pz] = pts[Math.max(i - 1, 0)], [nx, nz] = pts[Math.min(i + 1, n - 1)]
    let dx = nx - px, dz = nz - pz
    const len = Math.hypot(dx, dz) || 1
    dx /= len; dz /= len
    fx[i] = x; fz[i] = z; lx[i] = -dz; lz[i] = dx; ys[i] = y + lift
    alongs[i] = i ? alongs[i - 1] + Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]) : 0
  }
  const total = alongs[n - 1]
  const rise = [new Float64Array(n), new Float64Array(n)]          // 0 = the left side, 1 = the right
  if (ground && outer > 0) {
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? 1 : -1
      const ex = new Float64Array(n), ez = new Float64Array(n)
      for (let i = 0; i < n; i++) { ex[i] = fx[i] + lx[i] * sign * outer; ez[i] = fz[i] + lz[i] * sign * outer }
      for (let i = 0; i < n; i++) {
        let t = ground(ex[i], ez[i])                               // …and halfway to each neighbour, so the bilinear
        for (const j of [i - 1, i + 1]) {                          // terrain cannot poke through between two frames
          if (j < 0 || j >= n) continue
          t = Math.max(t, ground((ex[i] + ex[j]) / 2, (ez[i] + ez[j]) / 2))
        }
        rise[s][i] = Math.min(EDGE_RISE, Math.max(0, t + LIFT - (ys[i] + outerDy)))
      }
      blur(rise[s]); blur(rise[s])
      for (let i = 0; i < n; i++) rise[s][i] *= smoothstep(0, END_FADE, Math.min(alongs[i], total - alongs[i]))
    }
  }
  return { n, fx, fz, lx, lz, ys, alongs, total, rise, outer }
}

// a [0.25, 0.5, 0.25] pass with clamped ends, in place
function blur(a) {
  const n = a.length
  if (n < 3) return a
  let prev = a[0]
  for (let i = 1; i < n - 1; i++) { const cur = a[i]; a[i] = 0.25 * prev + 0.5 * cur + 0.25 * a[i + 1]; prev = cur }
  return a
}

// One strip of the cross section: `cols` are [offset from the centreline (+ left), height above the road level],
// ordered left to right. `u0` is where this strip starts across the section so the photo runs on unbroken from the
// strip before it. `code` goes into aRoad.w — a part plus a seed for the surfaces, a pattern plus a lane count for
// the markings. `ends` gives the markings the distance to each give-way junction.
// `soften` metres of wander on the outermost column. A kerbed street should end at a hard line, because that is what
// a kerb is, but a country lane has no edge: the tarmac frays into the verge, gravel and grass creep over it and the
// last hand's width of it is broken. A straight polygon boundary there is the strongest tell that this is geometry
// rather than ground, so the outer column is pushed in and out along its own cross-section and dipped below the
// surface by a world-space hash. Where it dips under, the terrain — which the road only clears by a few centimetres —
// comes through, and the edge reads as worn rather than cut. The hash is keyed to world position, so two tiles agree
// on their shared edge and neighbouring strips of the same road line up.
export function strip(f, cols, u0, hw, code, { dy = 0, ends = null, soften = 0 } = {}) {
  const { n, fx, fz, lx, lz, ys, alongs, rise, outer } = f
  const C = cols.length
  if (n < 2 || C < 2) return null
  const us = [u0]
  for (let c = 1; c < C; c++) us.push(us[c - 1] + Math.hypot(cols[c][0] - cols[c - 1][0], cols[c][1] - cols[c - 1][1]))
  const pos = new Float32Array(n * C * 3), uv = new Float32Array(n * C * 2), road = new Float32Array(n * C * 4)
  const endAttr = ends ? new Float32Array(n * C * 2) : null
  const idx = []
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < C; c++) {
      let o = cols[c][0]
      let h = cols[c][1]
      if (soften && (c === 0 || c === C - 1)) {
        const wx = fx[i] + lx[i] * o, wz = fz[i] + lz[i] * o
        o += (edgeHash(wx * 0.9, wz * 0.9) - 0.45) * soften * Math.sign(o || 1)
        h -= (0.35 + 0.65 * edgeHash(wx * 2.7 + 31, wz * 2.7 - 17)) * soften * 0.5
      }
      const side = o >= 0 ? 0 : 1
      const k = outer > 0 ? smoothstep(0.2, 1.0, Math.abs(o) / outer) : 0
      const v = i * C + c
      pos[3 * v] = fx[i] + lx[i] * o
      pos[3 * v + 1] = ys[i] + h + dy + rise[side][i] * k
      pos[3 * v + 2] = fz[i] + lz[i] * o
      uv[2 * v] = us[c]; uv[2 * v + 1] = alongs[i]
      road[4 * v] = o; road[4 * v + 1] = alongs[i]; road[4 * v + 2] = hw; road[4 * v + 3] = code
      if (endAttr) { endAttr[2 * v] = ends[0] + alongs[i]; endAttr[2 * v + 1] = ends[1] + (f.total - alongs[i]) }
    }
    if (i > 0) for (let c = 0; c < C - 1; c++) {
      const a = (i - 1) * C + c, b = a + 1, cc = i * C + c, d = cc + 1
      idx.push(a, cc, b, b, cc, d)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
  g.setAttribute("aRoad", new THREE.BufferAttribute(road, 4))
  if (endAttr) g.setAttribute("aEnds", new THREE.BufferAttribute(endAttr, 2))
  g.setIndex(idx)
  return g.toNonIndexed()
}

// 0 at an end that meets a junction wider than this road (so haaientanden belong there), NO_END at one that does not
export function yieldEnds(road, junctions, f) {
  const out = [NO_END, NO_END]
  if (!junctions?.length || !YIELDING.has(road.kind)) return out
  const hw = (road.width ?? 4) / 2
  const ends = [road.pts[0], road.pts[road.pts.length - 1]]
  for (const [jx, jz, , r] of junctions) {
    if (r <= hw + 1.4) continue                                    // the node's widest road is no wider than ours
    for (let e = 0; e < 2; e++) if (Math.hypot(ends[e][0] - jx, ends[e][1] - jz) < r + 3.0) out[e] = 0
  }
  if (f && f.total < 6) return [NO_END, NO_END]                    // too short a stub to paint a give-way row on
  return out
}

// ---- junction patches ---------------------------------------------------------------------------------------------

// A fan covering the crossing. RoadBuilder cuts every ribbon back by the node radius, so the patch has to reach past
// that to close the mouths — and its rim has to be at the height of whatever arrives there. Blending the mouth
// heights by angle gives a surface that meets a road climbing in from the east and another dropping away to the
// south at the same time, which a flat disc at the node height cannot.
export function junctionPatch([jx, jz, jy, r], roads, terrainAt, segments = 24) {
  const R = r * 1.08 + 0.4
  const mouths = []
  for (const road of roads) {
    const pts = road.pts
    if (!pts || pts.length < 2) continue
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const d = Math.hypot(p[0] - jx, p[1] - jz)
      if (d < 0.2 || d > R + 4) continue
      mouths.push([Math.atan2(p[1] - jz, p[0] - jx), p[2]])
    }
  }
  const rimY = (a) => {
    let num = jy * 0.4, den = 0.4                                  // the node's own height, as the fallback between arms
    for (const [ma, my] of mouths) { const d = angleGap(a, ma); const w = 1 / (d * d + 0.08); num += my * w; den += w }
    return num / den
  }
  const seed = (hash32(`j:${Math.round(jx)}:${Math.round(jz)}`) % 1024) / 1024
  const code = packCode(PART.JUNCTION, seed)
  const dome = crown(R) * 0.6
  const n = segments
  const pos = new Float32Array(n * 3 * 3), uv = new Float32Array(n * 3 * 2), road = new Float32Array(n * 3 * 4)
  const seat = (x, z, y) => Math.max(y, terrainAt ? Math.min(terrainAt(x, z), y + EDGE_RISE) : y) + LIFT
  let v = 0
  const put = (x, z, y) => {
    pos[3 * v] = x; pos[3 * v + 1] = y; pos[3 * v + 2] = z
    uv[2 * v] = x; uv[2 * v + 1] = z
    road[4 * v] = x - jx; road[4 * v + 1] = z - jz + seed * 40; road[4 * v + 2] = R; road[4 * v + 3] = code
    v++
  }
  const cy = seat(jx, jz, jy + dome)
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2
    const x0 = jx + Math.cos(a0) * R, z0 = jz + Math.sin(a0) * R
    const x1 = jx + Math.cos(a1) * R, z1 = jz + Math.sin(a1) * R
    put(jx, jz, cy)                                                // decreasing angle around the fan: normals face up
    put(x1, z1, seat(x1, z1, rimY(a1)))
    put(x0, z0, seat(x0, z0, rimY(a0)))
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
  g.setAttribute("aRoad", new THREE.BufferAttribute(road, 4))
  return g
}

// smallest angle between two headings, in radians
export function angleGap(a, b) { const d = Math.abs(((a - b) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI); return d }

// ---- bridges -------------------------------------------------------------------------------------------------------

// A flat ribbon along pts ([x, z, y]) of half-width hw, lifted by `lift`, shifted sideways by `offset` metres.
// uvMode "metres": u = 0..2hw across (or 0..wall height for parapets), v = metres along; "unit": u = 0..1 across and
// v = along / TEX_LEN. When `bottom` is given a vertical wall from bottom to lift is built instead (bridge parapets).
export function ribbon(pts, hw, lift, uvMode = "metres", offset = 0, bottom = null) {
  const verts = [], uvs = [], idx = []
  const edges = []                                            // [leftX, leftZ, rightX, rightZ, centreX, centreZ] per point
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
  let along = 0
  for (let i = 0; i < pts.length; i++) {
    const y = pts[i][2]
    if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])   // pts are [x, z, y]
    const [lxp, lzp, rxp, rzp, cx, cz] = edges[i]
    if (bottom === null) verts.push(lxp, y + lift, lzp, rxp, y + lift, rzp)
    else verts.push(cx, y + bottom, cz, cx, y + lift, cz)
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

// give a geometry built the old way the road-local attribute the surface shader needs; along comes from the v of its
// UVs, which is already metres for every one of these
function tag(geo, part, seed) {
  if (!geo) return null
  const pos = geo.attributes.position, uv = geo.attributes.uv
  const road = new Float32Array(pos.count * 4), code = packCode(part, seed)
  for (let i = 0; i < pos.count; i++) { road[4 * i] = 0; road[4 * i + 1] = uv ? uv.getY(i) : 0; road[4 * i + 2] = 1; road[4 * i + 3] = code }
  geo.setAttribute("aRoad", new THREE.BufferAttribute(road, 4))
  return geo
}

// bridge pillars about every 25 m along the deck, from the deck down 40 m (the terrain or water cuts them off),
// turned to the deck heading; a pillar that would land on another road moves along the deck until it stands clear
function pillars(pts, road, roads) {
  const geos = []
  const across = Math.max(1.2, (road.width ?? 4) * 0.35)
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
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false); geos.forEach((g) => g.dispose()); return merged
}

// whether (x, z) keeps `margin` metres between itself and the ribbon of every road but `own`
function clearOfRoads(x, z, roads, own, margin) {
  for (const r of roads) {
    if (r === own) continue
    const reach = (r.width ?? 4) / 2 + margin
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
