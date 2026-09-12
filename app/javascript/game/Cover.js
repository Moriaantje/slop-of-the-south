import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// BGT land cover per tile, and the water that runs through it.
//
// Tile format: cover = [[code, outerRing, holeRing, ...], ...] with rings as flat decimetre offsets [dx, dz, ...]
// from the tile's north-west corner (0..5000). Codes match LandCover::CODES on the server. Water entries carry their
// surface level first: [30, level | null, outerRing, ...] — a level means a flat surface over a carved bed (lakes,
// the Maas, canals), null means a thin watercourse draped on the terrain.
//
// The polygons are rasterised twice into the same paths. Once into a colour canvas, which is what Grass.js reads back
// to decide where tufts may grow (green means grass) and which is never uploaded to the GPU. And once into the cover
// mask that TerrainTile's material blends its photo-scanned layers through: red how much bare soil, green how much
// gravel or pavement, blue how much forest floor, whatever is left over is grass, and alpha how dry the spot is.
// Dryness is the trick that gets six materials out of four texture sets — one scanned grass covers both a June
// meadow and a straw verge, one soil covers both wet plough and dune sand — and jittering it per polygon from the
// ring's own hash is what keeps neighbouring fields from looking stamped from the same die.
export const TEXTURE_SIZE = 512
export const MASK_SIZE = 512               // ≈ 1 m per texel over a 500 m tile
const TILE_DM = 5000                       // a tile is 500 m, and rings arrive in decimetres
const BASE = "#7fa15a"
const BASE_DRY = 0.35                      // the dryness of ground no polygon covers
const COLORS = {
  1: ["#78a049", "#6f9a44", "#7ea64d"],                              // grasland agrarisch (meadow)
  2: ["#86a44f", "#7fa04a"],                                         // grasland overig
  3: ["#6e9448", "#739a4b"],                                         // groenvoorziening (urban green)
  4: ["#b69b63", "#c9b077", "#a48a58", "#9ea653", "#bfa76a", "#8d9b4c", "#d1b97d"],  // bouwland: soil, stubble, crops
  5: ["#7aa04a", "#74994a"],                                         // fruitteelt (orchard grass)
  6: ["#7f9d4f"],                                                    // boomteelt
  7: ["#4f7a38", "#557f3c"],                                         // bos floor
  8: ["#8b7d5b"], 9: ["#6d8b45"], 10: ["#88915a"], 11: ["#d8c8a2"], 12: ["#9a9468"],
  20: ["#b3a795", "#ada08d", "#b8ad9b"],                             // erf (yards)
  21: ["#5b5b5e"], 22: ["#8d7d72"], 23: ["#a89c86"], 24: ["#9d8b6c"],  // pavement grades
  30: ["#25393c"]                                                    // water bed (seen through the surface)
}

// code → [soil, hard, wood, dryness, how far dryness jitters per polygon]. Grass is what the first three leave over,
// so a pure meadow is three zeroes. Sand is soil at full dryness and closed pavement is gravel at almost none:
// the dryness channel doubles as "how bleached is this", which is exactly the axis that separates them.
const COVER = {
  1:  [0, 0, 0, 0.24, 0.24],          // grasland agrarisch
  2:  [0, 0, 0, 0.38, 0.24],          // grasland overig: rougher, drier
  3:  [0, 0, 0, 0.20, 0.14],          // groenvoorziening: mown and watered
  4:  [1, 0, 0, 0.38, 0.42],          // bouwland: from wet plough to pale stubble, field by field
  5:  [0, 0, 0, 0.26, 0.18],          // fruitteelt: orchard grass
  6:  [0.30, 0, 0.15, 0.40, 0.22],    // boomteelt: nursery rows with bare soil between them
  7:  [0, 0, 1, 0.34, 0.20],          // bos: leaf litter
  8:  [0.28, 0, 0, 0.82, 0.16],       // heide
  9:  [0, 0, 0.45, 0.44, 0.20],       // struiken
  10: [0, 0, 0, 0.58, 0.18],          // moeras, rietland: coarse pale reed
  11: [1, 0, 0, 1.00, 0.08],          // duin, zand
  12: [0.62, 0, 0, 0.70, 0.26],       // transitie
  20: [0, 1, 0, 0.48, 0.22],          // erf
  21: [0, 1, 0, 0.10, 0.10],          // gesloten verharding
  22: [0, 1, 0, 0.36, 0.16],          // open verharding
  23: [0.25, 0.75, 0, 0.50, 0.18],    // half verhard
  24: [0.55, 0.45, 0, 0.52, 0.20],    // onverhard
  30: [0.30, 0.70, 0, 0.04, 0.06],    // water bed: wet gravel, seen through the surface
}
const WATER = 30

// The four mask bytes for one polygon of `code`, with the dryness jittered by the ring's own hash so the field next
// door is never the same shade. Pure, so the table can be tested without a canvas.
export function coverMaskBytes(code, seed = 0) {
  const c = COVER[code]
  if (!c) return null
  const jitter = ((seed % 1024) / 1023 - 0.5) * c[4]
  const dry = Math.max(0, Math.min(1, c[3] + jitter))
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), Math.round(dry * 255)]
}

// Returns the colour canvas texture (Grass.js reads its pixels; nothing ever uploads it) with the GPU cover mask
// hanging off userData.mask, which is what TerrainTile hands to its material.
export function paintCover(cover) {
  const colour = context(TEXTURE_SIZE)
  colour.fillStyle = BASE
  colour.fillRect(0, 0, TILE_DM, TILE_DM)
  const weight = context(MASK_SIZE)
  weight.fillStyle = "#000000"                 // no soil, no gravel, no forest floor: all grass
  weight.fillRect(0, 0, TILE_DM, TILE_DM)
  const dryness = context(MASK_SIZE)
  dryness.fillStyle = grey(BASE_DRY)
  dryness.fillRect(0, 0, TILE_DM, TILE_DM)

  for (const entry of cover) {
    const palette = COLORS[entry[0]]
    if (!palette) continue
    const start = waterLevel(entry) === undefined ? 1 : 2          // water: [code, level, rings…]
    const seed = hash(entry[start])
    const bytes = coverMaskBytes(entry[0], seed)
    const path = new Path2D()
    for (let r = start; r < entry.length; r++) {
      const ring = entry[r]
      path.moveTo(ring[0], ring[1])
      for (let i = 2; i < ring.length; i += 2) path.lineTo(ring[i], ring[i + 1])
      path.closePath()
    }
    colour.fillStyle = palette[seed % palette.length]              // stable per polygon: fields keep their colour
    colour.fill(path, "evenodd")
    if (!bytes) continue
    weight.fillStyle = `rgb(${bytes[0]}, ${bytes[1]}, ${bytes[2]})`
    weight.fill(path, "evenodd")
    dryness.fillStyle = grey(bytes[3] / 255)
    dryness.fill(path, "evenodd")
  }

  const tex = new THREE.CanvasTexture(colour.canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.userData.mask = maskTexture(weight, dryness)
  return tex
}

// One canvas, scaled so a ring's decimetre coordinates land straight on it, with the path scaling folded into the
// transform instead of multiplied into every vertex.
function context(size) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = size
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  ctx.setTransform(size / TILE_DM, 0, 0, size / TILE_DM, 0, 0)
  return ctx
}
const grey = (v) => { const b = Math.round(Math.max(0, Math.min(1, v)) * 255); return `rgb(${b}, ${b}, ${b})` }

// The two rasters merged into one RGBA data texture: weights in RGB, dryness in A. It cannot be one canvas because
// canvas alpha composites rather than stores, and it is a DataTexture rather than a CanvasTexture because the rows
// have to be flipped here — the terrain UV runs south to north while the canvas runs north to south, and
// UNPACK_FLIP_Y does not apply to typed array uploads.
function maskTexture(weight, dryness) {
  const n = MASK_SIZE
  const w = weight.getImageData(0, 0, n, n).data
  const d = dryness.getImageData(0, 0, n, n).data
  const out = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    let src = y * n * 4, dst = (n - 1 - y) * n * 4
    for (let x = 0; x < n; x++, src += 4, dst += 4) {
      out[dst] = w[src]; out[dst + 1] = w[src + 1]; out[dst + 2] = w[src + 2]; out[dst + 3] = d[src]
    }
  }
  const tex = new THREE.DataTexture(out, n, n, THREE.RGBAFormat)
  tex.colorSpace = THREE.NoColorSpace          // weights, not colour: no sRGB decode
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

const LIFT = 0.12, MAX_EDGE = 40
const FLAT_EDGE = 16, FLAT_DEPTH = 7         // flat water is subdivided this fine so the depth ramp at the shore is sharp
const DRAPED_DEPTH = 0.8                     // a ditch has no carved bed, so it gets a plausible constant depth

// ---- water ----------------------------------------------------------------------------------------------------
// A tiling wave normal map, made here rather than downloaded: ten sine trains at whole-number frequencies (so the
// texture wraps exactly) with an ocean-ish 1/k falloff, stored as a normal in RGB and its own height in A. Two
// scrolling taps of it are the whole ripple field, and the height channel that comes free with them drives the
// shoreline foam — so the water costs two texture reads per fragment, not four.
const RIPPLE_SIZE = 128
const WAVES = [[1, 2], [2, -1], [3, 3], [5, -2], [4, 6], [7, 5], [9, -7], [11, 8], [13, 3], [6, -11]]
const RIPPLE_SLOPE = 2.4                     // how much of the encoded slope range the steepest wave uses

export function rippleTexture(n = RIPPLE_SIZE) {
  const h = new Float32Array(n * n), gx = new Float32Array(n * n), gy = new Float32Array(n * n)
  let s = 987654321
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  let norm = 0
  for (const [fx, fy] of WAVES) {
    const a = 1 / Math.pow(Math.hypot(fx, fy), 1.6), phase = rnd() * Math.PI * 2
    norm += a * Math.hypot(fx, fy) * 2 * Math.PI
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const t = 2 * Math.PI * (fx * x / n + fy * y / n) + phase
      const i = y * n + x
      h[i] += a * Math.sin(t)
      gx[i] += a * 2 * Math.PI * fx * Math.cos(t)
      gy[i] += a * 2 * Math.PI * fy * Math.cos(t)
    }
  }
  let hi = 0
  for (let i = 0; i < h.length; i++) hi = Math.max(hi, Math.abs(h[i]))
  const k = RIPPLE_SLOPE / (norm || 1), data = new Uint8Array(n * n * 4)
  for (let i = 0; i < h.length; i++) {
    const nx = -gx[i] * k, ny = -gy[i] * k, len = Math.hypot(nx, ny, 1)
    data[i * 4] = Math.round((nx / len * 0.5 + 0.5) * 255)
    data[i * 4 + 1] = Math.round((ny / len * 0.5 + 0.5) * 255)
    data[i * 4 + 2] = Math.round((1 / len * 0.5 + 0.5) * 255)
    data[i * 4 + 3] = Math.round((h[i] / (hi || 1) * 0.5 + 0.5) * 255)
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

// Tunables for the water, in one object so they can be poked from the console. Sizes are metres per repeat.
export const WATER_LOOK = {
  coarse: 7.5, fine: 2.6,        // the two ripple scales
  coarseAmp: 0.42, fineAmp: 0.22,
  drift: 0.055,                  // m/s the coarse train slides; the fine one runs faster and across it
  swell: 0.05,                   // m of vertical bob on open water
  rippleNear: 25, rippleFar: 260,  // where the ripples start fading out, before they alias into bands
  deepAt: 3.2,                   // m at which the body colour has reached its deep end
  opaqueAt: 1.5,                 // m at which the surface has stopped showing its bed
  minAlpha: 0.22, maxAlpha: 0.93,
  foamDepth: 0.55,               // m of depth the foam line reaches out from the shore
  f0: 0.02,                      // water's reflectance head on
}

// The water surface: two scrolling taps of the procedural wave map for the ripples, a Fresnel reflection that gives
// climbing rays the sky (horizon ↔ zenith from DayNight, plus the sun's glitter) and glancing ones the dim far bank,
// a body colour and an opacity that both follow the depth baked into every vertex, so shallow edges go translucent
// over their bed, and a foam line along the shore where that depth runs out. Two texture reads a fragment all told,
// because the wave height that drives the body shading and the foam comes back in the alpha of the same two taps.
// One shared material; updateWater() feeds it the time and the sky every frame.
const waterMat = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    time: { value: 0 }, daylight: { value: 1 }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(0xfff2dc) },
    zenith: { value: new THREE.Color(0x4f8fd2) }, horizon: { value: new THREE.Color(0xbfd4e6) }, deep: { value: new THREE.Color(0x152b28) }, shallow: { value: new THREE.Color(0x4c7a6a) },
    foamColor: { value: new THREE.Color(0xe8f2f4) }, bank: { value: new THREE.Color(0x2f3a30) }, ripple: { value: null },
    scales: { value: new THREE.Vector4() },     // 1/coarse, 1/fine, coarseAmp, fineAmp
    shape: { value: new THREE.Vector4() },      // 1/deepAt, 1/opaqueAt, foamDepth, f0
    fade: { value: new THREE.Vector4() },       // rippleNear, 1/(rippleFar - rippleNear), swell, drift
    body: { value: new THREE.Vector2() },       // minAlpha, maxAlpha
  }]),
  vertexShader: /* glsl */`
    #include <fog_pars_vertex>
    attribute float aDepth;
    uniform float time;
    uniform vec4 fade;
    varying vec3 vWorld;
    varying float vDepth;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vDepth = aDepth;
      // open water breathes; the shore stays pinned to its bed so no gap opens along the bank
      float swell = fade.z * smoothstep(0.0, 2.0, aDepth);
      wp.y += (sin(dot(wp.xz, vec2(0.31, 0.17)) + time * 1.1) + 0.6 * sin(dot(wp.xz, vec2(-0.22, 0.41)) + time * 1.7)) * swell;
      vWorld = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <fog_pars_fragment>
    uniform float time, daylight;
    uniform vec3 sunDir, sunColor, zenith, horizon, deep, shallow, foamColor, bank;
    uniform sampler2D ripple;
    uniform vec4 scales, shape, fade;
    uniform vec2 body;
    varying vec3 vWorld;
    varying float vDepth;
    void main() {
      vec2 p = vWorld.xz;
      float dist = distance(cameraPosition, vWorld);
      float far = clamp((dist - fade.x) * fade.y, 0.0, 1.0);        // ripples fade out before they alias into bands
      float t = time * fade.w;
      vec4 a = texture2D(ripple, p * scales.x + vec2(1.0, 0.55) * t);
      vec4 b = texture2D(ripple, p * scales.y - vec2(0.42, 1.0) * t * 2.3);
      vec2 slope = ((a.xy - 0.5) * scales.z + (b.xy - 0.5) * scales.w) * 2.0 * (1.0 - 0.85 * far);
      vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
      vec3 V = normalize(cameraPosition - vWorld);
      if (dot(n, V) < 0.0) n = -n;                                  // seen from below
      vec3 R = reflect(-V, n);
      float fres = shape.w + (1.0 - shape.w) * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      // A canal is not a sheet of white. Most of what you see in it at a glancing angle is not sky at all but the
      // far bank and the trees on it, so rays that leave the surface near the horizontal reflect a dim bank colour
      // and only rays that climb reach the sky. That is what gives water its dark bands, and the ripples break the
      // two apart into the restless contrast that reads as water rather than as varnish.
      vec3 sky = mix(bank * (0.10 + 0.90 * daylight), mix(horizon, zenith, clamp(R.y * 1.5, 0.0, 1.0)), smoothstep(-0.02, 0.15, R.y));
      float sd = max(dot(R, normalize(sunDir)), 0.0);
      float spec = pow(sd, 300.0) * 1.5 + pow(sd, 22.0) * 0.09;     // a tight sun and the broad sheen around it
      float wave = (a.w - 0.5) + (b.w - 0.5) * 0.6;                 // the wave height that came free with the normals
      vec3 col = mix(shallow, deep, clamp(vDepth * shape.x, 0.0, 1.0));
      col *= (0.12 + 0.88 * daylight) * (0.94 + 0.16 * wave);
      col = mix(col, sky, fres) + sunColor * spec;
      float alpha = mix(body.x, body.y, clamp(vDepth * shape.y, 0.0, 1.0)) + fres * 0.3;
      // the shore line: foam where the water runs out, torn up by the same wave height so it is never a clean band
      float band = 1.0 - clamp(vDepth / shape.z, 0.0, 1.0);
      float foam = smoothstep(0.42, 0.86, band * (0.62 + 0.9 * (wave + 0.5))) * (1.0 - 0.65 * far);
      col = mix(col, foamColor * (0.30 + 0.70 * daylight), foam);
      gl_FragColor = vec4(col, clamp(max(alpha, foam * 0.95), 0.0, 1.0));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
  transparent: true, fog: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2
})
waterMat.__shared = true
refreshWater()

// pushes WATER_LOOK into the packed uniform vectors; cheap enough to call by hand after poking a knob
export function refreshWater() {
  const W = WATER_LOOK, u = waterMat.uniforms
  u.scales.value.set(1 / W.coarse, 1 / W.fine, W.coarseAmp, W.fineAmp)
  u.shape.value.set(1 / W.deepAt, 1 / W.opaqueAt, W.foamDepth, W.f0)
  u.fade.value.set(W.rippleNear, 1 / Math.max(1e-3, W.rippleFar - W.rippleNear), W.swell, W.drift)
  u.body.value.set(W.minAlpha, W.maxAlpha)
}

// darkness / sky / sun from DayNight.env, once per frame
export function updateWater(env, t) {
  const u = waterMat.uniforms
  u.time.value = t
  u.ripple.value ??= rippleTexture()
  u.daylight.value = 1 - env.darkness
  u.sunDir.value.copy(env.sunDir); u.sunColor.value.copy(env.sunColor)
  u.zenith.value.copy(env.zenith); u.horizon.value.copy(env.horizon)
}

// Water polygons → surfaces: flat at their level over the carved bed, or draped just above the terrain for thin
// watercourses (level null). Every vertex carries how deep the water is under it — the bed is carved on the server
// and heightAt reads it back, so the depth is exact and costs the shader nothing. That one attribute is what makes
// the shallows translucent over their gravel, the middle of the Maas opaque, and the foam follow the bank.
export function buildWater(cover, heightAt, origin) {
  const [ox, oz] = origin
  const geos = []
  for (const entry of cover) {
    if (entry[0] !== WATER) continue
    const level = waterLevel(entry)
    const rings = []
    for (let r = level === undefined ? 1 : 2; r < entry.length; r++) {
      const flat = entry[r], ring = []
      for (let i = 0; i + 1 < flat.length; i += 2) ring.push(new THREE.Vector2(ox + flat[i] / 10, oz + flat[i + 1] / 10))
      if (ring.length >= 3) rings.push(ring)
    }
    if (!rings.length) continue
    let tris
    try { tris = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1)) } catch { continue }
    const pts = rings.flat()
    const verts = [], depths = []
    if (level === null || level === undefined) {
      const push = (p) => { verts.push(p.x, heightAt(p.x, p.y) + LIFT, p.y); depths.push(DRAPED_DEPTH) }
      for (const [a, b, c] of tris) subdivide(pts[a], pts[b], pts[c], push, 0, MAX_EDGE, 6)
    } else {
      const push = (p) => { verts.push(p.x, level + 0.02, p.y); depths.push(Math.max(0, level - heightAt(p.x, p.y))) }
      for (const [a, b, c] of tris) subdivide(pts[a], pts[b], pts[c], push, 0, FLAT_EDGE, FLAT_DEPTH)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
    g.setAttribute("aDepth", new THREE.Float32BufferAttribute(depths, 1))
    geos.push(g)
  }
  if (!geos.length) return null
  waterMat.uniforms.ripple.value ??= rippleTexture()      // in case a tile is built before the first updateWater
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  const mesh = new THREE.Mesh(merged, waterMat)
  mesh.renderOrder = 5
  return mesh
}

// the level slot of a water entry: a number (flat surface), null (draped), or undefined for tiles built before levels existed
// the water polygons of a tile with a known surface level, as flat [x, z, ...] outer rings in game units, for
// ChunkManager.waterLevelAt (what the mech wades or drowns in)
export function waterPolys(cover, origin) {
  const [ox, oz] = origin, out = []
  for (const entry of cover) {
    const level = waterLevel(entry)
    if (typeof level !== "number") continue
    const flat = entry[2]
    if (!flat || flat.length < 6) continue
    const ring = new Array(flat.length)
    for (let i = 0; i + 1 < flat.length; i += 2) { ring[i] = ox + flat[i] / 10; ring[i + 1] = oz + flat[i + 1] / 10 }
    out.push({ level, ring })
  }
  return out
}

function waterLevel(entry) {
  if (entry[0] !== WATER) return undefined
  return Array.isArray(entry[1]) ? undefined : entry[1]
}

// split long triangles so wide water follows the terrain instead of cutting through it, and so the depth every
// vertex carries ramps finely enough at the bank for the foam line to sit where the shore actually is
function subdivide(a, b, c, push, depth, maxEdge, maxDepth) {
  const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a)
  const longest = Math.max(ab, bc, ca)
  if (longest < maxEdge || depth > maxDepth) { push(a); push(b); push(c); return }
  const next = depth + 1
  if (longest === ab) { const m = a.clone().lerp(b, 0.5); subdivide(a, m, c, push, next, maxEdge, maxDepth); subdivide(m, b, c, push, next, maxEdge, maxDepth) }
  else if (longest === bc) { const m = b.clone().lerp(c, 0.5); subdivide(a, b, m, push, next, maxEdge, maxDepth); subdivide(a, m, c, push, next, maxEdge, maxDepth) }
  else { const m = c.clone().lerp(a, 0.5); subdivide(a, b, m, push, next, maxEdge, maxDepth); subdivide(m, b, c, push, next, maxEdge, maxDepth) }
}

function hash(ring) {
  let h = 2166136261
  for (let i = 0; i < Math.min(ring.length, 12); i++) h = Math.imul(h ^ ring[i], 16777619)
  return h >>> 0
}
