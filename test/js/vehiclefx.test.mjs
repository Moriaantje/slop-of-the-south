import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { VehicleFx } from "game/VehicleFx"
import { makeCarMesh } from "game/Vehicles"
import { TransformFx } from "game/TransformFx"
import { TUNING as T } from "game/Tuning"

// a pool that records what it was asked to draw instead of drawing it
const recorder = () => { const puffs = []; return { puffs, emit(x, y, z, vx, vy, vz, life, s0, s1, a0) { puffs.push({ x, y, z, vx, vy, vz, life, s0, s1, a0 }) } } }
const fixedRandom = (v) => { const real = Math.random; Math.random = () => v; return () => { Math.random = real } }

test("smoke puffs are laid where the tyre was, not all at where it is now", () => {
  const mesh = makeCarMesh(), pool = recorder(), fx = new VehicleFx(mesh, pool)
  const restore = fixedRandom(0.5)                       // kills the jitter so only the back-tracking shows
  try {
    fx.update({ smoking: true, vx: 30, vz: 0, boostPower: 0 }, 0.2)
  } finally { restore() }
  const rear = mesh.userData.wheels.filter((w) => !w.front)
  assert.equal(rear.length, 2)
  assert.ok(pool.puffs.length >= 2 * 3, `only ${pool.puffs.length} puffs in a long frame`)
  const left = pool.puffs.filter((_, i) => i % 2 === 0).map((p) => p.x)
  for (let i = 1; i < left.length; i++) assert.ok(left[i] > left[i - 1], `puff ${i} was not laid behind puff ${i - 1}`)
  assert.ok(left[left.length - 1] - left[0] > 0.5, `the trail spans only ${left[left.length - 1] - left[0]} m`)
  for (const p of pool.puffs) {
    assert.ok(p.s1 > p.s0, "a puff must expand as it dies")
    assert.ok(Math.abs(p.vx) < 30, "a puff must not ride along at the full speed of the car")
    assert.ok(p.vy > 0, "smoke rises")
    assert.ok(p.y < T.susp.wheelRadius, "smoke comes off the contact patch, not the hub")
  }
})

test("a frame with a huge stall does not empty the pool in one go", () => {
  const mesh = makeCarMesh(), pool = recorder(), fx = new VehicleFx(mesh, pool)
  fx.update({ smoking: true, vx: 20, vz: 0 }, 5)
  assert.ok(pool.puffs.length <= 2 * 6, `${pool.puffs.length} puffs from one stalled frame`)
  assert.equal(fx.acc, 0, "the backlog must be dropped, not carried")
})

test("not sliding means no smoke at all", () => {
  const mesh = makeCarMesh(), pool = recorder(), fx = new VehicleFx(mesh, pool)
  for (let i = 0; i < 60; i++) fx.update({ smoking: false, vx: 30, vz: 0 }, 1 / 60)
  assert.equal(pool.puffs.length, 0)
})

test("the exhaust flames light with the boost, flicker, and light a hot core only near full power", () => {
  const mesh = makeCarMesh(), fx = new VehicleFx(mesh, null)
  assert.equal(fx.flames.length, 2)
  fx.update({ smoking: false, boostPower: 0 }, 1 / 60)
  assert.ok(fx.flames.every((f) => !f.sprite.visible), "flames burn with no boost")

  for (let i = 0; i < 120; i++) fx.update({ smoking: false, boostPower: 1 }, 1 / 60)
  assert.ok(fx.power > 0.95, `boost power only reached ${fx.power}`)
  const sizes = []
  for (let i = 0; i < 40; i++) { fx.update({ smoking: false, boostPower: 1 }, 1 / 60); sizes.push(fx.flames[0].sprite.scale.y) }
  assert.ok(fx.flames.every((f) => f.sprite.visible && f.core.visible), "a flame at full boost has a hot core")
  assert.ok(Math.max(...sizes) - Math.min(...sizes) > 0.1, `the flame did not flicker (${Math.min(...sizes)}..${Math.max(...sizes)})`)
  assert.ok(Math.min(...sizes) > 0, "a flame must never invert")
  assert.notEqual(fx.flames[0].phase, fx.flames[1].phase, "twin pipes must not pulse in unison")

  for (let i = 0; i < 240; i++) fx.update({ smoking: false, boostPower: 0 }, 1 / 60)
  assert.ok(fx.flames.every((f) => !f.sprite.visible && !f.core.visible))
})

test("the transformation burst builds once, plays out and goes quiet", () => {
  const scene = new THREE.Scene(), fx = new TransformFx(scene)
  fx.update(1 / 60)                                        // nothing built yet: must be a no-op
  assert.equal(scene.children.length, 0)
  fx.charge(0, 0, 0, 0.5, 0x7fd2ff)
  const built = scene.children.length
  assert.ok(built > 4, `only ${built} objects in the kit`)
  assert.ok(fx.chargeSprite.visible)
  fx.burst(0, 0, 0, 0x7fd2ff)
  assert.ok(!fx.chargeSprite.visible, "the gathering glow is consumed by the flash")
  fx.update(1 / 60)
  assert.ok(fx.ring.visible && fx.column.visible && fx.flash.visible)
  assert.ok(fx.sparks.some((s) => s.sprite.visible))
  for (let i = 0; i < 120; i++) fx.update(1 / 60)
  assert.ok(!fx.ring.visible && !fx.column.visible && !fx.flash.visible)
  assert.ok(fx.sparks.every((s) => !s.sprite.visible))
  assert.equal(scene.children.length, built, "the burst must reuse its objects, not allocate per transformation")
  fx.dispose()
  assert.equal(scene.children.length, 0)
})
