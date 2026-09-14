import { test } from "node:test"
import assert from "node:assert/strict"
import { Vehicle } from "game/Vehicle"
import { VehicleFx } from "game/VehicleFx"
import { vehicleSpec } from "game/Vehicles"
import { TUNING as T } from "game/Tuning"

// The car already handled well; what is measured here is the weight that was added to it and, just as importantly,
// that adding it did not move the numbers the handling was tuned around. Top speed, the time to get there and the
// distance it takes to stop are all things a player has in their hands after ten minutes, so they are asserted
// rather than eyeballed.
const flat = () => 0
const keys = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, ...o })
const car = (id = "auto") => new Vehicle({ x: 0, z: 0, yaw: 0 }, vehicleSpec(id))
const run = (v, input, seconds, dt = 1 / 60, each = null) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) { v.update(dt, typeof input === "function" ? input(t) : input, flat); each?.(t) }
}

test("the throttle has an onset, and the top speed it reaches is the one the spec promises", () => {
  const v = car()
  const accels = []
  let last = 0
  run(v, keys({ throttle: 1 }), 3, 1 / 60, () => { accels.push((v.speed - last) * 60); last = v.speed })
  const peak = Math.max(...accels)
  assert.ok(accels[0] < peak * 0.35, `the first frame already pulled ${accels[0].toFixed(1)} of ${peak.toFixed(1)} m/s²`)
  assert.ok(v.torque > 0.98, "the drive must reach full torque at a held throttle")
  run(v, keys({ throttle: 1 }), 30)
  // the rise time is in the torque, not in the force balance, so the terminal speed is still exactly where the drag
  // curve puts it: accel = 0.35 v² / maxSpeed + 0.8
  const terminal = Math.sqrt((v.accel - 0.8) * v.maxSpeed / 0.35)
  assert.ok(Math.abs(v.speed - terminal) < 0.3, `top speed ${v.speed.toFixed(2)} against the drag balance ${terminal.toFixed(2)}`)
  assert.ok(v.speed < v.maxSpeed, "the boost cap is the ceiling, not the cruise")
})

test("time to speed and stopping distance stay in the range the handling was tuned around", () => {
  const v = car()
  let to25 = null
  run(v, keys({ throttle: 1 }), 12, 1 / 60, (t) => { if (to25 === null && v.speed >= 25) to25 = t })
  assert.ok(to25 > 1.5 && to25 < 7, `0–25 m/s in ${to25} s`)

  const b = car()
  run(b, keys({ throttle: 1 }), 12)
  const z0 = b.z, v0 = b.speed
  let dist = null
  run(b, keys({ brake: 1 }), 4, 1 / 60, () => { if (dist === null && b.speed <= 0.5) dist = Math.abs(b.z - z0) })
  assert.ok(dist > 20 && dist < 90, `stopped from ${v0.toFixed(1)} m/s in ${dist?.toFixed(1)} m`)

  // lifting off coasts: the engine lets go over a moment rather than falling straight onto the drag curve
  const c = car()
  run(c, keys({ throttle: 1 }), 6)
  const before = c.speed
  c.update(1 / 60, keys(), flat)
  assert.ok(c.torque > 0.5, `the throttle dropped to ${c.torque.toFixed(2)} in a single frame`)
  assert.ok(c.speed > before - 0.4, "lifting off must not brake the car")
})

test("a landing compresses the suspension, dips the nose and is published once", () => {
  const v = car()
  run(v, keys({ throttle: 1 }), 3)
  const landT0 = v.landT
  v.jump(11)
  assert.ok(v.susp.hv > 0, "leaving the ground must let the body up off its springs")
  let minMesh = 0, landings = 0
  run(v, keys({ throttle: 1 }), 3, 1 / 60, () => {
    if (v.landT !== landT0) { if (landings === 0) landings = 1; minMesh = Math.min(minMesh, v.mesh.position.y - v.y) }
  })
  assert.equal(v.landT, landT0 + 1, "the landing must be published exactly once")
  assert.ok(v.landImpact > 8, `landed at ${v.landImpact}`)
  assert.ok(minMesh < -0.05, `the springs did not take the landing (${minMesh.toFixed(3)} m of squat)`)
  assert.ok(minMesh > -T.susp.travel - 1e-6, "and the bump stop must hold the body off the floor")
  run(v, keys(), 3)
  assert.ok(Math.abs(v.mesh.position.y - v.y) < 0.05, "the body must come back to rest on its springs")
})

test("the dust goes up when the car lands, and only then", () => {
  const puffs = []
  const pool = { emit(x, y, z, vx, vy, vz, life, s0, s1, a0) { puffs.push({ x, y, z, vy, s0, s1, a0 }) } }
  const v = car()
  const fx = new VehicleFx(v.mesh, pool)
  run(v, keys({ throttle: 1 }), 1, 1 / 60, () => fx.update(v, 1 / 60))
  assert.equal(puffs.length, 0, "driving along threw dust")
  v.jump(12)
  run(v, keys({ throttle: 1 }), 3, 1 / 60, () => fx.update(v, 1 / 60))
  assert.ok(puffs.length >= v.mesh.userData.wheels.length, `only ${puffs.length} puffs from a landing`)
  for (const p of puffs) {
    assert.ok(p.s1 > p.s0, "a puff must expand as it dies")
    assert.ok(p.vy > 0 && p.vy < 2, `landing dust is shoved out, not blown up (${p.vy} m/s)`)
    assert.ok(p.a0 > 0 && p.a0 <= 0.5)
  }
  const n = puffs.length
  run(v, keys({ throttle: 1 }), 2, 1 / 60, () => fx.update(v, 1 / 60))
  assert.equal(puffs.length, n, "the landing threw dust more than once")
})
