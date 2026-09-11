import * as THREE from "three"
import { off } from "game/Flags"

// Image → texture plumbing shared by the aerial photos and the photo materials. Images are fetched (so a load can be
// aborted when its tile is dropped) and decoded asynchronously through an <img> (img.decode(), which every browser
// supports — createImageBitmap's orientation options do not survive Safari). The texture keeps three's default flip,
// so the image's top row lands at v = 1 — north on a terrain tile.
let version = 0
export const textureStats = { ok: 0, failed: 0, last: "" }     // for the ?debug=1 overlay

// called once from game.js with /api/world's assets_version, the cache-buster for public/textures and public/models
export function configure({ version: v }) { version = v ?? 0 }
export const assetsVersion = () => version
export const versioned = (url) => `${url}${url.includes("?") ? "&" : "?"}v=${version}`

export async function loadBitmap(url, { signal } = {}) {
  try {
    const res = await fetch(url, { signal, mode: "cors", credentials: "omit" })
    if (!res.ok) throw new Error(`${url}: ${res.status}`)
    const blob = await res.blob()
    const img = new Image()
    img.src = URL.createObjectURL(blob)
    await img.decode()
    textureStats.ok++
    return img
  } catch (err) {
    if (err?.name !== "AbortError") { textureStats.failed++; textureStats.last = `${url.split("?")[0]}: ${err.message ?? err}` }
    throw err
  }
}

export function bitmapTexture(image, { srgb = true, repeat = null, anisotropy = 4 } = {}) {
  const tex = new THREE.Texture(image)
  tex.flipY = true
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat, repeat) }
  tex.anisotropy = anisotropy
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.needsUpdate = true
  return tex
}

// frees the GPU texture and the bitmap's memory
export function disposeTexture(tex) {
  if (!tex) return
  tex.dispose()
  const img = tex.image
  if (img?.src?.startsWith?.("blob:")) URL.revokeObjectURL(img.src)
  img?.close?.()
}

// Photo-scanned PBR material sets (ambientCG, CC0) under public/textures/<set>/{color,normal,rough}.jpg. The material
// is created synchronously with the flat colour the game used to paint, so geometry never waits; the maps are
// assigned when they arrive. UVs are in metres: `size` is how many metres one repeat of the photo covers. Shared —
// callers never dispose these. ?pbr=0 keeps the flat colours (and the Node harness, which has no createImageBitmap).
const PBR_ON = !off("pbr") && typeof Image !== "undefined" && typeof fetch !== "undefined"
const sets = new Map()

export function pbr(set, { color = 0xffffff, tint = 0xffffff, size = 2, roughness = 0.95, normalScale = 1, ...extra } = {}) {
  const key = `${set}:${color}:${tint}:${size}:${JSON.stringify(extra)}`
  if (sets.has(key)) return sets.get(key)
  const m = new THREE.MeshStandardMaterial({ color, roughness, ...extra })
  m.__shared = true
  m.userData.set = set
  sets.set(key, m)
  if (PBR_ON) {
    const rep = 1 / size
    Promise.all([
      loadBitmap(versioned(`/textures/${set}/color.jpg`)),
      loadBitmap(versioned(`/textures/${set}/normal.jpg`)),
      loadBitmap(versioned(`/textures/${set}/rough.jpg`)),
    ]).then(([c, n, r]) => {
      m.map = bitmapTexture(c, { srgb: true, repeat: rep })
      m.normalMap = bitmapTexture(n, { srgb: false, repeat: rep })
      m.normalScale.set(normalScale, normalScale)
      m.roughnessMap = bitmapTexture(r, { srgb: false, repeat: rep })
      m.roughness = 1
      m.color.set(tint)                     // the photo carries the colour now; tint only shifts it (red cycle asphalt)
      m.needsUpdate = true
    }).catch((err) => console.warn(`textures/${set}: ${err.message}`))
  }
  return m
}
export const pbrEnabled = () => PBR_ON

// a tiling 256 px value-noise texture (three octaves plus grain) shared by the ground detail and the weathering
let noiseTex = null
export function noiseTexture() {
  if (noiseTex) return noiseTex
  const n = 256, c = document.createElement("canvas"); c.width = c.height = n
  const ctx = c.getContext("2d"), img = ctx.createImageData(n, n), d = img.data
  let s = 12345
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  // value noise, three octaves, periodic so the tile wraps
  const grid = (m) => { const g = new Float32Array(m * m); for (let i = 0; i < m * m; i++) g[i] = rnd(); return g }
  const octaves = [[8, grid(8), 0.5], [32, grid(32), 0.3], [128, grid(128), 0.2]]
  const sample = (g, m, x, y) => {
    const fx = x * m, fy = y * m, x0 = Math.floor(fx) % m, y0 = Math.floor(fy) % m, x1 = (x0 + 1) % m, y1 = (y0 + 1) % m
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy), sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    const a = g[y0 * m + x0], b = g[y0 * m + x1], cc = g[y1 * m + x0], dd = g[y1 * m + x1]
    return (a + (b - a) * sx) * (1 - sy) + (cc + (dd - cc) * sx) * sy
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 0
    for (const [m, g, w] of octaves) v += w * sample(g, m, x / n, y / n)
    v = 0.5 + (v - 0.5) * 1.6 + (rnd() - 0.5) * 0.12                         // more contrast, a little grain
    const p = (y * n + x) * 4, b = Math.max(0, Math.min(255, Math.round(v * 255)))
    d[p] = d[p + 1] = d[p + 2] = b; d[p + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 4
  noiseTex = tex
  return tex
}


// Weathering for the photo materials: a low-frequency tint so no tile repeats (the macro variation trick), a
// roughness that varies with the noise so surfaces catch the sky unevenly (wet-look patches on asphalt), and for
// walls a grime band at the foot plus damp moss creeping up the shaded faces — the dirt that every real wall has.
export function weathered(m, { walls = false, wet = 0.35 } = {}) {
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader) => {
    prev?.(shader)
    shader.uniforms.uNoise = { value: noiseTexture() }
    shader.uniforms.uWet = { value: wet }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldP;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n\tvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;")
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", "uniform float opacity;\nuniform sampler2D uNoise;\nuniform float uWet;\nvarying vec3 vWorldP;\nfloat wxNoise;")
      .replace("#include <map_fragment>", `#include <map_fragment>
\twxNoise = texture2D(uNoise, vWorldP.xz * 0.011).r;
\tfloat macro = texture2D(uNoise, vWorldP.xz * 0.0023 + 0.3).r;
\tdiffuseColor.rgb *= 0.9 + 0.2 * macro;                                                 // no two spots the same tone
${walls ? `\t{
\t\tfloat n = texture2D(uNoise, vec2(vWorldP.x + vWorldP.z, vWorldP.y) * 0.35).r;
\t\tfloat foot = 1.0 - smoothstep(0.0, 1.4 + n * 1.2, vFace.y);                             // splash and grime at the foot
\t\tdiffuseColor.rgb *= 1.0 - 0.28 * foot;
\t\tvec3 nW = normalize(transpose(mat3(viewMatrix)) * normalize(vNormal));
\t\tfloat shade = clamp(-nW.z * 0.5 + 0.5, 0.0, 1.0);                                        // north faces stay damp
\t\tfloat moss = foot * shade * smoothstep(0.45, 0.75, n) * 0.7;
\t\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.38, 0.16), moss);
\t}` : ""}`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = clamp(roughnessFactor - uWet * smoothstep(0.55, 0.8, wxNoise), 0.05, 1.0);")
  }
  const key = m.customProgramCacheKey
  m.customProgramCacheKey = () => (key ? key() : "") + (walls ? "|weathered-wall" : "|weathered")
  return m
}
