import { test } from "node:test"
import assert from "node:assert/strict"
import { buildRoads, ribbon, styleOf } from "game/Roads"

// a straight 100 m road northwards, 6 m wide, at height 10
const road = { kind: "primary", width: 6, pts: [[0, 0, 10], [0, -50, 10], [0, -100, 10]], lanes: 2 }

test("surface ribbons carry UVs in metres: u across the width, v along the road", () => {
  const g = ribbon(road.pts, 3, 0.05, "metres")
  const uv = g.attributes.uv, pos = g.attributes.position
  let maxU = 0, maxV = 0
  for (let i = 0; i < uv.count; i++) { maxU = Math.max(maxU, uv.getX(i)); maxV = Math.max(maxV, uv.getY(i)) }
  assert.equal(maxU, 6)
  assert.equal(maxV, 100)
  assert.equal(pos.count, 12)             // two segments × two triangles × three vertices
})

test("marking ribbons keep 0..1 across and repeat every TEX_LEN metres", () => {
  const g = ribbon(road.pts, 3, 0.06, "unit")
  const uv = g.attributes.uv
  let maxU = 0, maxV = 0
  for (let i = 0; i < uv.count; i++) { maxU = Math.max(maxU, uv.getX(i)); maxV = Math.max(maxV, uv.getY(i)) }
  assert.equal(maxU, 1)
  assert.ok(Math.abs(maxV - 100 / 24) < 1e-5)   // Float32 attribute
})

test("styles split into a photo surface and an optional markings layer", () => {
  assert.deepEqual(styleOf(road, false), { surface: "asphalt", marks: "edge-centre" })
  assert.deepEqual(styleOf(road, true), { surface: "asphalt", marks: "centre" })
  assert.deepEqual(styleOf({ kind: "cycleway", width: 2 }, true), { surface: "cycle", marks: null })
  assert.deepEqual(styleOf({ kind: "motorway", width: 12, lanes: 3 }, false), { surface: "asphalt", marks: "lanes-3" })
})

test("a marked road builds a surface mesh and a separate markings mesh", () => {
  const group = buildRoads([road], [[0, -50, 10, 6]], "platteland")
  const sets = group.children.map((m) => m.material.userData.set ?? "marks").sort()
  assert.deepEqual(sets, ["asphalt", "asphalt", "marks"])    // surface + junction disc + markings
})
