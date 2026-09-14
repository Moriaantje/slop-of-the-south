import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { ChunkManager, sliceParts } from "game/ChunkManager"

// The load hitch: a tile used to be built entirely inside one frame, which measured 8 ms for the median tile in the
// province and 120 ms for the worst of them. These cover the step machine that spreads it instead — that it makes
// progress, that it finishes, that it does not hand a half-built tile to anything, and that it lets go of a tile
// the player has already driven away from.

const CFG = { height_n: 3, height_step: 250, tile_size: 500, origin: { x: 0, y: 0 } }
const TILE = { origin: [0, 0], heights: [0, 1, 2, 0, 1, 2, 0, 1, 2], roads: [], junctions: [], buildings: [], meshes: [], trees: null }

// a manager with one fetched tile waiting in the queue, and a clock the test moves by hand
function pending(hooks = {}) {
  const scene = new THREE.Scene()
  const m = new ChunkManager(scene, CFG, hooks)
  m.tiles.set("0_0", { loading: true })
  m.queue.push({ tx: 0, ty: 0, key: "0_0", data: structuredClone(TILE) })
  return { m, scene }
}

test("a tile is built over several frames, not all in one", () => {
  const { m } = pending()
  let frames = 0
  let clock = 0
  const tick = () => { frames++; m.work(() => clock++ * 1e6) }    // a budget that is gone before the first step ends
  while (m.queue.length || m.job) { tick(); assert.ok(frames < 50, "the build should finish, not spin") }
  assert.ok(frames > 2, `the build should take more than one frame, took ${frames}`)
})

test("nothing sees the tile until its last step has run", () => {
  const { m, scene } = pending()
  let clock = 0
  const before = scene.children.length
  m.work(() => clock++ * 1e6)
  assert.equal(m.tiles.get("0_0").loading, true, "still loading after the first step")
  assert.equal(m.ready(0, 0), false)
  assert.equal(scene.children.length, before, "and nothing half-built has been added to the scene")
  while (m.job) m.work(() => clock++ * 1e6)
  assert.equal(m.ready(0, 0), true)
  assert.equal(scene.children.length, before + 1)
})

test("onTile fires exactly once, at the end", () => {
  let fired = 0
  const { m } = pending({ onTile: () => fired++ })
  let clock = 0
  while (m.queue.length || m.job) { m.work(() => clock++ * 1e6); if (m.job) assert.equal(fired, 0, "not before the end") }
  assert.equal(fired, 1)
})

test("a generous budget finishes a small tile in one frame", () => {
  const { m } = pending()
  m.work(() => 0)                                     // a clock that never advances: the whole budget is available
  assert.equal(m.ready(0, 0), true)
})

test("a tile the player has driven away from is dropped mid-build, not finished", () => {
  const { m, scene } = pending()
  let clock = 0
  const before = scene.children.length
  m.work(() => clock++ * 1e6)
  assert.ok(m.job, "a job is in flight")
  m.tiles.delete("0_0")                               // what update() does when the tile leaves the wanted set
  m.work(() => clock++ * 1e6)
  assert.equal(m.job, null, "the job was abandoned")
  assert.equal(scene.children.length, before, "and its group never reached the scene")
})

test("reload abandons the tile in flight so the next update streams it again", () => {
  const { m } = pending()
  let clock = 0
  m.work(() => clock++ * 1e6)
  assert.ok(m.job)
  m.reload()
  assert.equal(m.job, null)
  assert.equal(m.tiles.has("0_0"), false, "the entry is gone, so update() will fetch it afresh")
})

// ---- slicing ------------------------------------------------------------------------------------------------------

const parts = (n) => Array.from({ length: n }, (_, i) => i)

test("a tile small enough to build in one go is not sliced at all", () => {
  assert.deepEqual(sliceParts(parts(58)), [parts(58)])
  assert.deepEqual(sliceParts([]), [])
  assert.deepEqual(sliceParts(null), [])
})

test("a dense tile is sliced, but never into more than the cap", () => {
  assert.equal(sliceParts(parts(700)).length, 3)
  assert.equal(sliceParts(parts(1214)).length, 5)
  assert.equal(sliceParts(parts(100000)).length, 5, "the cap holds however dense the tile")
})

test("slicing loses nothing and reorders nothing", () => {
  for (const n of [1, 59, 260, 261, 700, 1214, 4000]) {
    assert.deepEqual(sliceParts(parts(n)).flat(), parts(n), `n = ${n}`)
    for (const s of sliceParts(parts(n))) assert.ok(s.length > 0, "no empty slice")
  }
})
