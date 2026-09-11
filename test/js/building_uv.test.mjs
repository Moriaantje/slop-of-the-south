import { test } from "node:test"
import assert from "node:assert/strict"
import { buildBuildingMeshes } from "game/BuildingMeshes"

// one 10 × 8 m house, 6 m walls and a horizontal roof, origin at (100, 20, -300); rings in centimetres from o
const wall = (x0, z0, x1, z1) => [2, [x0, 0, z0, x1, 0, z1, x1, 600, z1, x0, 600, z0]]
const house = { id: "h1", roof: "horizontal", o: [100, 20, -300], fp: [[100, -300, 110, -300, 110, -292, 100, -292]],
  f: [wall(0, 0, 1000, 0), wall(1000, 0, 1000, 800), wall(1000, 800, 0, 800), wall(0, 800, 0, 0), [1, [0, 600, 0, 1000, 600, 0, 1000, 600, 800, 0, 600, 800]]] }

test("walls and roof land in separate material buffers with metre UVs", () => {
  const handles = new Map()
  const group = buildBuildingMeshes([house], (k, h) => handles.set(k, h))
  assert.equal(group.children.length, 2)
  const h = handles.get("m:h1")
  assert.ok(h)
  assert.equal(h.ranges.length, 2)
  const total = h.ranges.reduce((n, r) => n + r.count, 0)
  assert.equal(total, 5 * 6)                        // five quads, two triangles each
  for (const r of h.ranges) {
    const uv = r.geo.attributes.uv
    let minV = Infinity, maxV = -Infinity
    for (let i = r.start; i < r.start + r.count; i++) { minV = Math.min(minV, uv.getY(i)); maxV = Math.max(maxV, uv.getY(i)) }
    const isWall = r.geo.attributes.position.count === 24
    if (isWall) {
      assert.ok(Math.abs(minV) < 1e-6 && Math.abs(maxV - 6) < 1e-6, `wall v 0..6, got ${minV}..${maxV}`)
      const face = r.geo.attributes.faceInfo, meta = r.geo.attributes.faceMeta
      const widths = new Set(), heights = new Set()
      for (let i = r.start; i < r.start + r.count; i++) { widths.add(Math.round(face.getZ(i) * 10) / 10); heights.add(Math.round(face.getW(i) * 10) / 10); assert.ok(face.getX(i) >= -1e-6, "u from the face's left edge") }
      assert.deepEqual([...widths].sort(), [10, 8], "the face widths for the window grid")
      assert.deepEqual([...heights], [6])
      assert.equal(meta.getX(r.start), 0, "the face's bottom for the window rows")
    }
    else assert.ok(maxV - minV > 7.9, "roof v spans the 8 m depth")
  }
})

test("remove() collapses every range of the building", () => {
  const handles = new Map()
  buildBuildingMeshes([house], (k, h) => handles.set(k, h))
  const h = handles.get("m:h1")
  h.remove()
  for (const r of h.ranges) {
    const p = r.geo.attributes.position
    const x = p.getX(r.start), y = p.getY(r.start)
    for (let i = r.start; i < r.start + r.count; i++) assert.ok(p.getX(i) === x && p.getY(i) === y)
  }
})

test("restore() unfolds a collapsed building again", () => {
  const handles = new Map()
  buildBuildingMeshes([house], (k, h) => handles.set(k, h))
  const h = handles.get("m:h1")
  const before = h.ranges.map((r) => Array.from(r.geo.attributes.position.array))
  h.remove()
  h.restore()
  h.ranges.forEach((r, i) => assert.deepEqual(Array.from(r.geo.attributes.position.array), before[i]))
})
