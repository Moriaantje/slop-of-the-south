import { test } from "node:test"
import assert from "node:assert/strict"
import { buildRoads, frames, strip, junctionPatch, angleGap, yieldEnds, CURB, ROAD_LIFT } from "game/Roads"
import { PART, PATTERN, packCode, NO_END } from "game/RoadShaders"

// The complaints these cover: ribbons that come apart in a valley, ribbons that do not meet at a junction whose
// arms arrive at different heights, and ribbons that do not line up across a tile boundary.

const straight = (n, step = 8, y = 10) => Array.from({ length: n }, (_, i) => [0, -i * step, y, 0])
const cols = (hw) => [[hw, 0], [0, 0.06], [-hw, 0]]

test("a bank beside the road lifts the edge, but never more than EDGE_RISE above the road", () => {
  // a valley wall: the terrain climbs steeply the moment you leave the carriageway on the left
  const ground = (x) => (x > 2.5 ? 10 + (x - 2.5) * 2 : 9.5)
  const f = frames(straight(12), 3, ROAD_LIFT, ground)
  const g = strip(f, cols(3), 0, 3, packCode(PART.ROAD, 0.2))
  const pos = g.attributes.position
  let maxAbove = 0
  for (let i = 0; i < pos.count; i++) maxAbove = Math.max(maxAbove, pos.getY(i) - (10 + ROAD_LIFT))
  assert.ok(maxAbove > 0.1, "the edge does follow the bank up")
  assert.ok(maxAbove <= 0.45 + 1e-3, `and stops at EDGE_RISE, got ${maxAbove}`)
})

test("the edge climb is smooth along the road: no single vertex spikes above its neighbours", () => {
  // one terrain sample poking through in the middle of the road, the case that used to make a fin
  const ground = (x, z) => (Math.abs(z + 40) < 3 && Math.abs(x) > 2.5 ? 11.5 : 9.0)
  const f = frames(straight(12), 3, ROAD_LIFT, ground)
  const g = strip(f, cols(3), 0, 3, packCode(PART.ROAD, 0.2))
  const pos = g.attributes.position
  const byZ = new Map()
  for (let i = 0; i < pos.count; i++) if (pos.getX(i) > 2.9) byZ.set(Math.round(pos.getZ(i)), pos.getY(i))
  const zs = [...byZ.keys()].sort((a, b) => b - a)
  let worst = 0
  for (let i = 1; i < zs.length; i++) worst = Math.max(worst, Math.abs(byZ.get(zs[i]) - byZ.get(zs[i - 1])))
  assert.ok(worst < 0.18, `neighbouring edge vertices stay within 18 cm, got ${worst.toFixed(3)}`)
})

test("both ends of a piece sit at exactly the road level, whatever the terrain does there", () => {
  // this is what makes two tiles meet: neither tile's terrain may move the vertex they share
  const f = frames(straight(10), 3, ROAD_LIFT, () => 40)        // terrain 30 m above the road
  const g = strip(f, cols(3), 0, 3, packCode(PART.ROAD, 0.2))
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    if (z > -0.01 || z < -71.99) assert.ok(Math.abs(pos.getY(i) - (10 + ROAD_LIFT)) < 0.07, `end vertex at z=${z} is at ${pos.getY(i)}`)
  }
})

test("the same shared vertex comes out identically from two tiles with different terrain", () => {
  const pts = straight(8)
  const a = strip(frames(pts, 3, ROAD_LIFT, () => 60), cols(3), 0, 3, packCode(PART.ROAD, 0.2))
  const b = strip(frames(pts, 3, ROAD_LIFT, () => 5), cols(3), 0, 3, packCode(PART.ROAD, 0.2))
  const pa = a.attributes.position, pb = b.attributes.position
  let checked = 0
  for (let i = 0; i < pa.count; i++) {
    if (pa.getZ(i) > -0.01) { assert.ok(Math.abs(pa.getY(i) - pb.getY(i)) < 1e-5); checked++ }
  }
  assert.ok(checked > 0)
})

test("the kerb stone stands CURB above the carriageway edge and the gutter dips below it", () => {
  const pts = straight(6)
  const group = buildRoads([{ kind: "residential", width: 6, oneway: false, pts }], [], "woonwijk", () => 9)
  const kerb = group.children.find((m) => m.material.userData.set === "concrete")
  assert.ok(kerb, "a built-up residential street gets a concrete kerb strip")
  const pos = kerb.geometry.attributes.position
  let lowest = Infinity, highest = -Infinity
  for (let i = 0; i < pos.count; i++) { lowest = Math.min(lowest, pos.getY(i)); highest = Math.max(highest, pos.getY(i)) }
  const edge = 10 + ROAD_LIFT
  assert.ok(lowest < edge - 0.02, `the gutter dips below the asphalt, got ${(lowest - edge).toFixed(3)}`)
  assert.ok(Math.abs(highest - (edge + CURB + 0.012)) < 1e-3, `the kerb top is CURB up, got ${(highest - edge).toFixed(3)}`)
})

test("the carriageway is cambered: the crown stands proud of both edges", () => {
  // measured on a kerbed street, whose edge is a hard line at the kerb; a country lane's edge deliberately frays
  const f = frames(straight(4), 4, ROAD_LIFT, null)
  const group = buildRoads([{ kind: "residential", width: 8, pts: straight(4) }], [], "woonwijk", null)
  const road = group.children.find((m) => m.material.userData.set === "asphalt")
  const pos = road.geometry.attributes.position
  let centre = -Infinity, edge = Infinity
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i)) < 0.01) centre = Math.max(centre, pos.getY(i))
    if (Math.abs(Math.abs(pos.getX(i)) - 4) < 0.01) edge = Math.min(edge, pos.getY(i))
  }
  assert.ok(centre - edge > 0.03 && centre - edge <= 0.06 + 1e-6, `camber ${(centre - edge).toFixed(3)} m`)
  assert.ok(f.total > 0)
})

test("a lane with no kerb frays into its verge, a kerbed street does not", () => {
  const edges = (biome, kind) => {
    const group = buildRoads([{ kind, width: 8, pts: straight(4) }], [], biome, null)
    const pos = group.children.find((m) => m.material.userData.set === "asphalt").geometry.attributes.position
    const xs = [], ys = []
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) > 3.2) { xs.push(Math.abs(pos.getX(i))); ys.push(pos.getY(i)) }
    return { spread: Math.max(...xs) - Math.min(...xs), drop: Math.max(...ys) - Math.min(...ys) }
  }
  const lane = edges("platteland", "secondary"), street = edges("woonwijk", "residential")
  assert.ok(lane.spread > 0.15, `the lane's edge wanders (${lane.spread.toFixed(2)} m)`)
  assert.ok(lane.drop > 0.05, `and dips under the verge (${lane.drop.toFixed(2)} m)`)
  assert.ok(street.spread < 0.01, `the kerbed street's edge is straight (${street.spread.toFixed(3)} m)`)
})

test("a junction patch meets the mouths that arrive at different heights", () => {
  // two roads into one node: one arriving at 12, one at 10
  const east = { kind: "residential", width: 6, pts: [[4, 0, 12], [40, 0, 13]] }
  const north = { kind: "residential", width: 6, pts: [[0, -4, 10], [0, -40, 9]] }
  const g = junctionPatch([0, 0, 11, 4], [east, north], null)
  const pos = g.attributes.position
  const at = (ax, az) => {                                  // the rim height nearest a direction
    let best = null, bd = Infinity
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i) - ax, pos.getZ(i) - az)
      if (d < bd && Math.hypot(pos.getX(i), pos.getZ(i)) > 1) { bd = d; best = pos.getY(i) }
    }
    return best
  }
  assert.ok(at(5, 0) > 11.5, `the eastern rim rises towards the 12 m mouth, got ${at(5, 0)}`)
  assert.ok(at(0, -5) < 10.6, `the northern rim drops towards the 10 m mouth, got ${at(0, -5)}`)
})

test("a junction patch faces up", () => {
  const g = junctionPatch([0, 0, 10, 5], [], null)
  g.computeVertexNormals()
  const n = g.attributes.normal
  for (let i = 0; i < n.count; i++) assert.ok(n.getY(i) > 0.9, `normal ${i} points up`)
})

test("angleGap never exceeds half a turn and is symmetric", () => {
  assert.ok(Math.abs(angleGap(0.1, 6.2) - (0.1 + Math.PI * 2 - 6.2)) < 1e-9)
  assert.ok(Math.abs(angleGap(0, Math.PI) - Math.PI) < 1e-9)
  assert.ok(angleGap(1, -1) === angleGap(-1, 1))
})

test("haaientanden go only where a minor road meets something wider", () => {
  const minor = { kind: "residential", width: 5, pts: [[0, 0, 10], [0, -30, 10]] }
  const f = frames(minor.pts, 2.5, ROAD_LIFT, null)
  assert.deepEqual(yieldEnds(minor, [[0, 0, 10, 6]], f), [0, NO_END])            // a 12 m road crosses here
  assert.deepEqual(yieldEnds(minor, [[0, 0, 10, 3.4]], f), [NO_END, NO_END])     // …but not here
  assert.deepEqual(yieldEnds({ ...minor, kind: "primary" }, [[0, 0, 10, 9]], f), [NO_END, NO_END])
})

test("marking geometry is built only for patterns that have paint on them", () => {
  const marked = buildRoads([{ kind: "secondary", width: 7, pts: straight(4) }], [], "platteland", null)
  const bare = buildRoads([{ kind: "residential", width: 5, oneway: true, pts: straight(4) }], [], "woonwijk", null)
  const hasMarks = (g) => g.children.some((m) => Object.keys(m.geometry.attributes).includes("aEnds"))
  assert.equal(hasMarks(marked), true)
  assert.equal(hasMarks(bare), false)
  assert.notEqual(PATTERN.NONE, PATTERN.CENTRE)
})
