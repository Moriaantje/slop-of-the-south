import * as THREE from "three"
import { off } from "game/Flags"
import { TUNING as T } from "game/Tuning"

// An environment map baked from the sky dome: PMREMGenerator renders a small dome with the same sky shader (a clone
// of DayNight's material, so the uniforms can be copied over and the ground half dimmed) whenever the light has
// changed enough or a few seconds have passed. Standard materials then get real ambient and specular response —
// cars and water pick up the sky — without any per-frame cost. ?env=0 skips it.
//
// Three things keep the bake from being felt. It is small: 128 px a cube face rather than the generator's default
// 256, which is a quarter of the pixels and a quarter of the texture memory, and a sky that is a gradient with a
// glow in it has no detail beyond that to lose. It is rare: only when the light has actually moved, else once a
// minute. And it has a floor under how often it may happen at all, because darkness moves fastest exactly at dusk,
// which is when it could otherwise fire on consecutive frames and stutter through the prettiest minute of the day.
const REFRESH_MS = 60000, DARKNESS_STEP = 0.04     // a PMREM bake is a visible hitch: only when the light moves, else once a minute
const MIN_GAP_MS = 1500                            // ms: never two bakes closer together than this, however fast dusk runs
const CUBE_PX = 128                                // px per face of the PMREM cube: a sky gradient needs no more

export class SkyEnv {
  constructor(world, dayNight) {
    this.enabled = !off("env")
    if (!this.enabled) return
    this.world = world
    this.dayNight = dayNight
    this.pmrem = new THREE.PMREMGenerator(world.renderer)
    this.scene = new THREE.Scene()
    this.material = dayNight.sky.material.clone()
    this.material.uniforms.groundDim.value = 0.4
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), this.material))
    this.target = null
    this.lastAt = -Infinity
    this.lastDarkness = -1
  }

  update(nowMs) {
    if (!this.enabled) return
    const d = this.dayNight.darkness
    const since = nowMs - this.lastAt
    if (since < MIN_GAP_MS || (since < REFRESH_MS && Math.abs(d - this.lastDarkness) < DARKNESS_STEP)) {
      this.world.scene.environmentIntensity = T.look.envIntensity
      return
    }
    this.lastAt = nowMs; this.lastDarkness = d
    const src = this.dayNight.sky.material.uniforms, dst = this.material.uniforms
    dst.zenith.value.copy(src.zenith.value); dst.horizon.value.copy(src.horizon.value); dst.glow.value.copy(src.glow.value)
    dst.sunDir.value.copy(src.sunDir.value); dst.glowStrength.value = src.glowStrength.value; dst.stars.value = 0
    const old = this.target
    this.target = this.pmrem.fromScene(this.scene, 0.04, 0.1, 100, { size: CUBE_PX })
    this.world.scene.environment = this.target.texture
    this.world.scene.environmentIntensity = T.look.envIntensity
    old?.dispose()
  }
}
