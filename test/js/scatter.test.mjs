import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { Scatter } from "game/Scatter"

// Cover polygons of a tile at the origin. Boundary dressing (hedgerows, fences) is decided per boundary by a hash
// of its first vertex, so tests that care about it sweep several differently placed fields.
const tile = (cover) => ({ key: "0_0", tx: 0, ty: 0, terrain: { ox: 0, oz: 0 }, roadIndex: null, water: [], objects: new Map(), cover })
const assets = { instanced: () => Promise.resolve([]) }
const scat = () => new Scatter({ scene: new THREE.Scene(), assets, heightAt: () => 0 })

// a square of side n metres with its north-west corner at (ox, oz), as decimetres from the tile corner
const square = (n, ox = 0, oz = 0) => { const r = []; for (const [x, z] of [[0, 0], [n, 0], [n, n], [0, n]]) r.push((x + ox) * 10, (z + oz) * 10); return r }

test("some meadows are hedged and some are left open; a hedged one gets a continuous row on its boundary", () => {
  let hedged = 0, open = 0, best = null
  for (let i = 0; i < 14; i++) {
    const s = scat()
    s.plan(tile([[1, square(150, i * 37, i * 53)]]))
    const bush = s.plans.get("0_0").get("bush") ?? []
    // the hedgerow rule steps every 2.6 m: a dressed 600 m boundary yields well over a hundred pieces
    if (bush.length / 6 > 100) { hedged++; best ??= { s, bush, ox: i * 37, oz: i * 53 } } else open++
  }
  assert.ok(hedged >= 3 && open >= 3, `hedged ${hedged}, open ${open} of 14 meadows`)
  const { bush, ox, oz } = best
  let onEdge = 0
  for (let i = 0; i < bush.length; i += 6) {
    const x = bush[i] - ox, z = bush[i + 2] - oz
    if (Math.min(x, z, 150 - x, 150 - z) < 3) onEdge++
  }
  assert.ok(onEdge > bush.length / 6 * 0.9, "the hedge follows the boundary")
})

test("arable land gets hay bales and field trees, yards get barrels and crates, and codes do not bleed", () => {
  const hay = scat(); hay.plan(tile([[4, square(300)]]))
  assert.ok(hay.plans.get("0_0").get("hay").length / 6 >= 5, "hay bales on the field")
  assert.equal(hay.plans.get("0_0").get("barrel"), undefined, "no farmyard barrels on arable land")
  let fenced = 0
  for (let i = 0; i < 12; i++) {
    const yard = scat(); yard.plan(tile([[20, square(60, i * 23, i * 41)]]))
    const p = yard.plans.get("0_0")
    for (const prop of ["barrel", "crate"]) assert.ok(p.get(prop)?.length, `${prop} in the yard`)
    if (p.get("fence")?.length) fenced++
  }
  assert.ok(fenced >= 1 && fenced <= 9, `${fenced} of 12 yards fenced`)
})

test("water is skipped and holes are respected", () => {
  const s = scat()
  s.plan(tile([[30, 3.2, square(200)]]))
  assert.equal(s.plans.get("0_0").size, 0, "nothing floats on water")
  const holed = scat()
  const outer = square(300), hole = []
  for (const [x, z] of [[100, 100], [200, 100], [200, 200], [100, 200]]) hole.push(x * 10, z * 10)
  holed.plan(tile([[7, outer, hole]]))
  const bush = holed.plans.get("0_0").get("bush")
  let inHole = 0
  for (let i = 0; i < bush.length; i += 6) if (bush[i] > 103 && bush[i] < 197 && bush[i + 2] > 103 && bush[i + 2] < 197) inHole++
  assert.equal(inHole, 0, "the clearing stays clear")
})

test("placements are deterministic", () => {
  const a = scat(); a.plan(tile([[1, square(200)]]))
  const b = scat(); b.plan(tile([[1, square(200)]]))
  assert.deepEqual(a.plans.get("0_0").get("bush"), b.plans.get("0_0").get("bush"))
})
