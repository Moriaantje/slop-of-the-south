import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { AoPass, SHADERS } from "game/Ao"
import { GRADE } from "game/Post"
import { Quality, LEVELS } from "game/Quality"

// Nothing in this project compiles GLSL before a browser does, and an undeclared uniform or a varying that only one
// stage knows about is a black screen with no message. So the shaders get the only static check they can have here:
// that the two stages agree on their varyings, and that the uniforms the source reads and the uniforms the material
// carries are the same set. Two sessions have already been lost to a shader that failed at first render.

const decls = (src, kind) => {
  const out = new Map()
  for (const m of src.matchAll(new RegExp(`\\b${kind}\\s+(\\w+)\\s+([^;]+);`, "g")))
    for (const name of m[2].split(",")) out.set(name.trim(), m[1])
  return out
}

const stages = [
  ["ao occlusion", SHADERS.occlusion, null],
  ["ao blur", SHADERS.blur, null],
  ["grade", { vertex: GRADE.vertexShader, fragment: GRADE.fragmentShader }, GRADE.uniforms],
]

for (const [name, shader, uniforms] of stages) {
  test(`${name}: every varying the fragment stage reads is written by the vertex stage`, () => {
    const inFragment = decls(shader.fragment, "varying"), inVertex = decls(shader.vertex, "varying")
    assert.ok(inFragment.size > 0, "a shader with no varyings at all is a sign the regex broke")
    for (const [v, type] of inFragment) {
      assert.ok(inVertex.has(v), `${v} is declared in the fragment stage but not the vertex stage`)
      assert.equal(inVertex.get(v), type, `${v} has a different type in each stage`)
    }
    for (const v of inVertex.keys()) assert.ok(new RegExp(`\\b${v}\\b`).test(shader.vertex.split("void main")[1] ?? ""), `${v} is declared but never written`)
  })

  test(`${name}: every uniform the fragment stage uses is declared`, () => {
    const declared = decls(shader.fragment, "uniform")
    const body = shader.fragment.replace(/\/\/[^\n]*/g, "").split("void main")[1] ?? ""
    for (const m of body.matchAll(/\b(u[A-Z]\w*|t[A-Z]\w*)\b/g))
      assert.ok(declared.has(m[1]), `${m[1]} is used but not declared as a uniform`)
  })

  if (uniforms) test(`${name}: the material's uniforms and the shader's declarations are the same set`, () => {
    const declared = [...decls(shader.fragment, "uniform").keys()].sort()
    assert.deepEqual(Object.keys(uniforms).sort(), declared)
  })
}

test("the occlusion shader never writes a bare integer where a float belongs", () => {
  // the one class of GLSL error this project keeps hitting that a regex can actually catch: a literal without a
  // decimal point used in float arithmetic. Loop counters and the sample-count macro are the legitimate integers.
  const body = SHADERS.occlusion.fragment.replace(/\/\/[^\n]*/g, "")
    .replace(/#define[^\n]*/g, "")
    .replace(/for \([^)]*\)/g, "")
  for (const m of body.matchAll(/(?<![.\w])\d+(?![.\d])/g)) assert.fail(`bare integer literal "${m[0]}" near: ${body.slice(Math.max(0, m.index - 40), m.index + 20).trim()}`)
})

// ---- the occlusion pass -------------------------------------------------------------------------------------------

const camera = () => new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 4000)

test("the occlusion pass leaves the colour chain alone", () => {
  const p = new AoPass(camera(), 1280, 720)
  assert.equal(p.needsSwap, false, "it writes its own buffer; nothing else in the chain shifts because of it")
  p.dispose()
})

test("the occlusion pass runs at a fraction of the frame buffer and follows a resize", () => {
  const p = new AoPass(camera(), 1280, 720, 0.25)
  assert.deepEqual([p.ao.width, p.ao.height], [320, 180])
  assert.deepEqual([p.blurred.width, p.blurred.height], [320, 180])
  p.setSize(1920, 1080)
  assert.deepEqual([p.ao.width, p.ao.height], [480, 270])
  assert.ok(Math.abs(p.occlusion.uniforms.uTexel.value.x - 1 / 480) < 1e-9, "the texel size follows the buffer")
  assert.ok(Math.abs(p.blur.uniforms.uTexel.value.y - 1 / 270) < 1e-9)
  p.dispose()
})

test("with no depth texture the occlusion pass does nothing rather than throwing", () => {
  const p = new AoPass(camera(), 320, 180)
  let drew = false
  const renderer = { setRenderTarget: () => { drew = true } }
  p.render(renderer, null, {})
  assert.equal(drew, false)
  p.dispose()
})

// ---- the quality ladder -------------------------------------------------------------------------------------------

const fakeWorld = () => ({
  renderer: { shadowMap: {}, setPixelRatio(r) { this.ratio = r }, },
  sun: { castShadow: false },
  scene: { traverse() {} },
})

test("the ladder only ever gets cheaper as it goes down", () => {
  for (let i = 1; i < LEVELS.length; i++) {
    const lo = LEVELS[i - 1], hi = LEVELS[i]
    assert.ok(lo.scale <= hi.scale, `${lo.name} renders no larger than ${hi.name}`)
    assert.ok(lo.shadow <= hi.shadow, `${lo.name} has no larger a shadow map than ${hi.name}`)
    assert.ok(lo.shadowEvery >= hi.shadowEvery, `${lo.name} redraws the shadow map no more often than ${hi.name}`)
    assert.ok(lo.ao <= hi.ao && lo.bloom <= hi.bloom, `${lo.name} spends no more on post than ${hi.name}`)
  }
})

test("the cheapest level has no post chain at all", () => {
  const L = LEVELS[0]
  assert.equal(L.post, false)
  assert.equal(L.ao, 0); assert.equal(L.bloom, 0); assert.equal(L.smaa, false); assert.equal(L.sharpen, 0)
  assert.ok(LEVELS.slice(1).every((l) => l.post === true), "every level above it does have one")
})

test("a quality change is handed to the post chain, which then knows to bypass itself", () => {
  const seen = []
  const post = { setQuality: (L) => seen.push(L.name) }
  const q = new Quality(fakeWorld(), post)
  assert.equal(seen.length, 1)
  q.level = 0
  q.apply()
  assert.deepEqual(seen[1], "bare")
})

test("the shadow map is redrawn on the level's own cadence", () => {
  const world = fakeWorld()
  const q = new Quality(world, null)
  q.shadowEvery = 3
  const drawn = []
  for (let f = 0; f < 6; f++) { q.update(16); drawn.push(world.renderer.shadowMap.needsUpdate) }
  assert.deepEqual(drawn, [true, false, false, true, false, false])
})

// ---- the chain end to end ------------------------------------------------------------------------------------------

// SMAAPass wants an Image to decode its lookup textures from; nothing else in the chain touches the browser.
globalThis.Image ??= class { set src(v) { this._src = v } get src() { return this._src } }

// A renderer that only knows how big it is. Nothing here renders: the point is that the chain is wired the size it
// thinks it is, which is exactly what went wrong before — the composer's buffers came out half again too large and
// the bloom pyramid ran at the full width of the frame instead of a fraction of it.
function stubRenderer(w = 1280, h = 720, ratio = 1.5) {
  const r = {
    p: ratio, shadowMap: {}, setRenderTarget() {}, render() {},
    getSize: (v) => v.set(w, h), getPixelRatio: () => ratio,
    setPixelRatio(p) { this.p = p },
    getDrawingBufferSize(v) { return v.set(Math.round(w * this.p), Math.round(h * this.p)) },
  }
  return r
}

const stubWorld = () => {
  const renderer = stubRenderer()
  return { renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 4000), sun: { castShadow: false }, render() {} }
}

test("the composer counts in drawing-buffer pixels, not in logical pixels times a stale ratio", async () => {
  const { Post } = await import("game/Post")
  const world = stubWorld()
  const post = new Post(world)
  assert.equal(post.composer._pixelRatio, 1, "so setSize means what this file means by it")
  const q = new Quality(world, post)
  const want = world.renderer.getDrawingBufferSize(new THREE.Vector2())
  assert.deepEqual([post.composer.renderTarget1.width, post.composer.renderTarget1.height], [want.x, want.y])
  assert.deepEqual([post.composer.renderTarget2.width, post.composer.renderTarget2.height], [want.x, want.y])
  assert.ok(post.composer.renderTarget1.depthTexture && post.composer.renderTarget2.depthTexture,
    "both buffers carry depth: the composer swaps them from frame to frame and the occlusion reads whichever it gets")
  assert.equal(q.name, LEVELS[3].name)
})

test("every quality level resizes the buffers, the occlusion and the bloom pyramid together", async () => {
  const { Post } = await import("game/Post")
  const world = stubWorld()
  const post = new Post(world)
  const q = new Quality(world, post)
  for (let level = 0; level < LEVELS.length; level++) {
    q.level = level
    q.apply()
    const L = LEVELS[level], size = world.renderer.getDrawingBufferSize(new THREE.Vector2())
    assert.equal(post.bypass, L.post === false, `${L.name}: bypass`)
    if (post.bypass) continue
    assert.deepEqual([post.composer.renderTarget1.width, post.composer.renderTarget1.height], [size.x, size.y], `${L.name}: buffer`)
    assert.ok(post.composer.renderTarget1.depthTexture, `${L.name}: depth survives the resize`)
    assert.equal(post.ao.enabled, L.ao > 0, `${L.name}: occlusion`)
    if (L.ao > 0) assert.equal(post.ao.ao.width, Math.round(size.x * L.ao), `${L.name}: occlusion runs at its fraction`)
    assert.equal(post.smaa.enabled, !!L.smaa, `${L.name}: smaa`)
    // UnrealBloomPass halves again inside setSize, so its first mip is a quarter of the fraction it is given
    if (L.bloom > 0) assert.equal(post.bloom.renderTargetsHorizontal[0].width, Math.round(Math.round(size.x * L.bloom) / 2), `${L.name}: bloom pyramid`)
  }
})
