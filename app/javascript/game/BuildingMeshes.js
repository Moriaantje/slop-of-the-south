import * as THREE from "three"
import { foldable, scaleRange, hullXZ, buildingHp } from "game/Destructibles"
import { pbr, pbrEnabled } from "game/Textures"
import { LOOK } from "game/TerrainTile"
import { TUNING as T } from "game/Tuning"

// 3D BAG LoD2.2 buildings: faces (roof planes and walls) triangulated here with earcut and merged into a few
// flat-shaded meshes per tile, one per photo material (two bricks, plaster, roof tiles, flat-roof concrete).
// Tile format per building: { id, roof, o: [x, y, z], f: [[label, outer, hole, ...], ...] } where rings are flat
// centimetre offsets [dx, dy, dz, ...] from o. Label 1 = roof, 2 = wall. `fp` holds the ground outline as flat
// [x, z, ...] rings in game units. Each face gets planar UVs in metres from its own basis (u along the eave / wall,
// v up or up-slope, courses starting at the building's base), so bricks and tiles stay level on every plane.
// With `reg` every building registers a destructible handle: its vertex ranges in the merged geometries, collapsed
// when it falls (Destructibles only ever calls remove()/tint()).
// Windows are painted by the wall shader from a per-face attribute (u from the face's left edge, v from the base,
// width, height): a grid of 2.4 m cells per 3 m floor, glass darker and glossier than the wall so the sky
// environment reflects in it, a light frame, and at night a hashed share of them lit warm. No geometry, no
// textures: a few dozen shader instructions per fragment, one program for all walls.
const WIN_UNIFORMS = { uWinLit: { value: 0.55 }, uWinGlow: { value: 1.6 } }
function windows(m) {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uDark: LOOK.uDark, uWinLit: WIN_UNIFORMS.uWinLit, uWinGlow: WIN_UNIFORMS.uWinGlow })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 faceInfo;\nattribute vec2 faceMeta;\nvarying vec4 vFace;\nvarying vec2 vMeta;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvFace = faceInfo; vMeta = faceMeta;")
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", `uniform float opacity;
uniform float uDark, uWinLit, uWinGlow;
varying vec4 vFace; varying vec2 vMeta;
float winHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
\tfloat win = 0.0, frame = 0.0, lit = 0.0;
\t{
\t\tfloat W = vFace.z, H = vFace.w, base = vMeta.x;
\t\tconst float floorH = 3.0, cellW = 2.4;
\t\tfloat ncols = floor((W - 0.9) / cellW);
\t\tfloat rows = floor((H - 0.35 + 0.6) / floorH);
\t\tif (ncols >= 1.0 && rows >= 1.0) {
\t\t\tfloat margin = (W - ncols * cellW) * 0.5;
\t\t\tfloat cu = (vFace.x - margin) / cellW, cv = (vFace.y - base - 0.35) / floorH;
\t\t\tfloat ci = floor(cu), ri = floor(cv);
\t\t\tif (ci >= 0.0 && ci < ncols && ri >= 0.0 && ri < rows) {
\t\t\t\tvec2 c = vec2(fract(cu), fract(cv));
\t\t\t\tvec2 aa = fwidth(c) * 1.2 + 0.002;
\t\t\t\tvec2 lo = vec2(0.31, 0.27), hi = vec2(0.69, 0.73);
\t\t\t\tvec2 inner = smoothstep(lo - aa, lo + aa, c) * (1.0 - smoothstep(hi - aa, hi + aa, c));
\t\t\t\tvec2 outer = smoothstep(lo - 0.045 - aa, lo - 0.045 + aa, c) * (1.0 - smoothstep(hi + 0.045 - aa, hi + 0.045 + aa, c));
\t\t\t\twin = inner.x * inner.y;
\t\t\t\tframe = max(outer.x * outer.y - win, 0.0);
\t\t\t\tfloat h = winHash(vec2(ci, ri) + vMeta.y * 17.0);
\t\t\t\tlit = step(1.0 - uWinLit, h) * (0.55 + 0.45 * winHash(vec2(ri, ci) * 3.1 + vMeta.y));
\t\t\t}
\t\t}
\t}
\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.85, 0.80), frame);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.11, 0.14), win);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, 0.15, win);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n\tmetalnessFactor = mix(metalnessFactor, 0.6, win);")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += win * lit * uDark * uWinGlow * vec3(1.0, 0.78, 0.5);")
  }
  m.customProgramCacheKey = () => "wall-windows"
  return m
}
export function tuneWindows() { WIN_UNIFORMS.uWinLit.value = T.look.windows.lit; WIN_UNIFORMS.uWinGlow.value = T.look.windows.glow }

const MATS = {
  brick:    windows(pbr("brick", { vertexColors: true, size: 2.2, side: THREE.DoubleSide, roughness: 0.9 })),
  brick2:   windows(pbr("brick2", { vertexColors: true, size: 2.4, side: THREE.DoubleSide, roughness: 0.9 })),
  plaster:  windows(pbr("plaster", { vertexColors: true, size: 3, side: THREE.DoubleSide, roughness: 0.9 })),
  rooftile: pbr("rooftile", { vertexColors: true, size: 1.6, side: THREE.DoubleSide, roughness: 0.85 }),
  flat:     pbr("concrete", { vertexColors: true, size: 3, side: THREE.DoubleSide, roughness: 0.95 }),
}
const WALL_SETS = ["brick", "brick", "brick2", "plaster", "brick", "plaster", "brick2", "brick"]

const WALLS = [0xd9c4a5, 0xcdb597, 0xb99c7a, 0xa8836a, 0xe3d6c3, 0xc9c1b4, 0x9c7b66, 0xdccbb6]  // brick, plaster, dark brick
const PITCHED = [0x6e3d33, 0x5a3a35, 0x4b4548, 0x7a4a3c, 0x3f3b3d, 0x8a5646]                   // tiles: terracotta to anthracite
const FLAT = [0x6f6c68, 0x7d7a74, 0x5e5c59]                                                      // bitumen / gravel
// with the photos on, the palette only tints the photo (mostly white, a hint of the colour); without, it is the colour
const MIX = pbrEnabled() ? 0.7 : 0
const POOL3 = [], POOL2 = []                                                                      // scratch vectors reused per face
const X_AXIS = new THREE.Vector3(1, 0, 0)

export function buildBuildingMeshes(meshes, reg) {
  if (!meshes?.length) return null
  const bufs = {}                       // material name → { pos, col, uv, face, meta }
  const buf = (name) => bufs[name] ??= { pos: [], col: [], uv: [], face: [], meta: [] }
  const handles = []
  const color = new THREE.Color(), white = new THREE.Color(0xffffff)
  const pts3 = [], pts2 = []
  const normal = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const tu = new THREE.Vector3(), tv = new THREE.Vector3()

  for (const b of meshes) {
    const h = hash(b.id)
    const wall = WALLS[h % WALLS.length], wallSet = WALL_SETS[h % WALL_SETS.length]
    const flat = b.roof === "horizontal"
    const roof = flat ? FLAT[h % FLAT.length] : PITCHED[(h >> 3) % PITCHED.length]
    const roofSet = flat ? "flat" : "rooftile"
    const [ox, oy, oz] = b.o
    const starts = {}                   // material name → vertex index where this building begins in that buffer
    const xz = []
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = -Infinity
    for (const face of b.f) {
      const label = face[0]
      // rings → arrays of Vector3 (outer first, then holes); the vectors come from a pool reused per face, since a
      // dense tile has 60k ring vertices and allocating them all made every tile load a visible hitch
      const rings = []
      let used = 0
      for (let r = 1; r < face.length; r++) {
        const flatRing = face[r], ring = []
        for (let i = 0; i + 2 < flatRing.length; i += 3) {
          const p = (POOL3[used] ??= new THREE.Vector3()).set(ox + flatRing[i] / 100, oy + flatRing[i + 1] / 100, oz + flatRing[i + 2] / 100); used++
          ring.push(p)
          if (reg) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); top = Math.max(top, p.y); if (!b.fp) xz.push(p.x, p.z) }
        }
        if (ring.length >= 3) rings.push(ring)
      }
      if (!rings.length) continue
      newell(rings[0], normal)
      if (normal.lengthSq() < 1e-12) continue
      normal.normalize()
      // 2D basis in the face plane for earcut
      u.copy(Math.abs(normal.y) > 0.9 ? X_AXIS : up).cross(normal).normalize()
      v.crossVectors(normal, u)
      // texture basis: tu horizontal along the face (eave / wall), tv up the wall or up the roof slope
      const horizontal = Math.abs(normal.y) > 0.999
      if (horizontal) { tu.copy(X_AXIS); tv.set(0, 0, 1) }
      else { tu.crossVectors(up, normal).normalize(); tv.crossVectors(normal, tu).normalize(); if (tv.y < 0) tv.negate() }
      pts3.length = 0; pts2.length = 0
      const contour = [], holes = []
      let used2 = 0
      for (let r = 0; r < rings.length; r++) {
        const target = r === 0 ? contour : []
        for (const p of rings[r]) { pts3.push(p); target.push((POOL2[used2] ??= new THREE.Vector2()).set(p.dot(u), p.dot(v))); used2++ }
        if (r > 0) holes.push(target)
      }
      let tris
      try { tris = THREE.ShapeUtils.triangulateShape(contour, holes) } catch { continue }
      // per-face tint so adjacent walls read as separate planes; walls get a fake directional shade
      const tint = 0.92 + ((h ^ (face.length * 7919)) % 17) / 100
      color.setHex(label === 1 ? roof : wall).lerp(white, MIX)
      const shade = label === 1 ? 1 : 0.85 + 0.15 * Math.abs(normal.x)
      const r = color.r * tint * shade, g = color.g * tint * shade, bl = color.b * tint * shade
      const name = label === 1 ? roofSet : wallSet
      const B = buf(name)
      starts[name] ??= B.pos.length / 3
      // v measured from the building base so brick courses start on the ground; u from the origin along the face.
      // The face's own extent (left edge, bottom, width, height) rides along for the window grid.
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
      for (const p of rings[0]) {
        const fu = (p.x - ox) * tu.x + (p.y - oy) * tu.y + (p.z - oz) * tu.z, fv = (p.x - ox) * tv.x + (p.y - oy) * tv.y + (p.z - oz) * tv.z
        minU = Math.min(minU, fu); maxU = Math.max(maxU, fu); minV = Math.min(minV, fv); maxV = Math.max(maxV, fv)
      }
      const seed = (h % 1000) / 1000
      for (const [a, b2, c] of tris) {
        for (const i of [a, b2, c]) {
          const p = pts3[i]
          const fu = (p.x - ox) * tu.x + (p.y - oy) * tu.y + (p.z - oz) * tu.z, fv = (p.x - ox) * tv.x + (p.y - oy) * tv.y + (p.z - oz) * tv.z
          B.pos.push(p.x, p.y, p.z); B.col.push(r, g, bl)
          B.uv.push(fu, fv)
          B.face.push(fu - minU, fv, maxU - minU, maxV - minV); B.meta.push(minV, seed)
        }
      }
    }
    const ranges = Object.entries(starts).map(([name, start]) => ({ name, start, count: bufs[name].pos.length / 3 - start })).filter((r) => r.count)
    if (reg && ranges.length) {
      const rings = b.fp ?? [hullXZ(xz)]
      handles.push({ key: `m:${b.id}`, kind: "m", rings, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, h: top - oy, max: buildingHp(rings), ranges })
    }
  }
  const geos = {}
  for (const [name, B] of Object.entries(bufs)) {
    if (!B.pos.length) continue
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute(B.pos, 3))
    geo.setAttribute("color", new THREE.Float32BufferAttribute(B.col, 3))
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(B.uv, 2))
    geo.setAttribute("faceInfo", new THREE.Float32BufferAttribute(B.face, 4))
    geo.setAttribute("faceMeta", new THREE.Float32BufferAttribute(B.meta, 2))
    geo.computeVertexNormals()          // non-indexed → one normal per triangle = flat shading
    geos[name] = geo
  }
  if (!Object.keys(geos).length) return null
  for (const h of handles) {
    const rs = h.ranges.map((r) => ({ geo: geos[r.name], start: r.start, count: r.count, fold: foldable(geos[r.name].attributes.position, r.start, r.count) }))
    reg(h.key, { ...h, ranges: rs,
      remove: () => { for (const r of rs) r.fold.remove() },
      restore: () => { for (const r of rs) r.fold.restore() },
      tint: (k) => { for (const r of rs) scaleRange(r.geo.attributes.color, r.start, r.count, k) } })
  }
  const group = new THREE.Group()
  for (const [name, geo] of Object.entries(geos)) group.add(new THREE.Mesh(geo, MATS[name]))
  return group
}

// Newell's method: robust polygon normal for concave / slightly non-planar rings
function newell(ring, out) {
  out.set(0, 0, 0)
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    out.x += (p.y - q.y) * (p.z + q.z)
    out.y += (p.z - q.z) * (p.x + q.x)
    out.z += (p.x - q.x) * (p.y + q.y)
  }
  return out
}

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
