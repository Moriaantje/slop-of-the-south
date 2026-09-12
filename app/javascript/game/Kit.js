import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { WIND, WIND_PARS } from "game/Wind"
import { GRASS_UNIFORMS } from "game/Grass"
import { leafAtlas, bleedAlpha, blob, shade, paletteOf } from "game/Foliage"
import { treeBarkMaterial, treeSpeciesGeometry, treeLeafMaterial } from "game/Trees"

// The things a Limburg field actually has in it that no model kit ships: cut stumps, stacked cordwood, molehills,
// reed beds at the water's edge, five-bar farm gates, mergel dry-stone walls, brambles and wildflower patches, and
// above all a proper hedge. Every one is generated here from primitives and merged into a single geometry per
// material, because the whole point is that Scatter can put a thousand of them down for one draw call. Nothing here
// loads a file, so nothing here can be missing.
//
// Three materials cover the lot. Timber borrows the trees' bark material, so a stump and the tree it was cut from
// are the same wood and the same normal-mapped furrows; stone and soil share one flat-shaded vertex-coloured
// material, because flat shading is what makes rough split stone read as stone; and anything with leaves or blades
// uses a card material that bends in the same wind as the grass around it. Colour is carried per vertex rather than
// per material, which is what lets a heap of firewood have pale cut ends and dark bark sides in one mesh.
const BARK_TILE = 0.42        // m per repeat of the bark texture, matching Trees.js
const CARD_ALPHA = 0.36       // alpha cut for leaf and petal cards
const FLOWER_PX = 192         // px of the wildflower card texture

// ---- materials ---------------------------------------------------------------------------------------------------

let roughMat = null
// Stone, soil, mortar: flat shaded so every facet of a split block catches the light differently, which is most of
// what tells a dry-stone wall from a painted box.
export function kitStoneMaterial() {
  if (roughMat) return roughMat
  roughMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 })
  roughMat.__shared = true
  return roughMat
}

const cardMats = new Map()
// Leaves, petals and blades: alpha cut, lit as if facing the sky so a hedge shades like a mass rather than a pile of
// quads, darker at the foot, and bending in the shared wind through a `flex` attribute.
export function kitCardMaterial(name, map, { skyLit = true, cut = true } = {}) {
  if (cardMats.has(name)) return cardMats.get(name)
  // solid blades want no alpha cut at all: alphaTest with a constant alpha of one hands smoothstep two equal edges,
  // which the GLSL spec leaves undefined and some drivers read as zero
  const m = new THREE.MeshStandardMaterial({ map, vertexColors: true, alphaTest: cut ? CARD_ALPHA : 0, alphaToCoverage: cut,
                                             side: THREE.DoubleSide, roughness: 0.9, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: GRASS_UNIFORMS.uTime, uWindDir: WIND.uWindDir, uWindGust: WIND.uWindGust })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nattribute float flex;\nvarying float vFoot;${WIND_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
\t{
\t\t#ifdef USE_INSTANCING
\t\tvec3 anchor = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
\t\t#else
\t\tvec3 anchor = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
\t\t#endif
\t\tvFoot = flex;
\t\ttransformed += windOffset(anchor, flex, 0.10, 0.012, uTime);
\t}`)
    if (skyLit) shader.vertexShader = shader.vertexShader
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = normalize(normal + vec3(0.0, 1.1, 0.0));")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vFoot;")
      .replace("#include <color_fragment>", "#include <color_fragment>\n\tdiffuseColor.rgb *= mix(0.42, 1.0, vFoot);")
  }
  m.customProgramCacheKey = () => `kit-card-${skyLit ? "sky" : "own"}-${cut ? "cut" : "solid"}`
  m.__shared = true
  cardMats.set(name, m)
  return m
}

// ---- the pieces --------------------------------------------------------------------------------------------------

const pieces = new Map()
export const KIT = ["stump", "logpile", "reed", "molehill", "gate", "drystone", "flowers", "bramble", "hedge", "pollard"]

// [{ geometry, material }] for one kit piece, built once. Every piece stands on y = 0 and is sized in metres, so
// Scatter's uniform scale reads as "how big is this one" rather than a magic number.
// Hedges, gates and walls are modelled lying along x because that is how you think about a wall while building it,
// but a boundary piece has to run along its own z: Scatter turns a prop so that its z follows the field edge, which
// is the convention the imported kit fences already use. Turning the geometry once here keeps every edge piece
// consistent, rather than making the placement code remember which model was built which way round.
const ALONG_X = new Set(["hedge", "gate", "drystone"])

export function kitPiece(name) {
  if (pieces.has(name)) return pieces.get(name)
  const out = BUILD[name] ? BUILD[name]() : []
  if (ALONG_X.has(name)) for (const p of out) p.geometry.rotateY(Math.PI / 2)
  pieces.set(name, out)
  return out
}

const BUILD = {
  // A cut stump with its root buttresses flaring into the ground and a pale sawn face on top.
  stump: () => {
    const parts = []
    const bark = new THREE.Color(0x6f5f4a), cut = new THREE.Color(0xc3a97e)
    parts.push(solid(new THREE.CylinderGeometry(0.30, 0.40, 0.52, 9, 1, true), bark, pose(0, 0.26, 0), 0.9))
    const top = solid(new THREE.CircleGeometry(0.30, 9), cut, pose(0, 0.52, 0, -Math.PI / 2), 1)
    parts.push(top)
    for (let i = 0; i < 5; i++) {                                   // roots breaking the ground line
      const a = i / 5 * Math.PI * 2 + 0.4
      parts.push(solid(new THREE.CylinderGeometry(0.05, 0.15, 0.5, 5, 1, true), bark,
        pose(Math.cos(a) * 0.30, 0.07, Math.sin(a) * 0.30, Math.PI / 2.1, a, 0), 0.6))
    }
    return [{ geometry: merge(parts), material: treeBarkMaterial() }]
  },

  // Cordwood stacked three, two, one, every log showing its sawn end. The stack is what a Limburg yard edge looks
  // like all winter, and it is three cylinders' worth of geometry.
  logpile: () => {
    const parts = []
    const bark = new THREE.Color(0x60513e), cut = new THREE.Color(0xbda173)
    const rows = [[-0.34, -0.02, 0.34], [-0.18, 0.18], [0]]
    rows.forEach((row, r) => {
      for (const x of row) {
        const y = 0.17 + r * 0.30, len = 1.5 + (r % 2) * 0.2, rad = 0.15
        parts.push(solid(new THREE.CylinderGeometry(rad, rad, len, 7, 1, true), bark, pose(x, y, 0, 0, 0, Math.PI / 2), 1.1))
        for (const s of [-1, 1]) parts.push(solid(new THREE.CircleGeometry(rad, 7), cut, pose(x, y, 0, 0, s * Math.PI / 2, 0), 1))
      }
    })
    return [{ geometry: merge(parts), material: treeBarkMaterial() }]
  },

  // A mole's spoil heap: a squashed cone of fresh dark earth with a couple of clods beside it. Tiny, and the sort of
  // thing that makes a meadow look lived in rather than mown by a shader.
  molehill: () => {
    const parts = []
    const soil = new THREE.Color(0x3b2e22)
    parts.push(solid(new THREE.ConeGeometry(0.34, 0.18, 9), soil, pose(0, 0.09, 0), 1))
    parts.push(solid(new THREE.ConeGeometry(0.16, 0.09, 7), new THREE.Color(0x4a3a2b), pose(0.28, 0.04, 0.16), 1))
    return [{ geometry: merge(parts), material: kitStoneMaterial() }]
  },

  // A five-bar gate hung between two posts, with the diagonal brace that keeps it from sagging.
  gate: () => {
    const parts = []
    const timber = new THREE.Color(0x7b6a52), post = new THREE.Color(0x5f5140)
    for (const s of [-1, 1]) parts.push(solid(new THREE.BoxGeometry(0.13, 1.45, 0.13), post, pose(s * 1.45, 0.72, 0), 1.2))
    for (let i = 0; i < 5; i++) parts.push(solid(new THREE.BoxGeometry(2.85, 0.09, 0.05), timber, pose(0, 0.24 + i * 0.24, 0), 1.2))
    parts.push(solid(new THREE.BoxGeometry(3.1, 0.08, 0.05), timber, pose(0, 0.72, 0, 0, 0, 0.37), 1.2))
    parts.push(solid(new THREE.BoxGeometry(0.09, 1.0, 0.05), timber, pose(-1.2, 0.72, 0), 1.2))
    return [{ geometry: merge(parts), material: treeBarkMaterial() }]
  },

  // Two metres of mergel dry-stone wall: courses of split blocks laid with the joints broken, each block turned and
  // sized a little differently, with a row of smaller cap stones on top. Flat shaded, so every face reads.
  drystone: () => {
    const parts = []
    const rnd = seeded(4242)
    const tones = [0xbdb5a2, 0xa89f8c, 0xc9c2b0, 0x958d7c, 0xb2a894]
    for (let course = 0; course < 3; course++) {
      const h = course === 2 ? 0.16 : 0.22
      const y = course === 2 ? 0.50 : 0.11 + course * 0.23
      const n = course === 2 ? 6 : 4
      for (let i = 0; i < n; i++) {
        const w = 2.0 / n * (0.8 + rnd() * 0.35)
        const x = -1 + (i + 0.5) * 2.0 / n + (rnd() - 0.5) * 0.08 + (course % 2) * 0.1
        parts.push(solid(new THREE.BoxGeometry(w, h, 0.42 * (0.85 + rnd() * 0.3)), new THREE.Color(tones[Math.floor(rnd() * tones.length)]),
          pose(x, y, (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.09, (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.07), 1))
      }
    }
    return [{ geometry: merge(parts), material: kitStoneMaterial() }]
  },

  // A reed bed: tapered blades fanned out of one root, straw at the tip and green at the foot, with a few brown seed
  // heads. Real ribbons rather than alpha cards, because a reed is a long thin thing and an alpha card of a long thin
  // thing is mostly wasted fill.
  reed: () => {
    const out = { pos: [], nor: [], uv: [], col: [], flex: [] }
    const rnd = seeded(1717)
    const pal = paletteOf("reed")
    for (let i = 0; i < 20; i++) {
      const a = rnd() * Math.PI * 2, lean = 0.18 + rnd() * 0.42
      const h = 1.1 + rnd() * 0.9
      const dir = new THREE.Vector3(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize()
      ribbon(out, new THREE.Vector3(Math.cos(a) * 0.1 * rnd(), 0, Math.sin(a) * 0.1 * rnd()), dir, h, 0.035 + rnd() * 0.02,
             rgb(pal, 0.25), rgb(pal, 0.72 + rnd() * 0.25))
    }
    const parts = [raw(out)]
    for (let i = 0; i < 4; i++) {
      const a = rnd() * Math.PI * 2, r = 0.1 + rnd() * 0.22
      parts.push(solid(new THREE.CylinderGeometry(0.012, 0.028, 0.26, 5), new THREE.Color(0x6b4f33),
        pose(Math.cos(a) * r, 1.5 + rnd() * 0.5, Math.sin(a) * r, (rnd() - 0.5) * 0.3, 0, (rnd() - 0.5) * 0.3), 1, 0.9))
    }
    return [{ geometry: merge(parts), material: kitCardMaterial("reed", null, { skyLit: false, cut: false }) }]
  },

  // A patch of wild flowers: three crossed cards of painted stems, umbels, poppies and cornflowers.
  flowers: () => [{ geometry: cards(crossPlan(0.85, 0.62)), material: kitCardMaterial("flowers", flowerTexture()) }],

  // Brambles: arching canes that root where they touch down, with leaves hung along them. The arch is what makes a
  // bramble a bramble, so the canes are real tubes and only the leaves are cards.
  bramble: () => {
    const parts = [], out = { pos: [], nor: [], uv: [], col: [], flex: [] }
    const rnd = seeded(9091)
    const cane = new THREE.Color(0x5a4736)
    const plan = []
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2 + rnd() * 0.6, reach = 0.55 + rnd() * 0.45, top = 0.55 + rnd() * 0.3
      let prev = new THREE.Vector3(0, 0.05, 0)
      for (let s = 1; s <= 3; s++) {
        const t = s / 3
        const p = new THREE.Vector3(Math.cos(a) * reach * t, top * Math.sin(Math.PI * t * 0.92), Math.sin(a) * reach * t)
        parts.push(tubeBetween(prev, p, 0.022 * (1.1 - t * 0.5), cane))
        plan.push({ at: p.clone(), size: 0.22 * (1 - t * 0.3), flex: 0.25 + t * 0.7 })
        prev = p
      }
    }
    for (const c of plan) for (let k = 0; k < 2; k++) card(out, rnd, c.at, c.size * (0.8 + rnd() * 0.4), c.flex, 0.92)
    return [{ geometry: merge(parts), material: treeBarkMaterial() },
            { geometry: raw(out), material: kitCardMaterial("bramble", leafAtlas("bramble").map) }]
  },

  // A metre and a half of hedgerow: a dark twiggy core with leaf cards packed over its surface, denser on top where
  // the light is. Instanced end to end this is what draws the field boundaries of the whole province, so it is kept
  // to about eighty triangles and its leaves come from the same atlas the trees use.
  hedge: () => {
    const rnd = seeded(3131)
    const parts = [solid(new THREE.BoxGeometry(1.3, 1.0, 0.72), new THREE.Color(0x2c2a1e), pose(0, 0.55, 0), 1)]
    const out = { pos: [], nor: [], uv: [], col: [], flex: [] }
    for (let i = 0; i < 34; i++) {
      const u = rnd() - 0.5, v = rnd(), w = rnd() - 0.5
      const at = new THREE.Vector3(u * 1.5, 0.16 + v * 1.08, w * 0.86)
      card(out, rnd, at, 0.30 + rnd() * 0.16, 0.15 + v * 0.8, 0.6 + v * 0.4)
    }
    return [{ geometry: merge(parts), material: kitStoneMaterial() },
            { geometry: raw(out), material: kitCardMaterial("hedge", leafAtlas("beech").map) }]
  },

  // A pollard willow, straight out of the tree generator so the ones Scatter stands along a ditch are the same
  // plant as the ones the tile data asks for.
  pollard: () => {
    const v = treeSpeciesGeometry("pollard", 5150)
    return [{ geometry: v.wood, material: treeBarkMaterial() },
            { geometry: v.leaves, material: treeLeafMaterial("willow") }]
  },
}

// ---- geometry helpers ----------------------------------------------------------------------------------------

// a primitive, flattened, placed, painted one colour and given bark UVs at `uvScale` metres per repeat
function solid(geo, colour, matrix, uvScale = 1, flex = 0) {
  const g = geo.toNonIndexed()
  g.applyMatrix4(matrix)
  const n = g.attributes.position.count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { col[i * 3] = colour.r; col[i * 3 + 1] = colour.g; col[i * 3 + 2] = colour.b }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3))
  const uv = g.attributes.uv
  if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale / BARK_TILE, uv.getY(i) * uvScale / BARK_TILE)
  g.setAttribute("flex", new THREE.Float32BufferAttribute(new Float32Array(n).fill(flex), 1))
  return g
}

function tubeBetween(a, b, r, colour) {
  const len = a.distanceTo(b)
  const mid = a.clone().lerp(b, 0.5)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1))
  return solid(new THREE.CylinderGeometry(r * 0.75, r, len, 4, 1, true), colour, m, 0.5, 0.5)
}

function pose(x, y, z, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1))
}

function merge(parts) {
  const g = parts.length === 1 ? parts[0] : (mergeGeometries(parts, false) ?? parts[0])
  g.computeVertexNormals()
  g.__shared = true
  return g
}

// a raw soup of triangles collected by ribbon() and card()
function raw(out) {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(out.pos, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(out.nor, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(out.uv, 2))
  g.setAttribute("color", new THREE.Float32BufferAttribute(out.col, 3))
  g.setAttribute("flex", new THREE.Float32BufferAttribute(out.flex, 1))
  g.__shared = true
  return g
}

// one tapered blade: two triangles running from a wide foot to a point, flex rising with height so the tip whips
function ribbon(out, base, dir, h, w, colFoot, colTip) {
  const side = new THREE.Vector3(0, 1, 0).cross(dir)
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
  side.normalize()
  const tip = base.clone().addScaledVector(dir, h)
  const nor = new THREE.Vector3().crossVectors(side, dir).normalize()
  const a = base.clone().addScaledVector(side, -w), b = base.clone().addScaledVector(side, w)
  const c = tip.clone().addScaledVector(side, -w * 0.12), d = tip.clone().addScaledVector(side, w * 0.12)
  const push = (p, u, v, col, flex) => {
    out.pos.push(p.x, p.y, p.z); out.nor.push(nor.x, nor.y, nor.z); out.uv.push(u, v)
    out.col.push(col.r, col.g, col.b); out.flex.push(flex)
  }
  push(a, 0, 0, colFoot, 0); push(b, 1, 0, colFoot, 0); push(d, 1, 1, colTip, 1)
  push(a, 0, 0, colFoot, 0); push(d, 1, 1, colTip, 1); push(c, 0, 1, colTip, 1)
}

// one leaf card: a quad at a random tilt taking a random cell of a 2x2 atlas
function card(out, rnd, at, size, flex, lit) {
  const n = new THREE.Vector3(rnd() - 0.5, rnd() - 0.15, rnd() - 0.5).normalize()
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(n.x) > 0.9) u.set(0, 0, 1)
  u.cross(n).normalize()
  const v = new THREE.Vector3().crossVectors(n, u)
  const cell = Math.floor(rnd() * 4), cx = (cell % 2) * 0.5, cy = Math.floor(cell / 2) * 0.5
  const half = size * 0.5, c = new THREE.Color(lit, lit, lit)
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
    const p = at.clone().addScaledVector(u, a * half).addScaledVector(v, b * half)
    out.pos.push(p.x, p.y, p.z); out.nor.push(n.x, n.y, n.z)
    out.uv.push(cx + (a * 0.25 + 0.25), cy + (b * 0.25 + 0.25))
    out.col.push(c.r, c.g, c.b); out.flex.push(flex)
  }
}

// three quads crossing at sixty degrees: the cheapest thing that still has parallax from every angle
function crossPlan(w, h) {
  const list = []
  for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) list.push({ a, w, h })
  return list
}

function cards(plan) {
  const out = { pos: [], nor: [], uv: [], col: [], flex: [] }
  for (const { a, w, h } of plan) {
    const ax = Math.cos(a) * w * 0.5, az = Math.sin(a) * w * 0.5
    const nor = new THREE.Vector3(-Math.sin(a), 0.4, Math.cos(a)).normalize()
    const corner = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]]
    for (const [sx, sy] of corner) {
      out.pos.push(sx * ax, sy * h, sx * az)
      out.nor.push(nor.x, nor.y, nor.z)
      out.uv.push(sx * 0.5 + 0.5, sy)
      out.col.push(1, 1, 1)
      out.flex.push(sy * sy)
    }
  }
  return raw(out)
}

// ---- the wildflower card -------------------------------------------------------------------------------------
let flowerCanvas = null
function flowerTexture() {
  if (flowerCanvas) return flowerCanvas
  const W = FLOWER_PX, c = document.createElement("canvas")
  c.width = c.height = W
  const ctx = c.getContext("2d")
  const rnd = seeded(606)
  const pal = paletteOf("lime")
  ctx.lineCap = "round"
  for (let i = 0; i < 40; i++) {                                     // the greenery the flowers stand in
    const x = W * (0.06 + rnd() * 0.88), h = W * (0.25 + rnd() * 0.45)
    ctx.strokeStyle = shade(pal, 0.2 + rnd() * 0.5); ctx.lineWidth = 1.4 + rnd() * 2.2
    ctx.beginPath(); ctx.moveTo(x, W); ctx.quadraticCurveTo(x + (rnd() - 0.5) * 22, W - h * 0.55, x + (rnd() - 0.5) * 34, W - h); ctx.stroke()
  }
  const heads = [
    ["#d8402f", "#2a1a18", 6.5],   // klaproos
    ["#5468b4", "#2a2a38", 5.0],   // korenbloem
    ["#e8d24a", "#8a6a20", 4.2],   // boterbloem
    ["#f2f0e4", "#c9b24a", 4.0],   // margriet
    ["#9a5cb0", "#3a2244", 4.6],   // knoopkruid
  ]
  for (let i = 0; i < 16; i++) {
    const [petal, eye, r] = heads[Math.floor(rnd() * heads.length)]
    const x = W * (0.1 + rnd() * 0.8), y = W * (0.12 + rnd() * 0.52)
    ctx.strokeStyle = shade(pal, 0.3); ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(x + (rnd() - 0.5) * 16, W * 0.95); ctx.quadraticCurveTo(x, y + 30, x, y + r); ctx.stroke()
    const petals = 5 + Math.floor(rnd() * 3)
    for (let k = 0; k < petals; k++) {
      const a = k / petals * Math.PI * 2 + rnd() * 0.3
      blob(ctx, x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, r * 0.72, petal)
    }
    blob(ctx, x, y, r * 0.36, eye)
  }
  bleedAlpha(c, 3)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  flowerCanvas = tex
  return tex
}

const rgb = (pal, k) => { const s = shade(pal, k).match(/\d+/g).map(Number); return new THREE.Color().setRGB(s[0] / 255, s[1] / 255, s[2] / 255, THREE.SRGBColorSpace) }
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }
