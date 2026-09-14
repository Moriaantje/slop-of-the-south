import * as THREE from "three"
import { TUNING as T, smoothDamp, smoothDampAngle, lerpAngle, wrapAngle, expDamp, smoothstep } from "game/Tuning"

// Chase camera. Sits behind a direction blended between the body's nose and its velocity (so in a drift the nose
// swings across the frame while the camera keeps looking down the road), at a distance and height that grow with
// speed and boost, with the field of view widening as well. Position, look target and yaw are each critically damped
// springs, so nothing snaps and nothing overshoots; the look target is damped faster than the position so the body
// stays framed.
//
// The camera is half of how movement feels, so it does more than trail. It breathes: the boom pays out under
// acceleration and draws in under the brake, which is what makes a standing start read as a shove rather than as a
// number going up, and it steadies in a drift — the position spring is slowed so the frame stops swimming while the
// car is sideways and the eye can read the slide. It leads: the look target slides towards the inside of a turn in
// proportion to how fast the heading is actually changing, so a corner is entered looking at the corner. And it
// scales the framing against a fixed reference speed rather than against whatever this body's own top speed is,
// which is the whole trick for a machine that walks: a mech at twelve metres a second sits close and low, a car at
// forty sits far and high, and neither needs its own set of numbers.
//
// It also refuses to be blocked. Heights are relative to the ground, and the clearance is checked at several points
// along the boom rather than only under the camera, so a rise between the body and the camera lifts the shot instead
// of swallowing it; and the camera is never allowed closer to the body than a minimum radius, so a squeeze between
// ground and car pushes it back rather than through the bodywork.
//
// Finally, shock. A landing, a hit or a transformation is a thing that happens to the body, and a body-mounted
// camera is where an eye would feel it: a damped spring drives the camera down and lets it ring back, with the look
// target taking part of it so the jolt reads as a jolt and not as a lift. Landings and transformations are noticed
// here from the body's own state, so no caller has to remember to report them, and `shock()` is open for anything
// that does want to say so. This is deliberately not Effects.shake, which is white noise added after the fact for an
// explosion; this is the suspension of the shot.
const SPEED_REF = 40           // m/s the framing is scaled against, whatever this body's own top speed happens to be
const DIST_PER_ACCEL = 0.14    // m of boom per m/s² of longitudinal acceleration
const MAX_ACCEL_DIST = 2.4     // m either way
const ACCEL_SMOOTH = 4         // /s: the acceleration the boom reads
const LOOK_INTO_TURN = 2.4     // m the look target slides towards the inside of a turn, per rad/s of heading change
const MAX_LOOK_SIDE = 3.0      // m
const YAW_RATE_SMOOTH = 6      // /s: the heading rate the lead is read from
const DRIFT_STEADY = 1.5       // factor on the position smooth time while sliding: the frame settles
const MIN_DIST = 3.2           // m the camera is never allowed closer to the body than
const BOOM_SAMPLES = [0.5, 0.78, 1]   // fractions along the boom where the ground is checked for clearance
const SHOCK_HZ = 3.4           // Hz of the shock spring
const SHOCK_ZETA = 0.42        // under one, so a jolt rings back instead of oozing
const SHOCK_LOOK = 0.55        // share of the shock the look target takes, so it reads as a jolt not a lift
const MAX_SHOCK = 0.9          // m
const LAND_SHOCK = 0.022       // m of dip per m/s of vertical speed at touchdown
const MAX_LAND = 26            // m/s of impact past which a landing is no worse
const TRANSFORM_SHOCK = 0.34   // m at the moment the bodies swap
const HIT_ACCEL = 45           // m/s² of sudden deceleration that is a collision rather than a brake
const HIT_SHOCK = 0.006        // m per m/s² past that

export class ChaseCamera {
  constructor(camera, heightAt = null) {
    this.camera = camera
    this.heightAt = heightAt
    this.pos = new THREE.Vector3(); this.posVel = [0, 0, 0]
    this.look = new THREE.Vector3(); this.lookVel = [0, 0, 0]
    this.yaw = 0; this.yawVel = [0]
    this.fov = T.camera.fov
    this.snapped = false
    this.clearState()
  }

  clearState() {
    this.accel = 0; this.bodyYawRate = 0
    this.shockY = 0; this.shockV = 0
    this._lastSpeed = 0; this._lastYaw = 0; this._lastVy = 0
    this._wasAir = false; this._wasMorphing = false
  }

  // a jolt: metres the camera is driven down before it rings back. Anything may call it (a hit, a stomp, a spell).
  shock(metres) { this.shockV -= Math.min(Math.abs(metres), MAX_SHOCK) * 2 * Math.PI * SHOCK_HZ }

  // desired camera yaw: behind the nose at rest, behind the velocity at speed (more so in a drift), behind the nose in reverse
  targetYaw(car) {
    const C = T.camera
    const speed = Math.hypot(car.vx ?? 0, car.vz ?? 0)
    if (speed < 0.5 || car.speed < -1) return car.yaw
    const velYaw = Math.atan2(-car.vx, -car.vz)
    const w = (car.drifting ? C.velBlendDrift : C.velBlend) * smoothstep(C.velBlendMinSpeed, C.velBlendFullSpeed, speed)
    return lerpAngle(car.yaw, velYaw, w)
  }

  // read what the body is doing this frame: acceleration for the boom, heading rate for the lead, and the shocks
  sense(car, dt) {
    const speed = car.speed ?? 0
    this.accel = expDamp(this.accel, (speed - this._lastSpeed) / dt, ACCEL_SMOOTH, dt)
    const raw = wrapAngle((car.yaw ?? 0) - this._lastYaw) / dt
    this.bodyYawRate = expDamp(this.bodyYawRate, raw, YAW_RATE_SMOOTH, dt)
    const hit = -(speed - this._lastSpeed) / dt - HIT_ACCEL
    if (hit > 0) this.shock(hit * HIT_SHOCK)
    const air = (car.vy ?? null) !== null
    if (this._wasAir && !air) this.shock(LAND_SHOCK * Math.min(MAX_LAND, Math.abs(this._lastVy)))
    const morphing = !!car.transforming
    if (morphing && !this._wasMorphing) this.shock(TRANSFORM_SHOCK)
    this._lastSpeed = speed; this._lastYaw = car.yaw ?? 0; this._wasAir = air; this._wasMorphing = morphing
    if (air) this._lastVy = car.vy
  }

  place(car, yaw, out, look) {
    const C = T.camera
    const s = Math.min(1, Math.hypot(car.vx ?? 0, car.vz ?? 0) / SPEED_REF), boost = car.boostPower ?? 0
    const cam = car.spec?.cam ?? { dist: 1, height: 1 }                                       // bigger vehicles push the camera back and up
    const pull = clamp(this.accel * DIST_PER_ACCEL, -MAX_ACCEL_DIST, MAX_ACCEL_DIST)          // the boom breathes with the throttle
    const dist = (C.dist + C.distPerSpeed * s + C.distBoost * boost) * cam.dist + pull, height = (C.height + C.heightPerSpeed * s) * cam.height
    const cy = car.y + 0.6 * ((car.mesh?.position.y ?? car.y) - car.y)                          // a jumping body pulls the camera up a little
    out.set(car.x + Math.sin(yaw) * dist, cy + height, car.z + Math.cos(yaw) * dist)             // behind = opposite of forward (-sin, -cos)
    const f = car.forward(), rx = -f.z, rz = f.x
    const side = clamp(this.bodyYawRate * LOOK_INTO_TURN, -MAX_LOOK_SIDE, MAX_LOOK_SIDE)         // lead into the corner
    look.set(car.x + f.x * C.lookAhead - rx * side, cy + C.lookHeight * (cam.look ?? 1), car.z + f.z * C.lookAhead - rz * side)
    return C.fov + C.fovPerSpeed * s + C.fovBoost * boost
  }

  // jump straight into place (spawn, teleport)
  snap(car) {
    this.clearState()
    this._lastSpeed = car.speed ?? 0; this._lastYaw = car.yaw ?? 0
    this._wasAir = (car.vy ?? null) !== null; this._wasMorphing = !!car.transforming
    this.yaw = this.targetYaw(car); this.yawVel[0] = 0
    const fov = this.place(car, this.yaw, this.pos, this.look)
    this.posVel.fill(0); this.lookVel.fill(0)
    this.fov = Math.min(T.camera.fovMax, fov)
    this.clear(car)
    this.snapped = true
    this.apply()
  }

  update(car, dt) {
    if (!this.snapped) return this.snap(car)
    const C = T.camera
    this.sense(car, dt)
    this.yaw = smoothDampAngle(this.yaw, this.targetYaw(car), this.yawVel, 0, C.yawSmooth, dt)
    const fov = this.place(car, this.yaw, _target, _lookTarget)
    const posSmooth = C.posSmooth * (car.drifting ? DRIFT_STEADY : 1)               // a slide steadies the frame
    this.pos.x = smoothDamp(this.pos.x, _target.x, this.posVel, 0, posSmooth, dt)
    this.pos.y = smoothDamp(this.pos.y, _target.y, this.posVel, 1, posSmooth, dt)
    this.pos.z = smoothDamp(this.pos.z, _target.z, this.posVel, 2, posSmooth, dt)
    this.look.x = smoothDamp(this.look.x, _lookTarget.x, this.lookVel, 0, C.lookSmooth, dt)
    this.look.y = smoothDamp(this.look.y, _lookTarget.y, this.lookVel, 1, C.lookSmooth, dt)
    this.look.z = smoothDamp(this.look.z, _lookTarget.z, this.lookVel, 2, C.lookSmooth, dt)
    this.stepShock(dt)
    this.pos.y += this.shockY
    this.look.y += this.shockY * SHOCK_LOOK
    this.clear(car)
    this.fov = expDamp(this.fov, Math.min(C.fovMax, fov), 1 / C.fovSmooth, dt)
    this.apply()
  }

  // the shock spring: an impulse drives it down and it rings back to nothing
  stepShock(dt) {
    const steps = dt > 1 / 60 ? 2 : 1, h = dt / steps
    const w = 2 * Math.PI * SHOCK_HZ, k = w * w, c = 2 * SHOCK_ZETA * w
    for (let s = 0; s < steps; s++) {
      this.shockV += (-k * this.shockY - c * this.shockV) * h
      this.shockY += this.shockV * h
    }
    this.shockY = clamp(this.shockY, -MAX_SHOCK, MAX_SHOCK)
  }

  // never through the ground and never inside the body: the boom is checked along its length, not only at its end
  clear(car) {
    const C = T.camera
    if (this.heightAt) {
      let lift = 0
      for (const u of BOOM_SAMPLES) {
        const px = car.x + (this.pos.x - car.x) * u, pz = car.z + (this.pos.z - car.z) * u
        const py = car.y + (this.pos.y - car.y) * u
        const need = (this.heightAt(px, pz) + C.groundClearance - py) / u
        if (need > lift) lift = need
      }
      if (lift > 0) { this.pos.y += lift; this.posVel[1] = Math.max(0, this.posVel[1]) }
    }
    const bodyY = car.mesh?.position.y ?? car.y
    const dx = this.pos.x - car.x, dy = this.pos.y - (bodyY + C.lookHeight * 0.5), dz = this.pos.z - car.z
    const d = Math.hypot(dx, dy, dz)
    if (d > 1e-3 && d < MIN_DIST) {                                                 // squeezed against the bodywork: back off
      const k = (MIN_DIST - d) / d
      this.pos.x += dx * k; this.pos.z += dz * k
      this.pos.y += Math.max(0, dy) * k
    }
  }

  apply() {
    this.camera.position.copy(this.pos)
    this.camera.lookAt(this.look)
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix() }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
const _target = new THREE.Vector3(), _lookTarget = new THREE.Vector3()
