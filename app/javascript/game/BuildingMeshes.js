import * as THREE from "three"
import { foldable, scaleRange, hullXZ, buildingHp } from "game/Destructibles"
import { pbr, pbrEnabled, weathered } from "game/Textures"
import { LOOK } from "game/TerrainTile"
import { TUNING as T, mulberry32 } from "game/Tuning"
import { off } from "game/Flags"

// 3D BAG LoD2.2 buildings: faces (roof planes and walls) triangulated here with earcut and merged into a few
// flat-shaded meshes per tile, one per photo material (two bricks, plaster, roof tiles, flat-roof concrete and the
// painted woodwork of the trim). Tile format per building: { id, roof, o: [x, y, z], f: [[label, outer, hole, ...]] }
// where rings are flat centimetre offsets [dx, dy, dz, ...] from o, or metres when the part carries `s: 1` (the
// footprint fallback in Buildings.js builds its parts that way). Label 1 = roof, 2 = wall. `fp` holds the ground
// outline as flat [x, z, ...] rings in game units. Each face gets planar UVs in metres from its own basis (u along
// the eave / wall, v up or up-slope, courses starting at the building's base), so bricks and tiles stay level on
// every plane. With `reg` every building registers a destructible handle: its vertex ranges in the merged
// geometries, collapsed when it falls (Destructibles only ever calls remove()/tint()).
//
// What the raw BAG faces never give you is the thousand small things that make a house read as built rather than
// extruded, so they are generated here from the faces we already have and from the building's id hash, which means
// they land in the same place on every load. The roof is extruded past the wall along its own plane with a fascia
// board and a half-round gutter hanging off it, the ridge gets a tile cap and a chimney, one downpipe runs to the
// ground, and a flat roof gets a parapet instead of an open edge. All of it is appended inside the building's own
// vertex range, so a collapsing building takes its chimney down with it.
//
// The façade itself is painted by the wall shader from a per-face attribute (u from the face's left edge, v from the
// base, width, height) plus a packed style index: a grid of 3 m cells per 3 m floor, the opening cut twice — once at
// the wall face and once a reveal deeper, so the strip between the two cuts shades as a real jamb — interior mapping
// behind the glass, a sill and a lintel, a plinth at the foot, quoins up the corners, and for the Limburg mix either
// brick, painted plaster, half-timbering or sawn marl blocks. No geometry, no extra textures: a few dozen shader
// instructions per fragment, one program for all walls.
const OVERHANG = 0.42          // m the roof projects past the wall, measured down the slope
const FASCIA = 0.20            // m the fascia board hangs below the projected roof edge
const GUTTER_OUT = 0.07        // m the gutter stands proud of the fascia
const GUTTER_H = 0.11          // m of gutter face
const RIDGE_W = 0.17           // m the ridge cap covers either side of the ridge line
const RIDGE_UP = 0.09          // m the ridge cap stands above the ridge line
const RIDGE_DROP = 0.05        // m it falls again at its outer edge
const CHIM_W = 0.62, CHIM_D = 0.46           // m, along and across the ridge
const CHIM_LO = 0.85, CHIM_HI = 1.75         // m of chimney above the ridge
const CHIM_SINK = 0.7          // m the chimney continues below the ridge so it never shows a gap
const PIPE_R = 0.055           // m radius of the downpipe
const PARAPET = 0.55, PARAPET_T = 0.28       // m high and m thick, round a flat roof
const EAVE_MIN = 1.0           // m: shorter roof edges get no overhang
const RIM_MIN = 1.6            // m: shorter flat-roof edges get no parapet
const FLAT_TOL = 0.06          // m either side of the lowest / highest point that still counts as the eave / ridge
const LEVEL_TOL = 0.12         // m of height difference an "horizontal" roof edge may have
const MAX_EAVES = 8, MAX_RIDGES = 4, MAX_RIMS = 8      // per building, so a church does not cost a thousand quads
const CHIM_MIN_RIDGE = 2.5     // m of ridge before a chimney is worth placing
const REVEAL = 0.13            // m the glass sits behind the wall face
const CHAMFER = 0.14           // m of corner the bent normal covers
const PLINTH = 0.55            // m of base course at the foot of a wall
// ?trim=0 drops every generated piece (roughly seventy vertices a building) for a machine that cannot afford them
const TRIM_ON = !off("trim")

const WIN_UNIFORMS = {
  uWinLit: { value: 0.35 }, uWinGlow: { value: 1.4 },
  uReveal: { value: REVEAL }, uChamfer: { value: CHAMFER }, uPlinth: { value: PLINTH },
}

function windows(m) {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uDark: LOOK.uDark, ...WIN_UNIFORMS })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 faceInfo;\nattribute vec2 faceMeta;\nvarying vec4 vFace;\nvarying vec2 vMeta;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvFace = faceInfo; vMeta = faceMeta;")
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", `uniform float opacity;
uniform float uDark, uWinLit, uWinGlow, uReveal, uChamfer, uPlinth;
varying vec4 vFace; varying vec2 vMeta;
float winHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// Interior mapping (van Dongen, 2008): the view ray enters the window and hits the back, side, floor or ceiling of
// a virtual room the size of the cell, so the glass shows depth and parallax without any geometry.
vec3 roomLook(vec3 r, vec2 pm, float roomW, float roomH, float depth, float rseed) {
\tvec3 p = vec3(pm, 0.0);
\tfloat tz = depth / max(-r.z, 1e-4);
\tfloat tx = r.x > 0.0 ? (roomW - p.x) / max(r.x, 1e-4) : (r.x < 0.0 ? -p.x / min(r.x, -1e-4) : 1e9);
\tfloat ty = r.y > 0.0 ? (roomH - p.y) / max(r.y, 1e-4) : (r.y < 0.0 ? -p.y / min(r.y, -1e-4) : 1e9);
\tfloat t = min(tz, min(tx, ty));
\tvec3 hue = mix(vec3(0.82, 0.74, 0.62), vec3(0.72, 0.78, 0.84), winHash(vec2(rseed * 5.1, 2.7)));
\tvec3 col = hue;                                                     // back wall
\tif (tx < tz && tx <= ty) col = hue * 0.72;                           // a side wall, in shade
\tif (ty < tz && ty < tx) col = r.y < 0.0 ? vec3(0.32, 0.22, 0.14) : vec3(0.92, 0.9, 0.86);   // floor, ceiling
\tvec3 hit = p + r * t;
\tfloat lamp = 1.0 - smoothstep(0.35, 0.9, distance(hit.xy / vec2(roomW, roomH), vec2(0.5, 0.75)));   // a light on the back wall
\treturn col * (0.55 + 0.45 * (1.0 - t / (depth * 1.6))) + lamp * 0.25;
}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
\tfloat win = 0.0, frame = 0.0, lit = 0.0, door = 0.0, reveal = 0.0, trimBand = 0.0;
\tvec2 revealDir = vec2(0.0);
\tvec3 glass = vec3(0.1, 0.12, 0.15);
\tfloat W = vFace.z, H = vFace.w, base = vMeta.x;
\tfloat style = floor(vMeta.y), fseed = fract(vMeta.y);
\tfloat fv = vFace.y - base;                                            // height above this face's own bottom
\tfloat pw = fwidth(vFace.x) + fwidth(vFace.y) + 0.004;
\tfloat detail = clamp(0.06 / pw, 0.0, 1.0);                            // the fine lines dissolve rather than shimmer
\t// the view ray in the face's own frame: x along the wall, y up, z out of it. The cross product degenerates on the
\t// horizontal caps of a parapet or a chimney, so it is guarded rather than normalised blind.
\tmat3 toWorld = transpose(mat3(viewMatrix));
\tvec3 nW = normalize(toWorld * normalize(vNormal));
\tvec3 tW = cross(vec3(0.0, 1.0, 0.0), nW);
\tfloat tLen = length(tW);
\ttW = tLen > 1e-3 ? tW / tLen : vec3(1.0, 0.0, 0.0);
\tvec3 bW = cross(nW, tW);
\tvec3 rW = toWorld * (-normalize(vViewPosition));
\tvec3 ray = vec3(dot(rW, tW), dot(rW, bW), dot(rW, nW));
\tif (ray.z > -0.06) ray.z = -0.06;
\t{
\t\tconst float floorH = 3.0, cellW = 3.0;
\t\tfloat ncols = floor((W - 1.2) / cellW);
\t\tfloat rows = floor((H - 0.35 + 0.6) / floorH);
\t\t// not every face has windows, and the big blank walls of sheds and halls have few: a per-face draw against its area
\t\tfloat faceDraw = winHash(vec2(fseed * 31.0, W * 0.37 + H * 0.91));
\t\tfloat faceKeep = mix(0.9, 0.3, clamp(W * H / 600.0, 0.0, 1.0));
\t\tif (ncols >= 1.0 && rows >= 1.0 && faceDraw < faceKeep) {
\t\t\tfloat margin = (W - ncols * cellW) * 0.5;
\t\t\tfloat cu = (vFace.x - margin) / cellW, cv = (fv - 0.35) / floorH;
\t\t\tfloat ci = floor(cu), ri = floor(cv);
\t\t\tif (ci >= 0.0 && ci < ncols && ri >= 0.0 && ri < rows) {
\t\t\t\tvec2 cell = vec2(cellW, floorH);
\t\t\t\tvec2 c = vec2(fract(cu), fract(cv));
\t\t\t\tvec2 aa = fwidth(c) * 1.2 + 0.002;
\t\t\t\tfloat cellDraw = winHash(vec2(ci, ri) + fseed * 17.0);
\t\t\t\tfloat doorCol = floor(winHash(vec2(fseed * 3.0, W)) * ncols);
\t\t\t\tbool isDoor = ri == 0.0 && ci == doorCol && base < 0.5;
\t\t\t\tvec2 lo = isDoor ? vec2(0.36, 0.02) : vec2(0.33, 0.30), hi = isDoor ? vec2(0.64, 0.72) : vec2(0.67, 0.72);
\t\t\t\tif (isDoor || cellDraw > 0.22) {
\t\t\t\t\t// the opening cut at the wall face, and the same opening a reveal deeper: between the two lies the jamb
\t\t\t\t\tvec2 par = ray.xy * (uReveal / -ray.z) / cell;
\t\t\t\t\tvec2 cIn = c + par;
\t\t\t\t\tvec2 inner = smoothstep(lo - aa, lo + aa, c) * (1.0 - smoothstep(hi - aa, hi + aa, c));
\t\t\t\t\tvec2 deep = smoothstep(lo - aa, lo + aa, cIn) * (1.0 - smoothstep(hi - aa, hi + aa, cIn));
\t\t\t\t\tvec2 outer = smoothstep(lo - 0.05 - aa, lo - 0.05 + aa, c) * (1.0 - smoothstep(hi + 0.05 - aa, hi + 0.05 + aa, c));
\t\t\t\t\tfloat cut = inner.x * inner.y, pane = cut * deep.x * deep.y;
\t\t\t\t\tframe = max(outer.x * outer.y - cut, 0.0);
\t\t\t\t\treveal = cut - pane;
\t\t\t\t\trevealDir = par;
\t\t\t\t\tif (isDoor) door = pane; else win = pane;
\t\t\t\t\tlit = step(1.0 - uWinLit, winHash(vec2(ri, ci) * 3.1 + fseed)) * (0.55 + 0.45 * winHash(vec2(ci * 7.0, ri) + fseed));
\t\t\t\t\tif (pane > 0.0) {
\t\t\t\t\t\tvec3 room = roomLook(ray, clamp(cIn, 0.0, 1.0) * cell, cellW, floorH, 3.5, fseed + ci * 0.13 + ri * 0.71);
\t\t\t\t\t\tfloat inside = mix(0.12, 0.05, uDark) + lit * uDark * 0.9;      // dim by day against the sky, lamplit at night
\t\t\t\t\t\tglass = room * inside;
\t\t\t\t\t}
\t\t\t\t\t// a stone sill under the opening and a lintel over it, both standing proud of the brick
\t\t\t\t\tvec2 mm = c * cell;
\t\t\t\t\tfloat aam = fwidth(mm.y) + 0.006;
\t\t\t\t\tfloat inX = smoothstep(lo.x * cellW - 0.12 - aam, lo.x * cellW - 0.12 + aam, mm.x) * (1.0 - smoothstep(hi.x * cellW + 0.12 - aam, hi.x * cellW + 0.12 + aam, mm.x));
\t\t\t\t\tfloat sill = inX * smoothstep(lo.y * floorH - 0.16 - aam, lo.y * floorH - 0.16 + aam, mm.y) * (1.0 - smoothstep(lo.y * floorH - 0.02 - aam, lo.y * floorH - 0.02 + aam, mm.y));
\t\t\t\t\tfloat lint = inX * smoothstep(hi.y * floorH + 0.02 - aam, hi.y * floorH + 0.02 + aam, mm.y) * (1.0 - smoothstep(hi.y * floorH + 0.15 - aam, hi.y * floorH + 0.15 + aam, mm.y));
\t\t\t\t\ttrimBand = max(sill, lint * 0.85) * (1.0 - cut);
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t// the façade's own surface: the Limburg mix of brick, painted plaster, half-timbering and sawn marl blocks
\tfloat edgeD = min(vFace.x, W - vFace.x);
\tfloat chamfer = W > 0.5 ? 1.0 - smoothstep(0.0, uChamfer, edgeD) : 0.0;
\tfloat onGround = 1.0 - step(0.5, base);
\tvec3 tone = vec3(1.0);
\tfloat joint = 0.0;
\tif (style > 2.5) {                                                    // mergelsteen: pale sawn blocks with wide joints
\t\ttone = vec3(1.16, 1.13, 1.03);
\t\tfloat course = floor(vFace.y / 0.36);
\t\tfloat jy = abs(fract(vFace.y / 0.36 + 0.5) - 0.5) * 0.36;
\t\tfloat jx = abs(fract((vFace.x + mod(course, 2.0) * 0.35) / 0.7 + 0.5) - 0.5) * 0.7;
\t\tjoint = max(1.0 - smoothstep(0.008, 0.022, jy), 0.7 * (1.0 - smoothstep(0.008, 0.022, jx)));
\t} else if (style > 1.5) {                                             // vakwerk: posts, rails and braces over pale infill
\t\ttone = vec3(1.12, 1.08, 0.99);
\t\tfloat y = fv - 2.9;
\t\tif (y > 0.0) {
\t\t\tfloat post = 1.0 - smoothstep(0.05, 0.08, abs(fract(vFace.x / 1.15 + 0.5) - 0.5) * 1.15);
\t\t\tfloat rail = 1.0 - smoothstep(0.06, 0.10, abs(fract(y / 2.7 + 0.5) - 0.5) * 2.7);
\t\t\tfloat brace = 1.0 - smoothstep(0.05, 0.09, abs(fract((vFace.x + y * 0.85) / 2.4 + 0.5) - 0.5) * 2.4);
\t\t\tjoint = max(post, max(rail, brace)) * smoothstep(0.0, 0.25, y);
\t\t}
\t} else if (style > 0.5) {                                             // geschilderd stucwerk: a flat warm or cool wash
\t\ttone = mix(vec3(1.08, 1.05, 0.98), vec3(0.94, 0.97, 1.0), winHash(vec2(fseed * 13.0, 4.0)));
\t}
\tdiffuseColor.rgb *= tone;
\t// the plinth at the foot, a string course halfway up a tall wall, and the quoins running up the corners
\tfloat plinth = onGround * (1.0 - smoothstep(uPlinth - 0.04, uPlinth + 0.04, vFace.y));
\tdiffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.71, 0.70), plinth * 0.8);
\tfloat band = H > 7.5 ? 1.0 - smoothstep(0.06, 0.13, abs(fv - 6.0)) : 0.0;
\tdiffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.18, 1.16, 1.10), band * 0.6 * detail);
\tfloat shadeLine = max(onGround * (1.0 - smoothstep(0.0, 0.05, abs(vFace.y - uPlinth))), band * (1.0 - smoothstep(0.0, 0.05, abs(fv - 5.9))));
\tfloat quoinOn = (style > 2.5 || winHash(vec2(fseed * 7.0, 1.3)) > 0.55) ? 1.0 : 0.0;
\tfloat quoin = quoinOn * step(2.0, W) * (1.0 - smoothstep(0.0, mix(0.11, 0.22, mod(floor(vFace.y / 0.34), 2.0)), edgeD));
\tdiffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.20, 1.18, 1.12), quoin * 0.55 * detail);
\tdiffuseColor.rgb *= 1.0 - 0.5 * clamp(joint, 0.0, 1.0) * detail;
\tdiffuseColor.rgb *= 1.0 - 0.35 * shadeLine * detail;
\t// cheap ambient occlusion: the foot of the wall, the shadow the eave throws along the top, and the corners
\tfloat topAo = H > 1.5 ? 1.0 - smoothstep(0.0, 0.75, H - fv) : 0.0;
\tdiffuseColor.rgb *= 1.0 - 0.20 * (1.0 - smoothstep(0.0, 1.6, vFace.y)) - 0.22 * topAo - 0.10 * chamfer;
\t// the openings, over everything else: jamb in shade, painted frame, glass last
\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.83, 0.78) * (0.48 + 0.22 * smoothstep(0.0, 0.4, revealDir.y)), reveal);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, vec3(0.93, 0.91, 0.87), 0.62), frame);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.1, 0.06) * (0.7 + 0.3 * winHash(vec2(fseed, W))), door);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.86, 0.82), trimBand * 0.75 * detail);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, 0.12, win);\n\troughnessFactor = mix(roughnessFactor, 0.55, frame);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n\tmetalnessFactor = mix(metalnessFactor, 0.35, win);")
      // after the maps, not before: normal_fragment_begin only seeds the tangent frame and normal_fragment_maps then
      // overwrites `normal` with the photo's normal map, so a bend applied any earlier is simply thrown away
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
\t{
\t\t// a chamfered arris instead of a razor edge: the normal swings outward over the last few centimetres so the
\t\t// corner catches a highlight the way a rounded brick corner does
\t\tif (chamfer > 0.0) {
\t\t\tvec3 upV = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
\t\t\tvec3 tV = cross(upV, normal);
\t\t\tfloat l = length(tV);
\t\t\tif (l > 1e-3) normal = normalize(normal + (tV / l) * (vFace.x < W * 0.5 ? -1.0 : 1.0) * chamfer * 0.55);
\t\t}
\t\t// the jamb of an opening faces back into the recess, against the direction the ray came from
\t\tif (reveal > 0.0) {
\t\t\tvec3 jamb = -normalize(vec3(revealDir, 0.15));
\t\t\tnormal = normalize(mix(normal, mat3(viewMatrix) * (tW * jamb.x + bW * jamb.y + nW * jamb.z), reveal * 0.7));
\t\t}
\t}`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += win * lit * uDark * uWinGlow * vec3(1.0, 0.8, 0.55) * glass * 2.5;")
  }
  m.customProgramCacheKey = () => "wall-windows"
  return m
}

// The roof tiles get the same treatment on a smaller budget: courses of pantiles running across the slope, the eave
// wet and mossy where the water sits, the ridge bleached by the sun, and moss on whatever faces north. It reuses the
// wall attributes (v up the slope from the face's own bottom, height = the slope length) so no extra data is needed.
function roofDetail(m) {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 faceInfo;\nattribute vec2 faceMeta;\nvarying vec4 vFace;\nvarying vec2 vMeta;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvFace = faceInfo; vMeta = faceMeta;")
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", "uniform float opacity;\nvarying vec4 vFace; varying vec2 vMeta;")
      .replace("#include <color_fragment>", `#include <color_fragment>
\tfloat slopeUp = vFace.y - vMeta.x, slopeH = max(vFace.w, 0.5);
\tfloat rpw = fwidth(slopeUp) + 0.004;
\tfloat rdet = clamp(0.05 / rpw, 0.0, 1.0);
\tfloat course = 1.0 - smoothstep(0.006, 0.026, abs(fract(slopeUp / 0.33 + 0.5) - 0.5) * 0.33);
\tdiffuseColor.rgb *= 1.0 - 0.20 * course * rdet;
\tfloat eave = 1.0 - smoothstep(0.0, 0.6, slopeUp);
\tfloat ridge = 1.0 - smoothstep(0.0, 0.5, slopeH - slopeUp);
\tdiffuseColor.rgb *= 1.0 - 0.22 * eave + 0.10 * ridge;
\tvec3 rnW = normalize(transpose(mat3(viewMatrix)) * normalize(vNormal));
\tfloat north = clamp(-rnW.z * 0.5 + 0.5, 0.0, 1.0);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.26, 0.32, 0.16), north * eave * 0.35);`)
  }
  m.customProgramCacheKey = () => "roof-detail"
  return m
}

export function tuneWindows() {
  const w = T.look.windows
  WIN_UNIFORMS.uWinLit.value = w.lit
  WIN_UNIFORMS.uWinGlow.value = w.glow
  const b = T.look.buildings            // optional: the knobs below only exist once Tuning gains the block
  WIN_UNIFORMS.uReveal.value = b?.reveal ?? REVEAL
  WIN_UNIFORMS.uChamfer.value = b?.chamfer ?? CHAMFER
  WIN_UNIFORMS.uPlinth.value = b?.plinth ?? PLINTH
}

const MATS = {
  brick:    weathered(windows(pbr("brick", { vertexColors: true, size: 2.2, side: THREE.DoubleSide, roughness: 0.9 })), { walls: true, wet: 0.15 }),
  brick2:   weathered(windows(pbr("brick2", { vertexColors: true, size: 2.4, side: THREE.DoubleSide, roughness: 0.9 })), { walls: true, wet: 0.15 }),
  plaster:  weathered(windows(pbr("plaster", { vertexColors: true, size: 3, side: THREE.DoubleSide, roughness: 0.9 })), { walls: true, wet: 0.1 }),
  rooftile: weathered(roofDetail(pbr("rooftile", { vertexColors: true, size: 1.6, side: THREE.DoubleSide, roughness: 0.85 })), { wet: 0.3 }),
  flat:     weathered(pbr("concrete", { vertexColors: true, size: 3, side: THREE.DoubleSide, roughness: 0.95 }), { wet: 0.3 }),
  // the woodwork and zinc: fine plaster at a 1 m repeat reads as painted board, and the vertex colour does the rest
  trim:     weathered(pbr("plaster", { vertexColors: true, size: 1, side: THREE.DoubleSide, roughness: 0.55 }), { wet: 0.25 }),
}
// only these materials read the per-face attributes; the others save the 24 bytes a vertex
const FACE_ATTRS = new Set(["brick", "brick2", "plaster", "rooftile"])

const WALL_SETS = ["brick", "brick", "brick2", "plaster", "brick", "plaster", "brick2", "plaster"]
const WALL_STYLE = [0, 0, 0, 1, 0, 2, 0, 3]    // 0 baksteen, 1 stucwerk, 2 vakwerk, 3 mergel — see the wall shader

const WALLS = [0xd9c4a5, 0xcdb597, 0xb99c7a, 0xa8836a, 0xe3d6c3, 0xc9c1b4, 0x9c7b66, 0xdccbb6]  // brick, plaster, dark brick
const PITCHED = [0x6e3d33, 0x5a3a35, 0x4b4548, 0x7a4a3c, 0x3f3b3d, 0x8a5646]                   // tiles: terracotta to anthracite
const FLAT = [0x6f6c68, 0x7d7a74, 0x5e5c59]                                                      // bitumen / gravel
// with the photos on, the palette only tints the photo (mostly white, a hint of the colour); without, it is the colour
const MIX = pbrEnabled() ? 0.7 : 0
// the trim is painted over a near-white plaster photo, so these are close to the colour you actually see
const PAINT = [[1.02, 1.00, 0.95], [0.42, 0.46, 0.40], [0.35, 0.29, 0.24], [0.74, 0.72, 0.66]]   // wit, donkergroen, bruin, grijs
const ZINC = [0.62, 0.64, 0.66]
const SOOT = [0.34, 0.32, 0.30]
const ROOF_TRIM = [1, 1, 1]           // the generated roof pieces take the tile photo straight
const TINT = new THREE.Color(), TINT_WHITE = new THREE.Color(0xffffff)
// the same lerp towards white the walls get, so a chimney matches the brick it grows out of
function brickTint(hex) { TINT.setHex(hex).lerp(TINT_WHITE, MIX); return [TINT.r, TINT.g, TINT.b] }

const POOL3 = [], POOL2 = []                                                                      // scratch vectors reused per face
const X_AXIS = new THREE.Vector3(1, 0, 0)

export function buildBuildingMeshes(meshes, reg) { return buildParts(meshes, reg, "m:", "m") }

// `parts` are BAG meshes, or the synthetic ones Buildings.js makes from a footprint; `prefix` and `kind` label the
// destructible handles so the two sources stay distinguishable to Combat and the server.
export function buildParts(parts, reg, prefix = "m:", kind = "m") {
  // a part may carry its own prefix and kind, so a tile can merge its BAG meshes and its fallback footprints into
  // one group over the shared materials instead of building two
  if (!parts?.length) return null
  const bufs = {}                       // material name → { pos, col, uv, face, meta }
  const buf = (name) => bufs[name] ??= { pos: [], col: [], uv: [], face: [], meta: [] }
  const handles = []
  const color = new THREE.Color(), white = new THREE.Color(0xffffff)
  const pts3 = [], pts2 = []
  const normal = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const tu = new THREE.Vector3(), tv = new THREE.Vector3()
  const eaves = [], ridges = [], rims = []     // the roof edges the trim is generated from, flat numbers per entry

  for (const b of parts) {
    const h = hash(b.id)
    const wall = WALLS[h % WALLS.length], slot = b.slot ?? h % WALL_SETS.length
    const wallSet = WALL_SETS[slot], style = WALL_STYLE[slot]
    const flat = b.roof === "horizontal"
    const roof = flat ? FLAT[h % FLAT.length] : PITCHED[(h >> 3) % PITCHED.length]
    const roofSet = flat ? "flat" : "rooftile"
    const [ox, oy, oz] = b.o
    const s = b.s ?? 0.01               // BAG rings are centimetre offsets; the footprint fallback sends metres
    const starts = {}                   // material name → vertex index where this building begins in that buffer
    // every buffer a building writes to has to remember where the building started, trim included
    const at = (name) => { const B = buf(name); starts[name] ??= B.pos.length / 3; return B }
    const xz = []
    eaves.length = 0; ridges.length = 0; rims.length = 0
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = -Infinity, bottom = Infinity
    // the packed style seed: an integer style plus a per-building fraction, kept clear of the integer boundaries so
    // floor() cannot land on the wrong style after interpolation
    const seed = style + 0.01 + ((h % 1000) / 1000) * 0.98
    for (const face of b.f) {
      const label = face[0]
      // rings → arrays of Vector3 (outer first, then holes); the vectors come from a pool reused per face, since a
      // dense tile has 60k ring vertices and allocating them all made every tile load a visible hitch
      const rings = []
      let used = 0
      for (let r = 1; r < face.length; r++) {
        const flatRing = face[r], ring = []
        for (let i = 0; i + 2 < flatRing.length; i += 3) {
          const p = (POOL3[used] ??= new THREE.Vector3()).set(ox + flatRing[i] * s, oy + flatRing[i + 1] * s, oz + flatRing[i + 2] * s); used++
          ring.push(p)
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
          top = Math.max(top, p.y); bottom = Math.min(bottom, p.y)
          if (reg && !b.fp) xz.push(p.x, p.z)
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
      if (label === 1) collectRoofEdges(rings[0], normal, tu, tv, horizontal, flat, eaves, ridges, rims)
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
      const tint = 0.96 + ((h ^ (face.length * 7919)) % 9) / 100
      color.setHex(label === 1 ? roof : wall).lerp(white, MIX)
      const shade = label === 1 ? 1 : 0.93 + 0.07 * Math.abs(normal.x)
      const r = color.r * tint * shade, g = color.g * tint * shade, bl = color.b * tint * shade
      const name = label === 1 ? roofSet : wallSet
      const B = at(name)
      // v measured from the building base so brick courses start on the ground; u from the origin along the face.
      // The face's own extent (left edge, bottom, width, height) rides along for the window grid.
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
      for (const p of rings[0]) {
        const fu = (p.x - ox) * tu.x + (p.y - oy) * tu.y + (p.z - oz) * tu.z, fv = (p.x - ox) * tv.x + (p.y - oy) * tv.y + (p.z - oz) * tv.z
        minU = Math.min(minU, fu); maxU = Math.max(maxU, fu); minV = Math.min(minV, fv); maxV = Math.max(maxV, fv)
      }
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
    if (TRIM_ON && bottom < Infinity) addDetail(at, h, seed, wallSet, wall, eaves, ridges, rims, oy, bottom)
    const ranges = Object.entries(starts).map(([name, start]) => ({ name, start, count: bufs[name].pos.length / 3 - start })).filter((r) => r.count)
    if (reg && ranges.length && b.id != null) {
      const fpRings = b.fp ?? [hullXZ(xz)]
      handles.push({ key: `${b.prefix ?? prefix}${b.id}`, kind: b.kind ?? kind, rings: fpRings, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, h: top - oy, max: buildingHp(fpRings), ranges })
    }
  }
  const geos = {}
  for (const [name, B] of Object.entries(bufs)) {
    if (!B.pos.length) continue
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute(B.pos, 3))
    geo.setAttribute("color", new THREE.Float32BufferAttribute(B.col, 3))
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(B.uv, 2))
    if (FACE_ATTRS.has(name)) {
      geo.setAttribute("faceInfo", new THREE.Float32BufferAttribute(B.face, 4))
      geo.setAttribute("faceMeta", new THREE.Float32BufferAttribute(B.meta, 2))
    }
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

// ---- roof edges -------------------------------------------------------------------------------------------------

// Which boundary edges of a roof face are its eave, its ridge or the rim of a flat roof. The face's own up-slope
// axis answers it: the lowest edge along tv is where the water leaves, the highest is where two planes meet. Both
// have to be level and long enough to be worth dressing, which rules out the slivers a hipped end produces.
// Eaves are stored running against tu, so the overhang and fascia quads below always wind outward.
function collectRoofEdges(ring, normal, tu, tv, horizontal, flat, eaves, ridges, rims) {
  const n = ring.length
  if (horizontal) {
    if (!flat) return                                      // the top platform of a hip roof, not a deck to fence in
    // outward is to the left of the edge only when the ring winds with its normal up; a deck wound the other way
    // (some BAG parts are) is walked backwards so the parapet still faces the street
    const flip = normal.y < 0
    for (let i = 0; i < n && rims.length < MAX_RIMS * 6; i++) {
      const p = ring[i], q = ring[(i + 1) % n]
      if (Math.hypot(q.x - p.x, q.z - p.z) < RIM_MIN) continue
      if (flip) rims.push(q.x, q.y, q.z, p.x, p.y, p.z)
      else rims.push(p.x, p.y, p.z, q.x, q.y, q.z)
    }
    return
  }
  if (normal.y < 0.08 || normal.y > 0.995) return           // a wall-like sliver, or a plane already handled as flat
  let lo = Infinity, hi = -Infinity
  for (const p of ring) { const f = p.dot(tv); if (f < lo) lo = f; if (f > hi) hi = f }
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n]
    if (Math.abs(p.y - q.y) > LEVEL_TOL) continue
    if (Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < EAVE_MIN) continue
    const fp = p.dot(tv), fq = q.dot(tv)
    if (fp - lo < FLAT_TOL && fq - lo < FLAT_TOL) {
      if (eaves.length >= MAX_EAVES * 9) continue
      const along = (q.x - p.x) * tu.x + (q.y - p.y) * tu.y + (q.z - p.z) * tu.z
      const a = along > 0 ? q : p, c = along > 0 ? p : q
      eaves.push(a.x, a.y, a.z, c.x, c.y, c.z, -tv.x, -tv.y, -tv.z)
    } else if (hi - fp < FLAT_TOL && hi - fq < FLAT_TOL && ridges.length < MAX_RIDGES * 6) {
      ridges.push(p.x, p.y, p.z, q.x, q.y, q.z)
    }
  }
}

// ---- generated detail -------------------------------------------------------------------------------------------

const QUAD_U = [0, 1, 1, 0, 1, 0]     // the two triangles of a quad, as (along the edge, along the extrusion) pairs
const QUAD_V = [0, 0, 1, 0, 1, 1]
const FI = { u: 0, w: 1, h: 1, y0: 0, base: 0, seed: 0 }   // the face attributes a generated quad carries

// One quad, as the edge a → b extruded by e: the winding puts its normal along (b - a) × e, which is how every
// caller below reasons about which way the thing faces. UVs run in metres so the photo keeps its scale.
function pushEdgeQuad(B, ax, ay, az, bx, by, bz, ex, ey, ez, col, fi) {
  const w = Math.hypot(bx - ax, by - ay, bz - az), hgt = Math.hypot(ex, ey, ez)
  for (let k = 0; k < 6; k++) {
    const t = QUAD_U[k], s = QUAD_V[k]
    const x = ax + (bx - ax) * t + ex * s, y = ay + (by - ay) * t + ey * s, z = az + (bz - az) * t + ez * s
    B.pos.push(x, y, z)
    B.col.push(col[0], col[1], col[2])
    B.uv.push(w * t, hgt * s)
    B.face.push(fi.u + w * t, y - fi.y0, fi.w, fi.h)
    B.meta.push(fi.base, fi.seed)
  }
}

// A vertical prism — a chimney, a downpipe — from a convex ring of [x, z] pairs. The ring is turned so every side
// faces outward (interior on the left, which the signed area tells us) and the cap is wound the other way so it
// faces up. Both follow from the same rule the quad above uses.
function pushPrism(B, ring, yTop, yBot, col, capCol, fi) {
  let area = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) area += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  const pts = area > 0 ? ring : reversedRing(ring)
  const n = pts.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    pushEdgeQuad(B, pts[i * 2], yTop, pts[i * 2 + 1], pts[j * 2], yTop, pts[j * 2 + 1], 0, yBot - yTop, 0, col, fi)
  }
  for (let i = 1; i < n - 1; i++) {         // the cap, fanned the other way round so its normal points up
    for (const k of [0, i + 1, i]) {
      B.pos.push(pts[k * 2], yTop, pts[k * 2 + 1])
      B.col.push(capCol[0], capCol[1], capCol[2])
      B.uv.push(pts[k * 2], pts[k * 2 + 1])
      B.face.push(0, yTop - fi.y0, fi.w, fi.h)
      B.meta.push(fi.base, fi.seed)
    }
  }
}

function reversedRing(ring) {
  const out = []
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i], ring[i + 1])
  return out
}

// The overhang, fascia, gutter, ridge cap, chimney, downpipe and parapet of one building. Everything is drawn from
// the id hash, so a house keeps its chimney in the same corner for ever, and everything lands in whatever buffer the
// building is already writing to, so the destructible range swallows it whole.
function addDetail(at, h, seed, wallSet, wallHex, eaves, ridges, rims, oy, bottom) {
  const rnd = mulberry32(h ^ 0x9e3779b9)
  const paint = PAINT[Math.floor(rnd() * PAINT.length)]
  const fi = FI
  let bestEave = -1, bestEaveLen = 0

  if (eaves.length) {
    const T2 = at("trim"), R = at("rooftile")
    fi.u = 0; fi.w = 1; fi.h = 1; fi.y0 = oy; fi.base = 0; fi.seed = seed
    for (let i = 0; i < eaves.length; i += 9) {
      const ax = eaves[i], ay = eaves[i + 1], az = eaves[i + 2]
      const bx = eaves[i + 3], by = eaves[i + 4], bz = eaves[i + 5]
      const dx = eaves[i + 6], dy = eaves[i + 7], dz = eaves[i + 8]
      const len = Math.hypot(bx - ax, by - ay, bz - az)
      if (len > bestEaveLen) { bestEaveLen = len; bestEave = i }
      // the roof plane carried past the wall, still in its own plane so the tiles keep running. Its face attributes
      // put it at the bottom of a slope, which is what tells the roof shader to shade it as a wet, mossy eave.
      fi.base = ay - oy
      pushEdgeQuad(R, ax, ay, az, bx, by, bz, dx * OVERHANG, dy * OVERHANG, dz * OVERHANG, ROOF_TRIM, fi)
      fi.base = 0
      const qax = ax + dx * OVERHANG, qay = ay + dy * OVERHANG, qaz = az + dz * OVERHANG
      const qbx = bx + dx * OVERHANG, qby = by + dy * OVERHANG, qbz = bz + dz * OVERHANG
      pushEdgeQuad(T2, qax, qay, qaz, qbx, qby, qbz, 0, -FASCIA, 0, paint, fi)       // the fascia board
      const hl = Math.hypot(dx, dz)
      if (hl < 1e-4 || len < 2.5) continue
      const hx = (dx / hl) * GUTTER_OUT, hz = (dz / hl) * GUTTER_OUT                  // outward, gutter width
      const gay = qay - FASCIA, gby = qby - FASCIA
      pushEdgeQuad(T2, qax + hx, gay, qaz + hz, qbx + hx, gby, qbz + hz, 0, -GUTTER_H, 0, ZINC, fi)
      pushEdgeQuad(T2, qax + hx, gay - GUTTER_H, qaz + hz, qbx + hx, gby - GUTTER_H, qbz + hz, -hx, -0.04, -hz, ZINC, fi)
    }
  }

  // the ridge cap: a shallow tent of tiles over the line where two planes meet, deduplicated because both meet there
  if (ridges.length) {
    const R = at("rooftile")
    fi.u = 0; fi.w = 1; fi.h = 1; fi.y0 = oy; fi.base = 0; fi.seed = seed
    const done = []
    let bestRidge = -1, bestRidgeLen = 0
    for (let i = 0; i < ridges.length; i += 6) {
      const ax = ridges[i], ay = ridges[i + 1], az = ridges[i + 2]
      const bx = ridges[i + 3], by = ridges[i + 4], bz = ridges[i + 5]
      const mx = (ax + bx) / 2, mz = (az + bz) / 2
      let seen = false
      for (let k = 0; k < done.length; k += 2) if (Math.hypot(done[k] - mx, done[k + 1] - mz) < 0.3) seen = true
      if (seen) continue
      done.push(mx, mz)
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 0.5) continue
      if (len > bestRidgeLen) { bestRidgeLen = len; bestRidge = i }
      const cx = -(bz - az) / len * RIDGE_W, cz = (bx - ax) / len * RIDGE_W           // across the ridge, horizontal
      const rax = ax, ray = ay + RIDGE_UP, raz = az, rbx = bx, rby = by + RIDGE_UP, rbz = bz
      fi.base = ay - oy - 1              // a slope length behind it, so the roof shader reads this as the sunlit ridge
      pushEdgeQuad(R, rbx, rby, rbz, rax, ray, raz, cx, -RIDGE_DROP, cz, ROOF_TRIM, fi)
      pushEdgeQuad(R, rax, ray, raz, rbx, rby, rbz, -cx, -RIDGE_DROP, -cz, ROOF_TRIM, fi)
      fi.base = 0
    }
    // one chimney, sitting astride the longest ridge at a spot the hash picks
    if (bestRidge >= 0 && bestRidgeLen > CHIM_MIN_RIDGE) {
      const ax = ridges[bestRidge], ay = ridges[bestRidge + 1], az = ridges[bestRidge + 2]
      const bx = ridges[bestRidge + 3], bz = ridges[bestRidge + 5]
      const len = Math.hypot(bx - ax, bz - az)
      const t = 0.2 + rnd() * 0.6
      const ux = (bx - ax) / len, uz = (bz - az) / len
      const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t
      const hw = CHIM_W / 2, hd = CHIM_D / 2
      const ring = [
        cx + ux * hw - uz * hd, cz + uz * hw + ux * hd,
        cx + ux * hw + uz * hd, cz + uz * hw - ux * hd,
        cx - ux * hw + uz * hd, cz - uz * hw - ux * hd,
        cx - ux * hw - uz * hd, cz - uz * hw + ux * hd,
      ]
      const yTop = ay + CHIM_LO + rnd() * (CHIM_HI - CHIM_LO)
      const W = at(wallSet)
      const col = brickTint(wallHex)
      // h stays under the 1.5 m the eave shadow needs and the 2.75 m a window row needs: a chimney is neither
      fi.u = 0; fi.w = CHIM_W; fi.h = 1.4; fi.y0 = oy; fi.base = ay - oy - CHIM_SINK; fi.seed = seed
      pushPrism(W, ring, yTop, ay - CHIM_SINK, col, SOOT, fi)
    }
  }

  // one downpipe off the longest eave, hugging the wall from the gutter to the ground
  if (bestEave >= 0 && bestEaveLen > 3.5) {
    const i = bestEave
    const ax = eaves[i], ay = eaves[i + 1], az = eaves[i + 2]
    const bx = eaves[i + 3], bz = eaves[i + 5]
    const len = Math.hypot(bx - ax, bz - az) || 1
    const ux = (bx - ax) / len, uz = (bz - az) / len
    const dx = eaves[i + 6], dz = eaves[i + 8]
    const hl = Math.hypot(dx, dz)
    if (hl > 1e-4) {
      const ox2 = (dx / hl) * (PIPE_R + 0.03), oz2 = (dz / hl) * (PIPE_R + 0.03)
      const off = 0.35 + rnd() * 0.3
      const px = ax + ux * off + ox2, pz = az + uz * off + oz2
      const ring = []
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2
        ring.push(px + (ux * Math.cos(a) - uz * Math.sin(a)) * PIPE_R, pz + (uz * Math.cos(a) + ux * Math.sin(a)) * PIPE_R)
      }
      const P = at("trim")
      fi.u = 0; fi.w = 1; fi.h = 1; fi.y0 = oy; fi.base = 0; fi.seed = seed
      pushPrism(P, ring, ay - FASCIA - 0.05, bottom - 0.05, ZINC, ZINC, fi)
    }
  }

  // a flat roof gets a parapet rather than an open edge: the wall carries on past the deck with a coping on top
  if (rims.length) {
    const W = at(wallSet)
    const col = brickTint(wallHex)
    for (let i = 0; i < rims.length; i += 6) {
      const ax = rims[i], ay = rims[i + 1], az = rims[i + 2]
      const bx = rims[i + 3], by = rims[i + 4], bz = rims[i + 5]
      const len = Math.hypot(bx - ax, bz - az) || 1
      const ix = (bz - az) / len * PARAPET_T, iz = -(bx - ax) / len * PARAPET_T       // inward, coping depth
      fi.u = 0; fi.w = len; fi.h = PARAPET; fi.y0 = oy; fi.base = ay - oy; fi.seed = seed
      pushEdgeQuad(W, ax, ay, az, bx, by, bz, 0, PARAPET, 0, col, fi)
      pushEdgeQuad(W, ax, ay + PARAPET, az, bx, by + PARAPET, bz, ix, 0, iz, col, fi)
    }
  }
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
  const str = String(s)
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}
