import * as THREE from "three"
import { TUNING as T, expDamp } from "game/Tuning"

// Per-car cosmetics: tyre smoke from the rear wheels while sliding and exhaust flames while boosting. Driven by a
// small duck-typed state so it serves the player's car (live values) and remote cars (flags from the network) alike:
//   { smoking: bool, boostPower: 0..1, vx, vz }
//
// Two things make the smoke read as smoke rather than as a string of beads. First, the puffs are placed where the
// tyre *was* when they were due, not where it is now: at 44 m/s a frame is nearly a metre, so emitting everything at
// the current contact patch lays down a dotted line that visibly pulses with the frame rate. The pending-puff
// counter already knows how long ago each one was owed, so each is walked back along the car's own velocity by
// exactly that much and the trail comes out continuous. Second, a puff keeps only part of the car's velocity —
// burnt rubber smoke is left behind in the air, it does not ride along — and the jitter that spreads it sideways is
// reused as its drift, so the cloud opens out behind the car instead of expanding as a sphere.
//
// The flames are two sprites per exhaust, an orange body and a hot core that only lights above two thirds boost,
// each on its own phase so a twin-pipe car does not pulse in unison. The flicker is three sines rather than a
// random number per frame: noise at frame rate strobes, a sum of incommensurate sines reads as combustion.
//
// A landing throws dust. The car counts its landings and publishes the speed of the last one, so this only has to
// watch the count change rather than have an event wired through the frame loop — which matters because Combat eats
// the `landed` flag before the effects ever run. The puffs go out low and sideways from each wheel rather than up,
// because what a landing kicks up is the loose surface being shoved out from under the tyre, and a cloud that rises
// from the contact patch reads as a smoke bomb instead.
const SMOKE_FULL_SPEED = 26     // m/s at which the tyres are scrubbing as hard as the rate allows
const SMOKE_SPREAD = 0.7        // metres of sideways jitter at the contact patch
const SMOKE_CARRY = 0.24        // share of the car's velocity a puff keeps
const SMOKE_SCRUB = 1.6         // /s: how fast the jitter offset turns into outward drift
const SMOKE_RISE = 0.8          // m/s the puff climbs
const SMOKE_RISE_JITTER = 0.7   // m/s extra, random
const SMOKE_LIFT = 0.14         // metres above the road the puff starts
const SMOKE_S0 = 0.45           // metres: puff size at birth
const SMOKE_S1 = 2.4            // metres: puff size at death
const SMOKE_ALPHA = 0.42
const MAX_PUFFS_PER_FRAME = 6   // a long stall must not dump the whole pool in one frame
const FLAME_HZ = 7.0            // base flicker rate
const FLAME_LEN = 0.55          // how much of the flame's length is flicker
const FLAME_WIDTH = 0.62        // flames are taller than they are wide
const CORE_FROM = 0.35          // boost power at which the white core lights
const FLAME_COOL = new THREE.Color(0xff7a1e)    // idle-rich orange
const FLAME_HOT = new THREE.Color(0x9fd0ff)     // lean blue-white at full boost
const LAND_REF = 16             // m/s of touchdown that throws as much dust as a landing ever throws
const LAND_PUFFS = 3            // puffs per wheel at a full-strength landing
const LAND_OUT = 3.2            // m/s the dust is shoved sideways out from under the tyre
const LAND_RISE = 0.5           // m/s it climbs, which is much less than tyre smoke: this is being pushed, not burnt
const LAND_LIFE = 0.75          // s
const LAND_S0 = 0.5, LAND_S1 = 3.0   // metres: birth and death size
const LAND_ALPHA = 0.5

export class VehicleFx {
  constructor(mesh, smokePool) {
    this.mesh = mesh
    this.pool = smokePool
    // Vehicles.js hands over rich records; tolerate a bare sprite so an older mesh still works
    this.flames = (mesh.userData.flames ?? []).map((f) => (f.isSprite ? { sprite: f, mat: f.material, core: null, coreMat: null, size: 1, phase: 0 } : f))
    this.rear = (mesh.userData.wheels ?? []).filter((w) => !w.front)
    this.wheels = mesh.userData.wheels ?? []
    this.acc = 0
    this.power = 0
    this.t = 0
    this.lastLand = null          // the car's landing count as of the last frame; null until the first one is seen
  }

  // a landing: dust shoved out from under every wheel, as much of it as the fall deserves
  land(impact) {
    if (!this.pool || !this.wheels.length) return
    const k = Math.min(1, impact / LAND_REF)
    const n = Math.max(1, Math.round(LAND_PUFFS * k))
    this.mesh.updateMatrixWorld()
    for (const w of this.wheels) {
      w.pivot.getWorldPosition(_p)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = 0.4 + Math.random() * 0.6
        this.pool.emit(
          _p.x + Math.cos(a) * r * 0.4, _p.y - (w.r ?? T.susp.wheelRadius) + 0.1, _p.z + Math.sin(a) * r * 0.4,
          Math.cos(a) * LAND_OUT * k, LAND_RISE * (0.5 + Math.random()), Math.sin(a) * LAND_OUT * k,
          LAND_LIFE * (0.8 + Math.random() * 0.5), LAND_S0, LAND_S1, LAND_ALPHA * k)
      }
    }
  }

  update(state, dt) {
    const F = T.fx
    this.t += dt
    const landT = state.landT ?? null
    if (landT !== this.lastLand) {
      if (this.lastLand !== null) this.land(state.landImpact ?? LAND_REF)
      this.lastLand = landT
    }
    const vx = state.vx ?? 0, vz = state.vz ?? 0
    if (state.smoking && this.pool && this.rear.length) {
      const drive = Math.min(1, 0.35 + Math.hypot(vx, vz) / SMOKE_FULL_SPEED)
      const rate = F.smokeRate * drive
      this.acc += rate * dt
      if (this.acc >= 1) this.mesh.updateMatrixWorld()
      let made = 0
      while (this.acc >= 1 && made < MAX_PUFFS_PER_FRAME) {
        this.acc -= 1; made++
        const back = Math.min(dt, this.acc / Math.max(rate, 1e-3))     // seconds ago this puff was owed
        for (const w of this.rear) {
          w.pivot.getWorldPosition(_p)
          const jx = (Math.random() - 0.5) * SMOKE_SPREAD, jz = (Math.random() - 0.5) * SMOKE_SPREAD
          this.pool.emit(
            _p.x - vx * back + jx, _p.y - (w.r ?? T.susp.wheelRadius) + SMOKE_LIFT, _p.z - vz * back + jz,
            vx * SMOKE_CARRY + jx * SMOKE_SCRUB, SMOKE_RISE + Math.random() * SMOKE_RISE_JITTER, vz * SMOKE_CARRY + jz * SMOKE_SCRUB,
            F.smokeLife * (0.8 + Math.random() * 0.5), SMOKE_S0, SMOKE_S1, SMOKE_ALPHA * drive)
        }
      }
      if (made >= MAX_PUFFS_PER_FRAME) this.acc = 0
    } else this.acc = 0

    this.power = expDamp(this.power, state.boostPower ?? 0, T.boost.powerSmooth, dt)
    const on = this.power > 0.05
    for (const f of this.flames) {
      f.sprite.visible = on
      if (f.core) f.core.visible = on && this.power > CORE_FROM
      if (!on) continue
      const p = this.t * FLAME_HZ + f.phase
      const flick = 0.5 + 0.5 * (Math.sin(p) * 0.5 + Math.sin(p * 1.87) * 0.3 + Math.sin(p * 3.11) * 0.2)
      const len = f.size * this.power * (0.55 + FLAME_LEN * F.flameFlicker * 2 * flick)
      f.sprite.scale.set(len * FLAME_WIDTH, len, len)
      f.mat.opacity = (0.5 + 0.45 * flick) * Math.min(1, this.power * 1.4)
      f.mat.color.copy(FLAME_COOL).lerp(FLAME_HOT, this.power * 0.55)
      if (!f.core?.visible) continue
      const hot = (this.power - CORE_FROM) / (1 - CORE_FROM)
      f.core.scale.set(len * 0.42, len * 0.52, len * 0.42)
      f.coreMat.opacity = (0.45 + 0.4 * flick) * hot
    }
  }
}

const _p = new THREE.Vector3()
