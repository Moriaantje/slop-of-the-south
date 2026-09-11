import { test } from "node:test"
import assert from "node:assert/strict"
import { nearestHub } from "game/Session"

test("nearestHub finds the closest hub within reach", () => {
  const hubs = [{ key: "a", x: 0, z: 0 }, { key: "b", x: 100, z: 0 }]
  assert.equal(nearestHub(90, 0, hubs).key, "b")
  assert.equal(nearestHub(90, 0, hubs, 5), null)
  assert.equal(nearestHub(2, 2, hubs, 5).key, "a")
})
