import { test } from "node:test"
import assert from "node:assert/strict"
import { TerrainTile, heightBlend, GROUND } from "game/TerrainTile"
import { coverMaskBytes, buildWater, rippleTexture } from "game/Cover"
import { Ortho } from "game/Ortho"

// A 3x3 height grid tilting one metre per grid step towards the east.
const CFG = { height_n: 3, height_step: 250, tile_size: 500 }
const RAMP = { origin: [0, 0], heights: [0, 1, 2, 0, 1, 2, 0, 1, 2] }

test("the terrain samples its height grid bilinearly", () => {
  const t = new TerrainTile(RAMP, CFG)
  assert.equal(t.heightAt(0, 0), 0)
  assert.equal(t.heightAt(250, 0), 1)
  assert.ok(Math.abs(t.heightAt(125, 125) - 0.5) < 1e-6)
})

test("vertex normals come from the height grid's own gradient, not from the facets", () => {
  const t = new TerrainTile(RAMP, CFG)
  const n = t.mesh.geometry.attributes.normal
  // one metre up per 250 m east: the normal leans west by exactly that slope, everywhere, including the border
  for (const i of [0, 1, 4, 8]) {
    assert.ok(Math.abs(n.getX(i) + 0.004 * n.getY(i)) < 1e-6, `normal ${i} x`)
    assert.ok(Math.abs(n.getZ(i)) < 1e-9, `normal ${i} z`)
    assert.ok(n.getY(i) > 0.999, `normal ${i} y`)
  }
})

test("a tile with no land cover still gets a material and a mask", () => {
  const t = new TerrainTile(RAMP, CFG)
  assert.ok(t.mesh.material.map, "the shared all-grass mask")
  assert.equal(t.mesh.material.map.image.width, 1)
})

test("the height blend hands the fragment to whichever layer stands proudest", () => {
  const opts = { influence: 0.4, range: 0.2 }
  // two layers half and half, but the second one's relief is much higher there: it takes most of the fragment
  const b = heightBlend([0.5, 0.5, 0, 0], [0.1, 0.9, 0, 0], opts)
  assert.ok(b[1] > b[0], "the proud layer wins")
  assert.ok(Math.abs(b[0] + b[1] - 1) < 1e-9, "and the two of them still make a whole")
  assert.equal(b[2], 0)
})

test("the height blend is a hard edge when the range is tight and a fade when it is wide", () => {
  const tight = heightBlend([0.5, 0.5, 0, 0], [0.2, 0.6, 0, 0], { influence: 0.4, range: 0.05 })
  const wide = heightBlend([0.5, 0.5, 0, 0], [0.2, 0.6, 0, 0], { influence: 0.4, range: 0.5 })
  assert.equal(tight[0], 0, "the tight blend cuts the loser out entirely")
  assert.ok(wide[0] > 0.3, "the wide blend cross-fades")
})

test("a layer with a negligible mask weight never contributes, whatever its relief", () => {
  const b = heightBlend([1, 0.001, 0, 0], [0, 1, 0, 0], { influence: 1, range: 1 })
  assert.equal(b[1], 0)
  assert.equal(b[0], 1)
})

test("the height blend never divides by zero", () => {
  assert.deepEqual(heightBlend([0, 0, 0, 0], [0, 0, 0, 0], GROUND), [0, 0, 0, 0])
})

test("the cover mask puts each land cover class on the right layer", () => {
  const grass = coverMaskBytes(1), arable = coverMaskBytes(4), wood = coverMaskBytes(7)
  const sand = coverMaskBytes(11), paving = coverMaskBytes(21)
  assert.deepEqual(grass.slice(0, 3), [0, 0, 0], "grass is what the other three leave over")
  assert.deepEqual(arable.slice(0, 3), [255, 0, 0], "bouwland is all soil")
  assert.deepEqual(wood.slice(0, 3), [0, 0, 255], "bos is all forest floor")
  assert.deepEqual(paving.slice(0, 3), [0, 255, 0], "verharding is all gravel")
  assert.ok(sand[3] > 230, "duin is soil at the bleached end")
  assert.ok(paving[3] < 40, "closed paving is the wet, dark end of the same set")
  assert.equal(coverMaskBytes(99), null, "an unknown class paints nothing")
})

test("dryness jitters per polygon but stays a byte", () => {
  const seen = new Set()
  for (let seed = 0; seed < 4096; seed += 37) {
    const b = coverMaskBytes(4, seed)
    assert.ok(b[3] >= 0 && b[3] <= 255, `dryness ${b[3]} out of range`)
    seen.add(b[3])
  }
  assert.ok(seen.size > 20, "neighbouring fields do not all come out the same shade")
  assert.deepEqual(coverMaskBytes(4, 123), coverMaskBytes(4, 123), "and the same polygon is always the same shade")
})

test("the wave texture is a usable normal map with its height in alpha", () => {
  const tex = rippleTexture(32)
  const d = tex.image.data
  assert.equal(d.length, 32 * 32 * 4)
  let lo = 255, hi = 0
  for (let i = 0; i < 32 * 32; i++) {
    assert.ok(d[i * 4 + 2] > 150, "every normal points up out of the surface")
    lo = Math.min(lo, d[i * 4 + 3]); hi = Math.max(hi, d[i * 4 + 3])
  }
  assert.ok(lo < 40 && hi > 215, "and the height channel uses its range")
})

// a 200 m square lake at level 10 over a bed that slopes down from the shore at 0.6 m per metre, capped at 5 m
const LAKE_RING = [0, 0, 2000, 0, 2000, 2000, 0, 2000]
const bed = (x, z) => 10 - Math.min(5, Math.max(0, Math.min(x, 200 - x, z, 200 - z)) * 0.6)

test("every water vertex carries how deep the water is under it", () => {
  const mesh = buildWater([[30, 10, LAKE_RING]], bed, [0, 0])
  const d = mesh.geometry.attributes.aDepth
  assert.equal(d.itemSize, 1)
  assert.equal(d.count, mesh.geometry.attributes.position.count)
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < d.count; i++) { lo = Math.min(lo, d.getX(i)); hi = Math.max(hi, d.getX(i)) }
  assert.equal(lo, 0, "the shore is where the water runs out")
  assert.ok(Math.abs(hi - 5) < 1e-6, "and the middle is as deep as the bed was carved")
})

test("a flat water surface is subdivided finely enough for the shore band to land on the bank", () => {
  const mesh = buildWater([[30, 10, LAKE_RING]], bed, [0, 0])
  const p = mesh.geometry.attributes.position
  let longest = 0
  for (let i = 0; i < p.count; i += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      longest = Math.max(longest, Math.hypot(p.getX(i + a) - p.getX(i + b), p.getZ(i + a) - p.getZ(i + b)))
    }
  }
  assert.ok(longest < 32, `longest water edge ${longest.toFixed(1)} m`)
  for (let i = 0; i < p.count; i++) assert.ok(Math.abs(p.getY(i) - 10.02) < 1e-6, "the surface stays flat at its level")
})

test("a draped watercourse follows the terrain and reads as shallow", () => {
  const mesh = buildWater([[30, null, LAKE_RING]], bed, [0, 0])
  const d = mesh.geometry.attributes.aDepth, p = mesh.geometry.attributes.position
  for (let i = 0; i < d.count; i++) assert.ok(d.getX(i) > 0 && d.getX(i) < 1.5)
  let varies = false
  for (let i = 1; i < p.count; i++) if (Math.abs(p.getY(i) - p.getY(0)) > 0.1) varies = true
  assert.ok(varies, "it is draped on the ground, not flat")
})

test("dry land builds no water at all", () => {
  assert.equal(buildWater([[1, [0, 0, 10, 0, 10, 10]]], bed, [0, 0]), null)
})

test("the aerial photo streams at the resolution a colour field needs, not a texture's", () => {
  const o = new Ortho({})
  assert.equal(o.near, 512)
  assert.equal(o.far, 256)
  assert.equal(o.enabled, true)
})
