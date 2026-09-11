import * as THREE from "three"
import { disposeTexture, loadBitmap, bitmapTexture, versioned, pbrEnabled, noiseTexture } from "game/Textures"

// Saturation and gain applied to the aerial photo: it carries baked sunlight already, so under the scene's own sun
// and tone mapping it washes out; a little less gain and a little more colour bring it next to the painted palette.
// Shared uniform objects, tweakable live through TUNING.look (DayNight copies them every frame). uDark is the
// night (0 day … 1 night), used by the lit windows in BuildingMeshes.
export const LOOK = { uSat: { value: 1.1 }, uGain: { value: 0.9 }, uDark: { value: 0 },
                      uDetail: { value: null }, uDetailScale: { value: 500 / 2.5 }, uDetailNear: { value: 30 }, uDetailFar: { value: 260 }, uDetailStrength: { value: 0.9 },
                      uGrass: { value: null }, uGrassN: { value: null }, uGrassOn: { value: 0 }, uGrassScale: { value: 500 / 1.6 } }

// Up close the photo cannot carry grass: at half a metre per pixel a lawn is a green smear. Where the photo pixel is
// green, the near field blends in a photo-scanned grass material (ambientCG Grass004, CC0): its albedo modulated by
// the photo's own brightness so the field keeps its patches, and its normal map so blades catch the sun. Fades out
// by 90 m, where the photo alone is sharp enough.
let grassRequested = false
function requestGrass() {
  if (grassRequested || !pbrEnabled()) return
  grassRequested = true
  Promise.all([loadBitmap(versioned("/textures/grass/color.jpg")), loadBitmap(versioned("/textures/grass/normal.jpg"))]).then(([c, n]) => {
    LOOK.uGrass.value = bitmapTexture(c, { srgb: true, repeat: 1 })
    LOOK.uGrassN.value = bitmapTexture(n, { srgb: false, repeat: 1 })
    LOOK.uGrassOn.value = 1
  }).catch((e) => console.warn("grass material:", e.message))
}

// The ground up close: a 500 m tile carries a 1024 px photo (half a metre per pixel) on a 10 m height grid, so the
// first thirty metres around the car were a blur of big soft pixels on flat facets. A tiling grain texture
// (procedural, 256 px, made once) is multiplied in at 2.5 m repeats and its gradient bends the normal a little, so
// the ground has grass and gravel texture that catches the light; both fade out with distance and cost a couple of
// texture reads per fragment. Shared by the photo, the painted land cover and the plain green.
function detailTexture() { return LOOK.uDetail.value ??= noiseTexture() }

const plain = terrainMaterial(null, false)                                       // tiles without land cover
plain.color.set(0x7fa15a)
plain.__shared = true

// Heightmap (rows north→south, columns west→east) → displaced plane, plus bilinear sampling. The material starts with
// the painted land cover (or the shared green) and swaps to the aerial photo when Ortho delivers it.
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
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.h[i])
    geo.computeVertexNormals()

    // per-tile material when a land cover texture is painted (disposed with the tile), else the shared green
    const material = texture ? terrainMaterial(texture, false) : plain
    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.position.set(this.ox + this.size / 2, 0, this.oz + this.size / 2)
  }

  // the aerial photo arrived: replace the paint (or the shared green) with it
  setMap(tex) {
    const old = this.mesh.material
    this.mesh.material = terrainMaterial(tex, true)
    if (old !== plain) { disposeTexture(old.map); old.dispose() }
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

// photo: true adds the saturation/gain tweak; all tiles of a kind share one shader program through the cache key
export function terrainMaterial(tex, photo) {
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uSat: LOOK.uSat, uGain: LOOK.uGain, uDetail: LOOK.uDetail, uDetailScale: LOOK.uDetailScale,
                                     uDetailNear: LOOK.uDetailNear, uDetailFar: LOOK.uDetailFar, uDetailStrength: LOOK.uDetailStrength,
                                     uGrass: LOOK.uGrass, uGrassN: LOOK.uGrassN, uGrassOn: LOOK.uGrassOn, uGrassScale: LOOK.uGrassScale })
    detailTexture(); requestGrass()
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vDetailUv;\nvarying vec2 vGrassUv;\nuniform float uDetailScale, uGrassScale;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvDetailUv = uv * uDetailScale;\n\tvGrassUv = uv * uGrassScale;")
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", `uniform float opacity;
uniform float uSat, uGain, uDetailNear, uDetailFar, uDetailStrength, uGrassOn;
uniform sampler2D uDetail, uGrass, uGrassN;
varying vec2 vDetailUv, vGrassUv;
float grassW = 0.0;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
${photo ? "\tfloat lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));\n\tdiffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, uSat) * uGain;" : ""}
\tfloat detailW = (1.0 - smoothstep(uDetailNear, uDetailFar, length(vViewPosition))) * uDetailStrength;
\tfloat det = texture2D(uDetail, vDetailUv).r;
\tfloat det2 = texture2D(uDetail, vDetailUv * 3.7 + 0.31).r;                       // a finer octave against visible repeats
\tfloat grain = mix(0.5, det * 0.7 + det2 * 0.3, detailW);
\tdiffuseColor.rgb *= 0.86 + 0.28 * grain;
\tif (uGrassOn > 0.5) {
\t\tvec3 ph = diffuseColor.rgb;
\t\tfloat green = clamp((ph.g - max(ph.r, ph.b)) * 10.0 + 0.2, 0.0, 1.0) * step(0.06, ph.g);   // how much this pixel is grass
\t\tgrassW = green * (1.0 - smoothstep(35.0, 95.0, length(vViewPosition)));
\t\tvec3 g = mix(texture2D(uGrass, vGrassUv).rgb, texture2D(uGrass, vGrassUv.yx * 0.23 + 0.5).rgb, 0.45);   // two scales: no visible repeat
\t\tfloat plum = dot(ph, vec3(0.3, 0.5, 0.2)) / 0.32;                                    // the photo's brightness keeps the patches
\t\tdiffuseColor.rgb = mix(ph, g * clamp(plum, 0.6, 1.4) * vec3(0.95, 1.0, 0.9), grassW * 0.75);
\t}`)
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
\t{
\t\tvec2 e = vec2(1.0 / 256.0, 0.0);                                                // the detail's gradient bends the normal: grass and gravel catch the light
\t\tfloat hx = texture2D(uDetail, vDetailUv + e.xy).r - texture2D(uDetail, vDetailUv - e.xy).r;
\t\tfloat hz = texture2D(uDetail, vDetailUv + e.yx).r - texture2D(uDetail, vDetailUv - e.yx).r;
\t\tvec3 bend = mat3(viewMatrix) * vec3(-hx, 0.0, -hz) * (2.2 * detailW);
\t\tnormal = normalize(normal + bend);
\t\tif (grassW > 0.0) {                                                                    // the grass normal map, world x/z as the tangent frame
\t\t\tvec3 gn = texture2D(uGrassN, vGrassUv).xyz * 2.0 - 1.0;
\t\t\tnormal = normalize(normal + mat3(viewMatrix) * vec3(gn.x, 0.0, -gn.y) * (0.9 * grassW));
\t\t}
\t}`)
  }
  m.customProgramCacheKey = () => photo ? "terrain-photo" : tex ? "terrain-paint" : "terrain-plain"
  return m
}
