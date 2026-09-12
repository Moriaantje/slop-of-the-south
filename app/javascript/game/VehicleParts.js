import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { noiseTexture } from "game/Textures"
import { off } from "game/Flags"

// The coachbuilding kit every vehicle in Vehicles.js is panelled from, and the reason the fleet stopped looking like
// stacked crates. Three ideas carry it. First, shape comes from lofting rather than from boxes: one closed cross
// section swept through a handful of stations, each station scaling and shifting it, which is how a real body is
// drawn (a section that swells over the wheels, narrows at the nose, leans in at the roof) and costs a fraction of
// the triangles that a pile of boxes does. Second, every part a vehicle owns is thrown into a bucket per material
// and the buckets are merged into one mesh each, so a car can have sixty separate pieces and still cost six draw
// calls; the matte bucket carries its colour in a vertex attribute so bumpers, seats, tyres and the driver all share
// a single material. Third, the paint is a clearcoat over a metallic base with grime injected low on the panels,
// because the single thing that separates car paint from plastic is the sharp second specular lobe of the lacquer
// and the dirt line that every car picks up off its own wheels. ?clearcoat=0 drops the second lobe on weak GPUs.
const PAINT_ROUGH = 0.36          // roughness of the metallic base coat under the lacquer
const PAINT_METAL = 0.55          // how much of the base coat is flake
const CLEARCOAT_ROUGH = 0.06      // the lacquer itself is almost mirror smooth
const GRIME_LOW = 0.20            // metres above the body origin: below this a panel is fully grimy
const GRIME_HIGH = 1.05           // metres: above this the paint is clean
const GRIME_SCALE = 0.55          // repeats of the noise texture per metre of body
const FLAKE_SCALE = 9.0           // repeats per metre of the fine metallic sparkle
const LATHE_SEG = 18              // radial segments of tyres, rims, domes and pipes
const TYRE_LUGS = 16              // tread blocks around the circumference
const RIM_SPOKES = 5
const CLEARCOAT = !off("clearcoat")

// ---- materials -----------------------------------------------------------------------------------------------

// Car paint: a coloured metallic base with a clear lacquer over it, plus the dirt every car throws up its own
// flanks. The grime is driven by the body-space height of the fragment, so it hugs the sills and the lower doors
// and leaves the roof clean, exactly where road spray lands. The cache key is constant so every car in the world
// shares one compiled program no matter how many colours are on the road.
export function carPaint(color) {
  const m = new THREE.MeshPhysicalMaterial({ color, metalness: PAINT_METAL, roughness: PAINT_ROUGH,
    clearcoat: CLEARCOAT ? 1 : 0, clearcoatRoughness: CLEARCOAT_ROUGH, envMapIntensity: 1.35 })
  // both of these may be three's own prototype methods, which read `this`: bind before wrapping
  const prev = m.onBeforeCompile.bind(m)
  const prevKey = m.customProgramCacheKey.bind(m)
  m.onBeforeCompile = (shader) => {
    prev(shader)
    shader.uniforms.uGrime = { value: noiseTexture() }
    shader.uniforms.uGrimeLow = { value: GRIME_LOW }
    shader.uniforms.uGrimeHigh = { value: GRIME_HIGH }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vBodyP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvBodyP = transformed;")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
uniform sampler2D uGrime;
uniform float uGrimeLow;
uniform float uGrimeHigh;
varying vec3 vBodyP;
float vpGrime;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
\tvpGrime = texture2D(uGrime, vBodyP.xz * ${GRIME_SCALE.toFixed(2)} + vBodyP.y * 0.21).r;
\tvpGrime *= 1.0 - smoothstep(uGrimeLow, uGrimeHigh, vBodyP.y);
\tvpGrime = clamp(vpGrime * 1.45 - 0.18, 0.0, 1.0);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.40 + vec3(0.085, 0.075, 0.062), vpGrime);
\tfloat vpFlake = texture2D(uGrime, vBodyP.xy * ${FLAKE_SCALE.toFixed(1)}).r;
\tdiffuseColor.rgb *= 0.955 + 0.09 * vpFlake;`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = clamp(roughnessFactor + 0.5 * vpGrime, 0.04, 1.0);")
  }
  m.customProgramCacheKey = () => prevKey() + "|carpaint"
  return m
}

// The one material every dull part shares: bumpers, grilles, seats, tyres, the driver's jacket, the tracks. Colour
// rides in the vertex attribute so all of it merges into a single draw call.
const matteMaterial = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0.06 })
const chromeMaterial = () => new THREE.MeshStandardMaterial({ color: 0xcfd6de, roughness: 0.15, metalness: 1, envMapIntensity: 1.7 })
// Glass is faked rather than refracted: real transmission costs a scene copy per frame. A very smooth, very dark
// almost-metal picks up the sky environment map hard at grazing angles, which is what actually reads as glass.
const glassMaterial = () => new THREE.MeshPhysicalMaterial({ color: 0x0c141d, roughness: 0.04, metalness: 0.25,
  clearcoat: CLEARCOAT ? 1 : 0, clearcoatRoughness: 0.02, envMapIntensity: 2.2, transparent: true, opacity: 0.78, depthWrite: false })
const rubberMaterial = () => new THREE.MeshStandardMaterial({ color: 0x16171b, roughness: 0.93, metalness: 0 })

export function vehicleMaterials(color) {
  return {
    paint: carPaint(color),
    matte: matteMaterial(),
    chrome: chromeMaterial(),
    glass: glassMaterial(),
    rubber: rubberMaterial(),
    head: new THREE.MeshStandardMaterial({ color: 0xfff8e6, emissive: 0xfff0c8, emissiveIntensity: 0.35, roughness: 0.12, metalness: 0 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x5a0c0c, emissive: 0xff1a12, emissiveIntensity: 0.12, roughness: 0.16, metalness: 0 }),
  }
}

// ---- the builder ---------------------------------------------------------------------------------------------

const KEEP = ["position", "normal", "uv"]

// Everything that goes into a bucket is flattened to the same attribute set, because mergeGeometries refuses a mix
// of indexed and non-indexed input and of differing attributes. The vertex counts here are in the thousands, so
// giving up the index buffer costs nothing measurable and removes a whole class of merge failure.
function plain(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo
  for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name)
  return g
}

function tinted(g, hex) {
  const c = new THREE.Color(hex)
  const n = g.attributes.position.count, arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3))
  return g
}

// One movable piece of a vehicle (the shell, a turret, a boom, a wheel): parts are collected per material and
// flushed into one merged mesh each when the vehicle is finished.
class Section {
  constructor(mats, target) { this.mats = mats; this.target = target; this.buckets = new Map() }

  add(key, geo, tint) {
    const g = plain(geo)
    if (this.mats[key]?.vertexColors) tinted(g, tint ?? 0x9a9a9a)
    if (!this.buckets.has(key)) this.buckets.set(key, [])
    this.buckets.get(key).push(g)
    return this
  }

  put(key, geo, tint) { return this.add(key, geo, tint) }
  paint(geo) { return this.add("paint", geo) }
  matte(geo, tint) { return this.add("matte", geo, tint) }
  chrome(geo) { return this.add("chrome", geo) }
  glass(geo) { return this.add("glass", geo) }
  rubber(geo) { return this.add("rubber", geo) }
  head(geo) { return this.add("head", geo) }
  tail(geo) { return this.add("tail", geo) }

  flush() {
    for (const [key, geos] of this.buckets) {
      const geo = geos.length === 1 ? geos[0] : (mergeGeometries(geos, false) ?? geos[0])
      const mesh = new THREE.Mesh(geo, this.mats[key])
      if (key === "glass") mesh.renderOrder = 2
      this.target.add(mesh)
    }
    this.buckets.clear()
  }
}

// `mats` is either a colour (the vehicle material set is built for it) or a ready-made map of name → material, so
// the mech can borrow the same merging machinery with a completely different palette.
export class Kit {
  constructor(mats) { this.mats = typeof mats === "number" ? vehicleMaterials(mats) : mats; this.sections = [] }
  section(target) { const s = new Section(this.mats, target); this.sections.push(s); return s }
  build() { for (const s of this.sections) s.flush(); return this.mats }
}

// ---- geometry ------------------------------------------------------------------------------------------------

// A closed rounded cross section, counter-clockwise in XY as seen from +z, for loft() to sweep.
export function profile(w, h, r, seg = 3) {
  const x = w / 2, y = h / 2
  r = Math.min(r, x, y)
  const pts = []
  const corners = [[x - r, y - r, 0], [-(x - r), y - r, Math.PI / 2], [-(x - r), -(y - r), Math.PI], [x - r, -(y - r), -Math.PI / 2]]
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2)
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
  }
  return pts
}

// Sweep `profile` through `stations` ({ z, sx, sy, ox, oy }) and skin it. The caps are fans from the centre of the
// end station, which is exact for the convex sections used here.
export function loft(shape, stations, { capFront = true, capBack = true } = {}) {
  const n = shape.length, s = stations.length
  const pos = [], uvs = [], idx = []
  for (let j = 0; j < s; j++) {
    const st = stations[j]
    for (let i = 0; i < n; i++) {
      pos.push(shape[i][0] * st.sx + (st.ox ?? 0), shape[i][1] * (st.sy ?? st.sx) + (st.oy ?? 0), st.z)
      uvs.push(i / n, j / Math.max(1, s - 1))
    }
  }
  for (let j = 0; j < s - 1; j++) for (let i = 0; i < n; i++) {
    const a = j * n + i, b = j * n + (i + 1) % n, c = (j + 1) * n + i, d = (j + 1) * n + (i + 1) % n
    idx.push(a, b, c, b, d, c)
  }
  const cap = (j, front) => {
    const st = stations[j], centre = pos.length / 3
    pos.push(st.ox ?? 0, st.oy ?? 0, st.z); uvs.push(0.5, 0.5)
    for (let i = 0; i < n; i++) {
      const a = j * n + i, b = j * n + (i + 1) % n
      if (front) idx.push(centre, b, a); else idx.push(centre, a, b)
    }
  }
  if (capFront) cap(0, true)
  if (capBack) cap(s - 1, false)
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

// A box with its edges taken off: an extruded rounded rectangle, so every panel catches a highlight along its
// corners instead of dying into a hard black edge the way a BoxGeometry does.
export function panel(w, h, d, { r = 0.1, bevel = 0.035, seg = 2 } = {}) {
  const b = Math.min(bevel, w / 4, h / 4, d / 4)
  const shape = roundedShape(Math.max(0.01, w - 2 * b), Math.max(0.01, h - 2 * b), r)
  const depth = Math.max(0.01, d - 2 * b)
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 1, curveSegments: seg, steps: 1 })
  g.translate(0, 0, -depth / 2)
  return g
}

function roundedShape(w, h, r) {
  const x = w / 2, y = h / 2
  const rr = Math.min(r, x * 0.98, y * 0.98)
  const s = new THREE.Shape()
  s.moveTo(-x + rr, -y)
  s.lineTo(x - rr, -y); s.quadraticCurveTo(x, -y, x, -y + rr)
  s.lineTo(x, y - rr); s.quadraticCurveTo(x, y, x - rr, y)
  s.lineTo(-x + rr, y); s.quadraticCurveTo(-x, y, -x, y - rr)
  s.lineTo(-x, -y + rr); s.quadraticCurveTo(-x, -y, -x + rr, -y)
  return s
}

// A revolved profile ([[radius, axial], …]) around the y axis: domes, pipes, rims, tyre carcasses. LatheGeometry
// derives its normals from the direction the profile travels, so a list written top-down comes out inside-out; the
// guard flips it rather than leaving that as a trap for every caller.
export function revolve(pts, seg = LATHE_SEG) {
  const p = pts[pts.length - 1][1] < pts[0][1] ? [...pts].reverse() : pts
  return new THREE.LatheGeometry(p.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y)), seg)
}

// A cylinder between two points, for arms, chains, roll bars and hydraulic rams.
export function strut(ax, ay, az, bx, by, bz, r, seg = 8) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz) || 1e-4
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1)
  const q = new THREE.Quaternion().setFromUnitVectors(UP, _v.set(dx, dy, dz).normalize())
  g.applyQuaternion(q)
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
  return g
}
const UP = new THREE.Vector3(0, 1, 0)
const _v = new THREE.Vector3()

// A wheel arch: half a torus laid over the wheel, flattened along the axle so it reads as a pressed steel lip
// rather than a length of pipe.
export function arch(r, tube, width) {
  const g = new THREE.TorusGeometry(r, tube, 5, 12, Math.PI)
  g.rotateY(Math.PI / 2)
  g.scale(width / (tube * 2), 1, 1)
  return g
}

// ---- wheels --------------------------------------------------------------------------------------------------

// A tyre with a real sidewall: the carcass is a revolved section that bulges out to the tread and tucks back to the
// bead, and the tread is a ring of lug blocks merged into it. Sixteen lugs are three hundred triangles and are the
// difference between "cylinder" and "tyre" from the chase camera, so they are worth every one of them. Everything
// here is built with the axle along y (that is the frame revolve() works in) and swung onto x at the end, because
// Suspension spins the wheel with mesh.rotation.x.
export function tyreGeometry(r, width, lugs = TYRE_LUGS) {
  const w = width / 2
  const carcass = revolve([
    [r * 0.56, -w], [r * 0.74, -w * 0.98], [r * 0.90, -w * 0.92], [r * 0.975, -w * 0.70],
    [r, -w * 0.42], [r, w * 0.42], [r * 0.975, w * 0.70], [r * 0.90, w * 0.92], [r * 0.74, w * 0.98], [r * 0.56, w],
  ])
  const parts = [carcass]
  for (let i = 0; i < lugs; i++) {
    // x is tangential, y axial along the axle, z the radial thickness of the block
    const g = new THREE.BoxGeometry(r * 0.30, width * 0.80, r * 0.09)
    g.rotateZ(i % 2 ? 0.13 : -0.13)                      // a chevron, so the tread has a direction
    g.translate(0, 0, r * 0.975)                         // out onto the tread band
    g.rotateY((i / lugs) * Math.PI * 2)                  // and round the axle
    parts.push(g)
  }
  const merged = mergeGeometries(parts.map(plain), false) ?? plain(carcass)
  merged.rotateZ(Math.PI / 2)
  return merged
}

// An alloy rim: a barrel, a dished face, spokes standing proud of it and a centre cap. `outboard` is +1 or -1 so
// the pretty side faces away from the car on both flanks (after the swing onto x, +y lands on -x, the left side).
export function rimGeometry(r, width, outboard = 1) {
  const w = width / 2, o = outboard
  const barrel = new THREE.CylinderGeometry(r * 0.60, r * 0.60, width * 0.92, LATHE_SEG, 1, true)
  const face = revolve([[0.001, o * w * 0.50], [r * 0.22, o * w * 0.52], [r * 0.40, o * w * 0.56],
                        [r * 0.56, o * w * 0.64], [r * 0.61, o * w * 0.74], [r * 0.61, o * w * 0.90]])
  const parts = [barrel, face]
  for (let i = 0; i < RIM_SPOKES; i++) {
    const s = new THREE.BoxGeometry(r * 0.14, width * 0.10, r * 0.44)
    s.translate(0, o * w * 0.62, r * 0.33)
    s.rotateY((i / RIM_SPOKES) * Math.PI * 2)
    parts.push(s)
  }
  const cap = new THREE.CylinderGeometry(r * 0.15, r * 0.17, width * 0.16, 10)
  cap.translate(0, o * w * 0.74, 0)
  parts.push(cap)
  const merged = mergeGeometries(parts.map(plain), false) ?? plain(barrel)
  merged.rotateZ(Math.PI / 2)
  return merged
}
