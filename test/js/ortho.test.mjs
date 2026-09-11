import { test } from "node:test"
import assert from "node:assert/strict"
import { wmsUrl } from "game/Ortho"

test("the WMS bbox is the tile's RD envelope", () => {
  const url = wmsUrl(372, 662, 1024)
  assert.match(url, /bbox=186000,331000,186500,331500/)
  assert.match(url, /width=1024&height=1024/)
  assert.match(url, /layers=Actueel_ortho25/)
  assert.match(url, /crs=EPSG:28992/)
})
