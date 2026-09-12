import { test } from "node:test"
import assert from "node:assert/strict"
import { buildRoads, ribbon, styleOf, frames, strip } from "game/Roads"
import { PATTERN, PART, packCode, unpackCode, packPattern, unpackPattern } from "game/RoadShaders"

// a straight 100 m road northwards, 6 m wide, at height 10
const road = { kind: "primary", width: 6, pts: [[0, 0, 10], [0, -50, 10], [0, -100, 10]], lanes: 2 }
const CARRIAGE = 5                                  // columns across the carriageway strip

test("a cross-section strip carries UVs in metres: u across the section, v along the road", () => {
  const f = frames(road.pts, 3, 0.05, null)
  const g = strip(f, [[3, 0], [0, 0.06], [-3, 0]], 0, 3, packCode(PART.ROAD, 0.5))
  const uv = g.attributes.uv, pos = g.attributes.position
  let maxU = 0, maxV = 0
  for (let i = 0; i < uv.count; i++) { maxU = Math.max(maxU, uv.getX(i)); maxV = Math.max(maxV, uv.getY(i)) }
  assert.ok(Math.abs(maxU - 6) < 0.01)              // 3 m out and 3 m back, plus a couple of cm of camber
  assert.equal(maxV, 100)
  assert.equal(pos.count, 24)                       // two segments × two quads × two triangles × three vertices
})

test("bridge parapet ribbons keep 0..1 across and repeat every TEX_LEN metres", () => {
  const g = ribbon(road.pts, 3, 0.06, "unit")
  const uv = g.attributes.uv
  let maxU = 0, maxV = 0
  for (let i = 0; i < uv.count; i++) { maxU = Math.max(maxU, uv.getX(i)); maxV = Math.max(maxV, uv.getY(i)) }
  assert.equal(maxU, 1)
  assert.ok(Math.abs(maxV - 100 / 24) < 1e-5)       // Float32 attribute
})

test("styles split into a photo surface and a marking pattern", () => {
  assert.deepEqual(styleOf(road, false), { surface: "asphalt", marks: PATTERN.EDGE_CENTRE })
  assert.deepEqual(styleOf(road, true), { surface: "asphalt", marks: PATTERN.CENTRE })
  assert.deepEqual(styleOf({ kind: "cycleway", width: 2 }, true), { surface: "cycle", marks: PATTERN.NONE })
  assert.deepEqual(styleOf({ kind: "cycleway", width: 3.5 }, true), { surface: "cycle", marks: PATTERN.CYCLE })
  assert.deepEqual(styleOf({ kind: "motorway", width: 12, lanes: 3 }, false), { surface: "asphalt", marks: PATTERN.LANES })
})

test("a town's residential streets are laid in brick, the countryside's in asphalt", () => {
  const street = { kind: "residential", width: 5 }
  assert.equal(styleOf(street, true).surface, "klinker")
  assert.equal(styleOf(street, false).surface, "asphalt")
  assert.equal(styleOf({ kind: "service", width: 8 }, true).surface, "asphalt")    // a wide depot road stays asphalt
})

test("a marked road builds surface, marking and junction meshes", () => {
  const group = buildRoads([road], [[0, -50, 10, 6]], "platteland")
  assert.equal(group.children.length, 3)
  const attrs = group.children.map((m) => Object.keys(m.geometry.attributes).sort().join(","))
  for (const a of attrs) assert.ok(a.includes("aRoad"), `every road mesh carries aRoad, got ${a}`)
  assert.equal(attrs.filter((a) => a.includes("aEnds")).length, 1)     // only the markings need the give-way ends
})

test("the packed attribute codes survive a Float32 round trip", () => {
  for (const part of Object.values(PART)) {
    for (const seed of [0, 0.125, 0.5, 0.898]) {
      const f = Math.fround(packCode(part, seed))
      const got = unpackCode(f)
      assert.equal(got.part, part)
      assert.ok(Math.abs(got.seed - seed) < 1e-3, `seed ${seed} → ${got.seed}`)
    }
  }
  for (const lanes of [0, 2, 3, 4]) {
    const got = unpackPattern(Math.fround(packPattern(PATTERN.LANES, lanes)))
    assert.deepEqual(got, { pattern: PATTERN.LANES, lanes })
  }
})
