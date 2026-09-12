import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { Avatar } from "game/Avatar"
import { vehicleSpec } from "game/Vehicles"
import { TUNING as T } from "game/Tuning"

const flat = () => 0
const keys = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, jump: false, hover: false, shield: false, transform: false, clearPressed() {}, ...o })

test("T folds the car into the mech at the swap time and unfolds it by the end", () => {
  const scene = new THREE.Scene(), modes = []
  const p = new Avatar({ spawn: { x: 0, z: 0, yaw: 0 }, spec: vehicleSpec("trike"), scene, heightAt: flat, onMode: (m) => modes.push(m) })
  assert.equal(p.mode, "car"); assert.ok(scene.children.includes(p.car.mesh))
  const dt = 1 / 60
  p.integrate(dt, keys({ transform: true })); p.settle(flat)
  assert.ok(p.transforming)
  let t = dt
  while (t < T.transform.swapAt - dt) { p.integrate(dt, keys()); p.settle(flat); t += dt }
  assert.equal(p.mode, "car")
  while (t < T.transform.swapAt + 2 * dt) { p.integrate(dt, keys()); p.settle(flat); t += dt }
  assert.equal(p.mode, "mech"); assert.deepEqual(modes, ["mech"])
  assert.ok(scene.children.includes(p.mech.mesh) && !scene.children.includes(p.car.mesh))
  while (t < T.transform.time + 2 * dt) { p.integrate(dt, keys()); p.settle(flat); t += dt }
  assert.ok(!p.transforming)
  assert.deepEqual([p.mesh.scale.x, p.mesh.scale.y, p.mesh.scale.z], [1, 1, 1])
  assert.equal(p.state().vehicle, "mech")
  // the cooldown blocks an immediate transform back
  p.integrate(dt, keys({ transform: true })); p.settle(flat)
  assert.ok(!p.transforming)
})

test("the transformation folds instead of spinning, and leaves both bodies exactly as it found them", () => {
  const scene = new THREE.Scene()
  const p = new Avatar({ spawn: { x: 0, z: 0, yaw: 0 }, spec: vehicleSpec("trike"), scene, heightAt: flat })
  const car = p.car.mesh, carBody = car.children[0]
  const dt = 1 / 60
  p.integrate(dt, keys({ transform: true })); p.settle(flat)
  let folded = 0, spin = 0
  let t = dt
  while (t < T.transform.swapAt - dt) {
    p.integrate(dt, keys()); p.settle(flat)
    folded = Math.max(folded, 1 - carBody.scale.z)
    spin = Math.max(spin, Math.abs(car.rotation.y - p.car.yaw))
    t += dt
  }
  assert.ok(folded > 0.4, `the car barely folded (${folded})`)
  assert.ok(spin < 0.3, `the car spun ${spin} rad: the transformation is a fold, not a pirouette`)
  // the mech unfolds with an overshoot: its body must pass its resting pose and come back
  let over = 0
  while (t < T.transform.time + 2 * dt) {
    p.integrate(dt, keys()); p.settle(flat)
    if (p.morph) over = Math.min(over, 1 - p.mech.body.scale.y)
    t += dt
  }
  assert.ok(over < -0.005, `the mech arrived without a settle (${over})`)
  assert.ok(!p.transforming)
  assert.deepEqual([carBody.scale.x, carBody.scale.y, carBody.scale.z], [1, 1, 1], "the car was left folded")
  assert.deepEqual([p.mech.body.scale.x, p.mech.body.scale.y, p.mech.body.scale.z], [1, 1, 1])
  for (const w of car.userData.wheels) {
    assert.ok(Math.abs(w.pivot.position.x - w.lx) < 1e-9 && Math.abs(w.pivot.position.z - w.lz) < 1e-9)
    assert.equal(Math.abs(w.pivot.rotation.z), 0)
  }
})
