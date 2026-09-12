import * as THREE from "three"
import { mulberry32 } from "game/Tuning"

// Everything vegetation is painted from. The game ships no foliage photographs, so every leaf, needle, blossom and
// strip of bark here is drawn with 2D canvas calls at load and uploaded once; that keeps the download at zero and,
// more importantly, lets the same brush paint a matching height field alongside the colour, which is then turned
// into a normal map by a Sobel pass. That second map is what stops a leaf card from reading as a flat sticker: the
// light catches each individual leaf and each bark furrow instead of the quad they live on, which is most of the
// difference between "a texture" and "a surface".
//
// A cluster is painted four times over into a 2x2 atlas, so one texture carries four different sprays of leaves and
// a card can pick a cell at random. A crown built from a single repeated sprite is the tell-tale of cheap foliage;
// four cells with random flips give sixteen apparent variations for the cost of one bind. Leaves are laid along
// twigs rather than scattered over the square, which leaves real gaps between the strands — the silhouette has to
// break up or a tree turns into a green blob at fifty metres. Each leaf drops a soft dark halo before its own fill,
// so overlapping leaves darken one another and the cluster gains the depth that flat blobs never have.
//
// One last detail that matters more than it sounds: after painting, the colour of the opaque pixels is bled outward
// into the transparent ones. Mipmapping averages RGB and alpha independently, so without that bleed every alpha-
// tested leaf gets a dark fringe as it shrinks into the distance, and a wood full of dark fringes reads as grime.

const ATLAS = 512                 // px, the leaf colour atlas (2x2 cells of 256)
const NORMAL_ATLAS = 256          // px, the matching normal map; half the colour resolution is plenty for leaves
const BARK = 512                  // px, one seamless tile of bark, about 0.45 m across
const BARK_NORMAL = 256           // px
const BLEED_PASSES = 3            // how far the opaque colour is dilated into the transparent pixels
const HEIGHT_TO_NORMAL = 2.6      // Sobel gain: how steep the painted height field is taken to be

// Leaf greens, dark to light. Each is a real species' range: beech turns almost blue-green in shade, willow is grey,
// poplar is bright and slightly yellow, conifer nearly black at the base of the spray.
const PALETTES = {
  beech:   ["#172c14", "#26491d", "#3c6b2a", "#548a3b", "#79a955", "#9dc274"],
  oak:     ["#182b13", "#28481b", "#3c6727", "#537f35", "#709c4a", "#90b566"],
  lime:    ["#1c3417", "#2f5623", "#487a31", "#639644", "#85b062", "#a6c685"],
  willow:  ["#23331d", "#375228", "#4f7137", "#6a8c4c", "#8aa46a", "#a8bb8c"],
  poplar:  ["#1d3517", "#305823", "#4a7a31", "#679a45", "#89b763", "#a9cb84"],
  birch:   ["#22391a", "#385f25", "#527e36", "#6f9c4c", "#91b76c", "#b3cf92"],
  conifer: ["#0f2216", "#18331f", "#224628", "#2e5832", "#3d6b40", "#527f53"],
  fruit:   ["#1f3a19", "#335c26", "#4c7a34", "#689646", "#88b164", "#a8c789"],
  bramble: ["#1a2e18", "#2a4a22", "#3e662f", "#547f3f", "#6f9757", "#8cae77"],
  reed:    ["#3c4a26", "#586330", "#77803f", "#9a9c55", "#b8b477", "#cfc99b"],
}

// How a leaf is shaped, as a half-width profile along the midrib: t runs 0 at the stalk to 1 at the tip and the
// function returns the fraction of the leaf's half-width there. A profile is far easier to reason about than a pile
// of bezier control points, and it is what makes an oak an oak: the cosine ripple is its lobes.
const PROFILE = {
  ovate:  (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.74)), 0.82),
  lobed:  (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.7) * (0.70 + 0.32 * Math.cos(t * 9.4 - 0.7)),
  lance:  (t) => Math.pow(Math.sin(Math.PI * t), 0.55) * 0.44,
  delta:  (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.34)), 0.9),
  round:  (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 1.05),
  serrate:(t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.78)), 0.8) * (0.88 + 0.14 * Math.cos(t * 21.0)),
}
export const LEAF_SHAPES = Object.keys(PROFILE)

// One entry per look a plant can wear: which profile, which greens, how long and wide a leaf is as a fraction of the
// atlas cell, how many leaves ride a twig and how tightly they sit.
export const FOLIAGE = {
  beech:   { shape: "ovate",   pal: "beech",   len: 0.25, wide: 0.44, per: 11, strands: 4, twig: "#5c4a33" },
  oak:     { shape: "lobed",   pal: "oak",     len: 0.27, wide: 0.50, per: 9,  strands: 4, twig: "#4e3f2c" },
  lime:    { shape: "round",   pal: "lime",    len: 0.25, wide: 0.62, per: 10, strands: 4, twig: "#5a4a35" },
  willow:  { shape: "lance",   pal: "willow",  len: 0.44, wide: 0.30, per: 12, strands: 3, twig: "#6b5a3c" },
  poplar:  { shape: "delta",   pal: "poplar",  len: 0.24, wide: 0.60, per: 10, strands: 4, twig: "#57492f" },
  birch:   { shape: "serrate", pal: "birch",   len: 0.20, wide: 0.48, per: 13, strands: 4, twig: "#6a5a44" },
  fruit:   { shape: "ovate",   pal: "fruit",   len: 0.24, wide: 0.46, per: 10, strands: 4, twig: "#5b4630", fruit: ["#c23a26", "#d8a52a"] },
  bramble: { shape: "serrate", pal: "bramble", len: 0.30, wide: 0.56, per: 7,  strands: 3, twig: "#4a3a2a", berry: ["#2b1930", "#6d2340"] },
  conifer: { shape: "needle",  pal: "conifer", len: 0.34, wide: 0.10, per: 26, strands: 5, twig: "#3f3527" },
  reed:    { shape: "lance",   pal: "reed",    len: 0.52, wide: 0.10, per: 14, strands: 4, twig: "#7a7345" },
}

// ---- the public textures -------------------------------------------------------------------------------------
const atlases = new Map()

// The leaf card texture for a look: { canvas, map, normalMap }. `canvas` is handed back raw because the tree
// impostors paint themselves by stamping these clusters onto a second canvas.
export function leafAtlas(name) {
  if (atlases.has(name)) return atlases.get(name)
  const spec = FOLIAGE[name] ?? FOLIAGE.beech
  const colour = surface(ATLAS)
  const height = surface(NORMAL_ATLAS)
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * 0.5, oy = Math.floor(cell / 2) * 0.5
    paintCluster(colour.ctx, "c", spec, mulberry32(hashName(name) + cell * 7919), ATLAS * 0.5, ox * ATLAS, oy * ATLAS)
    paintCluster(height.ctx, "h", spec, mulberry32(hashName(name) + cell * 7919), NORMAL_ATLAS * 0.5, ox * NORMAL_ATLAS, oy * NORMAL_ATLAS)
  }
  bleedAlpha(colour.canvas, BLEED_PASSES)
  const map = canvasTexture(colour.canvas, true)
  const normalMap = normalFromHeight(height.canvas, HEIGHT_TO_NORMAL)
  const out = { canvas: colour.canvas, map, normalMap: normalMap ? canvasTexture(normalMap, false) : null }
  atlases.set(name, out)
  return out
}

let barkCache = null
// One seamless bark tile shared by every trunk and branch in the world, tinted per species by the vertex colour.
// Bark is the same material everywhere at the scale a player sees it; what differs is hue, and hue is free.
export function barkTexture() {
  if (barkCache) return barkCache
  const colour = surface(BARK), height = surface(BARK_NORMAL)
  paintBark(colour.ctx, "c", BARK)
  paintBark(height.ctx, "h", BARK_NORMAL)
  const normal = normalFromHeight(height.canvas, 3.4)
  barkCache = { map: tiling(canvasTexture(colour.canvas, true)), normalMap: normal ? tiling(canvasTexture(normal, false)) : null }
  return barkCache
}

// ---- painting ------------------------------------------------------------------------------------------------

// A twig with leaves set alternately down it, drawn four times to fill one atlas cell. The leaves are placed along
// the curve rather than over the square so the gaps between strands stay transparent and the silhouette breaks up.
function paintCluster(ctx, mode, spec, rnd, s, ox, oy) {
  const cx = ox + s * 0.5, cy = oy + s * 0.5
  const strands = spec.strands
  for (let k = 0; k < strands; k++) {
    const a0 = (k / strands + rnd() * 0.35) * Math.PI * 2
    const x0 = cx + Math.cos(a0) * s * 0.52, y0 = cy + Math.sin(a0) * s * 0.52
    const a1 = a0 + Math.PI + (rnd() - 0.5) * 1.0
    const reach = s * (0.46 + rnd() * 0.36)
    const x1 = x0 + Math.cos(a1) * reach, y1 = y0 + Math.sin(a1) * reach
    const bow = (rnd() - 0.5) * s * 0.34
    const mx = (x0 + x1) * 0.5 - Math.sin(a1) * bow, my = (y0 + y1) * 0.5 + Math.cos(a1) * bow
    if (mode === "c") {
      ctx.strokeStyle = spec.twig
      ctx.lineWidth = s * 0.016
      ctx.lineCap = "round"
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, my, x1, y1); ctx.stroke()
    }
    const n = spec.per
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.1) continue                                            // a gap where a leaf was eaten or never grew
      const t = 0.1 + 0.9 * (i + rnd() * 0.6) / n
      const px = bez(x0, mx, x1, t), py = bez(y0, my, y1, t)
      const tx = bezD(x0, mx, x1, t), ty = bezD(y0, my, y1, t)
      const along = Math.atan2(ty, tx)
      const side = i % 2 === 0 ? 1 : -1
      const ang = along + side * (0.7 + rnd() * 0.55)
      const len = s * spec.len * (0.72 + rnd() * 0.5) * (1 - 0.3 * t)
      // light falls from the top left of the card, and leaves nearer the outside of the spray catch more of it
      const lit = clamp01(0.30 + 0.55 * ((cx - px) / s + (cy - py) / s) + 0.34 * t + (rnd() - 0.5) * 0.28)
      if (spec.shape === "needle") needleSpray(ctx, mode, spec, px, py, ang, len, lit, rnd)
      else drawLeaf(ctx, mode, spec, px, py, ang, len, lit, rnd)
    }
    if (mode === "c" && spec.fruit && k < 2 && rnd() < 0.75) {
      const t = 0.4 + rnd() * 0.5
      blob(ctx, bez(x0, mx, x1, t), bez(y0, my, y1, t), s * 0.048, spec.fruit[Math.floor(rnd() * spec.fruit.length)])
    }
    if (mode === "c" && spec.berry && rnd() < 0.7) {
      const t = 0.5 + rnd() * 0.4
      const bx = bez(x0, mx, x1, t), by = bez(y0, my, y1, t)
      for (let b = 0; b < 5; b++) blob(ctx, bx + (rnd() - 0.5) * s * 0.04, by + (rnd() - 0.5) * s * 0.04, s * 0.016, spec.berry[b % spec.berry.length])
    }
  }
}

// One leaf: a halo that darkens whatever lies beneath it, the blade itself under a gradient from stalk to tip, a
// midrib and laterals, and a sheen on the side the light comes from.
function drawLeaf(ctx, mode, spec, x, y, ang, len, lit, rnd) {
  const pal = PALETTES[spec.pal]
  const w = len * spec.wide * 0.5
  const bend = (rnd() - 0.5) * 0.55
  const curl = 0.75 + rnd() * 0.5                                          // some leaves are seen edge-on
  ctx.save()
  ctx.translate(x, y); ctx.rotate(ang + Math.PI * 0.5); ctx.scale(curl, 1)
  if (mode === "c") {
    leafPath(ctx, spec.shape, len * 1.14, w * 1.28, bend)
    ctx.fillStyle = "rgba(5,14,6,0.40)"; ctx.fill()
  } else {
    leafPath(ctx, spec.shape, len * 1.1, w * 1.2, bend)
    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fill()
  }
  leafPath(ctx, spec.shape, len, w, bend)
  if (mode === "c") {
    const g = ctx.createLinearGradient(-w, 0, w * 0.8, -len)
    g.addColorStop(0, shade(pal, lit * 0.5))
    g.addColorStop(0.5, shade(pal, lit))
    g.addColorStop(1, shade(pal, Math.min(1, lit * 1.22 + 0.08)))
    ctx.fillStyle = g
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, -len)
    g.addColorStop(0, "#4a4a4a"); g.addColorStop(0.45, "#d2d2d2"); g.addColorStop(1, "#7a7a7a")
    ctx.fillStyle = g
  }
  ctx.fill()
  // veins: the midrib stands proud, the laterals are a shade darker in colour and a shade higher in the height field
  ctx.lineCap = "round"
  ctx.strokeStyle = mode === "c" ? "rgba(238,246,214,0.22)" : "rgba(255,255,255,0.85)"
  ctx.lineWidth = Math.max(0.7, len * 0.035)
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(bend * w * 0.6, -len * 0.5, bend * w, -len); ctx.stroke()
  ctx.strokeStyle = mode === "c" ? "rgba(12,30,10,0.24)" : "rgba(255,255,255,0.4)"
  ctx.lineWidth = Math.max(0.5, len * 0.02)
  const prof = PROFILE[spec.shape] ?? PROFILE.ovate
  for (let i = 1; i <= 5; i++) {
    const t = i / 6, hw = prof(t) * w
    const bx = bend * w * t, by = -len * t
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + hw * 0.85, by - len * 0.14); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - hw * 0.85, by - len * 0.14); ctx.stroke()
  }
  if (mode === "c") {                                                      // a waxy highlight where the light hits
    const g = ctx.createLinearGradient(-w, -len * 0.2, w, -len * 0.8)
    g.addColorStop(0, "rgba(255,255,255,0)")
    g.addColorStop(0.55, `rgba(255,255,246,${(0.06 + lit * 0.13).toFixed(3)})`)
    g.addColorStop(1, "rgba(255,255,255,0)")
    leafPath(ctx, spec.shape, len * 0.96, w * 0.94, bend)
    ctx.fillStyle = g; ctx.fill()
  }
  ctx.restore()
}

// A conifer sprig: a twig with needles combed out along both sides. Painting needles as strokes rather than as
// shapes keeps the alpha thin and wiry, which is what a spruce silhouette actually looks like against the sky.
function needleSpray(ctx, mode, spec, x, y, ang, len, lit, rnd) {
  const pal = PALETTES[spec.pal]
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang + Math.PI * 0.5)
  ctx.lineCap = "round"
  const n = 9 + Math.floor(rnd() * 5)
  for (let i = 0; i < n; i++) {
    const t = i / n
    const nl = len * (0.30 + 0.16 * Math.sin(Math.PI * t)) * (0.7 + rnd() * 0.6)
    for (const side of [-1, 1]) {
      const k = clamp01(lit + (rnd() - 0.5) * 0.3 - t * 0.15)
      ctx.strokeStyle = mode === "c" ? shade(pal, k) : `rgba(255,255,255,${(0.45 + k * 0.5).toFixed(3)})`
      ctx.lineWidth = Math.max(0.8, len * 0.045)
      ctx.beginPath(); ctx.moveTo(0, -t * len)
      ctx.lineTo(side * nl * 0.85, -t * len - nl * (0.42 + rnd() * 0.3))
      ctx.stroke()
    }
  }
  ctx.strokeStyle = mode === "c" ? spec.twig : "rgba(255,255,255,0.75)"
  ctx.lineWidth = Math.max(0.8, len * 0.05)
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke()
  ctx.restore()
}

// The blade outline, walked as a polyline up one side and back down the other. Forty steps is smooth at the size a
// leaf is drawn and lets the profile do whatever it likes, lobes included.
export function leafPath(ctx, shape, len, halfWidth, bend = 0) {
  const prof = PROFILE[shape] ?? PROFILE.ovate
  const N = 40
  ctx.beginPath()
  for (let i = 0; i <= N; i++) { const t = i / N; ctx.lineTo(bend * halfWidth * t * t + prof(t) * halfWidth, -t * len) }
  for (let i = N; i >= 0; i--) { const t = i / N; ctx.lineTo(bend * halfWidth * t * t - prof(t) * halfWidth, -t * len) }
  ctx.closePath()
}

// Bark: vertical furrows that run the full height of the tile so it repeats without a seam, each stroke also drawn a
// tile to the left and right so it wraps horizontally too. A sine displacement with a whole number of periods keeps
// the top and bottom edges identical, which is the only trick needed to make a hand-painted tile tile.
function paintBark(ctx, mode, n) {
  const rnd = mulberry32(20260911)
  ctx.fillStyle = mode === "c" ? "#b0a08a" : "#808080"
  ctx.fillRect(0, 0, n, n)
  ctx.lineCap = "round"
  const stroke = (x0, amp, periods, phase, width, style) => {
    ctx.strokeStyle = style; ctx.lineWidth = width
    for (const dx of [-n, 0, n]) {
      ctx.beginPath()
      for (let y = 0; y <= n; y += n / 32) {
        const x = x0 + dx + Math.sin(y / n * Math.PI * 2 * periods + phase) * amp
        if (y === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }
  for (let i = 0; i < 70; i++) {                                           // deep furrows
    const x0 = rnd() * n, amp = n * (0.005 + rnd() * 0.035), per = 1 + Math.floor(rnd() * 3)
    const dark = 0.18 + rnd() * 0.3
    stroke(x0, amp, per, rnd() * 6.28, n * (0.004 + rnd() * 0.02), mode === "c" ? `rgba(32,24,16,${dark.toFixed(3)})` : `rgba(0,0,0,${dark.toFixed(3)})`)
  }
  for (let i = 0; i < 55; i++) {                                           // the ridges between them, catching light
    const x0 = rnd() * n, amp = n * (0.004 + rnd() * 0.03), per = 1 + Math.floor(rnd() * 3)
    const lightAmt = 0.10 + rnd() * 0.2
    stroke(x0, amp, per, rnd() * 6.28, n * (0.003 + rnd() * 0.012), mode === "c" ? `rgba(196,178,150,${lightAmt.toFixed(3)})` : `rgba(255,255,255,${lightAmt.toFixed(3)})`)
  }
  for (let i = 0; i < 260; i++) {                                          // lenticels and grain speckle
    const x = rnd() * n, y = rnd() * n, r = n * (0.002 + rnd() * 0.006)
    const g = rnd() < 0.5
    blob(ctx, x, y, r, mode === "c" ? (g ? "rgba(40,31,22,0.5)" : "rgba(170,156,132,0.35)") : (g ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.3)"))
  }
  for (let i = 0; i < 22; i++) {                                           // moss and lichen, only in the colour pass
    if (mode !== "c") continue
    const x = rnd() * n, y = rnd() * n, r = n * (0.02 + rnd() * 0.05)
    blob(ctx, x, y, r, rnd() < 0.6 ? "rgba(74,92,44,0.22)" : "rgba(146,150,124,0.18)")
  }
}

// ---- canvas and texture plumbing -----------------------------------------------------------------------------

function surface(n) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = n
  return { canvas, ctx: canvas.getContext("2d") }
}

function canvasTexture(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = 8
  return t
}

function tiling(t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; return t }

// Sobel over the painted height field. Returns a canvas, or null where there is no real 2D context (the Node test
// harness), in which case the caller simply goes without a normal map.
export function normalFromHeight(canvas, gain) {
  const n = canvas.width
  const src = canvas.getContext("2d")?.getImageData?.(0, 0, n, n)
  if (!src?.data) return null
  const d = src.data
  const h = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) h[i] = (d[i * 4] / 255) * (d[i * 4 + 3] / 255)
  const out = surface(n)
  const img = out.ctx.createImageData(n, n)
  if (!img?.data) return null
  const o = img.data
  const at = (x, y) => h[((y + n) % n) * n + ((x + n) % n)]
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
    const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
    let nx = -dx * gain, ny = dy * gain, nz = 1
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz)
    nx *= inv; ny *= inv; nz *= inv
    const p = (y * n + x) * 4
    o[p] = Math.round((nx * 0.5 + 0.5) * 255)
    o[p + 1] = Math.round((ny * 0.5 + 0.5) * 255)
    o[p + 2] = Math.round((nz * 0.5 + 0.5) * 255)
    o[p + 3] = 255
  }
  out.ctx.putImageData(img, 0, 0)
  return out.canvas
}

// Dilate the opaque colour into the transparent pixels so mipmaps never average a leaf towards black. Alpha is left
// exactly as painted; only RGB travels.
export function bleedAlpha(canvas, passes) {
  const n = canvas.width
  const ctx = canvas.getContext("2d")
  const img = ctx.getImageData?.(0, 0, n, n)
  if (!img?.data) return false
  const d = img.data
  const solid = new Uint8Array(n * n)
  for (let i = 0; i < n * n; i++) solid[i] = d[i * 4 + 3] > 8 ? 1 : 0
  for (let pass = 0; pass < passes; pass++) {
    const grown = solid.slice()
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x
      if (solid[i]) continue
      let r = 0, g = 0, b = 0, c = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = ((y + dy + n) % n) * n + ((x + dx + n) % n)
        if (!solid[j]) continue
        r += d[j * 4]; g += d[j * 4 + 1]; b += d[j * 4 + 2]; c++
      }
      if (!c) continue
      d[i * 4] = r / c; d[i * 4 + 1] = g / c; d[i * 4 + 2] = b / c
      grown[i] = 1
    }
    solid.set(grown)
  }
  ctx.putImageData(img, 0, 0)
  return true
}

// ---- little helpers ------------------------------------------------------------------------------------------

export function blob(ctx, x, y, r, style) { ctx.fillStyle = style; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill() }
const bez = (a, b, c, t) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c
const bezD = (a, b, c, t) => 2 * (1 - t) * (b - a) + 2 * t * (c - b)
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// a colour from a dark-to-light palette at k in [0, 1], interpolated so the ramp is smooth rather than banded
export function shade(pal, k) {
  const t = clamp01(k) * (pal.length - 1)
  const i = Math.min(pal.length - 2, Math.floor(t)), f = t - i
  const a = hex(pal[i]), b = hex(pal[i + 1])
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`
}
export function paletteOf(name) { return PALETTES[name] ?? PALETTES.beech }
function hex(s) { const v = parseInt(s.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255] }
function hashName(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) } return h >>> 0 }
