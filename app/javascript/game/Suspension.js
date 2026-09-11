import { TUNING as T } from "game/Tuning"

// Spring-damper body over four wheels. Each wheel samples the ground at its own corner and rests on it; the body
// floats on a heave spring (height) and an attitude spring (pitch, roll) whose targets come from the ground under
// the wheels plus the car's acceleration: throttle lifts the nose, braking dives, cornering and drifting lean the
// body outward. Front wheels show the steer angle, all wheels spin with the road speed.
// The car's `y` stays the mean ground height under the wheels (Combat, beacons and placement rely on it); only the
// mesh gets the sprung height and attitude.
export class Suspension {
  constructor(mesh) {
    this.mesh = mesh
    this.wheels = mesh.userData.wheels ?? []
    this.reset()
  }

  reset() { this.h = null; this.hv = 0; this.pitch = 0; this.pv = 0; this.roll = 0; this.rv = 0 }

  // car: { x, z, yaw, wheelbase, track, accLong, accLat, steer, wheelAngle, wheelWorld?, y (written) }
  update(car, heightAt, dt) {
    const S = T.susp
    const f = { x: -Math.sin(car.yaw), z: -Math.cos(car.yaw) }, rx = -f.z, rz = f.x
    const gC = heightAt(car.x, car.z)
    let sum = 0, front = 0, rear = 0, left = 0, right = 0
    const g = new Array(this.wheels.length)
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]
      const wx = car.x + rx * w.lx - f.x * w.lz, wz = car.z + rz * w.lx - f.z * w.lz      // local -z is forward
      let gi = heightAt(wx, wz)
      if (Math.abs(gi - gC) > S.maxCornerDrop) gi = gC                                    // unloaded tile or seam spike
      g[i] = gi; sum += gi
      if (w.front) front += gi; else rear += gi
      if (w.lx < 0) left += gi; else right += gi
      if (car.wheelWorld) car.wheelWorld[i] = { x: wx, y: gi, z: wz }
    }
    const n = this.wheels.length || 1
    const gY = this.wheels.length ? sum / n : gC
    const gPitch = this.wheels.length ? Math.atan2(front / (n / 2) - rear / (n / 2), car.wheelbase) : 0
    const gRoll = this.wheels.length ? Math.atan2(right / (n / 2) - left / (n / 2), car.track) : 0
    car.y = gY

    const pitchT = clamp(gPitch + S.pitchPerAccel * (car.accLong ?? 0), -S.maxPitch, S.maxPitch)
    const rollT = clamp(gRoll + S.rollPerAccel * (car.accLat ?? 0), -S.maxRoll, S.maxRoll)

    if (this.h === null) { this.h = gY; this.pitch = gPitch; this.roll = gRoll; this.hv = this.pv = this.rv = 0 }   // (re)seed after a reset or teleport
    const steps = dt > 1 / 60 ? 2 : 1, hh = dt / steps
    const wH = 2 * Math.PI * S.heaveHz, kH = wH * wH, cH = 2 * S.heaveZeta * wH
    const wA = 2 * Math.PI * S.attitudeHz, kA = wA * wA, cA = 2 * S.attitudeZeta * wA
    for (let s = 0; s < steps; s++) {
      this.hv += (kH * (gY - this.h) - cH * this.hv) * hh; this.h += this.hv * hh
      this.pv += (kA * (pitchT - this.pitch) - cA * this.pv) * hh; this.pitch += this.pv * hh
      this.rv += (kA * (rollT - this.roll) - cA * this.rv) * hh; this.roll += this.rv * hh
    }
    this.h = clamp(this.h, gY - S.travel, gY + S.travel)

    this.mesh.position.set(car.x, this.h, car.z)
    this.mesh.rotation.set(this.pitch, car.yaw, this.roll, "YXZ")

    // wheels rest on their own ground; the body corner above them moves with the springs
    const sp = Math.sin(this.pitch), sr = Math.sin(this.roll)
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]
      const cornerY = this.h - w.lz * sp + w.lx * sr
      w.pivot.position.y = (w.r ?? S.wheelRadius) + clamp(g[i] - cornerY, -S.travel, S.travel)
      w.pivot.rotation.y = w.front ? (car.steer ?? 0) : 0
      w.mesh.rotation.x = -(car.wheelAngle ?? 0)                                         // axle is local x; forward roll is negative
    }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
