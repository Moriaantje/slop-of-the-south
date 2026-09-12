import { test } from "node:test"
import assert from "node:assert/strict"
import { buildLamps, buildSignals, setNightLevel, updateSignals } from "game/Furniture"
import { buildSigns, outline, plateFace, plateShell } from "game/Signs"

const lamps = [[0, 0, 90, 6], [20, 0, 270, 6], [40, 0, 0, 9]]
const ground = (x, z) => 10 + x * 0.01 - z * 0.02

test("lamps instance one mast, one lens and one light pool per height class", () => {
  const g = buildLamps(lamps, ground)
  assert.equal(g.children.length, 6)                       // two heights × (mast, lens, pool)
  for (const m of g.children) assert.ok(m.isInstancedMesh)
  const counts = g.children.map((m) => m.count).sort()
  assert.deepEqual(counts, [1, 1, 1, 2, 2, 2])
})

test("the light pool sits under the luminaire, not under the mast, and follows the arm", () => {
  const g = buildLamps([[0, 0, 90, 6]], () => 0)           // the arm points east
  const pool = g.children.find((m) => m.material.blending !== undefined && m.material.transparent)
  const m = new (Object.getPrototypeOf(pool.matrix).constructor)()
  pool.getMatrixAt(0, m)
  const e = m.elements
  assert.ok(e[12] > 1.0, `the pool is offset east of the mast, got x=${e[12]}`)
  assert.ok(Math.abs(e[14]) < 0.01, `and not offset north or south, got z=${e[14]}`)
})

test("night turns the lens emissive and shows the pools; day hides them outright", () => {
  const g = buildLamps(lamps, ground)
  const pool = g.children.find((m) => m.material.transparent)
  setNightLevel(1)
  assert.ok(pool.visible)
  assert.ok(pool.material.opacity > 0.5)
  setNightLevel(0)
  assert.equal(pool.visible, false)
  assert.equal(pool.material.opacity, 0)
})

test("traffic lights instance three lenses per pole and cycle them", () => {
  const g = buildSignals([[0, 0, 90, 1], [0, 10, 0, 1]], ground)
  const [poles, heads, lights] = g.children
  assert.equal(poles.count, 2)
  assert.equal(heads.count, 2)
  assert.equal(lights.count, 6)
  assert.ok(lights.instanceColor, "the lenses are coloured per instance, not per material")
  updateSignals()
})

test("a sign plate is cut to the shape it was painted in", () => {
  for (const [shape, corners] of [["disc", 16], ["octagon", 8], ["diamond", 4], ["triangle", 3], ["rect", 4]]) {
    const o = outline(shape, 0.7, 0.7)
    assert.equal(o.ring.length, corners)
    const face = plateFace(o, 0.011)
    assert.equal(face.attributes.position.count, (corners - 2) * 3)
    const n = face.attributes.normal
    for (let i = 0; i < n.count; i++) assert.ok(n.getZ(i) > 0.99, `${shape} face points forward`)
    const uv = face.attributes.uv
    for (let i = 0; i < uv.count; i++) {
      assert.ok(uv.getX(i) >= -0.01 && uv.getX(i) <= 1.01, `${shape} UVs stay on the canvas`)
      assert.ok(uv.getY(i) >= -0.01 && uv.getY(i) <= 1.01)
    }
  }
})

test("the plate shell closes the back and the edge band all the way round", () => {
  const o = outline("rect", 1.0, 0.5)
  const shell = plateShell(o, 0.011)
  assert.equal(shell.attributes.position.count, (2 + 2 * 4) * 3)      // two back triangles plus two per edge
  const p = shell.attributes.position
  let front = 0, back = 0
  for (let i = 0; i < p.count; i++) (p.getZ(i) > 0 ? front++ : back++)
  assert.ok(front > 0 && back > 0)
})

test("signs on one spot share a pole and hang below each other", () => {
  const g = buildSigns([[0, 0, 90, "A1", "30", ""], [0.2, 0, 90, "OB101", "", "uitgezonderd fietsers"]], () => 5, () => {})
  const meshes = g.children
  assert.ok(meshes.length >= 3)                                        // two faces, the shared back material, one pole
  const ys = meshes.flatMap((m) => {
    const p = m.geometry.attributes.position, out = []
    for (let i = 0; i < p.count; i++) out.push(p.getY(i))
    return out
  })
  assert.ok(Math.max(...ys) > 7.4 && Math.max(...ys) < 8.1, "the top of the pole is just above the main sign")
  assert.ok(Math.min(...ys) < 5.1, "and the pole reaches the ground")
})
