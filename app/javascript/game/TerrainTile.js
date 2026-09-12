import * as THREE from "three"
import { disposeTexture, loadBitmap, bitmapTexture, versioned, pbrEnabled, noiseTexture } from "game/Textures"

// The ground. Every square metre of Limburg is described by BGT land cover, so the terrain does not need a photograph
// to know what it is: Cover.js rasterises the cover polygons of a tile into a four channel mask (red how much bare
// soil, green how much gravel or pavement, blue how much forest floor, whatever is left over is grass, and alpha how
// dry the spot is), and this material blends four photo-scanned PBR sets through it per fragment. The old terrain wore
// a 1024 px aerial photo at half a metre per pixel, which at walking distance is a smear of soft blobs; now the photo
// is demoted to a low frequency colour and brightness field laid over real material, so the fields keep the colours
// and the tracks that make them this place while the surface under the wheels is grass, clay and gravel with grain.
//
// What keeps it affordable, because this is the largest surface on screen and every instruction is paid millions of
// times a frame: the layers are gated on their mask weight, so a fragment in the middle of a meadow samples one set
// and skips the other three, and only the transitions pay for two; the normal maps stop being sampled at range and
// the extra fine tap stops close by; roughness is derived from the albedo and the dryness rather than a fourth map
// per set; and the triplanar side projection only switches on where the slope actually stretches the top down UVs.
// Texture UVs come from world XZ, not the tile UV, so materials run continuously across tile borders with no seam.

// Shared uniform objects, tweakable live through TUNING.look (DayNight copies them every frame). uDark is the
// night (0 day … 1 night), used by the lit windows in BuildingMeshes. uSat and uGain shape the aerial photo, which
// carries baked sunlight and washes out under the scene's own sun. uDetailStrength scales the material normals and
// uDetailFar is the distance by which they have faded out; the latter is read into a packed uniform at compile time,
// so changing it live wants a refreshUniforms() after.
export const LOOK = { uSat: { value: 1.1 }, uGain: { value: 0.9 }, uDark: { value: 0 },
                      uDetailStrength: { value: 0.9 }, uDetailFar: { value: 260 }, uDetail: { value: null } }

// Ground tunables in one object so they can be poked from the console (window.slop.ground) without a reload. These
// are the knobs that belong in TUNING.look.ground once Tuning.js can be edited.
export const GROUND = {
  fineNear: 10,           // m: the extra fine normal tap is at full strength up to here…
  fineFar: 28,            // m: …and gone by here. It is the most expensive thing in this shader per
                          // pixel it covers, so it only buys the metres you could reach out and touch
  macroSize: 130,         // m per repeat of the low frequency variation that stops the sets tiling visibly
  macroTint: 0.38,        // how much that variation lightens and darkens the ground
  warp: 1.6,              // m the same variation slides the texture grid, so no two repeats line up
  heightInfluence: 0.38,  // how strongly a layer's own relief wins the height blend at a transition
  blendRange: 0.16,       // width of that transition: small interlocks, large cross-fades
  slopeLo: 0.18,          // 1 - |n.y| at which the triplanar side projection starts…
  slopeHi: 0.55,          // …and at which it has fully taken over
  fineRatio: 5.7,         // how much finer the extra near normal tap is than the base one
  orthoNear: 0.32,        // how much of the aerial photo's colour shows through up close…
  orthoFar: 0.85,         // …and far away, where the material detail has faded anyway
  orthoFadeNear: 120,     // m over which that ramp runs
  orthoFadeFar: 420,
}

// The four sets, in mask channel order: the implicit base (grass), then red, green and blue. `size` is how many
// metres one repeat of the scan covers; `flat` is the colour the tile wears until the scan arrives.
//
// `wet` and `dry` are the colour the layer is driven to at either end of the dryness channel, which is what gets six
// materials out of four sets: one scanned grass reads as both a June meadow and a straw verge, one soil as both wet
// plough and dune sand. A plain multiply cannot do it, because these scans are dark (soil averages 0.10 linear) and
// no multiplier turns near-black clay into beach sand without blowing the contrast out with it. So the dry end takes
// the square root of the albedo first — a gamma lift that raises the midtones and compresses the range, exactly what
// bleaching in the sun does — and tints that. The multipliers below are the measured mean albedo of each scan
// divided into the linear colour the layer should sit at, wet and dry.
const LAYERS = [
  { set: "grass",       size: 1.7, wet: [0.80, 1.05, 1.00], dry: [0.56, 0.42, 0.49], rough: 0.97, flat: [0.62, 0.66, 0.42] },
  { set: "soil",        size: 1.5, wet: [1.05, 0.95, 0.95], dry: [0.96, 1.09, 0.89], rough: 0.94, flat: [0.52, 0.40, 0.30] },
  { set: "gravel",      size: 2.2, wet: [0.64, 0.66, 0.78], dry: [0.50, 0.49, 0.45], rough: 0.90, flat: [0.72, 0.70, 0.66] },
  { set: "forestfloor", size: 2.6, wet: [0.42, 0.62, 1.20], dry: [0.40, 0.43, 0.37], rough: 0.96, flat: [0.46, 0.36, 0.25] },
]
const WEIGHT_EPS = 0.004         // below this share a layer is not sampled at all
const NORMAL_STRENGTH = 1.15     // multiplies TUNING.look.detail

// Shared across every tile, so all terrain draws with one program and one set of texture bindings.
const MAPS = {
  uC0: { value: null }, uN0: { value: null }, uC1: { value: null }, uN1: { value: null },
  uC2: { value: null }, uN2: { value: null }, uC3: { value: null }, uN3: { value: null },
  uWet0: { value: new THREE.Vector3() }, uDry0: { value: new THREE.Vector3() },
  uWet1: { value: new THREE.Vector3() }, uDry1: { value: new THREE.Vector3() },
  uWet2: { value: new THREE.Vector3() }, uDry2: { value: new THREE.Vector3() },
  uWet3: { value: new THREE.Vector3() }, uDry3: { value: new THREE.Vector3() },
  uScale: { value: new THREE.Vector4() },     // 1 / metres per repeat, per layer
  uRough: { value: new THREE.Vector4() },
  uGround: { value: new THREE.Vector4() },    // heightInfluence, blendRange, slopeLo, 1 / (slopeHi - slopeLo)
  uMacro: { value: new THREE.Vector4() },     // 1 / macroSize, macroTint, warp, fineRatio
  uFade: { value: new THREE.Vector4() },      // fineNear, 1 / (fineFar - fineNear), normalFar, normalStrength
  uOrthoRamp: { value: new THREE.Vector4() }, // near strength, far strength, fade near, 1 / fade width
}
for (const [i, L] of LAYERS.entries()) {
  MAPS[`uWet${i}`].value.fromArray(L.wet)
  MAPS[`uDry${i}`].value.fromArray(L.dry)
}
refreshUniforms()

// pushes GROUND and LOOK into the packed uniform vectors; called on every compile and cheap enough to call by hand
// from the console after poking a knob
export function refreshUniforms() {
  const g = GROUND
  MAPS.uScale.value.set(...LAYERS.map((L) => 1 / L.size))
  MAPS.uRough.value.set(...LAYERS.map((L) => L.rough))
  MAPS.uGround.value.set(g.heightInfluence, g.blendRange, g.slopeLo, 1 / Math.max(1e-3, g.slopeHi - g.slopeLo))
  MAPS.uMacro.value.set(1 / g.macroSize, g.macroTint, g.warp, g.fineRatio)
  MAPS.uFade.value.set(g.fineNear, 1 / Math.max(1e-3, g.fineFar - g.fineNear), LOOK.uDetailFar.value, NORMAL_STRENGTH)
  MAPS.uOrthoRamp.value.set(g.orthoNear, g.orthoFar, g.orthoFadeNear, 1 / Math.max(1e-3, g.orthoFadeFar - g.orthoFadeNear))
}

// A single texel standing in for a map that has not arrived (or will never arrive, with ?pbr=0): the layer's flat
// colour for the albedo, a straight up normal for the relief. Without these three binds an empty black texture and
// the ground is pitch dark for the first second.
function solidTexture(rgb, srgb) {
  const data = new Uint8Array([Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255), 255])
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat)
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

let loaded = false
function loadLayers() {
  if (loaded) return
  loaded = true
  for (const [i, L] of LAYERS.entries()) {
    MAPS[`uC${i}`].value = solidTexture(L.flat, true)
    MAPS[`uN${i}`].value = solidTexture([0.5, 0.5, 1], false)
    if (!pbrEnabled()) continue
    // repeat: 1 only asks for wrapping — the shader scales world metres into UVs itself, so three's repeat is unused
    Promise.all([loadBitmap(versioned(`/textures/${L.set}/color.jpg`)), loadBitmap(versioned(`/textures/${L.set}/normal.jpg`))])
      .then(([c, n]) => {
        MAPS[`uC${i}`].value = bitmapTexture(c, { srgb: true, repeat: 1, anisotropy: 8 })
        MAPS[`uN${i}`].value = bitmapTexture(n, { srgb: false, repeat: 1, anisotropy: 4 })
      })
      .catch((e) => console.warn(`terrain/${L.set}: ${e.message}`))
  }
}

// The mask a tile without land cover wears: all grass, middling dryness. Shared and never disposed.
let plainMask = null
function plainMaskTexture() {
  if (plainMask) return plainMask
  plainMask = new THREE.DataTexture(new Uint8Array([0, 0, 0, 90]), 1, 1, THREE.RGBAFormat)
  plainMask.colorSpace = THREE.NoColorSpace
  plainMask.needsUpdate = true
  plainMask.__shared = true
  return plainMask
}

// Tiles with no land cover once shared one material. They cannot: setMap() writes that tile's aerial photograph
// into the material's own uniform, so a shared material means the last tile to load wins and every other bare tile
// wears its photo. Each tile gets its own; ChunkManager disposes it with the tile, since it is not marked shared.

// Heightmap (rows north→south, columns west→east) → displaced plane, plus bilinear sampling. Normals come from
// central differences over the height grid rather than from averaged face normals: the grid is the smooth surface
// the facets approximate, so its gradient shades the hillsides without the creases along every grid line, and it is
// still right along the tile's own border where a face average has no neighbour to average with.
export class TerrainTile {
  constructor(data, cfg, texture = null) {
    this.ox = data.origin[0]            // west edge (game x)
    this.oz = data.origin[1]            // north edge (game z)
    this.n = cfg.height_n
    this.step = cfg.height_step
    this.size = cfg.tile_size
    this.h = data.heights

    const geo = new THREE.PlaneGeometry(this.size, this.size, this.n - 1, this.n - 1)
    geo.rotateX(-Math.PI / 2)            // plane +y (top row) becomes -z (north), matching data order
    const pos = geo.attributes.position, nrm = geo.attributes.normal
    const n = this.n, h = this.h, s = this.step
    for (let i = 0; i < pos.count; i++) pos.setY(i, h[i])
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const i = r * n + c
      const dx = (h[r * n + Math.min(n - 1, c + 1)] - h[r * n + Math.max(0, c - 1)]) / (s * (Math.min(n - 1, c + 1) - Math.max(0, c - 1)))
      const dz = (h[Math.min(n - 1, r + 1) * n + c] - h[Math.max(0, r - 1) * n + c]) / (s * (Math.min(n - 1, r + 1) - Math.max(0, r - 1)))
      const len = Math.hypot(dx, dz, 1)
      nrm.setXYZ(i, -dx / len, 1 / len, -dz / len)
    }
    nrm.needsUpdate = true

    // per-tile material when land cover was painted (disposed with the tile), else the shared green
    const mask = texture?.userData?.mask ?? plainMask
    this.mesh = new THREE.Mesh(geo, terrainMaterial(mask))
    this.mesh.position.set(this.ox + this.size / 2, 0, this.oz + this.size / 2)
  }

  // the aerial photo arrived: it modulates the material's colour rather than replacing it, so this is a uniform swap
  // and never a shader recompile
  setMap(tex) {
    const u = this.mesh.material.userData.terrain
    if (!u) { disposeTexture(tex); return }
    disposeTexture(u.uOrtho.value)
    u.uOrtho.value = tex
    u.uOrthoOn.value = 1
  }

  heightAt(x, z) {
    const u = THREE.MathUtils.clamp((x - this.ox) / this.step, 0, this.n - 1.0001)
    const v = THREE.MathUtils.clamp((z - this.oz) / this.step, 0, this.n - 1.0001)
    const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r
    const h = this.h, n = this.n
    const top = h[r * n + c] * (1 - fu) + h[r * n + c + 1] * fu
    const bot = h[(r + 1) * n + c] * (1 - fu) + h[(r + 1) * n + c + 1] * fu
    return top * (1 - fv) + bot * fv
  }
}

// The height blend, in JS, exactly as the shader runs it: a layer's own relief is added to its mask weight, the
// winner sets the bar, and only what comes within `range` of the bar contributes. Two materials therefore interlock
// along the crevices of whichever one is standing proud instead of cross-fading into mush.
export function heightBlend(weights, heights, { influence = GROUND.heightInfluence, range = GROUND.blendRange } = {}) {
  const k = weights.map((w, i) => heights[i] * influence + w)
  const top = Math.max(...k)
  const b = k.map((v, i) => (weights[i] > WEIGHT_EPS ? Math.max(v - top + range, 0) : 0))
  const sum = b.reduce((a, c) => a + c, 0)
  return sum > 0 ? b.map((v) => v / sum) : b
}

// ---- the shader ---------------------------------------------------------------------------------------------------

// One layer's contribution: a colour tap, the matching normal tap while it is still worth having, the triplanar side
// tap on a slope, and the extra fine tap close to the camera. All four are behind the same mask weight test, so a
// fragment only pays for the materials that are actually on it.
function layerBlock(i) {
  const comp = "xyzw"[i]
  return `
\tvec3 c${i} = vec3(0.0); vec3 b${i} = vec3(0.0); float h${i} = 0.0;
\tif (w${i} > ${WEIGHT_EPS}) {
\t\tfloat sc = uScale.${comp};
\t\tvec2 uvT = (wxz + warp) * sc;
\t\tvec3 col = texture2D(uC${i}, uvT).rgb;
\t\tvec3 bmp = vec3(0.0);
\t\tif (normW > 0.02) {
\t\t\tvec3 nt = texture2D(uN${i}, uvT).xyz * 2.0 - 1.0;
\t\t\tbmp = vec3(nt.x, 0.0, nt.y);
\t\t}
\t\tif (slope > 0.02) {
\t\t\tvec2 uvS = (side + warp) * sc;
\t\t\tcol = mix(col, texture2D(uC${i}, uvS).rgb, slope);
\t\t\tif (normW > 0.02) {
\t\t\t\tvec3 ns = texture2D(uN${i}, uvS).xyz * 2.0 - 1.0;
\t\t\t\tbmp = mix(bmp, xMajor ? vec3(0.0, ns.y, ns.x) : vec3(ns.x, ns.y, 0.0), slope);
\t\t\t}
\t\t}
\t\tif (fineW > 0.02) {
\t\t\tvec3 nf = texture2D(uN${i}, (wxz + warp) * sc * uMacro.w).xyz * 2.0 - 1.0;
\t\t\tbmp += vec3(nf.x, 0.0, nf.y) * fineW;
\t\t}
\t\th${i} = dot(col, vec3(0.34, 0.45, 0.21));
\t\tc${i} = mix(col * uWet${i}, sqrt(col) * uDry${i}, dry);   // the dry end is a gamma lift, not a brighter multiply
\t\tb${i} = bmp * normW;                                                      // relief eases off rather than popping
\t}`
}

// mask: the per-tile cover mask (Cover.paintCover) or null for the shared all-grass material. It rides on the
// material's `map` slot so three declares the sampler and the tile UVs for us, and so ChunkManager's tile teardown
// frees it along with everything else.
export function terrainMaterial(mask) {
  const tileMask = mask ?? plainMaskTexture()
  const m = new THREE.MeshStandardMaterial({ map: tileMask, roughness: 1, metalness: 0 })
  const own = { uOrtho: { value: null }, uOrthoOn: { value: 0 } }
  m.userData.terrain = own
  m.onBeforeCompile = (shader) => {
    loadLayers()                     // the first compile is the earliest point at which the assets version is known
    refreshUniforms()
    LOOK.uDetail.value ??= noiseTexture()
    Object.assign(shader.uniforms, MAPS, own, {
      uSat: LOOK.uSat, uGain: LOOK.uGain, uNoise: LOOK.uDetail, uStrength: LOOK.uDetailStrength,
    })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldP;\nvarying vec3 vWorldN;")
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
\tvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
\tvWorldN = normalize(mat3(modelMatrix) * objectNormal);`)
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", `uniform float opacity;
uniform sampler2D uC0, uN0, uC1, uN1, uC2, uN2, uC3, uN3, uNoise, uOrtho;
uniform vec3 uWet0, uDry0, uWet1, uDry1, uWet2, uDry2, uWet3, uDry3;
uniform vec4 uScale, uRough, uGround, uMacro, uFade, uOrthoRamp;
uniform float uSat, uGain, uStrength, uOrthoOn;
varying vec3 vWorldP;
varying vec3 vWorldN;
vec3 tBump = vec3(0.0);
float tRough = 1.0;`)
      .replace("#include <map_fragment>", `{
\tvec4 mask = texture2D(map, vMapUv);
\tfloat dist = length(vViewPosition);
\tvec3 nW = normalize(vWorldN);
\tvec2 wxz = vWorldP.xz;

\t// one low frequency read does three jobs: it tints whole fields, it slides the texture grid so no two repeats of
\t// a set line up, and it varies the dryness within a field so nothing is uniform
\tfloat macro = texture2D(uNoise, wxz * uMacro.x).r;
\tvec2 warp = (vec2(macro, macro * macro) - 0.5) * uMacro.z;
\tfloat dry = clamp(mask.a + (macro - 0.5) * 0.35, 0.0, 1.0);

\tfloat w0 = clamp(1.0 - mask.r - mask.g - mask.b, 0.0, 1.0);   // grass is whatever the painted classes leave over
\tfloat w1 = mask.r, w2 = mask.g, w3 = mask.b;

\t// a top down projection stretches into streaks on a bank, so past uGround.z the dominant side plane takes over
\tfloat slope = clamp((1.0 - abs(nW.y) - uGround.z) * uGround.w, 0.0, 1.0);
\tbool xMajor = abs(nW.x) > abs(nW.z);
\tvec2 side = xMajor ? vec2(vWorldP.z, vWorldP.y) : vec2(vWorldP.x, vWorldP.y);

\tfloat normW = 1.0 - smoothstep(uFade.z * 0.6, uFade.z, dist);            // relief stops reading at range
\tfloat fineW = (1.0 - clamp((dist - uFade.x) * uFade.y, 0.0, 1.0)) * 0.55;  // the extra fine tap, close in only
${LAYERS.map((_, i) => layerBlock(i)).join("\n")}

\t// height blend: the layer standing proud keeps its crevices instead of dissolving into the next one
\tfloat k0 = h0 * uGround.x + w0, k1 = h1 * uGround.x + w1, k2 = h2 * uGround.x + w2, k3 = h3 * uGround.x + w3;
\tfloat top = max(max(k0, k1), max(k2, k3)) - uGround.y;
\tfloat g0 = w0 > ${WEIGHT_EPS} ? max(k0 - top, 0.0) : 0.0;
\tfloat g1 = w1 > ${WEIGHT_EPS} ? max(k1 - top, 0.0) : 0.0;
\tfloat g2 = w2 > ${WEIGHT_EPS} ? max(k2 - top, 0.0) : 0.0;
\tfloat g3 = w3 > ${WEIGHT_EPS} ? max(k3 - top, 0.0) : 0.0;
\tfloat gs = max(g0 + g1 + g2 + g3, 1e-4);

\tvec3 albedo = (c0 * g0 + c1 * g1 + c2 * g2 + c3 * g3) / gs;
\ttBump = (b0 * g0 + b1 * g1 + b2 * g2 + b3 * g3) / gs;
\ttRough = clamp(dot(vec4(g0, g1, g2, g3), uRough) / gs * (0.84 + 0.26 * dry), 0.06, 1.0);

\talbedo *= 1.0 - uMacro.y * 0.5 + uMacro.y * macro;                        // no two hectares quite the same tone
\talbedo *= mix(vec3(1.0), vec3(1.05, 1.0, 0.92), macro * macro * 0.7);     // …and a slow warm/cool drift over them

\tif (uOrthoOn > 0.5) {
\t\t// The aerial photo, deliberately soft: half a metre per pixel cannot carry grass, but it does know that this
\t\t// field is beet and that one maize, that this verge is mown and that a track crosses that meadow. So it is
\t\t// stripped of its own brightness and laid over the material as colour plus a gentle exposure, more of it far
\t\t// away where the material's detail has faded anyway. Ortho.js streams it at 512 px for a 500 m tile, so it is
\t\t// already as soft as it needs to be and no mip bias is needed to blur it further.
\t\tvec3 ph = texture2D(uOrtho, vMapUv).rgb;
\t\tfloat lum = dot(ph, vec3(0.299, 0.587, 0.114));
\t\tph = mix(vec3(lum), ph, uSat) * uGain;
\t\tfloat pl = max(dot(ph, vec3(0.3, 0.5, 0.2)), 0.03);
\t\tfloat k = mix(uOrthoRamp.x, uOrthoRamp.y, clamp((dist - uOrthoRamp.z) * uOrthoRamp.w, 0.0, 1.0));
\t\talbedo = mix(albedo, albedo * (ph / pl) * clamp(pl / 0.34, 0.65, 1.45), k);
\t}
\tdiffuseColor.rgb = albedo;
}`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = tRough;")
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
\t{
\t\tvec3 nW = normalize(vWorldN);
\t\tvec3 t = tBump - nW * dot(tBump, nW);                                   // keep the perturbation tangential
\t\tnormal = normalize(mat3(viewMatrix) * normalize(nW + t * (uStrength * uFade.w)));
\t}`)
  }
  m.customProgramCacheKey = () => "terrain-cover"
  const prevDispose = m.dispose.bind(m)
  m.dispose = () => { disposeTexture(own.uOrtho.value); own.uOrtho.value = null; own.uOrthoOn.value = 0; prevDispose() }
  return m
}
