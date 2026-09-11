import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { off } from "game/Flags"
import { TUNING as T } from "game/Tuning"

// The post-processing chain, the part of the look that geometry cannot give: ground-truth ambient occlusion
// (Jimenez et al. 2016, three's GTAOPass with its Poisson denoiser) darkens the foot of every wall, the underside of
// every eave and the gap between things; a soft bloom lifts the sun, the lit windows and the fire; a grade pass adds
// filmic contrast, a little saturation, warm highlights against cool shadows and a vignette; the output pass does
// ACES and sRGB last. Rendered at device ratio 1 into a 4× multisampled target (post costs fill rate; MSAA keeps the
// edges). ?post=0 falls back to the plain renderer.
const GRADE = {
  uniforms: { tDiffuse: { value: null }, uContrast: { value: 1.08 }, uSaturation: { value: 1.12 }, uWarm: { value: 0.06 }, uVignette: { value: 0.28 }, uLift: { value: 0.0 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uContrast, uSaturation, uWarm, uVignette, uLift;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;                       // linear HDR
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(lum), c, uSaturation);                          // saturation
      c = (c - 0.18) * uContrast + 0.18 + uLift;                   // contrast about mid grey
      // split toning: warm the bright end, cool the dark end
      float t = smoothstep(0.0, 1.2, lum);
      c *= mix(vec3(0.97, 0.99, 1.06), vec3(1.05, 1.0, 0.94), t) * (1.0 - uWarm) + uWarm;
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.25, 0.9, dot(d, d) * 2.2);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
}

export class Post {
  constructor(world) {
    this.enabled = !off("post")
    this.world = world
    if (!this.enabled) return
    const r = world.renderer
    r.setPixelRatio(1)
    const size = r.getDrawingBufferSize(new THREE.Vector2())
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(r, target)
    this.composer.addPass(new RenderPass(world.scene, world.camera))
    this.ao = new GTAOPass(world.scene, world.camera, size.x, size.y)
    this.ao.output = GTAOPass.OUTPUT.Default
    Object.assign(this.ao.gtaoMaterial.uniforms, {})
    this.ao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.5, thickness: 1.0, distanceFallOff: 1.0, scale: 1.4, samples: 12, screenSpaceRadius: false })
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 12 })
    this.ao.blendIntensity = T.look.post.ao
    this.composer.addPass(this.ao)
    // The AO pass draws depth and normals with an override material that knows nothing of alpha: every sprite, leaf
    // card, grass tuft and label would occlude as a solid quad and wear a dark box. Everything cut out or transparent
    // lives on layer 1, which the main camera and the shadow camera see and the AO pre-pass does not.
    world.camera.layers.enable(1)
    world.sun.shadow.camera.layers.enable(1)
    const aoRender = this.ao.render.bind(this.ao)
    this.ao.render = (...args) => { world.camera.layers.disable(1); aoRender(...args); world.camera.layers.enable(1) }
    this.frame = 0
    this.bloom = new UnrealBloomPass(size, T.look.post.bloom, 0.55, 0.9)
    this.composer.addPass(this.bloom)
    this.grade = new ShaderPass(GRADE)
    this.composer.addPass(this.grade)
    this.composer.addPass(new OutputPass())
    addEventListener("resize", () => this.resize())
  }

  resize() {
    if (!this.enabled) return
    const size = this.world.renderer.getDrawingBufferSize(new THREE.Vector2())
    this.composer.setSize(size.x, size.y)
    this.ao.setSize(size.x, size.y)
  }

  // darkness 0..1: bloom bites harder at night (lit windows, fire), the AO a little less
  // new objects arrive all the time (tiles, effects): sort them onto the alpha layer once a second
  classify() {
    this.world.scene.traverse((o) => {
      if (o.layers.mask !== 1) return
      const m = o.material
      if (o.isSprite || (m && (m.alphaTest > 0 || m.transparent))) o.layers.set(1)
    })
  }

  render(darkness = 0) {
    if (!this.enabled) { this.world.render(); return }
    if (this.frame++ % 30 === 0) this.classify()
    const P = T.look.post
    this.ao.blendIntensity = P.ao
    this.bloom.strength = P.bloom * (1 + 0.8 * darkness)
    this.bloom.threshold = P.bloomThreshold
    const u = this.grade.uniforms
    u.uContrast.value = P.contrast; u.uSaturation.value = P.saturation; u.uVignette.value = P.vignette; u.uWarm.value = P.warm
    this.composer.render()
  }
}
