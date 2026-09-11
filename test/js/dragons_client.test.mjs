import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { Dragons } from "game/Dragons"

// a fake asset loader: instances never become ready, so no clips are needed
const assets = { instantiate: () => ({ root: new THREE.Group(), ready: false, play() {}, update() {}, dispose() {} }) }
const session = { now: () => Date.now(), playerId: "me" }

test("a dragon flying straight at 4 Hz is drawn within a few metres of its true path", () => {
  const scene = new THREE.Scene()
  const d = new Dragons({ scene, assets, effects: { fire: { emit() {} }, flash() {} }, session, send() {}, heightAt: () => 0 })
  const local = { x: 0, y: 0, z: 0, yaw: 0 }
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 50, 200)
  const speed = 30, yaw = 0.4                    // m/s, heading
  const truth = (t) => ({ x: -Math.sin(yaw) * speed * t, z: -Math.cos(yaw) * speed * t })
  const t0 = performance.now()
  let maxErr = 0, frames = 0
  // feed a sample every 250 ms, render every 10 ms a quarter second behind
  const start = t0
  const realNow = performance.now
  for (let ms = 0; ms <= 3000; ms += 10) {
    const now = start + ms
    performance.now = () => now                  // the game's clock, for the samples and the renderer alike
    if (ms % 250 === 0) {
      const p = truth(ms / 1000)
      d.receive([{ id: "d1", kind: "dragon", name: "Test", lair: "o:w3", state: "hunt", x: p.x, y: 60, z: p.z, yaw, pitch: 0, speed, hp: 600, max: 600 }], Date.now())
    }
    d.update(local, camera, 0.01, 0)
    performance.now = realNow
    if (ms > 600) {                              // once the buffer holds a few samples
      const drawn = d.list.get("d1"), want = truth((ms - 250) / 1000)
      maxErr = Math.max(maxErr, Math.hypot(drawn.x - want.x, drawn.z - want.z)); frames++
    }
  }
  assert.ok(frames > 100)
  assert.ok(maxErr < 3, `max interpolation error ${maxErr.toFixed(2)} m`)
})

test("nearest() picks the dragon inside the aim cone and ignores the dead", () => {
  const scene = new THREE.Scene()
  const d = new Dragons({ scene, assets, effects: { fire: { emit() {} }, flash() {} }, session, send() {}, heightAt: () => 0 })
  const now = Date.now()
  d.receive([
    { id: "a", kind: "dragon", name: "A", state: "hunt", x: 0, y: 40, z: -100, yaw: 0, pitch: 0, speed: 0, hp: 600, max: 600 },   // straight ahead (north)
    { id: "b", kind: "dragon", name: "B", state: "hunt", x: 100, y: 40, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 600, max: 600 },    // to the east
    { id: "c", kind: "dragon", name: "C", state: "dead", x: 0, y: 40, z: -50, yaw: 0, pitch: 0, speed: 0, hp: 0, max: 600 },
  ], now)
  for (const x of d.list.values()) { x.x = x.buf[0].x; x.z = x.buf[0].z; x.alive = x.state !== "dead" }
  assert.equal(d.nearest(0, 0, 0).id, "a")
  assert.equal(d.nearest(0, 0, -Math.PI / 2).id, "b")     // facing east (positive yaw turns left … -π/2 is east)
  assert.equal(d.nearest(0, 0, Math.PI), null)
})
