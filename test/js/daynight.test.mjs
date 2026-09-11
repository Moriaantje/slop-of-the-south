import { test } from "node:test"
import assert from "node:assert/strict"
import { warpHours, DAY_SECONDS } from "game/DayNight"

test("the game day: daylight hours take seven minutes, the night one", () => {
  assert.ok(Math.abs(warpHours(0) - 3.75) < 1e-9)                        // the day starts before sunrise
  assert.ok(Math.abs(warpHours(DAY_SECONDS - 60) - 22.25) < 1e-9)        // dusk at seven minutes
  assert.ok(Math.abs(warpHours(DAY_SECONDS - 30) - 1.0) < 1e-9)          // halfway through the night: 01:00
  assert.ok(Math.abs(warpHours(DAY_SECONDS - 1e-9) - 3.75) < 1e-6)       // and round to the start
  // monotonic apart from the midnight wrap
  let last = -1, wraps = 0
  for (let s = 0; s < DAY_SECONDS; s += 0.5) { const h = warpHours(s); if (h < last) wraps++; last = h }
  assert.equal(wraps, 1)
})
