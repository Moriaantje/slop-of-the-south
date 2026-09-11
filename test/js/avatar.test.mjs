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
