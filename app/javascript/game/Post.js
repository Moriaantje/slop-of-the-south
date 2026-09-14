import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js"
import { AoPass } from "game/Ao"
import { off } from "game/Flags"
import { TUNING as T } from "game/Tuning"

// The post-processing chain, the part of the look that geometry cannot give: ambient occlusion darkens the foot of
// every wall, the underside of every eave and the gap between things; a soft bloom lifts the sun, the lit windows
// and the fire; a grade pass adds contrast-adaptive sharpening (AMD FidelityFX CAS, 2019: a 3×3 cross that sharpens
// flat areas more than busy ones, the single cheapest way to make a game read as crisp), filmic contrast, a little
// saturation, warm highlights against cool shadows, a vignette and a whisper of film grain to break up banding; the
// output pass does ACES and sRGB last, then SMAA (Jimenez et al. 2012) cleans the remaining edges.
//
// Everything here is fill rate, so everything here is a lever, and Quality.js pulls all of them. The chain was
// costing far more than it was worth. Three changes paid for themselves several times over.
//
// The occlusion no longer comes from three's GTAOPass. That pass renders the whole scene a second time through an
// override material to build a normal buffer — a third geometry pass, as expensive as the main render, on top of
// the shadow pass — then denoises and composites in two more full-screen passes. game/Ao reads the depth buffer the
// main render already wrote, runs at a quarter of the width, and hands its result to the grade, which multiplies it
// in while it is reading the frame anyway. One geometry pass gone, three full-screen passes down to two small ones.
//
// The frame buffer no longer carries 2× multisampling. Rendering into an offscreen target means the canvas's own
// multisampling was doing nothing at all, and MSAA inside the target buys little on a scene made mostly of
// alpha-tested foliage, which it cannot antialias. SMAA at the end of the chain does that work instead, and the
// buffer bandwidth halves. The trade is real: a bare roof edge against the sky is a touch harder than it was.
//
// And the chain can now be switched off entirely, pass by pass, down to a bare renderer call with nothing after it.
// That is what the cheapest quality level does, and it is the difference between a frame and half a frame.
//
// ?post=0 still falls back to the plain renderer for good.
export const GRADE = {
  uniforms: { tDiffuse: { value: null }, tAo: { value: null }, uAo: { value: 0 },
              uContrast: { value: 1.08 }, uSaturation: { value: 1.12 }, uWarm: { value: 0.06 }, uVignette: { value: 0.28 },
              uLift: { value: 0.0 }, uSharpen: { value: 0.5 }, uGrain: { value: 0.02 }, uTime: { value: 0 }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform sampler2D tAo;
    uniform float uAo, uContrast, uSaturation, uWarm, uVignette, uLift, uSharpen, uGrain, uTime;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;                       // linear HDR
      // contrast-adaptive sharpening: the four neighbours decide how much to sharpen, so noise and foliage are
      // left alone while flat surfaces and edges gain definition
      if (uSharpen > 0.0) {
        vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, -uTexel.y)).rgb;
        vec3 s = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;
        vec3 w = texture2D(tDiffuse, vUv + vec2(-uTexel.x, 0.0)).rgb;
        vec3 e = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;
        vec3 lo = min(c, min(min(n, s), min(w, e))), hi = max(c, max(max(n, s), max(w, e)));
        vec3 amp = sqrt(clamp(min(lo, 2.0 - hi) / max(hi, 1e-4), 0.0, 1.0));
        vec3 wgt = -amp * uSharpen * 0.2;
        c = clamp((c + (n + s + w + e) * wgt) / (1.0 + 4.0 * wgt), 0.0, 8.0);
      }
      // the occlusion buffer, upsampled by the hardware: folded in here so it costs one fetch and no pass of its own
      if (uAo > 0.0) c *= mix(1.0, texture2D(tAo, vUv).r, uAo);
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(lum), c, uSaturation);                          // saturation
      c = (c - 0.18) * uContrast + 0.18 + uLift;                   // contrast about mid grey
      // split toning: warm the bright end, cool the dark end
      float t = smoothstep(0.0, 1.2, lum);
      c *= mix(vec3(0.97, 0.99, 1.06), vec3(1.05, 1.0, 0.94), t) * (1.0 - uWarm) + uWarm;
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.25, 0.9, dot(d, d) * 2.2);
      // film grain, scaled down in the highlights: hides banding in the sky and the fog
      float g = fract(sin(dot(vUv * 1000.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      c += g * uGrain * (1.0 - smoothstep(0.0, 1.5, lum));
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
}

// A depth texture on the composer's colour buffer. The occlusion pass needs the depth the main render wrote, and
// the composer keeps two colour buffers and swaps between them from frame to frame, so both need one. Disposing the
// target afterwards is what makes three rebuild its framebuffer around the new attachment.
function attachDepth(target, w, h) {
  target.depthTexture?.dispose()
  const d = new THREE.DepthTexture(w, h)
  d.type = THREE.UnsignedIntType
  d.minFilter = THREE.NearestFilter
  d.magFilter = THREE.NearestFilter
  target.depthTexture = d
  target.dispose()
}

export class Post {
  constructor(world) {
    this.enabled = !off("post")
    this.bypass = false
    this.world = world
    if (!this.enabled) return
    const r = world.renderer
    const size = r.getDrawingBufferSize(new THREE.Vector2())
    // samples: 0 — SMAA at the end of the chain is the antialiasing now, see the note above
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0, stencilBuffer: false })
    this.composer = new EffectComposer(r, target)
    // EffectComposer.setSize takes LOGICAL pixels and multiplies by a pixel ratio it captured when it was built.
    // Everything here counts in drawing-buffer pixels, and it was being handed those, so on a Retina screen the
    // composer's buffers came out 1.5× wider and taller than the canvas — two and a quarter times the pixels, for
    // every pass in the chain, every frame. Pinning the ratio to one makes setSize mean what the rest of this file
    // means by it. The renderer's own pixel ratio is Quality.js's lever and is unaffected.
    this.composer.setPixelRatio(1)
    this.composer.addPass(new RenderPass(world.scene, world.camera))
    attachDepth(this.composer.renderTarget1, size.x, size.y)
    attachDepth(this.composer.renderTarget2, size.x, size.y)
    this.ao = new AoPass(world.camera, size.x, size.y, 0.25)
    this.composer.addPass(this.ao)
    this.bloom = new UnrealBloomPass(size.clone().multiplyScalar(0.5), T.look.post.bloom, 0.55, 0.9)
    this.composer.addPass(this.bloom)
    this.grade = new ShaderPass(GRADE)
    this.grade.uniforms.tAo.value = this.ao.texture
    this.grade.uniforms.uTexel.value.set(1 / size.x, 1 / size.y)
    this.composer.addPass(this.grade)
    this.composer.addPass(new OutputPass())
    this.smaa = new SMAAPass()
    this.composer.addPass(this.smaa)
    this.sharpen = 1
    this.aoFraction = 0.25
    this.bloomFraction = 0.5
    this.bufferSize = size.clone()
    addEventListener("resize", () => this.resize())
  }

  // Rebuilding the buffers throws away two full-resolution half-float targets and both depth textures, so that part
  // happens only when the drawing buffer has really changed size — a window resize, or a quality level with a new
  // scale. The second half always runs, because EffectComposer.setSize tells every pass it is full size, and the two
  // passes that are deliberately not full size have to be told again afterwards. That call is why the bloom pyramid
  // had been running at the full width of the frame ever since it was added, rather than at the half it asks for.
  resize(force = false) {
    if (!this.enabled) return
    const size = this.world.renderer.getDrawingBufferSize(new THREE.Vector2())
    const changed = size.x !== this.bufferSize.x || size.y !== this.bufferSize.y
    if (changed) {
      this.bufferSize.copy(size)
      this.composer.setSize(size.x, size.y)
      attachDepth(this.composer.renderTarget1, size.x, size.y)
      attachDepth(this.composer.renderTarget2, size.x, size.y)
      this.grade.uniforms.uTexel.value.set(1 / size.x, 1 / size.y)
    }
    if (!changed && !force) return
    if (this.aoFraction > 0) { this.ao.fraction = this.aoFraction; this.ao.setSize(size.x, size.y) }
    const b = this.bloomFraction || 0.5
    this.bloom.setSize(Math.max(16, Math.round(size.x * b)), Math.max(16, Math.round(size.y * b)))
  }

  // Quality.js decides what the frame may cost: whether the chain runs at all, the occlusion's fraction, the bloom
  // pyramid's size, whether SMAA runs and whether the grade sharpens.
  setQuality(L) {
    if (!this.enabled) return
    this.bypass = L.post === false
    this.sharpen = L.sharpen ?? 1
    if (this.bypass) return
    this.aoFraction = L.ao
    this.bloomFraction = L.bloom
    this.ao.enabled = L.ao > 0
    this.bloom.enabled = L.bloom > 0
    this.smaa.enabled = !!L.smaa
    this.resize(true)
  }

  // darkness 0..1: bloom bites harder at night (lit windows, fire)
  render(darkness = 0) {
    if (!this.enabled || this.bypass) {
      this.world.renderer.setRenderTarget(null)     // a quality change may have left a pass's buffer bound
      this.world.render()
      return
    }
    const P = T.look.post
    this.ao.intensity = P.ao
    this.grade.uniforms.uAo.value = this.ao.enabled ? 1 : 0
    this.bloom.strength = P.bloom * (1 + 0.8 * darkness)
    this.bloom.threshold = P.bloomThreshold
    const u = this.grade.uniforms
    u.uContrast.value = P.contrast; u.uSaturation.value = P.saturation; u.uVignette.value = P.vignette; u.uWarm.value = P.warm
    u.uSharpen.value = P.sharpen * this.sharpen; u.uGrain.value = P.grain; u.uTime.value = performance.now() * 0.001
    this.composer.render()
  }
}
