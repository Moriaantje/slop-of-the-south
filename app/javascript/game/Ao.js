import * as THREE from "three"
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js"

// Ambient occlusion from the depth buffer alone, and nothing else.
//
// What this replaces is worth saying plainly, because it was the single most expensive thing in the frame.
// three's GTAOPass is a beautiful piece of work, but before it can shade anything it renders the entire scene a
// second time through an override material to get view normals and depth — a whole extra geometry pass over every
// tile, every house, every tree, on top of the shadow pass and the main pass. Three geometry passes for one picture.
// It then runs the occlusion at half resolution, a Poisson denoise over that, and a third full-screen pass to
// composite the result. Measured on the real Limburg tiles that pre-pass costs the same draw calls and nearly the
// same triangles as the main render: a third of all the geometry work in the frame, spent on a buffer nobody sees.
//
// The main render already writes a depth buffer. So this pass takes that depth texture, reconstructs the view
// position of every pixel from the inverse projection, reconstructs the normal from the depth of its four
// neighbours (picking the nearer neighbour on each axis, so a silhouette does not bend the normal across it), and
// estimates occlusion with the Alchemy estimator (McGuire et al. 2011): for a ring of samples around the pixel,
// how far each one rises above the tangent plane, falling off with the square of its distance. Eight taps at a
// quarter of the buffer's width — a sixteenth of the pixels — then one depth-aware blur at the same size, and the
// grade pass multiplies the result in while it is already reading the frame, so there is no composite pass either.
//
// It buys two things besides the speed. Cut-out geometry now occludes correctly: the override material GTAO used
// knew nothing of alphaTest, so every leaf card and grass tuft wrote its whole quad into the normal buffer and wore
// a dark rectangle, which is why everything translucent had to be hidden from it on a separate layer. The depth
// buffer is written by the real materials, alpha test and all, so a leaf occludes as a leaf. And it never sees
// geometry that does not write depth, so the mech's shield bubble cannot black the screen out any more.
//
// What it gives up against ground-truth ambient occlusion is the wide, soft, physically-weighted horizon search:
// this darkens contacts and creases within a couple of metres and leaves the large-scale shading to the lights.
// From a car at speed that is the part the eye reads anyway.
const SAMPLES = 8              // taps per pixel; the loop bound is a compile-time constant, so this is a rebuild
const TURNS = 5.0              // how many times the sample spiral winds round, chosen coprime-ish with SAMPLES
const EPS = 0.03               // m²: keeps the inverse-square term finite for a sample on top of the centre
const BLUR_FALLOFF = 1.6       // per metre of depth difference: how fast the blur stops crossing an edge
const RADIUS = 2.0             // m: the world-space reach of the occlusion search
const BIAS = 0.12              // sine of the smallest elevation angle a sample must clear to count as occluding
const FADE_NEAR = 110          // m: occlusion starts fading out here…
const FADE_FAR = 220           // m: …and is gone by here, where a quarter-res reconstruction is only noise anyway

// Depth in [0, 1] to view-space z (negative, metres). The same expression three uses in its packing chunk.
const VIEW_Z = /* glsl */`
float viewZ(float depth) { return (uNear * uFar) / ((uFar - uNear) * depth - uFar); }`

const VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

const OCCLUSION = /* glsl */`
#define AO_SAMPLES ${SAMPLES}
uniform sampler2D tDepth;
uniform vec2 uTexel;          // 1 / the size of this pass's buffer, in uv
uniform vec2 uProjScale;      // half the projection's x and y scale: metres at one metre of depth, in uv
uniform mat4 uProjInv;
uniform float uNear, uFar, uRadius, uIntensity, uBias, uFadeNear, uFadeInv;
varying vec2 vUv;
${VIEW_Z}

// The view-space point behind a pixel: unproject a clip-space ray through it, then slide along that ray until its
// z matches the depth we read. Only correct for a perspective camera, which is the only one that renders the world.
vec3 viewPos(vec2 uv, float vz) {
  vec4 h = uProjInv * vec4(uv * 2.0 - 1.0, 0.5, 1.0);
  vec3 ray = h.xyz / h.w;
  return ray * (vz / ray.z);
}

void main() {
  float d = texture2D(tDepth, vUv).x;
  if (d >= 1.0) { gl_FragColor = vec4(1.0); return; }              // nothing was drawn here: no occlusion
  float z = viewZ(d);
  vec3 P = viewPos(vUv, z);

  // The normal, from the depth of the four neighbours. Taking the nearer of the two on each axis keeps a silhouette
  // from tilting the normal towards whatever lies far behind it, which is what makes naive depth normals ring.
  vec2 dx = vec2(uTexel.x, 0.0), dy = vec2(0.0, uTexel.y);
  vec3 pl = viewPos(vUv - dx, viewZ(texture2D(tDepth, vUv - dx).x));
  vec3 pr = viewPos(vUv + dx, viewZ(texture2D(tDepth, vUv + dx).x));
  vec3 pd = viewPos(vUv - dy, viewZ(texture2D(tDepth, vUv - dy).x));
  vec3 pu = viewPos(vUv + dy, viewZ(texture2D(tDepth, vUv + dy).x));
  vec3 ex = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 ey = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(ex, ey));
  if (N.z < 0.0) N = -N;                                           // the camera looks down -z, so the normal faces +z

  // A spiral of taps, rotated per pixel by interleaved gradient noise (Jimenez 2014) so the undersampling comes out
  // as a fine dither the blur can eat rather than as eight visible arms.
  float ang = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  vec2 reach = uProjScale * (uRadius / -z);
  float occ = 0.0;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float t = (float(i) + 0.5) / float(AO_SAMPLES);
    float a = ang + t * 6.2831853 * ${TURNS.toFixed(1)};
    vec2 suv = vUv + vec2(cos(a), sin(a)) * sqrt(t) * reach;
    vec3 v = viewPos(suv, viewZ(texture2D(tDepth, suv).x)) - P;
    float vv = dot(v, v);
    occ += max(0.0, dot(v, N) - uBias * sqrt(vv)) / (vv + ${EPS.toFixed(3)});
  }
  float ao = 1.0 - occ * uRadius * uIntensity * (2.0 / float(AO_SAMPLES));
  ao = mix(clamp(ao, 0.0, 1.0), 1.0, clamp((-z - uFadeNear) * uFadeInv, 0.0, 1.0));
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`

// A 3×3 box that will not blur across a depth edge, so the occlusion under a wall does not smear onto the wall.
const BLUR = /* glsl */`
uniform sampler2D tAo;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear, uFar;
varying vec2 vUv;
${VIEW_Z}

void main() {
  float z0 = viewZ(texture2D(tDepth, vUv).x);
  float sum = 0.0, wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      float w = exp(-abs(viewZ(texture2D(tDepth, vUv + o).x) - z0) * ${BLUR_FALLOFF.toFixed(2)});
      sum += texture2D(tAo, vUv + o).r * w;
      wsum += w;
    }
  }
  float ao = sum / max(wsum, 0.0001);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`

// A quarter-resolution single-byte buffer. Linear filtering, because the grade pass reads it at full resolution.
function aoTarget(w, h) {
  const t = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false })
  t.texture.minFilter = THREE.LinearFilter
  t.texture.magFilter = THREE.LinearFilter
  t.texture.wrapS = t.texture.wrapT = THREE.ClampToEdgeWrapping
  return t
}

// The shader sources, exported so the test suite can check the things nothing else here can: that every varying is
// declared in both stages and that every uniform a stage reads is declared. There is no GLSL compiler in this
// project, so that check is the only compiler these shaders get before a browser sees them.
export const SHADERS = { occlusion: { vertex: VERTEX, fragment: OCCLUSION }, blur: { vertex: VERTEX, fragment: BLUR } }

export class AoPass extends Pass {
  // camera: the one the scene was rendered with. fraction: the share of the frame buffer this runs at.
  constructor(camera, width, height, fraction = 0.25) {
    super()
    this.needsSwap = false                 // it writes its own buffer; the colour chain flows past untouched
    this.camera = camera
    this.fraction = fraction
    this.intensity = 1.0
    const w = Math.max(8, Math.round(width * fraction)), h = Math.max(8, Math.round(height * fraction))
    this.ao = aoTarget(w, h)
    this.blurred = aoTarget(w, h)
    this.occlusion = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
                  uProjScale: { value: new THREE.Vector2() }, uProjInv: { value: new THREE.Matrix4() },
                  uNear: { value: 0.5 }, uFar: { value: 4000 }, uRadius: { value: RADIUS },
                  uIntensity: { value: 1 }, uBias: { value: BIAS },
                  uFadeNear: { value: FADE_NEAR }, uFadeInv: { value: 1 / (FADE_FAR - FADE_NEAR) } },
      vertexShader: VERTEX, fragmentShader: OCCLUSION, depthTest: false, depthWrite: false,
    })
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tAo: { value: this.ao.texture }, tDepth: { value: null },
                  uTexel: { value: new THREE.Vector2(1 / w, 1 / h) }, uNear: { value: 0.5 }, uFar: { value: 4000 } },
      vertexShader: VERTEX, fragmentShader: BLUR, depthTest: false, depthWrite: false,
    })
    this.occlusionQuad = new FullScreenQuad(this.occlusion)
    this.blurQuad = new FullScreenQuad(this.blur)
  }

  // the texture the grade pass multiplies in
  get texture() { return this.blurred.texture }

  setSize(width, height) {
    const w = Math.max(8, Math.round(width * this.fraction)), h = Math.max(8, Math.round(height * this.fraction))
    this.ao.setSize(w, h)
    this.blurred.setSize(w, h)
    this.occlusion.uniforms.uTexel.value.set(1 / w, 1 / h)
    this.blur.uniforms.uTexel.value.set(1 / w, 1 / h)
  }

  // readBuffer is whatever the render pass drew into, and it carries the depth texture Post attached to it
  render(renderer, writeBuffer, readBuffer) {
    const depth = readBuffer?.depthTexture
    if (!depth) return                                   // no depth attached: leave the last frame's buffer alone
    const c = this.camera, u = this.occlusion.uniforms, e = c.projectionMatrix.elements
    u.tDepth.value = depth
    u.uProjScale.value.set(e[0] * 0.5, e[5] * 0.5)
    u.uProjInv.value.copy(c.projectionMatrixInverse)
    u.uNear.value = c.near; u.uFar.value = c.far
    u.uIntensity.value = this.intensity
    this.blur.uniforms.tDepth.value = depth
    this.blur.uniforms.uNear.value = c.near; this.blur.uniforms.uFar.value = c.far
    renderer.setRenderTarget(this.ao)
    this.occlusionQuad.render(renderer)
    renderer.setRenderTarget(this.blurred)
    this.blurQuad.render(renderer)
  }

  dispose() {
    this.ao.dispose(); this.blurred.dispose()
    this.occlusion.dispose(); this.blur.dispose()
    this.occlusionQuad.dispose(); this.blurQuad.dispose()
  }
}
