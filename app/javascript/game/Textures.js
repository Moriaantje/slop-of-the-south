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
