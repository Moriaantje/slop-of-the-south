import { test } from "node:test"
import assert from "node:assert/strict"
import { buildBuildingMeshes } from "game/BuildingMeshes"

// one 10 × 8 m house, 6 m walls and a horizontal roof, origin at (100, 20, -300); rings in centimetres from o
const wall = (x0, z0, x1, z1) => [2, [x0, 0, z0, x1, 0, z1, x1, 600, z1, x0, 600, z0]]
const house = { id: "h1", roof: "horizontal", o: [100, 20, -300], fp: [[100, -300, 110, -300, 110, -292, 100, -292]],
  f: [wall(0, 0, 1000, 0), wall(1000, 0, 1000, 800), wall(1000, 800, 0, 800), wall(0, 800, 0, 0), [1, [0, 600, 0, 1000, 600, 0, 1000, 600, 800, 0, 600, 800]]] }

// the same house with a gable roof: two slopes meeting on a ridge 8 m up, pentagon gable ends, origin at (0, 0, 0).
// Every ring is wound so its Newell normal points out of the building, which is what the generated trim assumes.
const m = (...pts) => pts.map((v) => v * 100)
const gable = { id: "g1", roof: "slanted", o: [0, 0, 0],
  fp: [[0, 0, 10, 0, 10, 8, 0, 8]],
  f: [
    [2, m(0, 0, 0, 0, 6, 0, 10, 6, 0, 10, 0, 0)],                                  // z = 0 side wall
    [2, m(0, 0, 8, 10, 0, 8, 10, 6, 8, 0, 6, 8)],                                  // z = 8 side wall
    [2, m(0, 0, 0, 0, 0, 8, 0, 6, 8, 0, 8, 4, 0, 6, 0)],                           // x = 0 gable end
    [2, m(10, 0, 0, 10, 6, 0, 10, 8, 4, 10, 6, 8, 10, 0, 8)],                      // x = 10 gable end
    [1, m(0, 6, 0, 0, 8, 4, 10, 8, 4, 10, 6, 0)],                                  // the slope facing -z
    [1, m(0, 6, 8, 10, 6, 8, 10, 8, 4, 0, 8, 4)],                                  // the slope facing +z
  ] }

const build = (part) => {
  const handles = new Map()
  const group = buildBuildingMeshes([part], (k, h) => handles.set(k, h))
  return { group, handle: handles.get(`m:${part.id}`) }
}
const totalVerts = (group) => group.children.reduce((n, c) => n + c.geometry.attributes.position.count, 0)

// the normal of triangle i of a non-indexed geometry, the way computeVertexNormals derives it
function triNormal(pos, i) {
  const p = (k) => [pos.getX(i * 3 + k), pos.getY(i * 3 + k), pos.getZ(i * 3 + k)]
  const [a, b, c] = [p(0), p(1), p(2)]
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

test("walls and roof land in separate material buffers with metre UVs", () => {
  const { group, handle } = build(house)
  assert.equal(group.children.length, 2)
  assert.ok(handle)
  assert.equal(handle.ranges.length, 2)
  // one building in the tile: every vertex of every buffer has to belong to its handle, trim included
  assert.equal(handle.ranges.reduce((n, r) => n + r.count, 0), totalVerts(group))
  for (const r of handle.ranges) {
    const isWall = !!r.geo.attributes.faceInfo          // only the wall and tile materials read the face attributes
    const uv = r.geo.attributes.uv
    const faces = Math.min(24, r.count)                 // the four wall quads come before any generated trim
    let minV = Infinity, maxV = -Infinity
    for (let i = r.start; i < r.start + faces; i++) { minV = Math.min(minV, uv.getY(i)); maxV = Math.max(maxV, uv.getY(i)) }
    if (isWall) {
      assert.ok(Math.abs(minV) < 1e-6 && Math.abs(maxV - 6) < 1e-6, `wall v 0..6, got ${minV}..${maxV}`)
      const face = r.geo.attributes.faceInfo, meta = r.geo.attributes.faceMeta
      const widths = new Set(), heights = new Set()
      for (let i = r.start; i < r.start + faces; i++) { widths.add(Math.round(face.getZ(i) * 10) / 10); heights.add(Math.round(face.getW(i) * 10) / 10); assert.ok(face.getX(i) >= -1e-6, "u from the face's left edge") }
      assert.deepEqual([...widths].sort(), [10, 8], "the face widths for the window grid")
      assert.deepEqual([...heights], [6])
      assert.equal(meta.getX(r.start), 0, "the face's bottom for the window rows")
    }
    else assert.ok(maxV - minV > 7.9, "roof v spans the 8 m depth")
  }
})

test("a flat roof is fenced with a parapet, inside the building's own range", () => {
  const { group, handle } = build(house)
  const wallRange = handle.ranges.find((r) => !!r.geo.attributes.faceInfo)
  assert.equal(wallRange.count, 24 + 4 * 12, "four walls plus a coped parapet on each of the four rim edges")
  const pos = wallRange.geo.attributes.position, face = wallRange.geo.attributes.faceInfo
  let above = 0
  for (let i = wallRange.start; i < wallRange.start + wallRange.count; i++) if (pos.getY(i) > 26.001) above++
  assert.ok(above > 0, "the parapet stands above the 6 m deck at y = 26")
  // a parapet must never grow windows: the shader needs a face lower than one storey for that
  for (let i = wallRange.start + 24; i < wallRange.start + wallRange.count; i++) assert.ok(face.getW(i) < 2.7, "parapet faces are shorter than a floor")
})

test("a pitched roof gets an overhang, a ridge cap, a chimney and a downpipe", () => {
  const { group, handle } = build(gable)
  assert.equal(group.children.length, 3, "tiles, walls and the painted trim")
  assert.equal(handle.ranges.reduce((n, r) => n + r.count, 0), totalVerts(group), "every generated vertex is in the range")

  const tiles = handle.ranges.find((r) => r.geo.attributes.faceInfo && r.geo.attributes.position.count % 6 === 0 && hasRoof(r))
  assert.ok(tiles, "a roof-tile buffer")
  const pos = tiles.geo.attributes.position
  let past = 0
  for (let i = 0; i < pos.count; i++) if (pos.getZ(i) < -0.1 || pos.getZ(i) > 8.1) past++
  assert.ok(past >= 6, "the roof projects past the wall on both eaves")
  let ridgeTop = -Infinity
  for (let i = 0; i < pos.count; i++) ridgeTop = Math.max(ridgeTop, pos.getY(i))
  assert.ok(ridgeTop > 8.0 && ridgeTop < 8.2, `the ridge cap sits just over the 8 m ridge, got ${ridgeTop}`)
  for (let t = 0; t < pos.count / 3; t++) assert.ok(triNormal(pos, t)[1] > 0, `roof triangle ${t} faces up`)

  // the chimney is brick, so it lands in the wall buffer above the ridge
  const walls = handle.ranges.find((r) => r !== tiles && r.geo.attributes.faceInfo)
  let chimney = 0
  for (let i = 0; i < walls.geo.attributes.position.count; i++) if (walls.geo.attributes.position.getY(i) > 8.2) chimney++
  assert.ok(chimney >= 4, "a chimney stands on the ridge")

  // the trim buffer holds the fascia, the gutter and the downpipe: below the eave and outboard of the wall
  const trim = handle.ranges.find((r) => !r.geo.attributes.faceInfo)
  assert.ok(trim, "a trim buffer")
  const tp = trim.geo.attributes.position
  let low = Infinity
  for (let i = 0; i < tp.count; i++) low = Math.min(low, tp.getY(i))
  assert.ok(low < 0.1, "the downpipe reaches the ground")
})

test("the generated detail is deterministic for a given id", () => {
  const a = build(gable), b = build(gable)
  const dump = ({ group }) => group.children.map((c) => Array.from(c.geometry.attributes.position.array))
  assert.deepEqual(dump(a), dump(b))
})

test("remove() collapses every range of the building", () => {
  const { handle } = build(gable)
  handle.remove()
  for (const r of handle.ranges) {
    const p = r.geo.attributes.position
    const x = p.getX(r.start), y = p.getY(r.start)
    for (let i = r.start; i < r.start + r.count; i++) assert.ok(p.getX(i) === x && p.getY(i) === y)
  }
})

test("restore() unfolds a collapsed building again", () => {
  const { handle } = build(gable)
  const before = handle.ranges.map((r) => Array.from(r.geo.attributes.position.array))
  handle.remove()
  handle.restore()
  handle.ranges.forEach((r, i) => assert.deepEqual(Array.from(r.geo.attributes.position.array), before[i]))
})

// the tile buffer is the one holding sloping triangles; the wall buffer's faces are vertical or capping a chimney
function hasRoof(r) {
  const pos = r.geo.attributes.position
  for (let t = 0; t < pos.count / 3; t++) {
    const n = triNormal(pos, t)
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    if (n[1] / len > 0.3 && n[1] / len < 0.99) return true
  }
  return false
}
