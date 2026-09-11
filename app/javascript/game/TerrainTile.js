import * as THREE from "three"
import { disposeTexture } from "game/Textures"

// Saturation and gain applied to the aerial photo: it carries baked sunlight already, so under the scene's own sun
// and tone mapping it washes out; a little less gain and a little more colour bring it next to the painted palette.
// Shared uniform objects, tweakable live through TUNING.look (DayNight copies them every frame). uDark is the
// night (0 day … 1 night), used by the lit windows in BuildingMeshes.
export const LOOK = { uSat: { value: 1.1 }, uGain: { value: 0.9 }, uDark: { value: 0 },
                      uDetail: { value: null }, uDetailScale: { value: 500 / 2.5 }, uDetailNear: { value: 30 }, uDetailFar: { value: 260 }, uDetailStrength: { value: 0.9 } }

// The ground up close: a 500 m tile carries a 1024 px photo (half a metre per pixel) on a 10 m height grid, so the
// first thirty metres around the car were a blur of big soft pixels on flat facets. A tiling grain texture
// (procedural, 256 px, made once) is multiplied in at 2.5 m repeats and its gradient bends the normal a little, so
// the ground has grass and gravel texture that catches the light; both fade out with distance and cost a couple of
// texture reads per fragment. Shared by the photo, the painted land cover and the plain green.
function detailTexture() {
  if (LOOK.uDetail.value) return LOOK.uDetail.value
  const n = 256, c = document.createElement("canvas"); c.width = c.height = n
  const ctx = c.getContext("2d"), img = ctx.createImageData(n, n), d = img.data
  let s = 12345
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  // value noise, three octaves, periodic so the tile wraps
  const grid = (m) => { const g = new Float32Array(m * m); for (let i = 0; i < m * m; i++) g[i] = rnd(); return g }
  const octaves = [[8, grid(8), 0.5], [32, grid(32), 0.3], [128, grid(128), 0.2]]
  const sample = (g, m, x, y) => {
    const fx = x * m, fy = y * m, x0 = Math.floor(fx) % m, y0 = Math.floor(fy) % m, x1 = (x0 + 1) % m, y1 = (y0 + 1) % m
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy), sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    const a = g[y0 * m + x0], b = g[y0 * m + x1], cc = g[y1 * m + x0], dd = g[y1 * m + x1]
    return (a + (b - a) * sx) * (1 - sy) + (cc + (dd - cc) * sx) * sy
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 0
    for (const [m, g, w] of octaves) v += w * sample(g, m, x / n, y / n)
    v = 0.5 + (v - 0.5) * 1.6 + (rnd() - 0.5) * 0.12                         // more contrast, a little grain
    const p = (y * n + x) * 4, b = Math.max(0, Math.min(255, Math.round(v * 255)))
    d[p] = d[p + 1] = d[p + 2] = b; d[p + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 4
  LOOK.uDetail.value = tex
  return tex
}

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
                                     uDetailNear: LOOK.uDetailNear, uDetailFar: LOOK.uDetailFar, uDetailStrength: LOOK.uDetailStrength })
    detailTexture()
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vDetailUv;\nuniform float uDetailScale;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvDetailUv = uv * uDetailScale;")
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float opacity;", `uniform float opacity;
uniform float uSat, uGain, uDetailNear, uDetailFar, uDetailStrength;
uniform sampler2D uDetail;
varying vec2 vDetailUv;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
${photo ? "\tfloat lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));\n\tdiffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, uSat) * uGain;" : ""}
\tfloat detailW = (1.0 - smoothstep(uDetailNear, uDetailFar, length(vViewPosition))) * uDetailStrength;
\tfloat det = texture2D(uDetail, vDetailUv).r;
\tfloat det2 = texture2D(uDetail, vDetailUv * 3.7 + 0.31).r;                       // a finer octave against visible repeats
\tfloat grain = mix(0.5, det * 0.7 + det2 * 0.3, detailW);
\tdiffuseColor.rgb *= 0.72 + 0.56 * grain;`)
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
\t{
\t\tvec2 e = vec2(1.0 / 256.0, 0.0);                                                // the detail's gradient bends the normal: grass and gravel catch the light
\t\tfloat hx = texture2D(uDetail, vDetailUv + e.xy).r - texture2D(uDetail, vDetailUv - e.xy).r;
\t\tfloat hz = texture2D(uDetail, vDetailUv + e.yx).r - texture2D(uDetail, vDetailUv - e.yx).r;
\t\tvec3 bend = mat3(viewMatrix) * vec3(-hx, 0.0, -hz) * (2.2 * detailW);
\t\tnormal = normalize(normal + bend);
\t}`)
  }
  m.customProgramCacheKey = () => photo ? "terrain-photo" : tex ? "terrain-paint" : "terrain-plain"
  return m
}
