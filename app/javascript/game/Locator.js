// Works out which street the car is on and which place it is in, for the HUD street sign.
const ROAD_RADIUS = 30            // metres from a road centreline before that road counts
const DISTRICT_RADIUS = 1500      // metres; beyond this no wijk is shown
const SETTLEMENT_WEIGHT = { city: 3.5, town: 2.5, village: 1, hamlet: 0.6 }   // bigger places "reach" further
const DISTRICT_KINDS = new Set(["suburb", "neighbourhood", "quarter"])

export class Locator {
  constructor(places) {
    this.settlements = places.filter((p) => p.kind in SETTLEMENT_WEIGHT)
    this.districts = places.filter((p) => DISTRICT_KINDS.has(p.kind))
    this.street = null
    this.place = null
    this.district = null
  }

  // roads: tile road entries ({ name, pts: [[x, z], ...] }) near the car
  update(x, z, roads) {
    let street = null, best = ROAD_RADIUS * ROAD_RADIUS
    for (const road of roads) {
      if (!road.name) continue
      const d = distSqToPolyline(x, z, road.pts)
      if (d < best) { best = d; street = road.name }
    }
    if (street) this.street = street        // keep the last street across junctions and off-road excursions

    let place = null, score = Infinity
    for (const p of this.settlements) {
      const s = Math.hypot(p.x - x, p.z - z) / SETTLEMENT_WEIGHT[p.kind]
      if (s < score) { score = s; place = p.name }
    }
    this.place = place

    let district = null, dist = DISTRICT_RADIUS
    for (const p of this.districts) {
      const d = Math.hypot(p.x - x, p.z - z)
      if (d < dist) { dist = d; district = p.name }
    }
    this.district = district && district !== place ? district : null
  }
}

function distSqToPolyline(x, z, pts) {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
    const dx = bx - ax, dz = bz - az
    const len2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2))
    const px = ax + dx * t - x, pz = az + dz * t - z
    best = Math.min(best, px * px + pz * pz)
  }
  return best
}
