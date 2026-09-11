// Where things may stand: the tests Grass and Scatter share. Rings are flat [x, z, x, z, ...] in game units.

// even-odd point-in-polygon
export function insideRing(x, z, r) {
  let inside = false
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1]
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export function insideAny(polys, x, z) {
  if (!polys) return false
  for (const w of polys) if (insideRing(x, z, w.ring ?? w)) return true
  return false
}

// ChunkManager's road grid { x0, z0, nx, nz, cells, cell }: items are segments [ax, az, ay, bx, bz, by, hw] or
// junction discs [x, z, y, r]. `margin` metres beyond the asphalt edge stay clear (verge, sidewalk, curb).
export function nearRoad(index, x, z, margin = 3.5) {
  if (!index) return false
  const cx = Math.floor((x - index.x0) / index.cell), cz = Math.floor((z - index.z0) / index.cell)
  if (cx < 0 || cz < 0 || cx >= index.nx || cz >= index.nz) return false
  const items = index.cells[cz * index.nx + cx]
  if (!items) return false
  for (const s of items) {
    if (s.length === 4) { if (Math.hypot(s[0] - x, s[1] - z) < s[3] + margin) return true; continue }
    const dx = s[3] - s[0], dz = s[4] - s[1], len2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / len2))
    if (Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z) < s[6] + margin) return true
  }
  return false
}

// inside any destructible building of the tile (its handles carry footprint rings)
export function inBuilding(objects, x, z, margin = 0) {
  if (!objects) return false
  for (const h of objects.values()) {
    if (!h.rings) continue
    if (x < h.x - 70 || x > h.x + 70 || z < h.z - 70 || z > h.z + 70) continue
    for (const ring of h.rings) if (insideRing(x, z, ring)) return true
    if (margin > 0 && Math.hypot(h.x - x, h.z - z) < margin) return true
  }
  return false
}

export function hash(v) { const x = Math.sin(v * 12.9898) * 43758.5453; return x - Math.floor(x) }
