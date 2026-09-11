import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// BGT land cover per tile: painted into a canvas texture that the terrain tile wears, plus water surfaces.
// Tile format: cover = [[code, outerRing, holeRing, ...], ...] with rings as flat decimetre offsets [dx, dz, ...]
// from the tile's north-west corner (0..5000). Codes match LandCover::CODES on the server. Water entries carry their
// surface level first: [30, level | null, outerRing, ...] — a level means a flat surface over a carved bed (lakes,
// the Maas, canals), null means a thin watercourse draped on the terrain.
export const TEXTURE_SIZE = 512
const BASE = "#7fa15a"
const COLORS = {
  1: ["#78a049", "#6f9a44", "#7ea64d"],                              // grasland agrarisch (meadow)
  2: ["#86a44f", "#7fa04a"],                                         // grasland overig
  3: ["#6e9448", "#739a4b"],                                         // groenvoorziening (urban green)
  4: ["#b69b63", "#c9b077", "#a48a58", "#9ea653", "#bfa76a", "#8d9b4c", "#d1b97d"],  // bouwland: soil, stubble, crops
  5: ["#7aa04a", "#74994a"],                                         // fruitteelt (orchard grass)
  6: ["#7f9d4f"],                                                    // boomteelt
  7: ["#4f7a38", "#557f3c"],                                         // bos floor
  8: ["#8b7d5b"], 9: ["#6d8b45"], 10: ["#88915a"], 11: ["#d8c8a2"], 12: ["#9a9468"],
  20: ["#b3a795", "#ada08d", "#b8ad9b"],                             // erf (yards)
  21: ["#5b5b5e"], 22: ["#8d7d72"], 23: ["#a89c86"], 24: ["#9d8b6c"],  // pavement grades
  30: ["#25393c"]                                                    // water bed (seen through the surface)
}
const WATER = 30

export function paintCover(cover) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = TEXTURE_SIZE
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = BASE
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE)
  const k = TEXTURE_SIZE / 5000
  for (const entry of cover) {
    const palette = COLORS[entry[0]]
    if (!palette) continue
    const start = waterLevel(entry) === undefined ? 1 : 2          // water: [code, level, rings…]
    ctx.fillStyle = palette[hash(entry[start]) % palette.length]  // stable per polygon: fields keep their colour
    ctx.beginPath()
    for (let r = start; r < entry.length; r++) {
      const ring = entry[r]
      ctx.moveTo(ring[0] * k, ring[1] * k)
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] * k, ring[i + 1] * k)
      ctx.closePath()
    }
    ctx.fill("evenodd")
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

const LIFT = 0.12, MAX_EDGE = 40

// The water surface: rippling normals from a few sine waves, the sky reflected by Fresnel (horizon ↔ zenith from
// DayNight), the sun's glitter, and transparency so the carved bed shows through. One shared material; updateWater()
// feeds it the time and the sky every frame.
const waterMat = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    time: { value: 0 }, daylight: { value: 1 }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(0xfff2dc) },
    zenith: { value: new THREE.Color(0x4f8fd2) }, horizon: { value: new THREE.Color(0xbfd4e6) }, deep: { value: new THREE.Color(0x14333d) }, shallow: { value: new THREE.Color(0x2f6f78) }
  }]),
  vertexShader: /* glsl */`
    #include <fog_pars_vertex>
    varying vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <fog_pars_fragment>
    uniform float time, daylight;
    uniform vec3 sunDir, sunColor, zenith, horizon, deep, shallow;
    varying vec3 vWorld;
    void main() {
      vec2 p = vWorld.xz;
      // three wave trains; the surface normal follows their slopes
      vec2 k1 = vec2(0.9, 0.35) * 0.9, k2 = vec2(-0.4, 0.8) * 1.8, k3 = vec2(0.25, -1.0) * 3.4;
      float far = smoothstep(20.0, 240.0, distance(cameraPosition, vWorld));   // ripples fade out before they alias into bands
      float a1 = 0.032 * (1.0 - 0.75 * far), a2 = 0.024 * (1.0 - far), a3 = 0.012 * (1.0 - far);
      float c1 = cos(dot(p, k1) + time * 1.2), c2 = cos(dot(p, k2) + time * 1.9), c3 = cos(dot(p, k3) + time * 2.8);
      vec2 slope = a1 * k1 * c1 + a2 * k2 * c2 + a3 * k3 * c3;
      vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
      vec3 V = normalize(cameraPosition - vWorld);
      if (dot(n, V) < 0.0) n = -n;                                 // seen from below
      vec3 R = reflect(-V, n);
      float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      vec3 sky = mix(horizon, zenith, clamp(R.y * 1.4, 0.0, 1.0));
      vec3 body = mix(deep, shallow, 0.35 + 0.25 * c2) * (0.12 + 0.88 * daylight);
      float glitter = pow(max(dot(R, normalize(sunDir)), 0.0), 220.0);
      vec3 col = mix(body, sky, fres) + sunColor * glitter * 0.8;
      gl_FragColor = vec4(col, 0.62 + 0.34 * fres);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
  transparent: true, fog: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2
})
waterMat.__shared = true

// darkness / sky / sun from DayNight.env, once per frame
export function updateWater(env, t) {
  const u = waterMat.uniforms
  u.time.value = t
  u.daylight.value = 1 - env.darkness
  u.sunDir.value.copy(env.sunDir); u.sunColor.value.copy(env.sunColor)
  u.zenith.value.copy(env.zenith); u.horizon.value.copy(env.horizon)
}

// Water polygons → surfaces: flat at their level over the carved bed, or draped just above the terrain for thin
// watercourses (level null).
export function buildWater(cover, heightAt, origin) {
  const [ox, oz] = origin
  const geos = []
  for (const entry of cover) {
    if (entry[0] !== WATER) continue
    const level = waterLevel(entry)
    const rings = []
    for (let r = level === undefined ? 1 : 2; r < entry.length; r++) {
      const flat = entry[r], ring = []
      for (let i = 0; i + 1 < flat.length; i += 2) ring.push(new THREE.Vector2(ox + flat[i] / 10, oz + flat[i + 1] / 10))
      if (ring.length >= 3) rings.push(ring)
    }
    if (!rings.length) continue
    let tris
    try { tris = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1)) } catch { continue }
    const pts = rings.flat()
    const verts = []
    if (level === null || level === undefined) {
      const push = (p) => verts.push(p.x, heightAt(p.x, p.y) + LIFT, p.y)
      for (const [a, b, c] of tris) subdivide(pts[a], pts[b], pts[c], push, 0)
    } else {
      for (const [a, b, c] of tris) for (const i of [a, b, c]) verts.push(pts[i].x, level + 0.02, pts[i].y)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
    geos.push(g)
  }
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  const mesh = new THREE.Mesh(merged, waterMat)
  mesh.renderOrder = 5
  return mesh
}

// the level slot of a water entry: a number (flat surface), null (draped), or undefined for tiles built before levels existed
// the water polygons of a tile with a known surface level, as flat [x, z, ...] outer rings in game units, for
// ChunkManager.waterLevelAt (what the mech wades or drowns in)
export function waterPolys(cover, origin) {
  const [ox, oz] = origin, out = []
  for (const entry of cover) {
    const level = waterLevel(entry)
    if (typeof level !== "number") continue
    const flat = entry[2]
    if (!flat || flat.length < 6) continue
    const ring = new Array(flat.length)
    for (let i = 0; i + 1 < flat.length; i += 2) { ring[i] = ox + flat[i] / 10; ring[i + 1] = oz + flat[i + 1] / 10 }
    out.push({ level, ring })
  }
  return out
}

function waterLevel(entry) {
  if (entry[0] !== WATER) return undefined
  return Array.isArray(entry[1]) ? undefined : entry[1]
}

// split long triangles so wide water follows the terrain instead of cutting through it
function subdivide(a, b, c, push, depth) {
  const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a)
  const longest = Math.max(ab, bc, ca)
  if (longest < MAX_EDGE || depth > 6) { push(a); push(b); push(c); return }
  if (longest === ab) { const m = a.clone().lerp(b, 0.5); subdivide(a, m, c, push, depth + 1); subdivide(m, b, c, push, depth + 1) }
  else if (longest === bc) { const m = b.clone().lerp(c, 0.5); subdivide(a, b, m, push, depth + 1); subdivide(a, m, c, push, depth + 1) }
  else { const m = c.clone().lerp(a, 0.5); subdivide(a, b, m, push, depth + 1); subdivide(m, b, c, push, depth + 1) }
}

function hash(ring) {
  let h = 2166136261
  for (let i = 0; i < Math.min(ring.length, 12); i++) h = Math.imul(h ^ ring[i], 16777619)
  return h >>> 0
}
