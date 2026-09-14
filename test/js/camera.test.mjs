import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { ChaseCamera } from "game/Camera"
import { TUNING as T } from "game/Tuning"

// The camera is half of how movement feels, so what is asserted here is what the shot does rather than which
// methods ran: how long it takes to settle, that it pays the boom out under power and draws it in under the brake,
// that it leads into a corner, that a walking body is framed closer and lower than a driving one, and that it can
// be neither pushed through the ground nor squeezed into the bodywork.
const flat = () => 0
const body = (o = {}) => ({
  x: 0, y: 0, z: 0, yaw: 0, speed: 0, vx: 0, vz: 0, vy: null, maxSpeed: 44, boostPower: 0, drifting: false,
  transforming: false, spec: { cam: { dist: 1, height: 1, look: 1 } }, mesh: { position: { y: 0 } },
  forward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) } }, ...o,
})
const make = (heightAt = flat) => new ChaseCamera(new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 4000), heightAt)
const run = (cam, b, seconds, dt = 1 / 60, each = null) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) { each?.(t, dt); cam.update(b, dt) }
}
const boom = (cam, b) => Math.hypot(cam.pos.x - b.x, cam.pos.z - b.z)

test("the camera settles behind a moved body in well under a second and does not overshoot", () => {
  const cam = make(), b = body()
  cam.snap(b)
  b.x = 30; b.z = -40
  let settled = null, maxDist = 0
  run(cam, b, 2, 1 / 60, (t) => {
    const d = Math.hypot(cam.pos.x - b.x, cam.pos.z - b.z)
    maxDist = Math.max(maxDist, d)
    if (settled === null && Math.abs(d - T.camera.dist) < 0.3) settled = t
  })
  assert.ok(settled !== null && settled < 1.2, `settled after ${settled} s`)
  const rest = boom(cam, b)
  assert.ok(Math.abs(rest - T.camera.dist) < 0.2, `came to rest ${rest} m behind instead of ${T.camera.dist}`)
})

test("the boom pays out under acceleration and draws in under the brake", () => {
  const cam = make(), b = body({ speed: 18, vz: -18 })
  cam.snap(b)
  run(cam, b, 2.5)                                                   // steady at 18 m/s
  const steady = boom(cam, b)

  const c2 = make(), b2 = body({ speed: 0 })
  c2.snap(b2)
  run(c2, b2, 1.4, 1 / 60, (t, dt) => { b2.speed = Math.min(18, b2.speed + 14 * dt); b2.vz = -b2.speed })
  const pulling = boom(c2, b2)
  assert.ok(b2.speed > 17.5, "the test body never reached the comparison speed")
  assert.ok(pulling > steady + 0.3, `accelerating boom ${pulling.toFixed(2)} m vs steady ${steady.toFixed(2)} m`)

  const c3 = make(), b3 = body({ speed: 18, vz: -18 })
  c3.snap(b3)
  run(c3, b3, 1, 1 / 60, (t, dt) => { b3.speed = Math.max(0, b3.speed - 14 * dt); b3.vz = -b3.speed })
  assert.ok(c3.accel < -5, `braking was not felt (${c3.accel.toFixed(1)} m/s²)`)
})

test("the camera leads into a turn", () => {
  const cam = make(), b = body({ speed: 20, vz: -20 })
  cam.snap(b)
  run(cam, b, 1.2, 1 / 60, (t, dt) => { b.yaw += 1.4 * dt; const f = b.forward(); b.vx = f.x * 20; b.vz = f.z * 20 })
  const f = b.forward(), rx = -f.z, rz = f.x
  const side = (cam.look.x - b.x) * rx + (cam.look.z - b.z) * rz          // + is to the body's right
  assert.ok(cam.bodyYawRate > 1, `the camera did not see the turn (${cam.bodyYawRate.toFixed(2)} rad/s)`)
  assert.ok(side < -0.8, `the look target sat ${side.toFixed(2)} m to the right of a left-hand turn`)

  const straight = make(), b2 = body({ speed: 20, vz: -20 })
  straight.snap(b2)
  run(straight, b2, 1.2)
  const f2 = b2.forward(), side2 = (straight.look.x - b2.x) * (-f2.z) + (straight.look.z - b2.z) * f2.x
  assert.ok(Math.abs(side2) < 0.05, `a straight line put the look ${side2} m off centre`)
})

test("a walking body is framed closer and lower than a driving one", () => {
  const walk = make(), w = body({ speed: 12, vz: -12, maxSpeed: 12 })
  walk.snap(w); run(walk, w, 2)
  const drive = make(), d = body({ speed: 40, vz: -40, maxSpeed: 44 })
  drive.snap(d); run(drive, d, 2)
  assert.ok(boom(walk, w) < boom(drive, d) - 1, `walking boom ${boom(walk, w).toFixed(2)} vs driving ${boom(drive, d).toFixed(2)}`)
  assert.ok(walk.pos.y < drive.pos.y - 0.3, `walking height ${walk.pos.y.toFixed(2)} vs driving ${drive.pos.y.toFixed(2)}`)
  assert.ok(walk.camera.fov < drive.camera.fov - 2, "the field of view must open up with real speed, not with a walk")
})

test("the camera is never under the ground, not even where the ground rises between it and the body", () => {
  const ridge = (x, z) => (z > 4 ? 30 : 0)                    // a wall right behind the car
  const cam = make(ridge), b = body()
  cam.snap(b)
  let worst = 0
  run(cam, b, 2, 1 / 60, () => { worst = Math.min(worst, cam.pos.y - (ridge(cam.pos.x, cam.pos.z) + T.camera.groundClearance)) })
  assert.ok(worst > -1e-6, `the camera sank ${(-worst).toFixed(3)} m into the hill`)
  // and the rise between the two is what lifted it, not only the ground under the lens
  const bump = (x, z) => (z > 2 && z < 5 ? 12 : 0)
  const c2 = make(bump), b2 = body()
  c2.snap(b2); run(c2, b2, 2)
  assert.equal(bump(c2.pos.x, c2.pos.z), 0, "the camera should have cleared the bump entirely")
  assert.ok(c2.pos.y > 10, `the camera stayed at ${c2.pos.y.toFixed(2)} m and looked through the bump`)
})

test("the camera is never squeezed into the body it follows", () => {
  const cam = make(), b = body()
  cam.snap(b)
  cam.pos.set(b.x + 0.05, b.y + 0.1, b.z + 0.05)
  cam.clear(b)
  const d = Math.hypot(cam.pos.x - b.x, cam.pos.y - (b.mesh.position.y + T.camera.lookHeight * 0.5), cam.pos.z - b.z)
  assert.ok(d > 3, `the camera ended up ${d.toFixed(2)} m from the body`)
})

test("a landing jolts the shot and rings back to nothing", () => {
  const cam = make(), b = body({ vy: 4 })
  cam.snap(b)
  run(cam, b, 0.5, 1 / 60, () => { b.vy = -20 })
  const level = cam.pos.y
  b.vy = null
  cam.update(b, 1 / 60)
  assert.ok(cam.shockY < -0.05 || cam.shockV < -0.5, "the touchdown was not felt at all")
  let dip = 0
  run(cam, b, 0.6, 1 / 60, () => { dip = Math.min(dip, cam.shockY) })
  assert.ok(dip < -0.15, `the shot dipped only ${dip.toFixed(3)} m`)
  run(cam, b, 2.5)
  assert.ok(Math.abs(cam.shockY) < 0.01, `the jolt never settled (${cam.shockY})`)
  assert.ok(Math.abs(cam.pos.y - level) < 0.05, "and the shot came back to where it was")

  // a transformation is felt too, and shock() is bounded however hard it is hit
  const c2 = make(), b2 = body()
  c2.snap(b2)
  b2.transforming = true
  c2.update(b2, 1 / 60)
  assert.ok(c2.shockV < -1, "the transformation was not felt")
  c2.shock(1e6)
  let worst = 0
  run(c2, b2, 1.5, 1 / 60, () => { worst = Math.min(worst, c2.shockY) })
  assert.ok(worst > -1.01, `an absurd shock moved the camera ${worst.toFixed(2)} m`)
})

test("a drift steadies the frame rather than swimming with the nose", () => {
  const grip = make(), a = body({ speed: 30, vz: -30 })
  grip.snap(a)
  const slide = make(), c = body({ speed: 30, vz: -30, drifting: true })
  slide.snap(c)
  // both bodies take the same sideways step: the sliding one's camera must follow it less far in the same time
  for (const b of [a, c]) { b.x = 12 }
  run(grip, a, 0.25); run(slide, c, 0.25)
  assert.ok(slide.pos.x < grip.pos.x, `drift ${slide.pos.x.toFixed(2)} vs grip ${grip.pos.x.toFixed(2)}`)
})
