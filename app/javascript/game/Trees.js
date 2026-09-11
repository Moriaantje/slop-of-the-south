import * as THREE from "three"
import { pointKey, hideInstance, showInstance } from "game/Destructibles"

// Trees the way games have built them since SpeedTree: a trunk and branches as real geometry, and the crown as a
// cloud of small leaf cards — dozens of 3D quads at random orientations inside the crown volume, each carrying a
// painted cluster of leaves with alpha, cut out with alpha-to-coverage so the edges stay soft under MSAA. A shader
// does the rest: the cards' normals point out from the crown centre so the whole crown shades round, a wind term
// sways the crown more than the trunk, and light coming through from behind adds a translucent glow (a cheap
// subsurface term). A handful of variants per kind is generated once from fixed seeds and instanced per tile.
// Tile entries: [x, z, kind, height] with kind 0 street/park tree, 1 broadleaf wood, 2 conifer, 3 hoogstam fruit.
// With `reg` every tree registers a destructible handle keyed by its position; a felled tree is a zero-scale instance.
const VARIANTS = { 0: 4, 1: 4, 2: 3, 3: 3 }
const BARK = { 0: 0x5b4634, 1: 0x4e3d30, 2: 0x4a3226, 3: 0x5a4331 }
const LEAVES = {
  0: ["#3f7a32", "#4f8c3a", "#63a046", "#7fb04e", "#9cc25a"],
  1: ["#2d5c27", "#3a6f2e", "#477f36", "#568e3f", "#6d9e48"],
  2: ["#1f4527", "#28522e", "#2f5f36", "#3a6b40"],
  3: ["#4f8a3a", "#63a04a", "#78b256", "#93c264", "#b7d27a"],
}
export const TREE_UNIFORMS = { uTime: { value: 0 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } }

// ---- materials: bark (vertex colours, flat), leaves (cluster texture, alpha to coverage, round normals, wind, translucency)
const barkMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 })
barkMat.__shared = true
const leafMats = {}
function leafMaterial(kind) {
  if (leafMats[kind]) return leafMats[kind]
  const map = new THREE.CanvasTexture(paintCluster(kind, 4000 + kind * 13))
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 4
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.35, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: TREE_UNIFORMS.uTime, uSunDir: TREE_UNIFORMS.uSunDir })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nattribute vec3 crown;\nvarying vec3 vCrownDir;")
      // the card's normal is the direction from the crown centre: the crown shades as one round mass
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = normalize(position - crown + vec3(0.0, 0.15, 0.0));\n\tvCrownDir = objectNormal;")
      // wind: the crown sways with a slow gust plus a flutter per card, the trunk (crown.y == 0) not at all
      .replace("#include <begin_vertex>", `#include <begin_vertex>
\t{
\t\tfloat phase = float(gl_InstanceID) * 0.71;
\t\tfloat gust = sin(uTime * 0.9 + phase) * 0.5 + sin(uTime * 1.7 + phase * 1.3) * 0.25;
\t\tfloat flutter = sin(uTime * 4.0 + position.x * 9.0 + position.z * 7.0) * 0.01;
\t\tfloat h = clamp(position.y, 0.0, 1.0);
\t\ttransformed.x += gust * 0.02 * h * h + flutter; transformed.z += gust * 0.012 * h * h;
\t}`)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSunDir;\nvarying vec3 vCrownDir;")
      // translucency: looking at the crown against the sun, light bleeds through the leaves
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
\t{
\t\tvec3 v = normalize(vViewPosition);
\t\tvec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
\t\tfloat back = pow(clamp(dot(-v, sunV), 0.0, 1.0), 6.0);
\t\ttotalEmissiveRadiance += diffuseColor.rgb * back * 0.9;
\t}`)
  }
  m.customProgramCacheKey = () => "leaf-cards"
  m.__shared = true
  leafMats[kind] = m
  return m
}

const variants = {}
for (const kind of [0, 1, 2, 3]) variants[kind] = Array.from({ length: VARIANTS[kind] }, (_, i) => buildVariant(kind, 1000 * (kind + 1) + 7 * i))

export function buildTrees(trees, heightAt, reg) {
  if (!trees?.length) return null
  const groups = new Map()
  for (const t of trees) {
    const kind = t[2] ?? 1
    const variant = Math.floor(rand(t[0], t[1]) * VARIANTS[kind])
    const key = kind * 10 + variant
    if (!groups.has(key)) groups.set(key, { v: variants[kind][variant], list: [], kind })
    groups.get(key).list.push(t)
  }
  const group = new THREE.Group()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const color = new THREE.Color()
  for (const { v, list, kind } of groups.values()) {
    const wood = new THREE.InstancedMesh(v.wood, barkMat, list.length)
    const leaves = new THREE.InstancedMesh(v.leaves, leafMaterial(kind), list.length)
    list.forEach(([x, z, , h], i) => {
      const spin = rand(z, x), width = (kind === 3 ? 1.3 : 1) * (0.85 + 0.3 * rand(x + 1, z)), tint = 0.85 + 0.3 * rand(x, z + 1)
      q.setFromAxisAngle(up, spin * Math.PI * 2)
      s.set(h * width, h, h * width)                           // the variant is 1 unit tall
      m.compose(p.set(x, heightAt(x, z) - 0.15, z), q, s)
      wood.setMatrixAt(i, m); leaves.setMatrixAt(i, m)
      leaves.setColorAt(i, color.setRGB(tint, tint * (0.97 + 0.06 * rand(x, z + 2)), tint * 0.95))
      reg?.(pointKey("t", x, z), { kind: "t", x, z, r: THREE.MathUtils.clamp(0.08 * h, 0.3, 1), h, max: 30,
        remove: () => { hideInstance(wood, i); hideInstance(leaves, i) }, restore: () => { showInstance(wood, i); showInstance(leaves, i) } })
    })
    wood.instanceMatrix.needsUpdate = true; leaves.instanceMatrix.needsUpdate = true; leaves.instanceColor.needsUpdate = true
    group.add(wood, leaves)
  }
  return group
}

// ---------------------------------------------------------------------------------------------------------------
// variant generation (deterministic per seed); the tree is scaled to exactly 1 unit tall

function buildVariant(kind, seed) {
  const rnd = mulberry32(seed)
  const wood = { pos: [], col: [] }, cards = { pos: [], uv: [], crown: [] }
  const bark = new THREE.Color(BARK[kind])
  const tips = []                                                              // where leaf cards gather
  if (kind === 2) conifer(wood, cards, rnd, bark)
  else branch(wood, rnd, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), kind === 3 ? 0.4 : kind === 0 ? 0.36 : 0.3, kind === 3 ? 0.05 : 0.035, 0, 2, bark, tips)
  if (kind !== 2) {
    // the crown: cards around every tip and filling the hull between them
    const centre = new THREE.Vector3(); for (const t of tips) centre.add(t); centre.divideScalar(tips.length || 1)
    const spread = kind === 3 ? 0.2 : 0.17
    for (const t of tips) for (let k = 0; k < 4; k++) card(cards, rnd, t.clone().add(randomIn(rnd, spread * 0.6)), spread * (1.1 + rnd() * 0.5), centre)
    for (let k = 0; k < tips.length * 1.5; k++) card(cards, rnd, centre.clone().add(randomIn(rnd, spread * 1.8)), spread * (1.1 + rnd() * 0.4), centre)
  }
  // normalise height over both meshes
  let maxY = 0
  for (let i = 1; i < wood.pos.length; i += 3) maxY = Math.max(maxY, wood.pos[i])
  for (let i = 1; i < cards.pos.length; i += 3) maxY = Math.max(maxY, cards.pos[i])
  const k = 1 / (maxY || 1)
  for (let i = 0; i < wood.pos.length; i++) wood.pos[i] *= k
  for (let i = 0; i < cards.pos.length; i++) cards.pos[i] *= k
  for (let i = 0; i < cards.crown.length; i++) cards.crown[i] *= k

  const wg = new THREE.BufferGeometry()
  wg.setAttribute("position", new THREE.Float32BufferAttribute(wood.pos, 3))
  wg.setAttribute("color", new THREE.Float32BufferAttribute(wood.col, 3))
  wg.computeVertexNormals(); wg.__shared = true
  const lg = new THREE.BufferGeometry()
  lg.setAttribute("position", new THREE.Float32BufferAttribute(cards.pos, 3))
  lg.setAttribute("uv", new THREE.Float32BufferAttribute(cards.uv, 2))
  lg.setAttribute("crown", new THREE.Float32BufferAttribute(cards.crown, 3))
  lg.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(cards.pos.length).fill(0), 3))
  lg.__shared = true
  return { wood: wg, leaves: lg }
}

// a leaf card: a quad of `size` at `at`, tilted at random, its crown-centre attribute for the round shading
function card(cards, rnd, at, size, centre) {
  const n = new THREE.Vector3(rnd() - 0.5, rnd() - 0.3, rnd() - 0.5).normalize()
  const u = new THREE.Vector3(1, 0, 0); if (Math.abs(n.x) > 0.9) u.set(0, 0, 1)
  u.cross(n).normalize()
  const v = new THREE.Vector3().crossVectors(n, u)
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]
  corners.forEach(([a, b], i) => {
    const p = at.clone().addScaledVector(u, a * size * 0.5).addScaledVector(v, b * size * 0.5)
    cards.pos.push(p.x, p.y, p.z); cards.uv.push(...uvs[i]); cards.crown.push(centre.x, centre.y, centre.z)
  })
}

function randomIn(rnd, r) { return new THREE.Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.7, rnd() - 0.5).multiplyScalar(2 * r) }

// broadleaf: tapered branch, then 2–3 children tilted outward; the tips collect leaf cards
function branch(out, rnd, origin, dir, len, radius, depth, maxDepth, bark, tips) {
  const end = origin.clone().addScaledVector(dir, len)
  cylinder(out, origin, end, radius, radius * (depth === maxDepth ? 0.35 : 0.65), depth === 0 ? 7 : 5, bark)
  if (depth === maxDepth) { tips.push(end); return }
  const n = 2 + (rnd() < 0.6 ? 1 : 0)
  const az0 = rnd() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const d = tilted(dir, az0 + i * 2 * Math.PI / n + (rnd() - 0.5) * 0.8, 0.45 + rnd() * 0.45)
    branch(out, rnd, end, d, len * (0.62 + rnd() * 0.15), radius * 0.62, depth + 1, maxDepth, bark, tips)
  }
  if (depth >= 1) tips.push(end)
}

// conifer: full-height trunk, tiers of cards hanging outward and down like boughs
function conifer(wood, cards, rnd, bark) {
  cylinder(wood, new THREE.Vector3(), new THREE.Vector3(0, 0.96, 0), 0.03, 0.006, 6, bark)
  const centre = new THREE.Vector3(0, 0.5, 0)
  const tiers = 7
  for (let t = 0; t < tiers; t++) {
    const y = 0.18 + t * 0.78 / tiers, r = 0.26 * (1 - t / (tiers + 0.8))
    const count = 4 + Math.floor(rnd() * 2)
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2 + rnd() * 0.5
      const at = new THREE.Vector3(Math.cos(a) * r * 0.6, y + rnd() * 0.04, Math.sin(a) * r * 0.6)
      card(cards, rnd, at, r * 1.3, centre)
    }
  }
  card(cards, rnd, new THREE.Vector3(0, 0.95, 0), 0.12, centre)
}

function tilted(dir, azimuth, tilt) {
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(dir.x) > 0.9) u.set(0, 0, 1)
  u.cross(dir).normalize()
  const v = new THREE.Vector3().crossVectors(dir, u)
  return new THREE.Vector3().addScaledVector(dir, Math.cos(tilt))
    .addScaledVector(u, Math.cos(azimuth) * Math.sin(tilt)).addScaledVector(v, Math.sin(azimuth) * Math.sin(tilt))
    .add(new THREE.Vector3(0, 0.12, 0)).normalize()
}

function cylinder(out, a, b, ra, rb, segs, color) {
  const axis = b.clone().sub(a).normalize()
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(axis.x) > 0.9) u.set(0, 0, 1)
  u.cross(axis).normalize()
  const v = new THREE.Vector3().crossVectors(axis, u)
  const ring = (c, r, i) => { const t = i / segs * Math.PI * 2; return c.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(v, Math.sin(t) * r) }
  for (let i = 0; i < segs; i++) {
    const a0 = ring(a, ra, i), a1 = ring(a, ra, i + 1), b0 = ring(b, rb, i), b1 = ring(b, rb, i + 1)
    tri(out, a0, b0, b1, color); tri(out, a0, b1, a1, color)
  }
}

function tri(out, a, b, c, color) {
  out.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  out.col.push(color.r, color.g, color.b, color.r, color.g, color.b, color.r, color.g, color.b)
}

// ---- the leaf cluster painting: a 256 px card of overlapping leaves in the kind's greens, lit from the top left
function paintCluster(kind, seed) {
  const rnd = mulberry32(seed)
  const n = 256, c = document.createElement("canvas"); c.width = c.height = n
  const ctx = c.getContext("2d")
  ctx.clearRect(0, 0, n, n)
  const greens = LEAVES[kind]
  if (kind === 2) {
    // needles: many short strokes radiating along twigs
    for (let t = 0; t < 14; t++) {
      const x0 = n * (0.2 + rnd() * 0.6), y0 = n * (0.2 + rnd() * 0.6), a = rnd() * Math.PI * 2
      for (let i = 0; i < 34; i++) {
        const d = i / 34 * n * 0.28, px = x0 + Math.cos(a) * d, py = y0 + Math.sin(a) * d
        ctx.strokeStyle = greens[Math.floor(rnd() * greens.length)]; ctx.lineWidth = 2.2
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a + 1.2) * 10, py + Math.sin(a + 1.2) * 10); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a - 1.2) * 10, py + Math.sin(a - 1.2) * 10); ctx.stroke()
      }
    }
    return c
  }
  const leaf = (x, y, r, a, fill) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = fill
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.bezierCurveTo(r * 0.8, -r * 0.4, r * 0.8, r * 0.5, 0, r); ctx.bezierCurveTo(-r * 0.8, r * 0.5, -r * 0.8, -r * 0.4, 0, -r); ctx.fill()
    ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.stroke()
    ctx.restore()
  }
  for (let i = 0; i < (kind === 3 ? 70 : 90); i++) {
    const ang = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * n * 0.42
    const x = n / 2 + Math.cos(ang) * d, y = n / 2 + Math.sin(ang) * d
    const light = 0.5 + 0.5 * ((n / 2 - x) / n * 0.8 + (n / 2 - y) / n * 1.2)
    const shade = Math.max(0, Math.min(0.999, light * 0.6 + rnd() * 0.5))
    leaf(x, y, n * (0.06 + rnd() * 0.05), rnd() * Math.PI, greens[Math.floor(shade * greens.length)])
  }
  if (kind === 3) for (let i = 0; i < 5; i++) {                                // fruit
    const x = n * (0.2 + rnd() * 0.6), y = n * (0.3 + rnd() * 0.5)
    ctx.fillStyle = rnd() < 0.5 ? "#d8442a" : "#e2b432"; ctx.beginPath(); ctx.arc(x, y, n * 0.03, 0, Math.PI * 2); ctx.fill()
  }
  return c
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// stable pseudo-random in [0,1) from a position
function rand(a, b) {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return x - Math.floor(x)
}
