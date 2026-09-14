import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { Avatar } from "game/Avatar"
import { VEHICLES, vehicleSpec } from "game/Vehicles"
import { TUNING as T } from "game/Tuning"

// The transformation used to be a swap behind a flash, and this file used to check that the swap happened cleanly:
// that the car left the scene, the mech joined it, and both were left unfolded afterwards. There is no swap any more
// — one mesh has a driving pose and a walking pose and the beat is every part travelling between them — so what is
// worth asserting has changed with it. The timing contract is unchanged and still checked. What replaces the
// fold-and-swap assertions is continuity: the same mesh throughout, nothing joining or leaving the scene or the
// machine while it transforms, and every part moving in small steps from one pose to the other and arriving exactly.

const flat = () => 0
const keys = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, jump: false, hover: false, shield: false, transform: false, clearPressed() {}, ...o })
const make = (scene, id = "trike", onMode = null) => new Avatar({ spawn: { x: 0, z: 0, yaw: 0 }, spec: vehicleSpec(id), scene, heightAt: flat, onMode })
const step = (p, dt = 1 / 60, input = keys()) => { p.integrate(dt, input); p.settle(flat) }
const centreOf = (o) => { o.updateWorldMatrix(true, true); const b = new THREE.Box3().setFromObject(o); return b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3()) }
const census = (root) => { const out = []; root.traverse((o) => out.push(o)); return out }

test("T hands control over at the swap time and the beat is finished by the end", () => {
  const scene = new THREE.Scene(), modes = []
  const p = make(scene, "trike", (m) => modes.push(m))
  assert.equal(p.mode, "car"); assert.ok(scene.children.includes(p.car.mesh))
  const dt = 1 / 60
  step(p, dt, keys({ transform: true }))
  assert.ok(p.transforming)
  let t = dt
  while (t < T.transform.swapAt - dt) { step(p, dt); t += dt }
  assert.equal(p.mode, "car")
  while (t < T.transform.swapAt + 2 * dt) { step(p, dt); t += dt }
  assert.equal(p.mode, "mech"); assert.deepEqual(modes, ["mech"])
  while (t < T.transform.time + 2 * dt) { step(p, dt); t += dt }
  assert.ok(!p.transforming)
  assert.equal(p.mesh.userData.morph.u, 1, "the machine must arrive exactly in its walking pose")
  assert.equal(p.state().vehicle, "mech")
  // the cooldown blocks an immediate transform back
  step(p, dt, keys({ transform: true }))
  assert.ok(!p.transforming)
})

test("the machine is never swapped: one mesh, nothing added to or taken out of the scene mid-transformation", () => {
  const scene = new THREE.Scene()
  const p = make(scene)
  assert.equal(p.car.mesh, p.mech.mesh, "the car and the mech must be the same machine")
  const mesh = p.mesh
  const dt = 1 / 60
  const sceneBefore = [...scene.children], partsBefore = census(mesh)
  step(p, dt, keys({ transform: true }))
  for (let t = dt; t < T.transform.time + 2 * dt; t += dt) {
    assert.deepEqual([...scene.children], sceneBefore, "something joined or left the scene during the morph")
    assert.deepEqual(census(mesh), partsBefore, "a part was added to or removed from the machine during the morph")
    assert.equal(p.mesh, mesh, "the avatar changed mesh mid-morph")
    step(p, dt)
  }
  assert.equal(p.mode, "mech")
  assert.deepEqual(census(p.mesh), partsBefore)
})

test("every part crosses between the two poses continuously, and travels a real distance doing it", () => {
  const scene = new THREE.Scene()
  const p = make(scene, "auto")
  const mesh = p.mesh, rig = mesh.userData.mech.rig
  const tracked = [...mesh.userData.wheels.map((w) => w.mesh), rig.mounts.head, rig.mounts.hips, ...mesh.children[0].children.slice(0, 6)]
  const dt = 1 / 120                                     // a fine step: a jump has to show up as a jump, not as a frame
  let last = tracked.map(centreOf)
  const start = tracked.map(centreOf)
  let biggestStep = 0
  step(p, dt, keys({ transform: true }))
  for (let t = dt; t < T.transform.time + 2 * dt; t += dt) {
    step(p, dt)
    const now = tracked.map(centreOf)
    for (let i = 0; i < now.length; i++) biggestStep = Math.max(biggestStep, now[i].distanceTo(last[i]))
    last = now
  }
  // A substitution puts a part's whole travel — one to three metres — into a single frame. The largest step here is
  // a tenth of that, and the largest ones belong to the limbs growing out of the chassis, where a growing part's
  // bounding-box centre moves faster than any of its geometry does.
  assert.ok(biggestStep < 0.22, `a part jumped ${biggestStep.toFixed(3)} m in one 120 Hz frame: that is a swap, not a morph`)
  const travelled = last.map((v, i) => v.distanceTo(start[i]))
  assert.ok(Math.min(...travelled) > 0.5, `a tracked part barely moved (${Math.min(...travelled).toFixed(2)} m)`)
  assert.ok(Math.max(...travelled) > 1.5, `nothing travelled far: the morph is not doing any work (${Math.max(...travelled).toFixed(2)} m)`)
})

test("the machine stays under the player: it does not teleport and it does not spin", () => {
  const scene = new THREE.Scene()
  const p = make(scene, "monster")
  const dt = 1 / 60
  for (let t = 0; t < 1.5; t += dt) step(p, dt, keys({ throttle: 1 }))
  const x = p.x, z = p.z, yaw = p.yaw
  step(p, dt, keys({ transform: true }))
  let drift = 0, spin = 0
  for (let t = dt; t < T.transform.time + 2 * dt; t += dt) {
    step(p, dt)
    drift = Math.max(drift, Math.hypot(p.mesh.position.x - x, p.mesh.position.z - z))
    spin = Math.max(spin, Math.abs(p.mesh.rotation.y - yaw))
  }
  assert.ok(drift < 0.5, `the machine slid ${drift.toFixed(2)} m while transforming`)
  assert.ok(spin < 0.05, `the machine turned ${spin.toFixed(2)} rad while transforming: it is a fold, not a pirouette`)
})

test("morphing back leaves the driving pose exactly as it was found, for every vehicle in the roster", () => {
  for (const id of ["auto", ...VEHICLES.map((v) => v.id)]) {
    const scene = new THREE.Scene()
    const p = make(scene, id)
    const mesh = p.mesh, dt = 1 / 60
    step(p, dt, keys({ transform: true }))
    for (let t = dt; t < T.transform.time + 2 * dt; t += dt) step(p, dt)
    assert.equal(p.mode, "mech", `${id}: never reached the mech`)
    p.cooldown = 0
    step(p, dt, keys({ transform: true }))
    for (let t = dt; t < T.transform.time + 2 * dt; t += dt) step(p, dt)
    assert.equal(p.mode, "car", `${id}: never came back`)
    assert.equal(mesh.userData.morph.u, 0, `${id}: did not arrive exactly in the driving pose`)
    for (const part of mesh.userData.morph.parts) {
      assert.ok(part.node.position.distanceTo(part.drive.position) < 1e-9 && part.node.scale.distanceTo(part.drive.scale) < 1e-9 &&
        Math.abs(part.node.quaternion.dot(part.drive.quaternion)) > 1 - 1e-9, `${id}: a part came back to the wrong place`)
      if (part.hidden) assert.equal(part.node.visible, false, `${id}: a walking-only part is still on show while driving`)
    }
    for (const w of mesh.userData.wheels) {
      assert.ok(Math.abs(w.pivot.position.x - w.lx) < 1e-9 && Math.abs(w.pivot.position.z - w.lz) < 1e-9, `${id}: a wheel did not come home`)
      assert.ok(Math.abs(w.pivot.position.y - w.r) < 1e-6, `${id}: the morph left the suspension channel dirty`)
    }
  }
})

test("the picker can change the car underneath, in either body", () => {
  const scene = new THREE.Scene()
  const p = make(scene, "trike")
  const old = p.mesh
  p.setSpec(vehicleSpec("tank"))
  assert.ok(!scene.children.includes(old) && scene.children.includes(p.mesh))
  assert.equal(p.car.mesh, p.mech.mesh, "the mech must follow the car into the new body")
  assert.equal(p.mesh.userData.morph.u, 0)
  p.setMode("mech")
  assert.equal(p.mode, "mech")
  assert.equal(p.mesh.userData.morph.u, 1, "setMode must put the machine straight into the pose it claims")
  p.setSpec(vehicleSpec("brommer"))
  assert.equal(p.mesh.userData.morph.u, 1, "the new body must arrive already standing, since the player is walking")
  assert.equal(p.mech.mesh, p.mesh)
})
