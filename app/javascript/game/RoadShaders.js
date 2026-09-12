import * as THREE from "three"
import { noiseTexture } from "game/Textures"

// The shading half of the streets. Every road surface in the world is one of a handful of shared photo materials, so
// all the detail that makes a street look used — wheel tracks polished into the lanes, tar patches, manhole covers,
// the grit and standing water in the gutter, mortar joints in the kerb stones, moss creeping across the pavement, and
// the lane markings themselves — has to come from the fragment shader rather than from geometry or from a texture per
// road. The trick that makes that possible is a single vec4 vertex attribute, aRoad, carrying road-local coordinates:
// how far the vertex sits from the centreline (metres, signed), how far it is along the road (metres), the road's half
// width, and a packed code holding which part of the cross section this is plus a per-road random seed. Road-local
// coordinates are what all of this detail actually wants — a wheel track is a band at a fixed distance from the
// centreline, a manhole sits at a fixed chainage — and because they are interpolated along the ribbon they bend with
// the road instead of swimming over it the way a planar texture does.
//
// The markings are painted the same way, analytically, in their own material. A canvas repeated every 24 m can never
// have a crisp edge (it is a mipmapped bitmap seen at a grazing angle) and its dashes slide when the ribbon's width
// changes; a signed distance evaluated per fragment is exact at every distance, costs nothing to store, and lets the
// Dutch markings be written down as what they are — a 0.10 m kantstreep 0.20 m in from the edge, a 3-9 dashed
// asstreep, haaientanden 1.2 m back from the junction mouth.
//
// Both shaders are injected with onBeforeCompile so the surfaces keep three's lighting, shadows and fog. The wrapping
// binds the previous method first: onBeforeCompile and customProgramCacheKey are prototype methods that read `this`,
// and a saved unbound reference throws at the first render.

// how the cross section is labelled in the packed code; the shader branches on it
export const PART = { ROAD: 0, KERB: 1, WALK: 2, JUNCTION: 3, STRUCTURE: 4 }

// pack a part index (0..4) and a seed in [0, 1) into one float: floor() is the part, fract()/0.9 the seed
export function packCode(part, seed) { return part + Math.min(0.899, Math.max(0, seed)) * 0.9 }
export function unpackCode(code) { const part = Math.floor(code + 1e-4); return { part, seed: (code - part) / 0.9 } }

// A marking pattern and a lane count in one float, as pattern * 8 + lanes. Whole numbers rather than a fraction:
// the shader branches on the pattern, and a branch must not turn on the difference of two nearly equal floats.
export const PATTERN = { NONE: 0, CENTRE: 1, EDGE_CENTRE: 2, LANES: 3, CYCLE: 4 }
export function packPattern(pattern, lanes = 0) { return pattern * 8 + Math.min(7, Math.max(0, lanes)) }
export function unpackPattern(code) { const pattern = Math.floor(code / 8); return { pattern, lanes: code - pattern * 8 } }

const NO_END = 1e4              // metres: "this end of the piece does not meet a junction we must give way to"
export { NO_END }

// ---- shared GLSL -------------------------------------------------------------------------------------------------

// A hash good enough for scattering patches and manholes. Deterministic in road-local metres, so the same manhole
// lands in the same place on every machine and never crawls as the camera moves.
const HASH = `
float rdHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
`

const VERTEX_HEAD = `
attribute vec4 aRoad;
varying vec4 vRoad;
`

// ---- the surface shader ------------------------------------------------------------------------------------------

const surfaced = new WeakSet()

// `sidewalkWidth` is how wide the paved strip behind the kerb is, so the moss knows where the property line is.
export function roadSurface(material, { sidewalkWidth = 1.7, kerbReach = 0.78 } = {}) {
  if (surfaced.has(material)) return material
  surfaced.add(material)
  const prev = material.onBeforeCompile.bind(material)
  const prevKey = material.customProgramCacheKey.bind(material)
  material.onBeforeCompile = (shader) => {
    prev(shader)
    shader.uniforms.uRdNoise = { value: noiseTexture() }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>${VERTEX_HEAD}`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvRoad = aRoad;")
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", `uniform float opacity;
uniform sampler2D uRdNoise;
varying vec4 vRoad;
float rdWet;
${HASH}`)
      .replace("#include <map_fragment>", `#include <map_fragment>
${surfaceBody(sidewalkWidth, kerbReach)}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
\troughnessFactor = clamp(roughnessFactor - 0.6 * clamp(rdWet, 0.0, 1.0), 0.04, 1.0);`)
  }
  material.customProgramCacheKey = () => `${prevKey()}|road-surface`
  return material
}

// The body runs right after the photo has been sampled, so everything here multiplies into a real material.
// `tint` collects the multiplicative darkening and `rdWet` the polish, which the roughness chunk picks up below.
function surfaceBody(sidewalkWidth, kerbReach) {
  return `\t{
\t\tfloat rdAcross = vRoad.x, rdAlong = vRoad.y, rdHw = max(vRoad.z, 0.4);
\t\tfloat rdPart = floor(vRoad.w + 1e-4);
\t\tfloat rdSeed = (vRoad.w - rdPart) / 0.9;
\t\tfloat rdN = clamp(rdAcross / rdHw, -1.0, 1.0);
\t\tfloat grime = texture2D(uRdNoise, vec2(rdAlong * 0.055, rdAcross * 0.13) + rdSeed).r;
\t\tfloat fine = texture2D(uRdNoise, vec2(rdAlong * 0.33, rdAcross * 0.44) + rdSeed * 0.7).r;
\t\tfloat tint = 1.0;
\t\trdWet = 0.0;
\t\tif (rdPart < 0.5) {
\t\t\t// Wheel tracks. Two tracks per lane: on a two-lane road the lanes sit at ±0.5 of the half width and the
\t\t\t// tyres at ±0.26 and ±0.72, which is where the surface is polished smooth and stained darker than the
\t\t\t// untravelled crown and the gritty edge. This is the single strongest cue that a road is driven on.
\t\t\tfloat t = min(abs(abs(rdN) - 0.26), abs(abs(rdN) - 0.72));
\t\t\tfloat track = (1.0 - smoothstep(0.03, 0.19, t)) * (0.55 + 0.45 * grime);
\t\t\ttint *= 1.0 - 0.17 * track;
\t\t\trdWet += 0.40 * track;
\t\t}
\t\tif (rdPart < 0.5 || (rdPart > 2.5 && rdPart < 3.5)) {
\t\t\t// Patched repairs: a coarse grid in road-local metres, one cell in six cut out and relaid. The seam is
\t\t\t// drawn as a thin dark line just inside the cell so the patch reads as a rectangle of newer, blacker tar.
\t\t\tvec2 cell = vec2(rdAlong, rdAcross) / vec2(7.0, 2.4);
\t\t\tfloat ph = rdHash(floor(cell) + rdSeed * 37.0);
\t\t\tvec2 f = fract(cell);
\t\t\tfloat edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
\t\t\tfloat has = step(0.83, ph);
\t\t\tfloat patch = has * smoothstep(0.05, 0.09, edge);
\t\t\tfloat seam = has * (1.0 - smoothstep(0.0, 0.03, abs(edge - 0.07)));
\t\t\ttint *= 1.0 - 0.14 * patch - 0.22 * seam;
\t\t\trdWet += 0.18 * patch;

\t\t\t// Manhole covers and gully gratings: one candidate every 21 m of road, present in a bit under two thirds
\t\t\t// of them, placed across the width by its own hash. Cast iron is darker, smoother and faintly ringed.
\t\t\tfloat cl = floor(rdAlong / 21.0);
\t\t\tfloat hp = rdHash(vec2(cl * 3.0 + 1.0, rdSeed * 41.0));
\t\t\tfloat ha = rdHash(vec2(cl + 11.0, rdSeed * 5.0));
\t\t\tfloat hx = rdHash(vec2(cl, rdSeed * 17.0 + 3.0));
\t\t\tvec2 md = vec2(rdAlong - (cl + 0.2 + 0.6 * ha) * 21.0, rdAcross - (hx * 1.3 - 0.65) * rdHw);
\t\t\tfloat r = length(md);
\t\t\tfloat lid = step(hp, 0.62) * (1.0 - smoothstep(0.29, 0.315, r));
\t\t\tfloat ring = 0.5 + 0.5 * cos(r * 78.0);
\t\t\ttint *= 1.0 - lid * (0.36 - 0.12 * ring);
\t\t\trdWet += 0.45 * lid;

\t\t\t// The gutter: grit washes to the low point of the camber and sits there, and after rain it holds water.
\t\t\tfloat gut = smoothstep(0.70, 0.99, abs(rdN));
\t\t\tfloat puddle = gut * smoothstep(0.56, 0.80, texture2D(uRdNoise, vec2(rdAlong * 0.028, rdAcross * 0.05) + 7.3).r);
\t\t\ttint *= 1.0 - 0.13 * gut * grime - 0.30 * puddle;
\t\t\trdWet += 0.95 * puddle;
\t\t}
\t\tif (rdPart > 0.5 && rdPart < 1.5) {
\t\t\t// Kerb stones: a mortar joint every metre, and the face and channel stained by everything the gutter carries.
\t\t\tfloat j = min(fract(rdAlong), 1.0 - fract(rdAlong));
\t\t\ttint *= 1.0 - 0.42 * (1.0 - smoothstep(0.0, 0.028, j));
\t\t\tfloat kd = abs(rdAcross) - rdHw;
\t\t\ttint *= 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.45, kd)) * (0.55 + 0.45 * grime);
\t\t\trdWet += 0.55 * (1.0 - smoothstep(0.0, 0.32, kd));
\t\t}
\t\tif (rdPart > 1.5 && rdPart < 2.5) {
\t\t\t// Pavement: the paver joints are in the photo already, so all this adds is dirt near the kerb and the moss
\t\t\t// that grows along the property line where nobody walks and the buildings keep the sun off.
\t\t\tfloat sd = abs(rdAcross) - rdHw - ${kerbReach.toFixed(3)};
\t\t\ttint *= 0.93 + 0.12 * grime;
\t\t\tfloat moss = smoothstep(0.58, 0.95, fine) * smoothstep(${(sidewalkWidth * 0.45).toFixed(3)}, ${sidewalkWidth.toFixed(3)}, sd) * 0.5;
\t\t\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.23, 0.29, 0.13), moss);
\t\t}
\t\tif (rdPart > 3.5) {
\t\t\t// Parapets and pillars: rain streaks down concrete, so darken with height below each horizontal band.
\t\t\ttint *= 0.88 + 0.20 * grime;
\t\t}
\t\tdiffuseColor.rgb *= tint;
\t}`
}

// ---- the markings shader -----------------------------------------------------------------------------------------

// Signed-distance helpers. `aa` is half a fragment in the same units as the coordinate, so an edge lands exactly on
// the geometric boundary and resolves through alphaToCoverage instead of stair-stepping.
const MARK_HELPERS = `
float rdStripe(float x, float c, float h, float aa) { return 1.0 - smoothstep(-aa, aa, abs(x - c) - h); }
float rdDash(float s, float on, float period, float aa) {
\tfloat f = mod(s, period);
\treturn 1.0 - smoothstep(-aa, aa, max(-f, f - on));
}
// Haaientanden: a row of triangles pointing back at the driver, their bases on the give-way line. The lane
// argument is the distance from the centreline on the approaching side, s the distance to the junction mouth.
float rdTeeth(float lane, float s, float hw, float aaA, float aaL) {
\tif (s > 60.0 || lane < 0.10 || lane > hw - 0.05) return 0.0;
\tfloat f = clamp((s - 1.20) / 0.50, 0.0, 1.0);
\tfloat x = mod(lane - 0.25, 1.0) - 0.5;
\tfloat cov = 1.0 - smoothstep(-aaA, aaA, abs(x) - 0.26 * f);
\treturn cov * (1.0 - smoothstep(-aaL, aaL, abs(s - 1.45) - 0.25));
}
`

const marked = new WeakSet()

export function roadMarkings(material) {
  if (marked.has(material)) return material
  marked.add(material)
  const prev = material.onBeforeCompile.bind(material)
  const prevKey = material.customProgramCacheKey.bind(material)
  material.onBeforeCompile = (shader) => {
    prev(shader)
    shader.uniforms.uRdNoise = { value: noiseTexture() }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>${VERTEX_HEAD}
attribute vec2 aEnds;
varying vec2 vEnds;`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvRoad = aRoad;\n\tvEnds = aEnds;")
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", `uniform float opacity;
uniform sampler2D uRdNoise;
varying vec4 vRoad;
varying vec2 vEnds;
${MARK_HELPERS}`)
      .replace("#include <map_fragment>", `#include <map_fragment>
${MARK_BODY}`)
  }
  material.customProgramCacheKey = () => `${prevKey()}|road-markings`
  return material
}

const MARK_BODY = `\t{
\t\tfloat across = vRoad.x, along = vRoad.y, hw = max(vRoad.z, 0.4);
\t\tfloat pattern = floor(vRoad.w / 8.0 + 0.001);
\t\tfloat lanes = vRoad.w - pattern * 8.0;
\t\tfloat aaA = fwidth(across) * 0.8 + 0.0006;
\t\tfloat aaL = fwidth(along) * 0.8 + 0.0006;
\t\tfloat cov = 0.0;
\t\tif (pattern > 1.5 && pattern < 3.5) {
\t\t\t// Kantstrepen: a continuous 0.10 m line whose outer edge sits 0.15 m in from the asphalt edge.
\t\t\tcov = max(cov, rdStripe(abs(across), hw - 0.20, 0.05, aaA));
\t\t}
\t\tif (pattern < 2.5) {
\t\t\t// Asstreep, the 3-9 dashed centre line the Netherlands uses on every undivided road.
\t\t\tcov = max(cov, rdStripe(across, 0.0, 0.05, aaA) * rdDash(along + 1.0, 3.0, 12.0, aaL));
\t\t}
\t\tif (pattern > 2.5 && pattern < 3.5) {
\t\t\t// Lane dividers on a dual carriageway: the same 3-9 dash, one per lane boundary, no centre line.
\t\t\tfor (int k = 1; k < 4; k++) {
\t\t\t\tif (float(k) >= lanes) break;
\t\t\t\tfloat c = -hw + 2.0 * hw * float(k) / lanes;
\t\t\t\tcov = max(cov, rdStripe(across, c, 0.05, aaA) * rdDash(along + float(k) * 3.0, 3.0, 12.0, aaL));
\t\t\t}
\t\t}
\t\tif (pattern > 3.5) {
\t\t\t// A wide fietspad gets a fine 1-1 dashed centre line over the red surfacing.
\t\t\tcov = max(cov, rdStripe(across, 0.0, 0.045, aaA) * rdDash(along, 1.0, 2.0, aaL));
\t\t}
\t\tcov = max(cov, rdTeeth(-across, vEnds.y, hw, aaA, aaL));
\t\tcov = max(cov, rdTeeth(across, vEnds.x, hw, aaA, aaL));
\t\tfloat wear = texture2D(uRdNoise, vec2(along * 0.09, across * 0.35)).r;
\t\tdiffuseColor.a *= clamp(cov * (0.72 + 0.45 * wear), 0.0, 1.0);
\t\tdiffuseColor.rgb *= 0.86 + 0.16 * wear;
\t}`

// The markings material: opaque with an alpha test so it stays out of the sorted transparent pass, and
// alphaToCoverage so the cut edge resolves against the multisampled buffer instead of crawling.
export function markingMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0xeceae0, roughness: 0.62, metalness: 0.0,
    alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  })
  m.alphaToCoverage = true
  m.__shared = true
  return roadMarkings(m)
}
