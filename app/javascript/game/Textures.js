import * as THREE from "three"

// Image → texture plumbing shared by the aerial photos and the photo materials. Images are fetched (so a load can be
// aborted when its tile is dropped) and decoded off the main thread with createImageBitmap; the bitmap is flipped on
// decode and the texture told not to flip, so the image's top row lands at v = 1 — north on a terrain tile.
let version = 0

// called once from game.js with /api/world's assets_version, the cache-buster for public/textures and public/models
export function configure({ version: v }) { version = v ?? 0 }
export const assetsVersion = () => version
export const versioned = (url) => `${url}${url.includes("?") ? "&" : "?"}v=${version}`

export async function loadBitmap(url, { signal } = {}) {
  const res = await fetch(url, { signal, mode: "cors", credentials: "omit" })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const blob = await res.blob()
  return createImageBitmap(blob, { imageOrientation: "flipY", colorSpaceConversion: "none", premultiplyAlpha: "none" })
}

export function bitmapTexture(bitmap, { srgb = true, repeat = null, anisotropy = 8 } = {}) {
  const tex = new THREE.Texture(bitmap)
  tex.flipY = false
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
  tex.image?.close?.()
}
