import * as THREE from "three"
import { TUNING as T, expDamp } from "game/Tuning"

// Per-car cosmetics: tyre smoke from the rear wheels while sliding and exhaust flames while boosting. Driven by a
// small duck-typed state so it serves the player's car (live values) and remote cars (flags from the network alike):
//   { smoking: bool, boostPower: 0..1, vx, vz }
export class VehicleFx {
  constructor(mesh, smokePool) {
    this.mesh = mesh
    this.pool = smokePool
    this.flames = mesh.userData.flames ?? []
    this.rear = (mesh.userData.wheels ?? []).filter((w) => !w.front)
    this.acc = 0
    this.power = 0
  }

  update(state, dt) {
    const F = T.fx
    // smoke: a steady stream of puffs from each rear wheel, carried along a little with the car and rising
    if (state.smoking && this.pool) {
      this.acc += F.smokeRate * dt
      if (this.acc >= 1) this.mesh.updateMatrixWorld()
      while (this.acc >= 1) {
        this.acc -= 1
        for (const w of this.rear) {
          w.pivot.getWorldPosition(_p)
          const jx = (Math.random() - 0.5) * 0.6, jz = (Math.random() - 0.5) * 0.6
          this.pool.emit(_p.x + jx, _p.y - T.susp.wheelRadius + 0.15, _p.z + jz,
            (state.vx ?? 0) * 0.3 + jx, 0.7 + Math.random() * 0.5, (state.vz ?? 0) * 0.3 + jz,
            F.smokeLife, 0.5, 1.8, 0.4)
        }
      }
    } else this.acc = 0
    // flames: scale with the (smoothed) boost power and flicker
    this.power = expDamp(this.power, state.boostPower ?? 0, T.boost.powerSmooth, dt)
    const on = this.power > 0.05
    for (const s of this.flames) {
      s.visible = on
      if (on) s.scale.setScalar(this.power * (0.55 + F.flameFlicker * Math.random()))
    }
  }
}

const _p = new THREE.Vector3()
