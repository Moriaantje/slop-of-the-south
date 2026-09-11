import * as THREE from "three"
import { TUNING as T, expDamp } from "game/Tuning"
import { Suspension } from "game/Suspension"
import { softTexture } from "game/Effects"

// Arcade car. yaw = 0 faces north (-z); positive yaw turns left. Velocity lives in the body frame: `speed` along the
// heading (the signed scalar Combat reads and writes) and `lateral` along the right-hand vector. Each step the nose
// turns, the world velocity is re-projected onto the new heading — which turns some forward speed into sideways
// speed — and grip bleeds the sideways part away. At full grip that is the old bicycle model; in a drift (handbrake
// while turning at speed, or a hard turn at high speed) the rear grip drops, the car slides at an angle and keeps
// rotating on its own; counter-steer trims the angle. Releasing a charged drift pays out a mini-turbo. Shift burns
// the nitro meter; road pads refill it. The frame runs integrate() (input → speed, heading, position), lets Combat
// push the car out of whatever it hit, then settle() (suspension: terrain contact and body attitude).
const DEFAULT_SPEC = { id: "auto", length: 4.1, track: 1.6, ram: 0.1, clear: 0.4, push: false, pushMin: 0 }
const SUBSTEP = 1 / 120

export class Vehicle {
  constructor(spawn, spec = DEFAULT_SPEC) {
    this.spec = spec
    this.wheelbase = 2.6
    this.track = 1.6
    this.maxSpeed = T.car.maxSpeed
    this.accel = T.car.accel
    this.brakeForce = T.car.brakeForce
    this.maxSteer = T.car.maxSteer
    this.mesh = makeCarMesh()
    this.lights = this.mesh.userData.lights
    this.braking = false
    this.darkness = 0
    this.susp = new Suspension(this.mesh)
    this.wheelWorld = []          // [{x, y, z}] ground contact of each wheel, filled by the suspension
    this.boostMeter = 0.5         // survives resets
    // two spotlights for the player's own car light up the road ahead at night
    this.spots = [-0.6, 0.6].map((x) => {
      const spot = new THREE.SpotLight(0xfff3d6, 0, 65, 0.5, 0.65, 1.7)
      spot.position.set(x, 0.7, -2.0)
      spot.target.position.set(x * 0.7, -0.6, -24)
      this.mesh.add(spot, spot.target)
      return spot
    })
    this.reset(spawn)
  }

  // darkness 0..1 (DayNight): headlights on in the dark, dim running lights by day
  setNight(darkness) {
    this.darkness = darkness
    for (const spot of this.spots) spot.intensity = 140 * darkness * darkness
    this.lights.head.emissiveIntensity = 0.35 + 2.2 * darkness
    this.updateTail()
  }

  updateTail() { this.lights.tail.emissiveIntensity = this.braking ? 1.9 : 0.12 + 0.7 * this.darkness }

  reset(spawn) {
    this.x = spawn.x; this.z = spawn.z; this.y = 0
    this.yaw = spawn.yaw; this.speed = 0; this.steer = 0
    this.lateral = 0; this.vx = 0; this.vz = 0; this.yawRate = 0
    this.grip = 1; this.slip = 0
    this.drifting = false; this.driftDir = 0; this.driftMild = false; this.driftT = 0; this.chargeLevel = 0
    this.boosting = false; this.burstT = 0; this.boostPower = 0
    this.accLong = 0; this.accLat = 0; this.wheelAngle = 0
    this._dt = 1 / 60; this._speedOut = 0
    this.susp.reset()
  }

  forward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) } }

  update(dt, input, heightAt) { this.integrate(dt, input); this.settle(heightAt) }

  // fixed 120 Hz substeps so the slide model behaves the same at 30 and 144 fps; the car ends exactly dt ahead
  integrate(dt, input) {
    this._dt = dt
    if (this.speed !== this._speedOut) this.lateral *= 0.3          // Combat bounced or slowed us: kill most of the slide
    const n = Math.max(1, Math.ceil(dt / SUBSTEP)), h = dt / n, v0 = this.speed
    for (let i = 0; i < n; i++) this.step(h, input)
    this.accLong = expDamp(this.accLong, (this.speed - v0) / dt, T.susp.accelSmooth, dt)
    this.accLat = expDamp(this.accLat, -this.speed * this.yawRate, T.susp.accelSmooth, dt)   // +right
    this._speedOut = this.speed
    const braking = (input.brake && this.speed > 0.5) || (input.handbrake && Math.abs(this.speed) > 0.5)
    if (braking !== this.braking) { this.braking = braking; this.updateTail() }
  }

  step(h, input) {
    const D = T.drift
    let f = this.forward(), rx = -f.z, rz = f.x
    const wx = f.x * this.speed + rx * this.lateral, wz = f.z * this.speed + rz * this.lateral   // world velocity

    this.updateBoost(h, input)
    const cap = this.maxSpeed * (1 + T.boost.speedBonus * this.boostPower)
    const accel = this.accel * (1 + T.boost.accelBonus * this.boostPower)

    // longitudinal
    let v = this.speed
    const drag = 0.35 * v * Math.abs(v) / this.maxSpeed + 0.8 * Math.sign(v)
    let a = input.throttle * accel - drag
    if (input.brake) a -= v > 0.5 ? this.brakeForce : this.accel * 0.6            // brake, then reverse
    if (input.handbrake) a -= (this.drifting ? D.handbrakeDecel : 12) * Math.sign(v)
    if (this.drifting) a -= D.slideDrag * Math.sign(v)
    v += a * h
    if (v > cap) v = expDamp(v, cap, T.boost.overspeedBleed, h)
    v = Math.max(v, -this.maxSpeed * T.car.reverseFrac)
    if (Math.abs(v) < 0.05 && !input.throttle && !input.brake) v = 0

    // steering: less lock at speed, more in a drift, smoothed; the tyres can only supply maxLatAccel of cornering
    const lock = this.maxSteer * (this.drifting ? D.steerLockBonus : 1) / (1 + Math.abs(v) / 18)
    this.steer = expDamp(this.steer, input.steer * lock, T.car.steerRate, h)
    const kinFree = (v / this.wheelbase) * Math.tan(this.steer)                      // what the front wheels ask for
    const maxYaw = D.maxLatAccel / Math.max(Math.abs(v), 1)
    const kinYawRate = clamp(kinFree, -maxYaw, maxYaw)

    // drift state machine
    const fast = v > D.minSpeed, steering = input.steer !== 0
    const latDemand = Math.abs(v * kinFree)                                          // centripetal accel the tyres must supply
    if (!this.drifting) {
      if (fast && input.handbrake && steering) this.startDrift(Math.sign(input.steer), false)
      else if (v > D.naturalDrift.minSpeed && latDemand > D.naturalDrift.latAccel) this.startDrift(Math.sign(this.steer) || 1, true)
    } else if (!fast) this.endDrift(false)
    else if (!this.driftMild && !input.handbrake) this.endDrift(true)                // release → mini-turbo
    else if (this.driftMild && input.handbrake && steering) { this.driftMild = false; this.driftDir = Math.sign(input.steer); this.driftT = 0 }
    else if (this.driftMild && latDemand < D.naturalDrift.latAccel * 0.6) this.endDrift(false)

    const gripTarget = this.drifting ? (this.driftMild ? D.gripMild : D.gripDrift) : D.gripNormal
    this.grip = expDamp(this.grip, gripTarget, gripTarget < this.grip ? D.gripInRate : D.gripOutRate, h)

    // yaw: kinematic when gripping; in a drift the steer counts more and the car keeps rotating on its own, so
    // steering into the slide grows the angle and counter-steering shrinks it
    let yawTarget = kinYawRate
    if (this.drifting && !this.driftMild) yawTarget = clamp(kinFree * D.yawGain, -D.driftMaxYaw, D.driftMaxYaw) + this.driftDir * D.yawSustain * Math.min(1, v / 20)
    this.yawRate = expDamp(this.yawRate, yawTarget, this.drifting ? D.yawRateSmooth.drift : D.yawRateSmooth.grip, h)
    this.yaw += this.yawRate * h

    // re-project the world velocity onto the new heading; grip bleeds the sideways part away, and most of what it
    // bleeds is redirected forward (arcade: turning costs little speed, sliding costs some)
    f = this.forward(); rx = -f.z; rz = f.x
    const mag = Math.hypot(wx, wz)
    let vLong = wx * f.x + wz * f.z, vLat = wx * rx + wz * rz
    this.slip = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.5))
    let damp = D.latDampMax * this.grip
    if (Math.abs(this.slip) > D.maxSlip) damp += 6                                   // spin-out guard
    vLat *= Math.max(0, 1 - damp * h)
    if (Math.abs(vLat) < 0.02) vLat = 0
    const lost = mag - Math.hypot(vLong, vLat)
    if (lost > 0) vLong += Math.sign(vLong || v || 1) * lost * (this.drifting ? D.redirect.drift : D.redirect.grip)
    vLong += v - this.speed                                                          // this step's longitudinal acceleration

    this.speed = vLong; this.lateral = vLat
    this.vx = f.x * vLong + rx * vLat; this.vz = f.z * vLong + rz * vLat
    this.x += this.vx * h; this.z += this.vz * h

    if (this.drifting && !this.driftMild && Math.abs(this.slip) > D.chargeSlip) {
      this.driftT += h
      this.chargeLevel = D.chargeLevels.filter((t) => this.driftT >= t).length
    }
    this.wheelAngle += (vLong / T.susp.wheelRadius) * h
  }

  startDrift(dir, mild) { this.drifting = true; this.driftDir = dir || 1; this.driftMild = mild; this.driftT = 0; this.chargeLevel = 0 }

  // payout: a released handbrake drift converts its charge into a free burst and meter; a slow-down or a hit does not
  endDrift(payout) {
    if (payout && this.chargeLevel > 0) this.addBoost(this.chargeLevel * T.boost.meterPerLevel, T.boost.burst[this.chargeLevel])
    this.drifting = false; this.driftMild = false; this.driftT = 0; this.chargeLevel = 0
  }

  addBoost(fill, burst = 0) { this.boostMeter = Math.min(1, this.boostMeter + fill); this.burstT = Math.max(this.burstT, burst) }

  // Shift drains the meter (with hysteresis so an empty meter does not flicker); bursts are free; refill when idle
  updateBoost(h, input) {
    const B = T.boost
    const wantHold = !!input.boost && (this.boosting ? this.boostMeter > 0 : this.boostMeter > B.reengage)
    if (wantHold) this.boostMeter = Math.max(0, this.boostMeter - h / B.drainTime)
    if (this.burstT > 0) this.burstT -= h
    this.boosting = wantHold || this.burstT > 0
    if (!this.boosting) this.boostMeter = Math.min(1, this.boostMeter + h / B.refillTime)
    this.boostPower = expDamp(this.boostPower, this.boosting ? 1 : 0, B.powerSmooth, h)
  }

  // Terrain contact and body attitude via the suspension; car.y stays the ground height under the centre
  settle(heightAt) { this.susp.update(this, heightAt, this._dt) }

  get smoking() { return this.drifting && Math.abs(this.slip) > T.fx.smokeSlip }

  state() {
    return { x: this.x, y: this.y, z: this.z, yaw: this.yaw, speed: this.speed, brake: this.braking, drift: this.smoking, boost: this.boostPower > 0.3 }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

let flameMat = null
function flameMaterial() {
  return flameMat ??= new THREE.SpriteMaterial({ map: softTexture(), color: 0xff8a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
}

// The car model, shared by the player and the other players. userData carries the animated parts: lights (materials),
// wheels (pivot groups at the corners, so they can steer, spin and ride up and down) and exhaust flames (sprites).
export function makeCarMesh(color = 0xd7412b) {
  const g = new THREE.Group()
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.4 })
  const dark  = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 })
  const body  = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 4.1), paint); body.position.y = 0.55
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.9), paint); cabin.position.set(0, 1.05, -0.2)
  g.add(body, cabin)
  const wheel = new THREE.CylinderGeometry(T.susp.wheelRadius, T.susp.wheelRadius, 0.25, 14); wheel.rotateZ(Math.PI / 2)
  const wheels = []
  for (const [lx, lz] of [[-0.85, -1.3], [0.85, -1.3], [-0.85, 1.3], [0.85, 1.3]]) {   // front left, front right, rear left, rear right
    const pivot = new THREE.Group(); pivot.position.set(lx, T.susp.wheelRadius, lz)
    const w = new THREE.Mesh(wheel, dark); pivot.add(w); g.add(pivot)
    wheels.push({ pivot, mesh: w, lx, lz, front: lz < 0 })
  }
  // lights: headlights at the front (-z), tail/brake lights at the back; their emissive intensity is animated
  const head = new THREE.MeshStandardMaterial({ color: 0xfff8e6, emissive: 0xfff3cc, emissiveIntensity: 0.35, roughness: 0.3 })
  const tail = new THREE.MeshStandardMaterial({ color: 0x7a1010, emissive: 0xff1a12, emissiveIntensity: 0.12, roughness: 0.4 })
  const lamp = new THREE.BoxGeometry(0.34, 0.16, 0.06)
  for (const x of [-0.6, 0.6]) {
    const h = new THREE.Mesh(lamp, head); h.position.set(x, 0.62, -2.06); g.add(h)
    const t = new THREE.Mesh(lamp, tail); t.position.set(x, 0.66, 2.06); g.add(t)
  }
  const flames = [-0.45, 0.45].map((x) => { const s = new THREE.Sprite(flameMaterial()); s.position.set(x, 0.42, 2.25); s.scale.setScalar(0); s.visible = false; g.add(s); return s })
  g.userData.lights = { head, tail }
  g.userData.wheels = wheels
  g.userData.flames = flames
  return g
}
