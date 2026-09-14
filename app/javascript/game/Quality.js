import * as THREE from "three"
import { flag } from "game/Flags"

// What the frame is allowed to cost. Everything expensive here is fill rate — the post chain and the shadow map are
// paid per pixel — so the levers are, in order of how much they buy: the resolution the world is rendered at
// (upscaled to the canvas at the end, the dynamic-resolution trick every console game uses), how much of the post
// chain runs at all, how large the shadow map is and how often it is redrawn. The level moves itself: the median of
// the last thirty frames decides, with a wide dead band and a slow climb so it settles instead of oscillating.
// ?q=0..4 pins it, ?q=auto is the default.
//
// The ladder now has a floor below what it used to have. Level 0 renders the world and puts it on the screen, full
// stop: no occlusion, no bloom, no grade, no antialiasing, no second buffer to read and write. It is a different
// picture — flatter, harder-edged, no vignette, no contact darkening — and it is the one to pick when frames matter
// more than anything else, which is what was asked for. Level 1 buys the grade back for one full-screen pass, which
// is most of the look for a small fraction of the old cost. From level 2 the occlusion joins in, at a quarter of
// the buffer's width; from 3 the SMAA edge pass; 4 is everything, at full resolution.
const LEVELS = [
  // scale: fraction of the device pixels. post: whether the chain runs at all. ao/bloom: 0 = off, else the fraction
  // of the buffer that pass runs at. sharpen: multiplies the grade's sharpening. shadow: shadow map texels.
  { name: "bare",  scale: 0.55, post: false, ao: 0,    bloom: 0,    smaa: false, sharpen: 0, shadow: 1024, soft: false, shadowEvery: 4 },
  { name: "fast",  scale: 0.65, post: true,  ao: 0,    bloom: 0,    smaa: false, sharpen: 0, shadow: 1024, soft: false, shadowEvery: 3 },
  { name: "mid",   scale: 0.75, post: true,  ao: 0.25, bloom: 0.25, smaa: false, sharpen: 1, shadow: 1536, soft: false, shadowEvery: 2 },
  { name: "high",  scale: 0.85, post: true,  ao: 0.25, bloom: 0.5,  smaa: true,  sharpen: 1, shadow: 2048, soft: false, shadowEvery: 2 },
  { name: "ultra", scale: 1.00, post: true,  ao: 0.5,  bloom: 0.5,  smaa: true,  sharpen: 1, shadow: 2048, soft: true,  shadowEvery: 1 },
]
const START = 3                // the level a session opens at, before the frame time has had its say
const WINDOW = 30              // frames per measurement
const SLOW_MS = 20, FAST_MS = 11
const MAX_SCALE = Math.min(devicePixelRatio || 1, 1.5)

export { LEVELS }

export class Quality {
  constructor(world, post) {
    this.world = world
    this.post = post
    const pin = flag("q")
    this.pinned = pin !== null && pin !== "auto" ? THREE.MathUtils.clamp(Number(pin) | 0, 0, LEVELS.length - 1) : null
    this.level = this.pinned ?? START
    this.times = []
    this.slow = 0; this.fast = 0
    this.frame = 0
    world.renderer.shadowMap.autoUpdate = false
    this.apply()
  }

  get name() { return LEVELS[this.level].name }

  apply() {
    const L = LEVELS[this.level], r = this.world.renderer
    r.setPixelRatio(MAX_SCALE * L.scale)
    this.post?.setQuality?.(L)
    const sun = this.world.sun
    if (sun.castShadow) {
      const type = L.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap
      if (r.shadowMap.type !== type) { r.shadowMap.type = type; this.world.scene.traverse((o) => { if (o.isMesh && o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.needsUpdate = true)) }) }
      if (sun.shadow.mapSize.x !== L.shadow) {
        sun.shadow.mapSize.set(L.shadow, L.shadow)
        sun.shadow.map?.dispose()
        sun.shadow.map = null
      }
    }
    this.shadowEvery = L.shadowEvery
  }

  // once per frame, before rendering: decides whether the shadow map is redrawn and watches the frame time
  update(frameMs) {
    this.world.renderer.shadowMap.needsUpdate = this.frame++ % this.shadowEvery === 0
    if (this.pinned !== null) return
    this.times.push(frameMs)
    if (this.times.length < WINDOW) return
    this.times.sort((a, b) => a - b)
    const median = this.times[WINDOW >> 1]
    this.times.length = 0
    if (median > SLOW_MS) { this.slow++; this.fast = 0 } else if (median < FAST_MS) { this.fast++; this.slow = 0 } else { this.slow = 0; this.fast = 0 }
    if (this.slow >= 2 && this.level > 0) { this.level--; this.slow = 0; this.apply() }          // drop at once when it hurts
    else if (this.fast >= 6 && this.level < LEVELS.length - 1) { this.fast = 0; this.level++; this.apply() }   // climb back slowly
  }
}
