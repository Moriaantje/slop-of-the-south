import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { Combat } from "game/Combat"
import { Dragons } from "game/Dragons"
import { makeFireball, makeGroundFire } from "game/Fireball"
import { ALPHA } from "game/Layers"

// The dragons' half of the projectile system: a shot the server has already resolved, flown on the client and burst
// on the point the server named. These tests are about the contract between the two — not the looks.

const effects = () => {
  const calls = { explosions: [], flashes: [], embers: 0, shakes: 0 }
  return {
    calls,
    explosion: (x, y, z, r) => calls.explosions.push({ x, y, z, r }),
    flash: (x, y, z, r) => calls.flashes.push({ x, y, z, r }),
    dust() {}, debris() {}, collapse() {},
    shake: () => calls.shakes++,
    fire: { emit: () => calls.embers++ },
    add() {},
  }
}
const index = { near() {}, hitPoint: () => null, groundOf: () => 0 }
const car = { x: 0, z: 0, vy: null, kick() {}, jump() {} }

function combat(fx = effects()) {
  const scene = new THREE.Scene()
  return { c: new Combat({ scene, index, effects: fx, heightAt: () => 0, car, send() {} }), scene, fx }
}

// z = -50 m/s, no other velocity, 100 m up, 14 m/s² down: two seconds of flight, 28 m of drop, 100 m downrange
const SHOT = { id: "d1s1", x: 0, y: 100, z: 0, vx: 0, vy: 0, vz: -50, g: 14, ttl: 2, ix: 0, iy: 72, iz: -100, r: 13, flavour: "castle" }

test("a dragon's fireball flies the server's parabola and bursts on the server's point", () => {
  const { c, scene, fx } = combat()
  c.dragonShot({ ...SHOT })
  assert.equal(c.shots.length, 1)
  const s = c.shots[0]
  assert.ok(s.server, "it is a recording, not a prediction")
  assert.equal(s.dmg, 0, "the client decides no damage for it")
  assert.ok(scene.children.includes(s.mesh))
  for (let i = 0; i < 19; i++) c.projectiles(0.1)
  // a fifth of a second from the end it is still in the air and close to where the maths says it should be
  assert.equal(c.shots.length, 1)
  const t = 1.9
  assert.ok(Math.abs(s.z - -50 * t) < 1, `downrange drift ${Math.abs(s.z + 50 * t).toFixed(2)} m`)
  assert.ok(Math.abs(s.y - (100 - 0.5 * 14 * t * t)) < 3, "and within a few metres of the true height")
  c.projectiles(0.1)
  assert.equal(c.shots.length, 0, "it is gone once its time is up")
  assert.equal(scene.children.includes(s.mesh), false, "and so is its mesh")
  const boom = fx.calls.explosions.at(-1)
  assert.deepEqual([boom.x, boom.y, boom.z], [SHOT.ix, SHOT.iy, SHOT.iz], "it bursts exactly where the server said")
  assert.ok(fx.calls.embers > 0, "and throws fire")
})

test("the same shot told twice is drawn once, and one that already burst is not drawn at all", () => {
  const { c } = combat()
  c.dragonShot({ ...SHOT })
  c.dragonShot({ ...SHOT })
  c.dragonShot({ ...SHOT })
  assert.equal(c.shots.length, 1, "the server republishes every tick; the id is what makes that free")
  c.dragonShot({ ...SHOT, id: "d1s2", ttl: -3 })
  assert.equal(c.shots.length, 1, "a shot whose flight is over adds nothing to the air")
})

test("a shot heard late joins its flight where it already is", () => {
  const { c } = combat()
  c.dragonShot({ ...SHOT, age: 1, ttl: 1 })
  const s = c.shots[0]
  assert.equal(s.z, -50, "a second of travel downrange")
  assert.ok(Math.abs(s.y - (100 - 0.5 * 14)) < 0.01, "and a second of falling")
  assert.ok(Math.abs(s.vy - -14) < 0.01, "carrying the speed it had picked up by then")
})

test("burning ground is keyed by id: repeats refresh it, they do not stack it", () => {
  const { c, scene } = combat()
  c.groundFire("f1", 10, 20, 8, 3, "castle")
  assert.equal(c.fires.size, 1)
  const domes = c.fires.get("f1").domes.map((d) => d.mesh)
  assert.ok(domes.every((m) => scene.children.includes(m)))
  c.groundFire("f1", 10, 20, 8, 3, "castle")
  c.groundFire("f1", 10, 20, 8, 5, "castle")
  assert.equal(c.fires.size, 1, "one patch, however often the server mentions it")
  assert.equal(c.fires.get("f1").life, 5, "and the longest life wins")
  for (let i = 0; i < 40; i++) c.projectiles(0.1)
  assert.equal(c.fires.size, 1, "still burning after four seconds of a five second fire")
  for (let i = 0; i < 20; i++) c.projectiles(0.1)
  assert.equal(c.fires.size, 0, "out")
  assert.ok(domes.every((m) => !scene.children.includes(m)), "and cleared out of the scene")
})

test("reset puts out every fire and forgets every shot", () => {
  const { c } = combat()
  c.dragonShot({ ...SHOT })
  c.groundFire("f1", 0, 0, 8, 9)
  c.reset()
  assert.equal(c.shots.length, 0)
  assert.equal(c.fires.size, 0)
  c.dragonShot({ ...SHOT })
  assert.equal(c.shots.length, 1, "a shot with a remembered id may fly again after a reset")
})

// ---- the routing on the way in --------------------------------------------------------------------------------

const assets = { instantiate: () => ({ root: new THREE.Group(), ready: false, play() {}, update() {}, dispose() {} }) }

function dragons(fx = effects()) {
  const { c } = combat(fx)
  const scene = new THREE.Scene()
  const sent = []
  const d = new Dragons({ scene, assets, effects: fx, session: { now: () => Date.now(), playerId: "me" },
                          send: (a, p) => sent.push([a, p]), heightAt: () => 0, combat: c })
  return { d, c, sent }
}

test("shots and burning ground in the actors list go to Combat, not into the list of dragons", () => {
  const { d, c } = dragons()
  const now = Date.now()
  d.receive([
    { id: "d1", kind: "dragon", name: "Vuurtong", state: "aim", x: 0, y: 80, z: 0, yaw: 0, pitch: 0, speed: 40, hp: 900, max: 900, flavour: "castle" },
    { id: "d1s1", kind: "shot", owner: "d1", flavour: "castle", x: 0, y: 80, z: -10, vx: 0, vy: 4, vz: -60, g: 14, t0: now, t1: now + 2500, ix: 0, iy: 0, iz: -150, r: 13 },
    { id: "d1s1f", kind: "fire", flavour: "castle", x: 0, z: -150, r: 9, until: now + 7000 },
  ], now)
  assert.deepEqual([...d.list.keys()], ["d1"], "only the dragon is a dragon")
  assert.equal(c.shots.length, 1, "the fireball went to the projectile system")
  assert.equal(c.fires.size, 1, "and the burning ground with it")
})

test("a shot leaves the mouth of the dragon we are drawing, a quarter second behind the server", () => {
  const { d, c } = dragons()
  const now = Date.now()
  // told about it the instant it was fired: we draw the dragon 250 ms in the past, so the shot has not left yet
  d.receive([{ id: "d1s9", kind: "shot", owner: "d1", flavour: "castle", x: 0, y: 80, z: 0, vx: 0, vy: 0, vz: -60, g: 14,
               t0: now, t1: now + 2000, ix: 0, iy: 0, iz: -120, r: 13 }], now)
  const s = c.shots[0]
  assert.equal(s.z, 0, "it is still at the lips")
  assert.ok(Math.abs(s.life - 2.25) < 0.05, "and has a quarter second longer to fly than the server thinks")
})

test("the health bar predicts what the server will allow, not what the spell claims", () => {
  const { d, sent } = dragons()
  const now = Date.now()
  d.receive([{ id: "d1", kind: "dragon", name: "Vuurtong", state: "hunt", x: 0, y: 80, z: 0, yaw: 0, pitch: 0, speed: 40, hp: 900, max: 900 }], now)
  const dragon = d.list.get("d1")
  dragon.alive = true
  d.struck({ id: "d1" }, "fireball")
  assert.equal(dragon.hp, 840, "capped at 60, whatever Tuning says the fireball hits for")
  assert.equal(sent.at(-1)[0], "strike")
  d.struck({ id: "d1" }, "lightning")
  assert.equal(dragon.hp, 810, "lightning hits for 30, under its own cap of 45, so the cap changes nothing there")
})

test("a staggering verdict jolts the dragon on every screen", () => {
  const { d } = dragons()
  const now = Date.now()
  d.receive([{ id: "d1", kind: "dragon", name: "Vuurtong", state: "breathe", x: 0, y: 80, z: 0, yaw: 0, pitch: 0, speed: 16, hp: 900, max: 900 }], now)
  d.strike({ dragon_id: "d1", hp: 700, by: "someone-else", kind: "fireball", staggered: true })
  const dragon = d.list.get("d1")
  assert.equal(dragon.state, "stagger")
  assert.equal(dragon.jolt, 1)
})

test("every loose flame claims the alpha layer, or the pre-pass hangs a dark square off it", () => {
  for (const mesh of [makeFireball(1.1), makeGroundFire(6, "ruins")]) {
    assert.equal(mesh.layers.mask, 1 << ALPHA)
    assert.equal(typeof mesh.onBeforeRender, "function", "its own seed and colour ride in on onBeforeRender")
  }
})
