import { test } from "node:test"
import assert from "node:assert/strict"
import { buildBuildings, footprintPart, cwRing, shoelace, hipRoof, inset } from "game/Buildings"

// A footprint without a 3D BAG model becomes a part in the same format the modelled buildings use, so the winding of
// every ring it generates is load-bearing: get it backwards and the whole building is lit from the inside out.
const square = [[0, 0], [0, 10], [12, 10], [12, 0]]
const box = { id: 7, base: 20, height: 6, kind: "house", roof: "slanted", footprint: square }

function newell(ring) {                       // ring is flat [x, y, z, ...]
  const n = ring.length / 3
  const out = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const px = ring[i * 3], py = ring[i * 3 + 1], pz = ring[i * 3 + 2]
    const qx = ring[j * 3], qy = ring[j * 3 + 1], qz = ring[j * 3 + 2]
    out[0] += (py - qy) * (pz + qz)
    out[1] += (pz - qz) * (px + qx)
    out[2] += (px - qx) * (py + qy)
  }
  const len = Math.hypot(...out) || 1
  return out.map((v) => v / len)
}
const centroid = (ring) => {
  const n = ring.length / 3, c = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += ring[i * 3 + k] / n
  return c
}

test("a footprint is wound clockwise in the x/z map whichever way it came in", () => {
  const cw = cwRing(square), ccw = cwRing([...square].reverse())
  assert.ok(shoelace(cw) < 0 && shoelace(ccw) < 0)
  assert.equal(cw.length, 8)
})

test("every wall of a fallback building faces out of it", () => {
  const part = footprintPart(box)
  const mid = [6, 0, 5]                       // the footprint's centre, relative to the part origin at (0, 0)
  const walls = part.f.filter((f) => f[0] === 2)
  assert.equal(walls.length, 4)
  for (const [, ring] of walls) {
    const n = newell(ring), c = centroid(ring)
    assert.ok(Math.abs(n[1]) < 1e-6, "a wall is vertical")
    const out = n[0] * (c[0] - mid[0]) + n[2] * (c[2] - mid[2])
    assert.ok(out > 0, `wall normal points away from the centre, got ${out}`)
  }
})

test("the invented hip roof slopes up and outward, and its deck faces the sky", () => {
  const part = footprintPart(box)
  assert.equal(part.roof, "slanted")
  const roofs = part.f.filter((f) => f[0] === 1)
  assert.equal(roofs.length, 5, "four slopes and the deck between them")
  const mid = [6, 0, 5]
  for (const [, ring] of roofs.slice(0, 4)) {
    const n = newell(ring), c = centroid(ring)
    assert.ok(n[1] > 0.3 && n[1] < 0.99, `a slope, got n.y ${n[1]}`)
    assert.ok(n[0] * (c[0] - mid[0]) + n[2] * (c[2] - mid[2]) > 0, "the slope falls away from the ridge")
  }
  assert.ok(newell(roofs[4][1])[1] > 0.999, "the deck between the hips faces up")
})

test("the hip offset refuses a footprint it cannot mitre", () => {
  assert.equal(hipRoof([0, 0, 0, 1, 40, 1, 40, 0]), null, "a 1 m strip is narrower than two insets")
  const spike = [0, 0, 10, 0.2, 20, 0, 20, 8, 0, 8]          // a needle-sharp corner at the middle of the long side
  assert.equal(hipRoof(spike), null)
  const ok = hipRoof([0, 0, 0, 10, 12, 10, 12, 0])
  assert.ok(ok && ok.rise > 1 && ok.rise < 2.5, "a 12 × 10 block gets a believable pitch")
  for (let i = 0; i < ok.q.length; i += 2) {
    assert.ok(ok.q[i] > 0.5 && ok.q[i] < 11.5 && ok.q[i + 1] > 0.5 && ok.q[i + 1] < 9.5, "the inner ring sits inside")
  }
})

test("a flat-roofed kind skips the hip and keeps its deck", () => {
  const part = footprintPart({ ...box, kind: "warehouse" })
  assert.equal(part.roof, "horizontal")
  assert.equal(part.f.filter((f) => f[0] === 1).length, 1)
})

test("fallback buildings register the same destructible handles as before", () => {
  const handles = new Map()
  const group = buildBuildings([box], (k, h) => handles.set(k, h))
  assert.ok(group)
  const h = handles.get("b:7")
  assert.ok(h, "the handle key still names the OSM id")
  assert.equal(h.kind, "b")
  assert.deepEqual(h.rings, [square.flat()])
  assert.ok(h.max > 0 && h.h > 6, "hit points from the footprint, height including the roof")
  const before = h.ranges.map((r) => Array.from(r.geo.attributes.position.array))
  h.remove()
  for (const r of h.ranges) {
    const p = r.geo.attributes.position
    for (let i = r.start; i < r.start + r.count; i++) assert.equal(p.getX(i), p.getX(r.start))
  }
  h.restore()
  h.ranges.forEach((r, i) => assert.deepEqual(Array.from(r.geo.attributes.position.array), before[i]))
})

test("a building without a usable footprint is skipped rather than thrown at", () => {
  assert.equal(buildBuildings([{ id: 1, base: 0, height: 3, footprint: [[0, 0], [1, 1]] }], () => {}), null)
  assert.equal(buildBuildings([], () => {}), null)
})

test("a surveyed outline is welded and straightened before anything is built on it", () => {
  // a 10 × 8 rectangle traced badly: a corner split in two 5 cm apart, and a point sitting mid-edge
  const messy = [[0, 0], [5, 0], [10, 0], [10, 8], [10.03, 8.02], [0, 8]]
  const ring = cwRing(messy)
  assert.equal(ring.length / 2, 4, "four real corners survive")
  assert.ok(Math.abs(Math.abs(shoelace(ring)) - 80) < 0.5, "and they still enclose the same 80 m²")
  // the winding test above proves the walls follow; here only that the count dropped
  assert.equal(footprintPart({ id: 1, base: 0, height: 6, roof: "slanted", footprint: messy }).f.filter((f) => f[0] === 2).length, 4)
})

test("an L-shaped footprint gets its roof from a shorter offset rather than none", () => {
  const L = [0, 0, 0, 12, 7, 12, 7, 4, 14, 4, 14, 0]     // a 4 m wing off a 12 m block, clockwise
  assert.equal(inset(L, 2.4), null, "the full offset eats the narrow wing")
  const roof = hipRoof(L)
  assert.ok(roof, "a shorter one survives")
  assert.ok(roof.rise > 0.3 && roof.rise < 1.4, `a shallower pitch to match, got ${roof.rise}`)
  for (let i = 0; i < roof.q.length; i += 2) assert.ok(pointInside(roof.q[i], roof.q[i + 1], L), "every ridge corner is over the building")
})

function pointInside(x, z, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
