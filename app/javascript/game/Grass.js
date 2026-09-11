import * as THREE from "three"

// Grass and flowers where the land cover says grass: for the tiles nearest the player, tufts are scattered on a
// jittered grid wherever the tile's painted cover is green (meadow, lawn, verge) and no road or house stands, as
// instanced crosses of two alpha-tested quads carrying a canvas-painted tuft (three kinds: grass, grass with
// daisies, tall meadow with poppies), tinted per tuft, swaying in the vertex shader and fading out past 120 m.
// Placement runs a few thousand points per frame so a tile never hitches; beyond two tiles the layer is dropped.
const SPACING = 3.2, JITTER = 1.4, FADE_NEAR = 90, FADE_FAR = 140, PER_FRAME = 2500, KEEP_TILES = 1
export const GRASS_UNIFORMS = { uTime: { value: 0 } }

const geometry = (() => {
  const pos = [], uv = [], idx = []
  for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) {                     // three quads in a star
    const ax = Math.cos(a), az = Math.sin(a)
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

const materials = []
function material(kind) {
  if (materials[kind]) return materials[kind]
  const map = new THREE.CanvasTexture(paintTuft(kind)); map.colorSpace = THREE.SRGBColorSpace
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.3, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = GRASS_UNIFORMS.uTime
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nvarying float vFade;")
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = vec3(0.0, 1.0, 0.0);")          // lit like the ground it grows on
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tfloat w = sin(uTime * 1.7 + float(gl_InstanceID) * 1.31) * 0.12 * transformed.y * transformed.y;\n\ttransformed.x += w; transformed.z += w * 0.5;")
      .replace("#include <fog_vertex>", "#include <fog_vertex>\n\tvFade = 1.0 - smoothstep(" + FADE_NEAR.toFixed(1) + ", " + FADE_FAR.toFixed(1) + ", length(mvPosition.xyz));")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vFade;")
      .replace("#include <alphatest_fragment>", "\tdiffuseColor.a *= vFade;\n#include <alphatest_fragment>")
  }
  m.customProgramCacheKey = () => "grass-tuft"
  m.__shared = true
  materials[kind] = m
  return m
}

export class Grass {
  constructor(scene, heightAt) {
    this.scene = scene
    this.heightAt = heightAt
    this.layers = new Map()        // tile key → { group, meshes, job }
    this.jobs = []
  }

  // tile: { key, tx, ty, terrain, roadIndex, water, objects, coverClass: { data, n } }, near: within KEEP_TILES of the player
  update(tiles, cx, cy) {
    for (const t of tiles.values()) {
      if (t.loading) continue
      const near = Math.max(Math.abs(t.tx - cx), Math.abs(t.ty - cy)) <= KEEP_TILES
      const have = this.layers.get(t.key)
      if (near && !have) this.start(t)
      else if (!near && have) this.drop(t.key)
    }
    for (const [key] of this.layers) if (!tiles.has(key)) this.drop(key)
    // a slice of placement work per frame
    let budget = PER_FRAME
    while (budget > 0 && this.jobs.length) {
      const job = this.jobs[0]
      budget -= this.step(job, budget)
      if (job.done) { this.jobs.shift(); this.finish(job) }
    }
  }

  start(t) {
    const job = { tile: t, i: 0, pts: [[], [], []], done: false }
    const n = Math.floor(500 / SPACING)
    job.n = n
    this.layers.set(t.key, { group: null, job })
    this.jobs.push(job)
  }

  // green pixels of the painted cover (1 m per pixel scaled to the class grid) decide where grass grows
  step(job, budget) {
    const t = job.tile, cc = t.coverClass, n = job.n, total = n * n
    const ox = t.terrain.ox, oz = t.terrain.oz
    let used = 0
    while (job.i < total && used < budget) {
      const i = job.i++, gx = i % n, gz = Math.floor(i / n)
      used++
      const jx = hash(gx * 7 + gz * 13 + t.tx) - 0.5, jz = hash(gx * 3 + gz * 17 + t.ty) - 0.5
      const x = ox + (gx + 0.5) * SPACING + jx * 2 * JITTER, z = oz + (gz + 0.5) * SPACING + jz * 2 * JITTER
      // the cover class: sample the downsampled paint
      let lush = 0.4
      if (cc) {
        const px = Math.min(cc.n - 1, Math.floor((x - ox) / 500 * cc.n)), pz = Math.min(cc.n - 1, Math.floor((z - oz) / 500 * cc.n))
        const p = (pz * cc.n + px) * 4, r = cc.data[p], g = cc.data[p + 1], b = cc.data[p + 2]
        if (!(g > r + 8 && g > b + 16 && g > 70)) continue                  // not green: pavement, fields' bare soil, water
        lush = (g - r) / 80                                                 // meadows greener than lawns
      }
      if (hash(i * 31 + t.tx * 3) > 0.55 + lush * 0.5) continue
      if (t.roadIndex && nearRoad(t.roadIndex, x, z)) continue
      if (insideAny(t.water, x, z)) continue
      if (t.objects && inBuilding(t.objects, x, z)) continue
      const kind = hash(i * 11 + 5) < 0.12 ? 2 : hash(i * 5 + 1) < 0.3 ? 1 : 0
      job.pts[kind].push(x, this.heightAt(x, z), z, 0.7 + lush * 0.6)
    }
    if (job.i >= total) job.done = true
    return used
  }

  finish(job) {
    const layer = this.layers.get(job.tile.key)
    if (!layer) return
    const group = new THREE.Group()
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color()
    job.pts.forEach((pts, kind) => {
      const count = pts.length / 4
      if (!count) return
      const mesh = new THREE.InstancedMesh(geometry, material(kind), count)
      for (let i = 0; i < count; i++) {
        const x = pts[i * 4], y = pts[i * 4 + 1], z = pts[i * 4 + 2], lush = pts[i * 4 + 3]
        q.setFromAxisAngle(up, hash(x * 0.37 + z * 0.91) * Math.PI)
        const h = (kind === 2 ? 0.9 : 0.55) * (0.8 + 0.4 * hash(x + z))
        mesh.setMatrixAt(i, m.compose(p.set(x, y - 0.02, z), q, s.set(h * 2.4, h, h * 2.4)))
        mesh.setColorAt(i, c.setRGB(0.85 + 0.2 * hash(z - x), 0.85 + 0.3 * lush * hash(x * 1.3), 0.8))
      }
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      group.add(mesh)
    })
    layer.group = group
    this.scene.add(group)
  }

  drop(key) {
    const layer = this.layers.get(key)
    if (!layer) return
    if (layer.group) { this.scene.remove(layer.group); for (const mesh of layer.group.children) mesh.dispose() }
    layer.job.done = true; this.jobs = this.jobs.filter((j) => j !== layer.job)
    this.layers.delete(key)
  }
}

// ---- placement tests --------------------------------------------------------------------------------------------
function nearRoad(index, x, z) {
  // index: ChunkManager's road grid { x0, z0, nx, nz, cells, cell }; items are segments [ax, az, ay, bx, bz, by, hw] or
  // junction discs [x, z, y, r]. Keep 3.5 m off the asphalt edge: verge, sidewalk and curb stay clear.
  const cx = Math.floor((x - index.x0) / index.cell), cz = Math.floor((z - index.z0) / index.cell)
  if (cx < 0 || cz < 0 || cx >= index.nx || cz >= index.nz) return false
  const items = index.cells[cz * index.nx + cx]
  if (!items) return false
  for (const s of items) {
    if (s.length === 4) { if (Math.hypot(s[0] - x, s[1] - z) < s[3] + 3.5) return true; continue }
    const dx = s[3] - s[0], dz = s[4] - s[1], len2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / len2))
    if (Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z) < s[6] + 3.5) return true
  }
  return false
}
function insideAny(polys, x, z) {
  if (!polys) return false
  for (const w of polys) if (insideRing(x, z, w.ring)) return true
  return false
}
function inBuilding(objects, x, z) {
  for (const h of objects.values()) {
    if (!h.rings) continue
    if (x < h.x - 60 || x > h.x + 60 || z < h.z - 60 || z > h.z + 60) continue
    for (const ring of h.rings) if (insideRing(x, z, ring)) return true
  }
  return false
}
function insideRing(x, z, r) {
  let inside = false
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1]
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
function hash(v) { const x = Math.sin(v * 12.9898) * 43758.5453; return x - Math.floor(x) }

// ---- the painting: a tuft of blades, with daisies or poppies on kinds 1 and 2 -------------------------------------
function paintTuft(kind) {
  const W = 128, H = 128, c = document.createElement("canvas"); c.width = W; c.height = H
  const ctx = c.getContext("2d")
  ctx.clearRect(0, 0, W, H)
  let s = 99 + kind * 17
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const greens = kind === 2 ? ["#6f9a3a", "#86ad44", "#9dbd52", "#b3c95e"] : ["#4f8a34", "#5f9b3c", "#72ad46", "#88bb50", "#a3c85c"]
  ctx.lineCap = "round"
  for (let i = 0; i < 70; i++) {
    const x0 = W * (0.08 + rnd() * 0.84), lean = (rnd() - 0.5) * W * 0.45, h = H * (kind === 2 ? 0.55 + rnd() * 0.45 : 0.35 + rnd() * 0.45)
    ctx.strokeStyle = greens[Math.floor(rnd() * greens.length)]
    ctx.lineWidth = 2 + rnd() * 3
    ctx.beginPath(); ctx.moveTo(x0, H); ctx.quadraticCurveTo(x0 + lean * 0.3, H - h * 0.6, x0 + lean, H - h); ctx.stroke()
  }
  if (kind === 1) for (let i = 0; i < 4; i++) {                              // daisies
    const x = W * (0.2 + rnd() * 0.6), y = H * (0.35 + rnd() * 0.3)
    ctx.fillStyle = "#f4f4ec"; for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; ctx.beginPath(); ctx.arc(x + Math.cos(a) * 4, y + Math.sin(a) * 4, 3.2, 0, Math.PI * 2); ctx.fill() }
    ctx.fillStyle = "#f2c026"; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill()
  }
  if (kind === 2) for (let i = 0; i < 3; i++) {                              // poppies and a purple knapweed
    const x = W * (0.2 + rnd() * 0.6), y = H * (0.15 + rnd() * 0.3)
    ctx.fillStyle = i === 2 ? "#8a4ea8" : "#d8302a"; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = "#2a1a1a"; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill()
  }
  return c
}
