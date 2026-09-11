import { test } from "node:test"
import assert from "node:assert/strict"
import { Mech } from "game/Mech"
import { TUNING as T } from "game/Tuning"

const flat = () => 0
const keys = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, jump: false, hover: false, shield: false, ...o })
const run = (mech, heightAt, input, seconds, dt = 1 / 60, each = null) => {
  for (let t = 0; t < seconds; t += dt) { mech.integrate(dt, typeof input === "function" ? input(t) : input); mech.settle(heightAt); each?.(t) }
}

test("walks up to the walking speed and turns in place", () => {
  const m = new Mech({ x: 0, z: 0, yaw: 0 }, { heightAt: flat })
  run(m, flat, keys({ throttle: 1 }), 3)
  assert.ok(Math.abs(m.speed - T.mech.walk) < 0.3, `speed ${m.speed}`)
  assert.ok(m.z < -20, "moved north")
  const m2 = new Mech({ x: 0, z: 0, yaw: 0 }, { heightAt: flat })
  run(m2, flat, keys({ steer: 1 }), 1)
  assert.ok(Math.abs(m2.yaw - T.mech.turnRate) < 0.05)
  assert.ok(Math.hypot(m2.x, m2.z) < 0.01, "stayed put")
})

test("a jump peaks near 8 m and lands; the landing flag fires once", () => {
  const m = new Mech({ x: 0, z: 0, yaw: 0 }, { heightAt: flat })
  let apex = 0, landings = 0
  run(m, flat, (t) => keys({ jump: t < 1 / 60 }), 3, 1 / 60, () => { apex = Math.max(apex, m.mesh.position.y); if (m.landed) { landings++; m.landed = false } })
  assert.ok(apex > 7.6 && apex < 8.6, `apex ${apex}`)
  assert.equal(landings, 1)
  assert.equal(m.vy, null)
})

test("hovering after the apex sinks slowly and burns mana", () => {
  const m = new Mech({ x: 0, z: 0, yaw: 0 }, { heightAt: flat })
  const mana0 = m.mana
  let hoverT = 0
  run(m, flat, (t) => keys({ jump: t < 1 / 60, hover: t > 0.1 }), 2.5, 1 / 60, () => { if (m.hovering) hoverT += 1 / 60 })
  assert.ok(hoverT > 0.5, `hovered ${hoverT}s`)
  assert.ok(m.vy !== null && m.vy >= -T.mech.hoverSink - 1e-6, `sinking at ${m.vy}`)
  assert.ok(m.mana < mana0 - 0.1, `mana ${m.mana}`)
})

test("the slope gate: 42° stops the mech, 17° does not", () => {
  const steep = (x, z) => -0.9 * z, gentle = (x, z) => -0.3 * z          // uphill towards north (-z)
  const a = new Mech({ x: 0, z: 0, yaw: 0 }, { heightAt: steep })
  run(a, steep, keys({ throttle: 1 }), 2)
  assert.ok(Math.abs(a.z) < 0.5 && a.blocked, `steep: z ${a.z}`)
  const b = new Mech({ x: 0, z: 0, yaw: 0 }, { heightAt: gentle })
  run(b, gentle, keys({ throttle: 1 }), 2)
  assert.ok(b.z < -10 && !b.blocked, `gentle: z ${b.z}`)
  assert.ok(Math.abs(b.y - gentle(b.x, b.z)) < 1, "rides the slope")
})

test("the shield slows the walk and drains mana; the curb is stepped smoothly", () => {
  const m = new Mech({ x: 0, z: 0, yaw: 0 }, { heightAt: flat })
  run(m, flat, keys({ throttle: 1, shield: true }), 3)
  assert.ok(m.shield)
  assert.ok(Math.abs(m.speed - T.mech.walk * T.mech.shieldSlow) < 0.3, `speed ${m.speed}`)
  assert.ok(m.mana < 0.5 - 0.3, `mana ${m.mana}`)
  const curb = (x, z) => (z < -5 ? 0.15 : 0)
  const c = new Mech({ x: 0, z: 0, yaw: 0 }, { heightAt: curb })
  let maxStep = 0, last = 0
  run(c, curb, keys({ throttle: 1 }), 1.5, 1 / 60, () => { maxStep = Math.max(maxStep, Math.abs(c.mesh.position.y - last)); last = c.mesh.position.y })
  assert.ok(maxStep < 0.06, `largest per-frame step ${maxStep}`)
  assert.ok(Math.abs(c.y - 0.15) < 0.01)
})

test("state() reports the mech for the network", () => {
  const m = new Mech({ x: 1, z: 2, yaw: 0.3 }, { heightAt: flat })
  run(m, flat, keys(), 0.1)
  const s = m.state()
  assert.equal(s.vehicle, "mech"); assert.equal(s.air, false); assert.equal(s.shield, false)
})
