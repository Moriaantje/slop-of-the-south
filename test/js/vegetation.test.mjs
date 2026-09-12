import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { buildTrees, updateTreeLod, treeVariants, treeSpeciesGeometry } from "game/Trees"
import { Grass, coverTint } from "game/Grass"
import { KIT, kitPiece } from "game/Kit"
import { shade, paletteOf, leafPath, LEAF_SHAPES, FOLIAGE, leafAtlas, normalFromHeight, bleedAlpha } from "game/Foliage"
import { treeBarkMaterial, treeLeafMaterial } from "game/Trees"
import { grassMaterial } from "game/Grass"
import { kitCardMaterial } from "game/Kit"
import { weatherProp } from "game/Scatter"

const KINDS = [0, 1, 2, 3]
const finite = (attr) => { for (let i = 0; i < attr.array.length; i++) if (!Number.isFinite(attr.array[i])) return false; return true }
const range = (attr) => { let lo = Infinity, hi = -Infinity; for (const v of attr.array) { lo = Math.min(lo, v); hi = Math.max(hi, v) } return [lo, hi] }

test("every variant is a complete, finite, unit-tall tree", () => {
  for (const kind of KINDS) for (const v of treeVariants(kind)) {
    const wood = v.wood.getAttribute("position"), leaves = v.leaves.getAttribute("position")
    assert.ok(wood.count > 30, `${v.name} has a trunk`)
    assert.ok(leaves.count > 60, `${v.name} has a crown`)
    for (const [name, g] of [["wood", v.wood], ["leaves", v.leaves]]) {
      const n = g.getAttribute("position").count
      for (const key of Object.keys(g.attributes)) {
        assert.equal(g.getAttribute(key).count, n, `${v.name} ${name}.${key} matches the position count`)
        assert.ok(finite(g.getAttribute(key)), `${v.name} ${name}.${key} is finite`)
      }
    }
    // the shaders read flex and ao straight through a mix(), so anything outside [0, 1] shows as a glitch
    for (const key of ["flex", "ao"]) {
      const [lo, hi] = range(v.leaves.getAttribute(key))
      assert.ok(lo >= 0 && hi <= 1, `${v.name} leaf ${key} stays in [0, 1], got ${lo}..${hi}`)
    }
    const box = new THREE.Box3().setFromBufferAttribute(v.wood.getAttribute("position"))
    assert.ok(box.min.y > -0.02, `${v.name} stands on the ground`)
    assert.ok(box.max.y <= 1.001, `${v.name} fits inside one unit`)
  }
})

test("the whole tree, crown and all, fills its unit exactly once", () => {
  for (const kind of KINDS) for (const v of treeVariants(kind)) {
    let top = 0
    for (const c of v.cards) top = Math.max(top, c.at.y + c.size * 0.8)
    for (let i = 1; i < v.wood.getAttribute("position").array.length; i += 3) top = Math.max(top, v.wood.getAttribute("position").array[i])
    assert.ok(Math.abs(top - 1) < 1e-6, `${v.name} normalises to exactly 1, got ${top}`)
  }
})

test("the far card is wide enough to hold the tree it stands in for, and no wider than it needs", () => {
  for (const kind of KINDS) for (const v of treeVariants(kind)) {
    let reach = 0
    for (const c of v.cards) reach = Math.max(reach, Math.hypot(c.at.x, c.at.z) + c.size * 0.8)
    assert.ok(v.farWidth * 0.5 >= reach - 1e-6, `${v.name} would clip its impostor cell (${v.farWidth} for ${reach * 2})`)
    assert.ok(v.farWidth <= 2.2, `${v.name} far card stays within the atlas cell`)
  }
})

test("the variants of a kind are genuinely different shapes, not one shape reseeded", () => {
  for (const kind of KINDS) {
    const widths = treeVariants(kind).map((v) => v.farWidth)
    const spread = Math.max(...widths) / Math.min(...widths)
    assert.ok(spread > 1.25, `kind ${kind} silhouettes vary by ${spread.toFixed(2)}x`)
  }
  // a Lombardy poplar is a spire and a spreading oak is a dome: their proportions must not be close
  const poplar = treeSpeciesGeometry("poplar", 11), oak = treeSpeciesGeometry("oak", 11)
  assert.ok(oak.farWidth > poplar.farWidth * 1.6, "an oak spreads far wider than a poplar")
  const pollard = treeSpeciesGeometry("pollard", 11)
  assert.ok(pollard.farWidth < poplar.farWidth, "a pollarded willow is stubbier still")
})

test("the LOD sorts every standing tree into exactly one mesh, and a felled one into none", () => {
  const trees = []
  for (let i = 0; i < 240; i++) trees.push([(i % 20) * 12, Math.floor(i / 20) * 12, 1, 10])
  const handles = new Map()
  const group = buildTrees(trees, () => 0, (key, h) => handles.set(key, h))
  const tally = () => {
    let near = 0, far = 0
    for (const m of group.children) {
      if (m.geometry.getAttribute("crown")) near += m.count
      else if (m.geometry.index) far += m.count
    }
    return { near, far }
  }
  for (const m of group.children) {
    assert.ok(m.boundingSphere, "every mesh carries a sphere that does not depend on how many instances it holds")
    assert.ok(m.boundingSphere.radius > 100, "and that sphere covers the tile's trees rather than collapsing to a point")
  }
  updateTreeLod(0, 0)
  const a = tally()
  assert.equal(a.near + a.far, 240, "every tree is drawn exactly once")
  assert.ok(a.near > 0 && a.far > 0, `the split does something: ${a.near} near, ${a.far} far`)
  updateTreeLod(2000, 2000)
  assert.equal(tally().near, 0, "nothing close remains when the player has driven away")
  updateTreeLod(0, 0)
  const [key] = handles.keys()
  handles.get(key).remove()
  assert.equal(tally().near + tally().far, 239, "a felled tree leaves both meshes")
  handles.get(key).restore()
  assert.equal(tally().near + tally().far, 240, "and comes back when the server says so")
})

test("a tuft takes the colour of the ground it grows in", () => {
  const neutral = coverTint(92, 133, 59)
  for (const c of neutral) assert.ok(c > 0.6 && c < 1.7, `a typical meadow pixel barely shifts the tuft: ${c}`)
  const lush = coverTint(70, 160, 55), dry = coverTint(150, 140, 90)
  assert.ok(lush[1] > neutral[1], "greener ground makes greener grass")
  assert.ok(dry[0] > lush[0], "a dry verge goes straw where a water meadow does not")
  assert.ok(dry[2] > lush[2], "and the straw carries its warmth into the blue too")
  for (const v of [...coverTint(0, 0, 0), ...coverTint(255, 255, 255)]) assert.ok(v >= 0.45 && v <= 1.9, "the tint is clamped")
})

test("the dense grass tier follows the viewer and hands its cells back", () => {
  const n = 64, data = new Uint8ClampedArray(n * n * 4)
  for (let i = 0; i < n * n; i++) { data[i * 4] = 84; data[i * 4 + 1] = 142; data[i * 4 + 2] = 58; data[i * 4 + 3] = 255 }
  const tile = { key: "0_0", tx: 0, ty: 0, loading: false, terrain: { ox: 0, oz: 0 }, roadIndex: null, water: [], objects: new Map(), coverClass: { data, n } }
  const tiles = new Map([["0_0", tile]])
  const grass = new Grass(new THREE.Scene(), () => 0)
  for (let f = 0; f < 400; f++) grass.update(tiles, 0, 0, 250, 250)
  const layer = grass.layers.get("0_0")
  assert.ok(layer.pts.length / 8 > 8000, "a tile of meadow carries thousands of sparse tufts")
  assert.ok(layer.live.size > 5 && layer.live.size < 40, `only the dense cells in reach exist: ${layer.live.size}`)
  let dense = 0
  for (const meshes of layer.live.values()) for (const m of meshes) dense += m.count
  assert.ok(dense > 300, "and they really do carry instances")
  assert.ok(dense < layer.pts.length / 8, "yet far fewer than holding the whole tile's worth would cost")
  const before = layer.group.children.length
  for (let f = 0; f < 200; f++) grass.update(tiles, 0, 0, 2000, 2000)
  assert.equal(layer.live.size, 0, "drive away and every dense cell is handed back")
  assert.ok(layer.group.children.length < before, "and taken out of the scene")
  assert.ok(layer.sparse.every((m) => !m.visible), "the sparse cells go dark too")
})

test("every kit piece is real geometry standing on the ground", () => {
  for (const name of KIT) {
    const parts = kitPiece(name)
    assert.ok(parts.length > 0, `${name} builds something`)
    for (const { geometry, material } of parts) {
      assert.ok(material, `${name} has a material`)
      const pos = geometry.getAttribute("position")
      const tris = (geometry.index ? geometry.index.count : pos.count) / 3
      assert.ok(tris >= 6 && tris < 400, `${name} is ${tris} triangles, which is a sane budget for an instance`)
      assert.ok(finite(pos), `${name} has finite vertices`)
      const box = new THREE.Box3().setFromBufferAttribute(pos)
      assert.ok(box.min.y > -0.35, `${name} is not buried`)
      assert.ok(box.max.y > 0.05 && box.max.y < 12, `${name} has a believable height (${box.max.y.toFixed(2)} m)`)
      for (const key of Object.keys(geometry.attributes)) assert.equal(geometry.getAttribute(key).count, pos.count, `${name}.${key} matches`)
    }
  }
})

test("the leaf palette ramps from shadow to sunlight without banding or overflow", () => {
  const pal = paletteOf("oak")
  const lum = (css) => { const [r, g, b] = css.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  let prev = -1
  for (let i = 0; i <= 20; i++) {
    const l = lum(shade(pal, i / 20))
    assert.ok(l >= prev - 1e-9, "the ramp never goes backwards")
    assert.ok(l >= 0 && l <= 255, "and never leaves the gamut")
    prev = l
  }
  assert.equal(shade(pal, -5), shade(pal, 0), "out of range clamps low")
  assert.equal(shade(pal, 5), shade(pal, 1), "and high")
})

test("every foliage look names a leaf profile the painter knows how to draw", () => {
  for (const [name, spec] of Object.entries(FOLIAGE)) {
    assert.ok(spec.shape === "needle" || LEAF_SHAPES.includes(spec.shape), `${name} asks for a shape that exists`)
    assert.ok(spec.per > 0 && spec.strands > 0, `${name} puts leaves on twigs`)
  }
  // leafPath must close its outline whatever profile it is handed, or the fill leaks across the card
  const ops = []
  const stub = { beginPath: () => ops.push("b"), lineTo: (x, y) => ops.push(Number.isFinite(x) && Number.isFinite(y) ? "l" : "BAD"), closePath: () => ops.push("c") }
  for (const shape of LEAF_SHAPES) {
    ops.length = 0
    leafPath(stub, shape, 40, 12, 0.3)
    assert.equal(ops[0], "b"); assert.equal(ops[ops.length - 1], "c")
    assert.ok(!ops.includes("BAD"), `${shape} produces finite points`)
    assert.ok(ops.length > 60, `${shape} is walked finely enough to be smooth`)
  }
})


// ---------------------------------------------------------------------------------------------------------------
// A canvas stand-in with real pixels. The harness stubs everything on a 2D context to a no-op, which is right for
// modules that only paint, but the passes that read pixels back — the Sobel that makes the leaf normal map, the
// alpha bleed, the shared noise texture the weathering samples — need somewhere for those pixels to live.
function pixelCanvas() {
  const canvas = { width: 0, height: 0 }
  const ctx = new Proxy({
    canvas,
    data: null,
    getImageData(x, y, w, h) { ctx.data ??= new Uint8ClampedArray(w * h * 4); return { data: ctx.data, width: w, height: h } },
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h } },
    putImageData(img) { ctx.data = img.data },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 10 }),
  }, { get: (t, k) => (k in t ? t[k] : () => undefined), set: (t, k, v) => { t[k] = v; return true } })
  canvas.getContext = () => ctx
  return canvas
}
function withPixels(fn) {
  const was = globalThis.document
  globalThis.document = { createElement: () => pixelCanvas() }
  try { return fn() } finally { globalThis.document = was }
}
// a canvas already filled in by hand, to feed the pixel passes something with a known shape in it
function filled(n, at) {
  const c = pixelCanvas()
  c.width = c.height = n
  const ctx = c.getContext("2d")
  const img = ctx.getImageData(0, 0, n, n)
  for (let i = 0; i < n * n; i++) { const px = at(i % n, Math.floor(i / n)); for (let k = 0; k < 4; k++) img.data[i * 4 + k] = px[k] }
  return c
}

// The shaders. Node cannot compile GLSL, but it can prove that every chunk these materials mean to replace exists
// in three's real source, that the injections leave the braces balanced, that no varying is declared in one stage
// and read in the other, and that every uniform and attribute referenced is both declared and bound. Those are the
// four ways a hand-written onBeforeCompile has actually broken this project.
const BASE = THREE.ShaderLib.physical
const compile = (m) => {
  const shader = { uniforms: {}, vertexShader: BASE.vertexShader, fragmentShader: BASE.fragmentShader }
  m.onBeforeCompile(shader, {})
  return shader
}
const delta = (s, a, b) => s.split(a).length - s.split(b).length

test("every material's shader injection lands, balanced and complete", () => withPixels(() => {
  const mats = {
    bark: treeBarkMaterial(),
    leaf: treeLeafMaterial("beech"),
    "grass far": grassMaterial(0, false),
    "grass near": grassMaterial(2, true),
    "kit card": kitCardMaterial("test-card", leafAtlas("beech").map),
    weathered: weatherProp(new THREE.MeshStandardMaterial({ roughness: 0.8 })),
  }
  const vB = delta(BASE.vertexShader, "{", "}"), fB = delta(BASE.fragmentShader, "{", "}")
  const vP = delta(BASE.vertexShader, "(", ")"), fP = delta(BASE.fragmentShader, "(", ")")
  for (const [name, m] of Object.entries(mats)) {
    const s = compile(m)
    assert.notEqual(s.vertexShader, BASE.vertexShader, `${name}: the vertex chunks it names exist in r0.186`)
    assert.equal(delta(s.vertexShader, "{", "}"), vB, `${name}: vertex braces balance`)
    assert.equal(delta(s.fragmentShader, "{", "}"), fB, `${name}: fragment braces balance`)
    assert.equal(delta(s.vertexShader, "(", ")"), vP, `${name}: vertex parens balance`)
    assert.equal(delta(s.fragmentShader, "(", ")"), fP, `${name}: fragment parens balance`)
    for (const src of [s.vertexShader, s.fragmentShader]) assert.ok(!src.includes("undefined"), `${name}: nothing interpolated in as undefined`)
    for (const v of ["vAo", "vFade", "vBlade", "vFoot", "vPropW", "vPropY"]) {
      const used = (src) => new RegExp(`\\b${v}\\b`).test(src)
      const declared = (src) => new RegExp(`varying\\s+\\w+\\s+${v}\\s*;`).test(src)
      if (!used(s.vertexShader) && !used(s.fragmentShader)) continue
      assert.ok(declared(s.vertexShader) && declared(s.fragmentShader), `${name}: varying ${v} is declared in both stages`)
    }
    for (const u of ["uTime", "uSunDir", "uWindDir", "uWindGust", "uNoise"]) {
      for (const src of [s.vertexShader, s.fragmentShader]) {
        if (!new RegExp(`\\b${u}\\b`).test(src)) continue
        assert.ok(new RegExp(`uniform\\s+\\w+\\s+${u}\\s*;`).test(src), `${name}: ${u} is declared where it is used`)
        assert.ok(u in s.uniforms, `${name}: ${u} is bound into shader.uniforms`)
      }
    }
    // the wind helper's own parameters are called flex too, so look for the attribute outside that function
    const body = s.vertexShader.replace(/vec3 windOffset\([\s\S]*?\n}/, "")
    for (const a of ["flex", "crown", "ao"]) {
      if (!new RegExp(`\\b${a}\\b\\s*[;,)*+.]`).test(body)) continue
      assert.ok(new RegExp(`attribute\\s+\\w+\\s+${a}\\s*;`).test(s.vertexShader), `${name}: attribute ${a} is declared`)
    }
  }
}))

test("the height field really does become a normal map", () => withPixels(() => {
  // a ramp rising to the right: the normal must tip consistently towards -x and stay unit length
  const out = normalFromHeight(filled(16, (x) => [Math.round(x / 15 * 255), 0, 0, 255]), 2.5)
  assert.ok(out, "a context that can hand pixels back yields a normal map")
  const px = out.getContext("2d").getImageData(0, 0, 16, 16).data
  for (let i = 0; i < 16 * 16; i++) {
    const nx = px[i * 4] / 255 * 2 - 1, ny = px[i * 4 + 1] / 255 * 2 - 1, nz = px[i * 4 + 2] / 255 * 2 - 1
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 0.02, "every normal is unit length")
    assert.equal(px[i * 4 + 3], 255, "and opaque")
  }
  const mid = (16 * 8 + 8) * 4
  assert.ok(px[mid] / 255 * 2 - 1 < -0.3, "a slope rising to the right tips the normal left")
  assert.ok(Math.abs(px[mid + 1] / 255 * 2 - 1) < 0.05, "and neither up nor down")
  assert.equal(normalFromHeight({ width: 8, getContext: () => ({}) }, 2), null, "and a context without pixels simply goes without")
}))

test("colour bleeds out under the alpha so mipmaps never darken a leaf edge", () => {
  const dot = filled(8, (x, y) => (x === 4 && y === 4 ? [255, 40, 10, 255] : [0, 0, 0, 0]))
  assert.equal(bleedAlpha(dot, 2), true)
  const d = dot.getContext("2d").getImageData(0, 0, 8, 8).data
  const at = (x, y) => (y * 8 + x) * 4
  assert.ok(d[at(5, 4)] > 200, "the neighbour picked up the colour")
  assert.equal(d[at(5, 4) + 3], 0, "but stayed transparent")
  assert.ok(d[at(6, 4)] > 100, "and it travelled a second ring out")
  assert.equal(d[at(4, 4) + 3], 255, "while the original is untouched")
  assert.equal(bleedAlpha({ width: 8, getContext: () => ({}) }, 1), false, "a context without pixels says so rather than throwing")
})

test("a leaf atlas is painted once and shared", () => {
  const a = leafAtlas("oak"), b = leafAtlas("oak")
  assert.equal(a, b, "atlases are cached, not repainted per material")
  assert.ok(a.canvas, "the raw canvas is kept for the impostor painter to stamp from")
  assert.ok(a.map, "and a texture is made of it")
})
