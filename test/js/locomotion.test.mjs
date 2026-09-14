import { test } from "node:test"
import assert from "node:assert/strict"
import { Locomotion } from "game/Locomotion"
import { TUNING as T } from "game/Tuning"

// A headless walking harness. Locomotion never touches a scene graph, so a plain object with the fields a body owns
// is the whole fixture: everything below asserts numbers a player would feel — time to speed, stopping distance,
// jump apex, the cost of a kerb, how long a skid lasts — rather than that a method was called.
const flat = () => 0
const body = (x = 0, z = 0, yaw = 0) => ({ x, y: 0, z, yaw, speed: 0, vx: 0, vz: 0, vy: null, airY: 0, landed: false })
const cmd = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, jump: false, hover: false, ...o })
function run(loco, b, heightAt, c, seconds, dt = 1 / 60, each = null) {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    loco.integrate(dt, b, typeof c === "function" ? c(t) : c)
    const draw = loco.settle(dt, b, heightAt)
    each?.(t, draw)
  }
}
const walking = (heightAt = flat, opts = {}) => {
  const l = new Locomotion({ heightAt, ...opts }), b = body()
  run(l, b, heightAt, cmd({ throttle: 1 }), 3)
  return [l, b]
}

test("acceleration has onset and fall-off rather than a step", () => {
  const l = new Locomotion({ heightAt: flat }), b = body()
  const accels = []
  let last = 0
  run(l, b, flat, cmd({ throttle: 1 }), 2, 1 / 60, () => { accels.push((b.speed - last) * 60); last = b.speed })
  assert.ok(accels[0] < 1, `the first frame already pulls ${accels[0].toFixed(1)} m/s²`)
  const peak = Math.max(...accels), peakAt = accels.indexOf(peak) / 60
  assert.ok(peakAt > 0.08, `acceleration peaks after only ${peakAt.toFixed(3)} s`)
  assert.ok(accels[accels.length - 1] < peak * 0.2, "acceleration must fall away as the top speed is reached")
  assert.ok(Math.abs(b.speed - T.mech.walk) < 0.2, `top speed ${b.speed}`)
})

test("lifting off coasts; the brake plants a foot and stops in a few metres", () => {
  const [l, b] = walking()
  const z0 = b.z
  let coastT = null
  run(l, b, flat, cmd(), 3, 1 / 60, (t) => { if (coastT === null && b.speed < 0.1) coastT = t })
  assert.ok(coastT > 0.7 && coastT < 2.5, `coasted to rest in ${coastT} s`)
  assert.ok(z0 - b.z > 4, `coasted only ${(z0 - b.z).toFixed(1)} m`)

  const [l2, b2] = walking()
  const z1 = b2.z
  let stopT = null, dist = null, plant = 0
  run(l2, b2, flat, cmd({ brake: 1 }), 2, 1 / 60, (t) => {
    plant = Math.max(plant, l2.planted)
    if (dist === null && b2.speed <= 0) { dist = z1 - b2.z; stopT = t }
  })
  assert.ok(dist > 2 && dist < 8, `stopping distance ${dist.toFixed(2)} m`)
  assert.ok(stopT < 1.2, `took ${stopT} s to stop`)
  assert.ok(plant > 0.8, `the plant never showed (${plant.toFixed(2)})`)
  assert.ok(b2.speed < -1, "holding the brake past the stop walks backwards")
})

test("a standing pivot is crisp, a running turn is wider and skids before the velocity follows", () => {
  const l = new Locomotion({ heightAt: flat }), b = body()
  run(l, b, flat, cmd({ steer: 1 }), 1)
  assert.ok(Math.abs(b.yaw - T.mech.turnRate) < 0.05, `standing pivot reached ${b.yaw} rad in a second`)
  assert.ok(Math.hypot(b.x, b.z) < 0.01, "a pivot does not travel")

  const [l2, b2] = walking()
  const yaw0 = b2.yaw
  let maxLat = 0, maxBank = 0
  run(l2, b2, flat, cmd({ throttle: 1, steer: 1 }), 1, 1 / 60, () => { maxLat = Math.max(maxLat, Math.abs(l2.lateral)); maxBank = Math.max(maxBank, l2.bank) })
  assert.ok(b2.yaw - yaw0 < T.mech.turnRate * 0.8, "a run must turn in a wider arc than a standing pivot")
  assert.ok(maxLat > 1, `no sideways carry in a turn at speed (${maxLat.toFixed(2)} m/s)`)
  assert.ok(maxBank > 0.05, `the body did not bank into the turn (${maxBank.toFixed(3)} rad)`)

  // and the skid dies away in a fraction of a second once the steering stops
  let killed = null
  run(l2, b2, flat, cmd({ throttle: 1 }), 1, 1 / 60, (t) => { if (killed === null && Math.abs(l2.lateral) < 0.05) killed = t })
  assert.ok(killed !== null && killed < 0.75, `the skid took ${killed} s to scrub off`)
})

test("the body banks across a slope and pitches along it, and leans into its own acceleration", () => {
  const hill = (x) => 0.25 * x                                  // rises towards +x, so walking north it is a side slope
  const l = new Locomotion({ heightAt: hill }), b = body()
  run(l, b, hill, cmd({ throttle: 1 }), 2)
  assert.ok(l.bank > 0.1, `no roll across the slope (${l.bank.toFixed(3)} rad)`)   // ground rises to the right
  const up = (x, z) => -0.3 * z
  const l2 = new Locomotion({ heightAt: up }), b2 = body()
  run(l2, b2, up, cmd({ throttle: 1 }), 2)
  assert.ok(l2.lean > 0.15, `the body did not pitch up the hill (${l2.lean.toFixed(3)})`)

  // on the flat, accelerating leans the body forward (negative pitch) and braking leans it back
  const l3 = new Locomotion({ heightAt: flat }), b3 = body()
  let minLean = 0
  run(l3, b3, flat, cmd({ throttle: 1 }), 1.5, 1 / 60, () => { minLean = Math.min(minLean, l3.lean) })
  assert.ok(minLean < -0.03, `no forward lean under power (${minLean.toFixed(3)})`)
  let maxLean = -1
  run(l3, b3, flat, cmd({ brake: 1 }), 0.8, 1 / 60, () => { maxLean = Math.max(maxLean, l3.lean) })
  assert.ok(maxLean > 0.03, `no backward lean under the brake (${maxLean.toFixed(3)})`)
})

test("the feet stand on what is under them, and a kerb is told from a hill and costs a beat", () => {
  const kerb = (x, z) => (z < -5 ? 0.15 : 0)
  const l = new Locomotion({ heightAt: kerb }), b = body()
  let maxStep = 0, last = 0, stepped = 0
  run(l, b, kerb, cmd({ throttle: 1 }), 1.5, 1 / 60, (_, draw) => { maxStep = Math.max(maxStep, Math.abs(draw - last)); last = draw; if (l.stepping) stepped += 1 / 60 })
  assert.ok(maxStep < 0.06, `the body jumped ${maxStep.toFixed(3)} m in one frame`)
  assert.ok(Math.abs(b.y - 0.15) < 0.01, `ended at ${b.y}`)
  assert.ok(stepped > 0.15, `the kerb cost no time at all (${stepped.toFixed(2)} s)`)
  const flatRun = new Locomotion({ heightAt: flat }), fb = body()
  run(flatRun, fb, flat, cmd({ throttle: 1 }), 1.5)
  assert.ok(fb.z - b.z < -0.4, `the kerb cost no ground (${(b.z - fb.z).toFixed(2)} m)`)

  // a hill of the same gradient is not a step: it must never trip the kerb cost
  const slope = (x, z) => -0.3 * z
  const l3 = new Locomotion({ heightAt: slope }), b3 = body()
  let hillSteps = 0
  run(l3, b3, slope, cmd({ throttle: 1 }), 2, 1 / 60, () => { if (l3.stepping) hillSteps++ })
  assert.equal(hillSteps, 0, "a slope was mistaken for a kerb")

  // the feet: each lands on its own ground, on either side of a ridge
  const ridge = (x) => (x > 0 ? 1 : 0)
  const l4 = new Locomotion({ heightAt: ridge }), b4 = body()
  run(l4, b4, ridge, cmd(), 0.5)
  const [left, right] = l4.feet
  assert.ok(left.x < 0 && right.x > 0, "the feet are not either side of the body")
  assert.ok(Math.abs(right.y - 1) < 1e-9 && Math.abs(left.y) < 1e-9, `feet at ${left.y} and ${right.y} over a ridge`)
})

test("a jump crouches first, hangs at the apex and absorbs the landing with a real recovery", () => {
  const l = new Locomotion({ heightAt: flat }), b = body()
  let apex = 0, leftAt = null, landings = 0, landAt = 0, maxCompress = 0, minCompress = 0, slowest = 1
  run(l, b, flat, (t) => cmd({ jump: t < 1 / 60 }), 3, 1 / 60, (t, draw) => {
    if (leftAt === null && b.vy !== null) leftAt = t
    if (b.vy === null && leftAt !== null) { maxCompress = Math.max(maxCompress, l.compress); slowest = Math.min(slowest, l.penalty()) }
    if (leftAt === null) minCompress = Math.max(minCompress, l.compress)
    apex = Math.max(apex, draw)
    if (b.landed) { landings++; b.landed = false; landAt = t }
  })
  assert.ok(leftAt > 0.05, `the body left the ground after only ${leftAt} s — there is no windup`)
  assert.ok(minCompress > 0.4, `the legs never bent for the jump (${minCompress.toFixed(2)})`)
  assert.ok(apex > 7.6 && apex < 8.6, `apex ${apex}`)
  assert.equal(landings, 1)
  assert.ok(maxCompress > 0.15, `the landing was not absorbed (${maxCompress.toFixed(2)})`)
  assert.ok(l.landImpact > 15, `landed at ${l.landImpact} m/s`)
  // the fall is quicker than the rise: the apex hangs, the descent commits
  const rise = 1.0 - leftAt, fall = landAt - 1.0
  assert.ok(fall < rise, `rise ${rise.toFixed(2)} s, fall ${fall.toFixed(2)} s`)
  assert.ok(slowest < 0.6, `the walk was barely slowed on landing (${slowest.toFixed(2)})`)
  assert.equal(l.penalty(), 1, "the slow must have worn off half a second later")
})

test("a jump pressed just before landing still fires, and one just after an edge still fires", () => {
  // buffer: the press lands while still in the air, and is spent the moment the feet touch
  const l = new Locomotion({ heightAt: flat }), b = body()
  let landings = 0
  run(l, b, flat, (t) => cmd({ jump: t < 1 / 60 || (b.vy !== null && b.vy < 0 && b.airY < 1.5) }), 4, 1 / 60, () => { if (b.landed) { landings++; b.landed = false } })
  assert.equal(landings, 2, "the buffered jump did not fire on landing")

  // coyote: the ground drops away, and a jump within the grace still gets its full arc
  const ledge = (x, z) => (z < -3 ? -6 : 0)
  const l2 = new Locomotion({ heightAt: ledge }), b2 = body()
  let fired = false, apex = 0
  run(l2, b2, ledge, () => { const c = cmd({ throttle: 1 }); if (b2.vy !== null && !fired) { fired = true; c.jump = true } return c }, 2.5, 1 / 60, (_, draw) => { apex = Math.max(apex, draw) })
  assert.ok(fired && apex > 7, `the coyote jump only reached ${apex.toFixed(2)} m`)

  // …but a jump well after the edge is gone is not a free double jump
  const l3 = new Locomotion({ heightAt: ledge }), b3 = body()
  let air = null, late = false, apex3 = 0
  run(l3, b3, ledge, (t) => { const c = cmd({ throttle: 1 }); if (b3.vy !== null && air === null) air = t
    if (air !== null && !late && t - air > 0.3) { late = true; c.jump = true } return c }, 2.5, 1 / 60, (_, draw) => { apex3 = Math.max(apex3, draw) })
  assert.ok(late && apex3 < 1, `a late jump lifted the body to ${apex3.toFixed(2)} m`)
})

test("the slope gate stops the mech dead and hovering holds the sink", () => {
  const steep = (x, z) => -0.9 * z
  const l = new Locomotion({ heightAt: steep }), b = body()
  run(l, b, steep, cmd({ throttle: 1 }), 2)
  assert.ok(l.blocked && Math.abs(b.z) < 0.5, `climbed ${b.z} m up a 42° wall`)
  assert.equal(b.speed, 0)

  const l2 = new Locomotion({ heightAt: flat }), b2 = body()
  let hovered = 0
  run(l2, b2, flat, (t) => cmd({ jump: t < 1 / 60, hover: t > 0.2 }), 2.5, 1 / 60, () => { if (l2.hovering) hovered += 1 / 60 })
  assert.ok(hovered > 0.5, `hovered ${hovered.toFixed(2)} s`)
  assert.ok(b2.vy !== null && b2.vy >= -T.mech.hoverSink - 1e-6, `sinking at ${b2.vy}`)
})

test("reset puts every channel back, and an outside shove is not fought", () => {
  const l = new Locomotion({ heightAt: flat }), b = body()
  run(l, b, flat, cmd({ throttle: 1, steer: 1 }), 1.5)
  assert.ok(Math.abs(l.lateral) > 0.1 && Math.abs(l.yawRate) > 0.1)
  l.reset()
  assert.equal(l.lateral, 0); assert.equal(l.yawRate, 0); assert.equal(l.force, 0)
  assert.equal(l.compress, 0); assert.equal(l.lean, 0); assert.equal(l.bank, 0)
  assert.equal(l.groundY, null); assert.equal(l.seeded, false)

  // Combat reaches in and halves the speed: the sideways carry goes with it rather than swinging the body round
  const [l2, b2] = walking()
  run(l2, b2, flat, cmd({ throttle: 1, steer: 1 }), 0.6)
  const lat = Math.abs(l2.lateral)
  b2.speed *= 0.5
  l2.integrate(1 / 60, b2, cmd({ throttle: 1 }))
  assert.ok(Math.abs(l2.lateral) < lat * 0.5, `the slide survived the shove (${l2.lateral} vs ${lat})`)
})
