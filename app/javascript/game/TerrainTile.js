import * as THREE from "three"
import { disposeTexture } from "game/Textures"

const plain = new THREE.MeshStandardMaterial({ color: 0x7fa15a, roughness: 1 })   // tiles without land cover
plain.__shared = true

// Saturation and gain applied to the aerial photo: it carries baked sunlight already, so under the scene's own sun
// and tone mapping it washes out; a little less gain and a little more colour bring it next to the painted palette.
// Shared uniform objects, tweakable live through TUNING.look (DayNight copies them every frame).
export const LOOK = { uSat: { value: 1.1 }, uGain: { value: 0.9 } }

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

// photo: true adds the saturation/gain tweak; every photo tile shares one shader program through the cache key
export function terrainMaterial(tex, photo) {
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })
  if (photo) {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uSat = LOOK.uSat
      shader.uniforms.uGain = LOOK.uGain
      shader.fragmentShader = shader.fragmentShader
        .replace("uniform float opacity;", "uniform float opacity;\nuniform float uSat;\nuniform float uGain;")
        .replace("#include <map_fragment>", "#include <map_fragment>\n\tfloat lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));\n\tdiffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, uSat) * uGain;")
    }
    m.customProgramCacheKey = () => "terrain-photo"
  }
  return m
}
