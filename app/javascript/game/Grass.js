import * as THREE from "three"
import { nearRoad, insideAny, inBuilding, hash } from "game/Placement"
import { WIND, WIND_PARS } from "game/Wind"
import { bleedAlpha, blob, shade, paletteOf } from "game/Foliage"

// Ground cover where the land cover says green. Tufts are scattered on a jittered grid wherever the tile's painted
// cover is actually green — meadow, lawn, verge — and no road or house stands, as instanced three-quad stars
// carrying a canvas-painted tuft of blades, and they are drawn in two tiers. The sparse tier is tall and reaches out
// to the fog. The dense tier is three short extra tufts crowded around every point the sparse tier accepted, and it
// only exists within NEAR_FAR metres of the viewer. That is the shape of the problem: close to the camera it is the
// bare ground between tufts that reads as cheap, and far away nobody can count them, so the density that matters is
// bought only where it is seen.
//
// The dense tier is never stored. Each of its tufts is a pure function of the sparse tuft it belongs to — the angle
// and radius come out of the same hash — so a twenty-metre cell can be built the moment it comes within reach and
// thrown away the moment it leaves, and a tile carries nothing for it but the sparse points it already had. Held as
// data instead, a tile of meadow would be sixty thousand instances of which some two thousand are ever drawn.
//
// Two things tie the grass to the ground it grows on. Its colour is taken from the same cover pixel the terrain is
// painted with, so a tuft on a dry verge is straw and a tuft in a water meadow is deep green rather than every blade
// in the province being the same sampled swatch. And it bends in the shared wind of Wind.js, the one the trees use,
// so a gust crosses the field and the hedge and the crown of the oak above it together.
//
// Placement runs a few thousand candidates per frame so a tile never hitches, the tufts are split into cells that
// are culled whole before the GPU hears about them, and beyond KEEP_TILES the layer is dropped outright.
const SPACING = 3.8, JITTER = 1.5          // m between sparse candidates, and how far one may wander off the grid
const INFILL = 3                           // dense tufts crowded around each accepted sparse one
const FADE_NEAR = 80, FADE_FAR = 130       // m: the sparse tier dissolves between these
const NEAR_FADE = 26, NEAR_FAR = 40        // m: the dense tier dissolves between these
const PER_FRAME = 2600                     // candidates tested per frame across all tiles
const KEEP_TILES = 1, CELL = 100, CELL_NEAR = 25   // m: the culling grids, tight for the dense tier
const NEAR_REACH = NEAR_FAR + CELL_NEAR * 0.71    // m: a dense cell is built once its nearest corner could be seen
const CELLS_PER_FRAME = 2                  // dense cells built per frame, so a fast drive never hitches
const STRIDE = 8                           // floats per stored sparse tuft: x, y, z, lush, r, g, b, kind
const TALL = 0.62, SHORT = 0.30            // m: the height of a sparse and a dense tuft before variation
const SWAY = 0.26, FLUTTER = 0.02          // units of travel at the tip in a fresh breeze
// The average sRGB of the painted tuft texture. Tinting is a ratio against this in linear light, so a tuft comes out
// the colour of the ground beneath it rather than the colour the brush happened to use.
const REF = [0.36, 0.52, 0.23]
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

const materials = new Map(), tufts = new Map()
// the sparse and dense tiers of one kind wear the same painting, so it is uploaded once
function tuftTexture(kind) {
  if (tufts.has(kind)) return tufts.get(kind)
  const t = new THREE.CanvasTexture(paintTuft(kind))
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  tufts.set(kind, t)
  return t
}
// exported so the shader-injection test can compile it against three's real source
export function grassMaterial(kind, dense) {
  const key = `${kind}:${dense ? "n" : "f"}`
  if (materials.has(key)) return materials.get(key)
  const map = tuftTexture(kind)
  const near = dense ? NEAR_FADE : FADE_NEAR, far = dense ? NEAR_FAR : FADE_FAR
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.3, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: GRASS_UNIFORMS.uTime, uWindDir: WIND.uWindDir, uWindGust: WIND.uWindGust })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nvarying float vFade;\nvarying float vBlade;${WIND_PARS}`)
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = vec3(0.0, 1.0, 0.0);\n\tvBlade = position.y;")   // lit like the ground it grows on
      .replace("#include <begin_vertex>", `#include <begin_vertex>
\t{
\t\t#ifdef USE_INSTANCING
\t\tvec3 anchor = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
\t\t#else
\t\tvec3 anchor = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
\t\t#endif
\t\ttransformed += windOffset(anchor, position.y * position.y, ${SWAY.toFixed(3)}, ${FLUTTER.toFixed(3)}, uTime);
\t}`)
      .replace("#include <fog_vertex>", `#include <fog_vertex>\n\tvFade = 1.0 - smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, length(mvPosition.xyz));`)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vFade;\nvarying float vBlade;")
      .replace("#include <alphatest_fragment>", "\tdiffuseColor.a *= vFade;\n#include <alphatest_fragment>")
      // the base of a tuft sits in its own shade; without this the grass looks pasted onto the ground
      .replace("#include <color_fragment>", "#include <color_fragment>\n\tdiffuseColor.rgb *= mix(0.45, 1.0, vBlade);")
  }
  m.customProgramCacheKey = () => `grass-tuft-${dense ? "n" : "f"}`
  m.__shared = true
  materials.set(key, m)
  return m
}

// The colour a tuft should be to sit in ground painted (r, g, b). The ratio is taken in linear light and then pulled
// most of the way back towards neutral: the point is to follow the ground, not to repaint the grass.
export function coverTint(r, g, b, blend = 0.7) {
  const lin = (v) => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2)
  const out = [r, g, b].map((v, i) => {
    const ratio = lin(v) / Math.max(1e-4, Math.pow(REF[i], 2.2))
    return Math.max(0.45, Math.min(1.9, 1 + (ratio - 1) * blend))
  })
  return out
}

export class Grass {
  constructor(scene, heightAt) {
    this.scene = scene
    this.heightAt = heightAt
    this.layers = new Map()        // tile key → { group, job, pts, cells, live }
    this.jobs = []
    this.viewX = 0; this.viewZ = 0
  }

  // tile: { key, tx, ty, terrain, roadIndex, water, objects, coverClass: { data, n } }, near: within KEEP_TILES
  update(tiles, cx, cy, viewX = 0, viewZ = 0) {
    this.viewX = viewX; this.viewZ = viewZ
    for (const t of tiles.values()) {
      if (t.loading) continue
      const near = Math.max(Math.abs(t.tx - cx), Math.abs(t.ty - cy)) <= KEEP_TILES
      const have = this.layers.get(t.key)
      if (near && !have) this.start(t)
      else if (!near && have) this.drop(t.key)
    }
    for (const [key] of this.layers) if (!tiles.has(key)) this.drop(key)
    let budget = CELLS_PER_FRAME
    for (const layer of this.layers.values()) {
      if (!layer.group) continue
      // the sparse tier: only the cells within sight draw, skipped before the GPU ever hears of them
      for (const mesh of layer.sparse) {
        const d = Math.hypot(mesh.userData.cx - viewX, mesh.userData.cz - viewZ)
        mesh.visible = d < FADE_FAR + CELL * 0.71
      }
      budget = this.dense(layer, budget)
    }
    // a slice of placement work per frame
    let work = PER_FRAME
    while (work > 0 && this.jobs.length) {
      const job = this.jobs[0]
      work -= this.step(job, work)
      if (job.done) { this.jobs.shift(); this.finish(job) }
    }
  }

  start(t) {
    const job = { tile: t, i: 0, pts: [], done: false, n: Math.floor(500 / SPACING) }
    this.layers.set(t.key, { group: null, job, sparse: [], cells: null, live: new Map() })
    this.jobs.push(job)
  }

  // green pixels of the painted cover (1 m per pixel scaled to the class grid) decide where grass grows; the cover
  // colour itself rides along with every accepted point so the tuft can be tinted to match the ground it stands in
  step(job, budget) {
    const t = job.tile, cc = t.coverClass, n = job.n, total = n * n
    const ox = t.terrain.ox, oz = t.terrain.oz
    let used = 0
    while (job.i < total && used < budget) {
      const i = job.i++, gx = i % n, gz = Math.floor(i / n)
      used++
      const jx = hash(gx * 7 + gz * 13 + t.tx) - 0.5, jz = hash(gx * 3 + gz * 17 + t.ty) - 0.5
      const x = ox + (gx + 0.5) * SPACING + jx * 2 * JITTER, z = oz + (gz + 0.5) * SPACING + jz * 2 * JITTER
      let lush = 0.4, cr = 92, cg = 133, cb = 59
      if (cc) {
        const px = Math.min(cc.n - 1, Math.floor((x - ox) / 500 * cc.n)), pz = Math.min(cc.n - 1, Math.floor((z - oz) / 500 * cc.n))
        const p = (pz * cc.n + px) * 4
        cr = cc.data[p]; cg = cc.data[p + 1]; cb = cc.data[p + 2]
        if (!(cg > cr + 8 && cg > cb + 16 && cg > 70)) continue              // not green: pavement, bare soil, water
        lush = (cg - cr) / 80                                                // meadows greener than lawns
      }
      if (hash(i * 31 + t.tx * 3) > 0.58 + lush * 0.45) continue
      if (t.roadIndex && nearRoad(t.roadIndex, x, z)) continue
      if (insideAny(t.water, x, z)) continue
      if (t.objects && inBuilding(t.objects, x, z)) continue
      const kind = hash(i * 11 + 5) < 0.12 ? 2 : hash(i * 5 + 1) < 0.3 ? 1 : 0
      job.pts.push(x, this.heightAt(x, z), z, lush, cr, cg, cb, kind)
    }
    if (job.i >= total) job.done = true
    return used
  }

  finish(job) {
    const layer = this.layers.get(job.tile.key)
    if (!layer) return
    const ox = job.tile.terrain.ox, oz = job.tile.terrain.oz
    layer.group = new THREE.Group()
    layer.ox = ox; layer.oz = oz
    layer.pts = new Float32Array(job.pts)
    job.pts = null
    // the sparse tier, in hundred-metre cells so a whole patch can be culled at once
    const byCell = index(layer.pts, ox, oz, CELL, (i) => layer.pts[i + 7])
    for (const [key, offsets] of byCell) {
      const [k, kind] = key
      layer.sparse.push(this.mesh(layer, offsets, kind, false, k, CELL))
    }
    // the dense tier is only indexed here; a cell is not built until the viewer is close enough to see it
    layer.cells = index(layer.pts, ox, oz, CELL_NEAR, () => 0)
    this.scene.add(layer.group)
  }

  // build the dense cells that have come within reach and throw away the ones that have left
  dense(layer, budget) {
    const n = Math.ceil(500 / CELL_NEAR)
    for (const [key, offsets] of layer.cells) {
      const k = key[0]
      const cx = layer.ox + ((k % n) + 0.5) * CELL_NEAR, cz = layer.oz + (Math.floor(k / n) + 0.5) * CELL_NEAR
      const want = Math.hypot(cx - this.viewX, cz - this.viewZ) < NEAR_REACH
      const have = layer.live.get(k)
      if (want && !have) {
        if (budget <= 0) continue
        budget--
        layer.live.set(k, [this.mesh(layer, offsets, 0, true, k, CELL_NEAR)])   // one look close up; the flowers are Scatter's job
      } else if (!want && have) {
        for (const mesh of have) { layer.group.remove(mesh); mesh.dispose() }
        layer.live.delete(k)
      }
    }
    return budget
  }

  // one instanced patch. For the sparse tier each stored point is one tuft; for the dense tier each stored point
  // stands in for INFILL short ones, whose places come straight back out of the hash that put the first one there.
  mesh(layer, offsets, kind, isDense, cellKey, cell) {
    const pts = layer.pts
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0), c = new THREE.Color()
    const spots = []
    for (const i of offsets) {
      if (!isDense) { if (pts[i + 7] !== kind) continue; spots.push([pts[i], pts[i + 1], pts[i + 2], i]); continue }
      for (let k = 0; k < INFILL; k++) {
        const a = hash(pts[i] * 3.7 + pts[i + 2] * 1.3 + k * 19.3) * Math.PI * 2
        const r = 0.45 + hash(pts[i] * 5.1 - pts[i + 2] * 2.7 + k * 7.7) * SPACING * 0.5
        const x = pts[i] + Math.cos(a) * r, z = pts[i + 2] + Math.sin(a) * r
        spots.push([x, this.heightAt(x, z), z, i])
      }
    }
    const mesh = new THREE.InstancedMesh(geometry, grassMaterial(kind, isDense), Math.max(1, spots.length))
    spots.forEach(([x, y, z, i], j) => {
      const lush = pts[i + 3]
      q.setFromAxisAngle(up, hash(x * 0.37 + z * 0.91) * Math.PI)
      const base = isDense ? SHORT : (kind === 2 ? TALL * 1.5 : TALL)
      const h = base * (0.78 + 0.44 * hash(x + z)) * (0.85 + lush * 0.3)
      mesh.setMatrixAt(j, m.compose(p.set(x, y - 0.02, z), q, s.set(h * 2.4, h, h * 2.4)))
      const [tr, tg, tb] = coverTint(pts[i + 4], pts[i + 5], pts[i + 6])
      const v = 0.88 + 0.24 * hash(z - x)
      mesh.setColorAt(j, c.setRGB(tr * v, tg * v * (0.96 + 0.08 * lush), tb * v))
    })
    mesh.count = spots.length
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    const n = Math.ceil(500 / cell)
    mesh.userData.cx = layer.ox + ((cellKey % n) + 0.5) * cell
    mesh.userData.cz = layer.oz + (Math.floor(cellKey / n) + 0.5) * cell
    mesh.visible = isDense && spots.length > 0
    layer.group.add(mesh)
    return mesh
  }

  drop(key) {
    const layer = this.layers.get(key)
    if (!layer) return
    if (layer.group) { this.scene.remove(layer.group); for (const mesh of layer.group.children) mesh.dispose() }
    layer.job.done = true; this.jobs = this.jobs.filter((j) => j !== layer.job)
    this.layers.delete(key)
  }
}

// Sort stored tufts into square cells, keyed by cell and by whatever `of` says makes two tufts different (the tuft
// kind for the sparse tier, nothing for the dense one). The cell index is clamped so a tuft that jittered a metre
// over the tile edge joins the cell it is nearest rather than wrapping into the next row.
function index(pts, ox, oz, cell, of) {
  const n = Math.ceil(500 / cell)
  const out = new Map()
  const clamp = (v) => Math.max(0, Math.min(n - 1, v))
  for (let i = 0; i < pts.length; i += STRIDE) {
    const k = clamp(Math.floor((pts[i] - ox) / cell)) + n * clamp(Math.floor((pts[i + 2] - oz) / cell))
    const key = `${k}|${of(i)}`
    let list = out.get(key)
    if (!list) { list = []; out.set(key, list) }
    list.push(i)
  }
  // hand the caller back [cellIndex, discriminator] pairs rather than a string it would have to parse
  return [...out].map(([key, list]) => [key.split("|").map(Number), list])
}

// ---- the painting: a tuft of tapered blades, with clover and daisies on kind 1 and a tall flowering meadow on 2 ---
// Blades are drawn as filled shapes that narrow to a point rather than as round-capped strokes: the tip of a real
// blade of grass is a needle, and a canvas full of blunt sausages is exactly what reads as a low-effort texture.
function paintTuft(kind) {
  const W = 192, H = 192
  const c = document.createElement("canvas"); c.width = W; c.height = H
  const ctx = c.getContext("2d")
  ctx.clearRect(0, 0, W, H)
  let s = 99 + kind * 17
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const pal = paletteOf(kind === 2 ? "reed" : "lime")
  const blade = (x0, lean, h, width, k) => {
    const tipX = x0 + lean, tipY = H - h
    const midX = x0 + lean * 0.28, midY = H - h * 0.62
    ctx.beginPath()
    ctx.moveTo(x0 - width, H)
    ctx.quadraticCurveTo(midX - width * 0.55, midY, tipX, tipY)
    ctx.quadraticCurveTo(midX + width * 0.55, midY, x0 + width, H)
    ctx.closePath()
    ctx.fillStyle = shade(pal, k)
    ctx.fill()
    ctx.strokeStyle = `rgba(255,255,240,${(0.05 + k * 0.10).toFixed(3)})`     // the light running down the fold
    ctx.lineWidth = 0.9
    ctx.beginPath(); ctx.moveTo(x0, H); ctx.quadraticCurveTo(midX, midY, tipX, tipY); ctx.stroke()
  }
  // a dark undergrowth pass first, so the tuft has a shaded interior instead of a flat sheet of one green
  for (let i = 0; i < 34; i++) {
    const x0 = W * (0.12 + rnd() * 0.76)
    blade(x0, (rnd() - 0.5) * W * 0.4, H * (0.22 + rnd() * 0.3), 1.6 + rnd() * 1.6, rnd() * 0.22)
  }
  const n = kind === 2 ? 46 : 58
  for (let i = 0; i < n; i++) {
    const x0 = W * (0.06 + rnd() * 0.88)
    const lean = (rnd() - 0.5) * W * 0.5
    const h = H * (kind === 2 ? 0.55 + rnd() * 0.42 : 0.32 + rnd() * 0.46)
    const lift = h / H                                                        // taller blades catch more light
    blade(x0, lean, h, 1.7 + rnd() * 2.2, Math.min(0.99, 0.22 + lift * 0.6 + rnd() * 0.25))
  }
  if (kind === 1) {
    for (let i = 0; i < 5; i++) {                                             // clover leaves low in the tuft
      const x = W * (0.15 + rnd() * 0.7), y = H * (0.68 + rnd() * 0.24), r = 3.5 + rnd() * 2
      for (let k = 0; k < 3; k++) {
        const a = k / 3 * Math.PI * 2 + rnd()
        blob(ctx, x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.85, shade(pal, 0.3 + rnd() * 0.3))
      }
    }
    for (let i = 0; i < 4; i++) {                                             // daisies
      const x = W * (0.2 + rnd() * 0.6), y = H * (0.4 + rnd() * 0.3)
      for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2; blob(ctx, x + Math.cos(a) * 4.6, y + Math.sin(a) * 4.6, 3.2, k % 2 ? "#f7f7ef" : "#e6e6dc") }
      blob(ctx, x, y, 2.8, "#f2c026")
    }
  }
  if (kind === 2) {
    for (let i = 0; i < 7; i++) {                                             // seed heads on their own stalks
      const x = W * (0.12 + rnd() * 0.76), y = H * (0.08 + rnd() * 0.3)
      ctx.strokeStyle = shade(pal, 0.4); ctx.lineWidth = 1.4
      ctx.beginPath(); ctx.moveTo(x + (rnd() - 0.5) * 14, H * 0.75); ctx.quadraticCurveTo(x, y + 16, x, y); ctx.stroke()
      for (let k = 0; k < 9; k++) blob(ctx, x + (rnd() - 0.5) * 5, y + k * 2.4, 1.9, shade(pal, 0.62 + rnd() * 0.3))
    }
    for (let i = 0; i < 4; i++) {                                             // poppies, a cornflower, a knapweed
      const x = W * (0.18 + rnd() * 0.64), y = H * (0.12 + rnd() * 0.34)
      const petal = i === 3 ? "#5468b4" : i === 2 ? "#8a4ea8" : "#cf2f26"
      ctx.strokeStyle = shade(pal, 0.32); ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(x + (rnd() - 0.5) * 10, H * 0.8); ctx.quadraticCurveTo(x, y + 22, x, y + 4); ctx.stroke()
      for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2 + 0.4; blob(ctx, x + Math.cos(a) * 3.6, y + Math.sin(a) * 3.6, 3.4, petal) }
      blob(ctx, x, y, 1.7, "#2a1a1a")
    }
  }
  bleedAlpha(c, 3)
  return c
}
