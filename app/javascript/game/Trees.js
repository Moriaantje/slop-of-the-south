import * as THREE from "three"
import { pointKey, hideInstance, showInstance } from "game/Destructibles"

// Trees as painted billboards: each tree is a cross of two quads carrying a canopy painted once on a canvas (a few
// hundred soft leaf clusters and a trunk, per kind and variant), alpha-tested so the shadow map sees the leaf shape,
// with normals bent into a sphere so the crown is lit round, and a slow sway in the vertex shader. Eight thousand
// of these are four triangles each — a tenth of the old low-poly geometry — and read as foliage from every distance.
// Tile entries: [x, z, kind, height] with kind 0 street/park tree, 1 broadleaf wood, 2 conifer, 3 hoogstam fruit.
// With `reg` every tree registers a destructible handle keyed by its position; a felled tree is a zero-scale instance.
const VARIANTS = { 0: 3, 1: 3, 2: 2, 3: 2 }
const LEAVES = {
  0: ["#3f7a32", "#4f8c3a", "#63a046", "#7fb04e", "#9cc25a"],
  1: ["#2d5c27", "#3a6f2e", "#477f36", "#568e3f", "#6d9e48"],
  2: ["#1f4527", "#28522e", "#2f5f36", "#3a6b40"],
  3: ["#4f8a3a", "#63a04a", "#78b256", "#93c264", "#b7d27a"],
}
export const TREE_UNIFORMS = { uTime: { value: 0 } }

// the cross: two unit quads (1 wide, 1 tall from y = 0) at right angles
const geometry = (() => {
  const pos = [], uv = [], idx = []
  for (const [ax, az] of [[1, 0], [0, 1]]) {
    const b = pos.length / 3
    for (const [sx, y] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]) { pos.push(sx * ax, y, sx * az); uv.push(sx + 0.5, y) }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0), 3))
  g.setIndex(idx)
  g.__shared = true
  return g
})()

const materials = {}
function material(kind, variant) {
  const key = `${kind}:${variant}`
  if (materials[key]) return materials[key]
  const map = new THREE.CanvasTexture(paintTree(kind, 1000 * (kind + 1) + 7 * variant))
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 4
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = TREE_UNIFORMS.uTime
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      // the crown is lit as a sphere around (0, 0.65, 0), the trunk below stays upright
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = normalize(vec3(position.x * 2.2, (position.y - 0.62) * 1.4 + 0.45, position.z * 2.2));")
      // sway: the top of the tree leans with a slow wind, each instance out of phase
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tfloat sway = sin(uTime * 1.1 + float(gl_InstanceID) * 0.73) * 0.025 * transformed.y * transformed.y;\n\ttransformed.x += sway; transformed.z += sway * 0.6;")
  }
  m.customProgramCacheKey = () => "tree-billboard"
  m.__shared = true
  materials[key] = m
  return m
}

export function buildTrees(trees, heightAt, reg) {
  if (!trees?.length) return null
  const groups = new Map()
  for (const t of trees) {
    const kind = t[2] ?? 1
    const variant = Math.floor(rand(t[0], t[1]) * VARIANTS[kind])
    const key = kind * 10 + variant
    if (!groups.has(key)) groups.set(key, { mat: material(kind, variant), list: [], kind })
    groups.get(key).list.push(t)
  }
  const group = new THREE.Group()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const color = new THREE.Color()
  for (const { mat, list, kind } of groups.values()) {
    const mesh = new THREE.InstancedMesh(geometry, mat, list.length)
    list.forEach(([x, z, , h], i) => {
      const spin = rand(z, x), width = (kind === 3 ? 1.3 : kind === 2 ? 0.7 : 1) * (0.85 + 0.3 * rand(x + 1, z)), tint = 0.85 + 0.3 * rand(x, z + 1)
      q.setFromAxisAngle(up, spin * Math.PI * 2)
      s.set(h * width, h, h * width)                           // the painting is 1 unit tall
      mesh.setMatrixAt(i, m.compose(p.set(x, heightAt(x, z) - 0.1, z), q, s))
      mesh.setColorAt(i, color.setRGB(tint, tint * (0.97 + 0.06 * rand(x, z + 2)), tint * 0.95))
      reg?.(pointKey("t", x, z), { kind: "t", x, z, r: THREE.MathUtils.clamp(0.08 * h, 0.3, 1), h, max: 30, remove: () => hideInstance(mesh, i), restore: () => showInstance(mesh, i) })
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.needsUpdate = true
    group.add(mesh)
  }
  return group
}

// ---------------------------------------------------------------------------------------------------------------
// the painting: a 256 × 512 canvas, trunk at the bottom, the crown a cloud of soft leaf discs shaded from the top left

function paintTree(kind, seed) {
  const rnd = mulberry32(seed)
  const W = 256, H = 512, c = document.createElement("canvas"); c.width = W; c.height = H
  const ctx = c.getContext("2d")
  ctx.clearRect(0, 0, W, H)
  const leaves = LEAVES[kind]
  const trunkH = kind === 2 ? 0.16 : kind === 3 ? 0.28 : 0.3                    // share of the height that is bare trunk
  // trunk and a couple of branches
  const bark = ctx.createLinearGradient(0, 0, W, 0); bark.addColorStop(0, "#3a2a1c"); bark.addColorStop(0.5, "#6a4e36"); bark.addColorStop(1, "#33241a")
  ctx.fillStyle = bark
  const tw = kind === 2 ? 0.045 : 0.075
  ctx.beginPath(); ctx.moveTo(W * (0.5 - tw), H); ctx.lineTo(W * (0.5 + tw), H); ctx.lineTo(W * (0.5 + tw * 0.5), H * (1 - trunkH - 0.15)); ctx.lineTo(W * (0.5 - tw * 0.5), H * (1 - trunkH - 0.15)); ctx.fill()
  if (kind !== 2) for (let i = 0; i < 3; i++) {
    const y0 = H * (1 - trunkH - 0.02 - rnd() * 0.1), dir = rnd() < 0.5 ? -1 : 1
    ctx.lineWidth = W * 0.02; ctx.strokeStyle = "#4a3626"; ctx.beginPath(); ctx.moveTo(W / 2, y0); ctx.quadraticCurveTo(W * (0.5 + dir * 0.15), y0 - H * 0.08, W * (0.5 + dir * 0.28), y0 - H * 0.2); ctx.stroke()
  }
  if (kind === 2) {
    // conifer: stacked jagged tiers, darker below
    const tiers = 6
    for (let t = 0; t < tiers; t++) {
      const yBase = H * (0.98 - trunkH * 0.5 - t * (1 - trunkH) / tiers * 0.95), yTop = yBase - H * (1 - trunkH) / tiers * 1.6
      const r = W * 0.46 * (1 - t / (tiers + 1))
      const g = ctx.createLinearGradient(W / 2 - r, 0, W / 2 + r, 0)
      g.addColorStop(0, leaves[0]); g.addColorStop(0.45, leaves[Math.min(3, 1 + t % 3)]); g.addColorStop(1, leaves[1])
      ctx.fillStyle = g
      ctx.beginPath(); ctx.moveTo(W / 2, yTop)
      for (let k = 0; k <= 8; k++) { const f = k / 8, x = W / 2 + r * (f * 2 - 1), jag = (k % 2 ? -1 : 1) * H * 0.012 + (rnd() - 0.5) * H * 0.01; ctx.lineTo(x, yBase + jag - Math.abs(f * 2 - 1) * H * 0.01) }
      ctx.closePath(); ctx.fill()
    }
    return c
  }
  // broadleaf: many soft discs, denser and darker towards the bottom, a light from the top left
  const cx = W / 2, cy = H * (1 - trunkH) * 0.5, rx = W * 0.47, ry = H * (1 - trunkH) * 0.48
  const n = kind === 3 ? 240 : 320
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.92
    const x = cx + Math.cos(a) * rx * d, y = cy + Math.sin(a) * ry * d * (kind === 3 ? 0.9 : 1)
    const light = 0.5 + 0.5 * (((cx - x) / rx) * 0.4 + ((cy - y) / ry) * 0.6)           // top-left brighter
    const shade = Math.max(0, Math.min(1, light * 0.7 + rnd() * 0.5 - (d * 0.3)))
    ctx.fillStyle = leaves[Math.min(leaves.length - 1, Math.floor(shade * leaves.length))]
    const r = W * (0.035 + rnd() * 0.05)
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, ctx.fillStyle); g.addColorStop(0.7, ctx.fillStyle); g.addColorStop(1, "rgba(0,0,0,0)")
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
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
