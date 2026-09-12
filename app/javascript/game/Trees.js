import * as THREE from "three"
import { pointKey } from "game/Destructibles"
import { mulberry32, TUNING as T } from "game/Tuning"
import { WIND, WIND_PARS } from "game/Wind"
import { leafAtlas, barkTexture, bleedAlpha, clamp01 } from "game/Foliage"

// Trees, built the way every engine has built them since SpeedTree: real tapered geometry for the trunk and
// branches, and a crown made of small leaf cards — quads at random orientations through the crown volume, each
// carrying a painted spray of leaves with alpha. The shader does the work that makes them read as a plant rather
// than a pile of chips. Every card's normal points out from the crown centre so the whole crown shades as one round
// mass instead of flickering per quad, a baked occlusion value darkens the cards buried inside that mass, the
// crown's own normal map catches light per leaf, one shared wind function bends the trunk and the crown together,
// and light coming from behind bleeds through the outer leaves as a cheap subsurface term.
//
// Silhouette is what a player actually reads at distance, so the variants are real species rather than one shape
// with the dice rolled differently: the straight grey column of a beech, the low heavy spread of an oak, the narrow
// spire of a Lombardy poplar, the curtain of a weeping willow, and the knuckled heads of the pollard willows that
// line every Limburg field. Each grows from the same recursive limb routine under a different set of habits.
//
// Distance is handled by a two-tier LOD. Inside LOD_NEAR a tree is the full article; beyond it, it becomes a cross
// of three cards carrying an orthographic painting of that exact variant — its own skeleton projected and its own
// leaf clusters stamped on. Not a camera-facing sprite: a fixed cross, which keeps parallax and keeps the tree
// standing in the world when you drive past. The split is a memcpy of prepared matrices into the two meshes and is
// only redone when the viewer has moved LOD_MOVE metres, so it costs nothing per frame. Call updateTreeLod(x, z)
// from the frame loop to drive it from the player; failing that the far meshes drive it themselves from the camera
// they are handed at render time, one tile's worth per callback.
//
// Tile entries: [x, z, kind, height] with kind 0 street/park tree, 1 broadleaf wood, 2 conifer, 3 hoogstam fruit.
// With `reg` every tree registers a destructible handle keyed by its position; a felled tree drops out of both LODs.
const LOD_NEAR = T.veg.lodNear      // m: full geometry inside this radius, a card cross beyond it
const LOD_DROP = T.veg.lodDrop      // m: past this a tree is not drawn at all. It has to cover the loaded tiles
                                    // (a radius of two 500 m tiles, corner to corner) or trees vanish in plain sight,
                                    // because the fog does not begin to hide anything until 900 m.
const LOD_MOVE = 22           // m the viewer must travel before the near/far split is recomputed
const NOMINAL = 14            // m: the height the bark texture scale is worked out for (trees are 1 unit tall here)
const BARK_TILE = 0.42        // m covered by one repeat of the bark texture
const SWAY = 0.030            // units of crown travel at full flex in a fresh breeze (~0.4 m on a 14 m tree)
const FLUTTER = 0.006         // units of the fast per-leaf tremble
const IMPOSTOR = 512          // px: the far-LOD atlas, 2x2 cells of one variant each
const FAR_W_MAX = 2.2         // units: the widest a far card may be; each variant asks for exactly what it needs
const CROWN_AO = 0.40         // how dark a leaf card buried in the middle of the crown goes

// Habits, per species. `trunk` is the bare fraction of the height before the first fork, `r0` the base radius in
// tree heights, `kids` the children at each depth, `tilt` how far a child leans off its parent, `lift` how much a
// limb curves back towards vertical as it grows and `sag` how much it gives way to gravity, `wide` the horizontal
// stretch of the whole crown, `card` a leaf card's size and `fill` how many extra cards pad the crown per tip.
const SPECIES = {
  beech:   { foliage: "beech",  bark: 0xcfc6bb, trunk: 0.46, r0: 0.030, taper: 0.58, kids: [3, 3, 2], tilt: 0.60, lift: 0.45, sag: 0.04, gnarl: 0.18, wide: 0.82, lenK: 0.64, radK: 0.56, cards: 4, fill: 1.6, card: 0.125 },
  oak:     { foliage: "oak",    bark: 0x9a8a74, trunk: 0.24, r0: 0.050, taper: 0.55, kids: [3, 3, 2], tilt: 1.05, lift: 0.30, sag: 0.16, gnarl: 0.55, wide: 1.30, lenK: 0.68, radK: 0.54, cards: 5, fill: 2.0, card: 0.145 },
  lime:    { foliage: "lime",   bark: 0xb0a08c, trunk: 0.38, r0: 0.034, taper: 0.58, kids: [3, 2, 2], tilt: 0.72, lift: 0.42, sag: 0.07, gnarl: 0.25, wide: 1.00, lenK: 0.65, radK: 0.56, cards: 5, fill: 2.0, card: 0.130 },
  poplar:  { foliage: "poplar", bark: 0xa89c86, trunk: 0.18, r0: 0.026, taper: 0.72, kids: [4, 3, 2], tilt: 0.34, lift: 0.85, sag: 0.02, gnarl: 0.12, wide: 0.38, lenK: 0.58, radK: 0.56, cards: 4, fill: 1.5, card: 0.086 },
  birch:   { foliage: "birch",  bark: 0xe6e2d8, trunk: 0.44, r0: 0.021, taper: 0.60, kids: [3, 2, 2], tilt: 0.66, lift: 0.26, sag: 0.32, gnarl: 0.22, wide: 0.70, lenK: 0.66, radK: 0.54, cards: 4, fill: 1.4, card: 0.100 },
  willow:  { foliage: "willow", bark: 0x9e8f78, trunk: 0.30, r0: 0.046, taper: 0.56, kids: [3, 3],     tilt: 0.95, lift: 0.55, sag: 0.10, gnarl: 0.40, wide: 1.15, lenK: 0.70, radK: 0.54, cards: 2, fill: 0.5, card: 0.112, weep: 5 },
  apple:   { foliage: "fruit",  bark: 0x9c8a70, trunk: 0.26, r0: 0.040, taper: 0.55, kids: [3, 2, 2], tilt: 1.00, lift: 0.35, sag: 0.14, gnarl: 0.60, wide: 1.10, lenK: 0.64, radK: 0.54, cards: 5, fill: 1.8, card: 0.108 },
  pear:    { foliage: "fruit",  bark: 0x94836c, trunk: 0.32, r0: 0.034, taper: 0.60, kids: [3, 2, 2], tilt: 0.55, lift: 0.62, sag: 0.05, gnarl: 0.35, wide: 0.68, lenK: 0.64, radK: 0.56, cards: 5, fill: 1.7, card: 0.104 },
  pollard: { foliage: "willow", bark: 0x8e8068, trunk: 0.42, r0: 0.082, taper: 0.86, kids: [],         tilt: 0,    lift: 0,    sag: 0,    gnarl: 0.5,  wide: 0.85, lenK: 1,    radK: 1,    cards: 5, fill: 0.6, card: 0.095, pollard: 13 },
  spruce:  { foliage: "conifer", bark: 0x8a7157, r0: 0.030, conifer: { tiers: 12, base: 0.10, top: 0.97, r: 0.30, droop: 0.24, card: 0.098, perTier: 7 } },
  pine:    { foliage: "conifer", bark: 0xb08a62, r0: 0.038, conifer: { tiers: 6,  base: 0.52, top: 0.97, r: 0.36, droop: 0.04, card: 0.140, perTier: 7 } },
  larch:   { foliage: "conifer", bark: 0x94806a, r0: 0.026, conifer: { tiers: 10, base: 0.18, top: 0.97, r: 0.24, droop: 0.32, card: 0.086, perTier: 6 } },
}
// which species stand for each tile kind; the index into this list is the variant a tree's position hashes to
const KINDS = {
  0: ["lime", "beech", "poplar", "oak"],
  1: ["oak", "beech", "birch", "willow"],
  2: ["spruce", "pine", "larch"],
  3: ["apple", "pear", "pollard"],
}

export const TREE_UNIFORMS = { uTime: { value: 0 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } }

// ---- materials -------------------------------------------------------------------------------------------------

// The bend, shared word for word by the bark and the leaf cards so a crown never drifts off the branch it hangs on.
const SWAY_GLSL = `\t{
\t\t#ifdef USE_INSTANCING
\t\tvec3 anchor = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
\t\t#else
\t\tvec3 anchor = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
\t\t#endif
\t\ttransformed += windOffset(anchor, flex, ${SWAY.toFixed(4)}, ${FLUTTER.toFixed(4)}, uTime);
\t}`

let barkMatCache = null
function barkMaterial() {
  if (barkMatCache) return barkMatCache
  const { map, normalMap } = barkTexture()
  const m = new THREE.MeshStandardMaterial({ map, normalMap, vertexColors: true, roughness: 1, metalness: 0 })
  if (normalMap) m.normalScale.set(1.1, 1.1)
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: TREE_UNIFORMS.uTime, uWindDir: WIND.uWindDir, uWindGust: WIND.uWindGust })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nattribute float flex;${WIND_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${SWAY_GLSL}`)
  }
  m.customProgramCacheKey = () => "tree-bark"
  m.__shared = true
  barkMatCache = m
  return m
}

const leafMats = new Map()
function leafMaterial(foliage) {
  if (leafMats.has(foliage)) return leafMats.get(foliage)
  const { map, normalMap } = leafAtlas(foliage)
  const m = new THREE.MeshStandardMaterial({ map, normalMap, alphaTest: 0.38, alphaToCoverage: true,
                                             side: THREE.DoubleSide, roughness: 0.72, metalness: 0 })
  if (normalMap) m.normalScale.set(0.85, 0.85)
  const hasNormal = !!normalMap
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: TREE_UNIFORMS.uTime, uSunDir: TREE_UNIFORMS.uSunDir,
                                     uWindDir: WIND.uWindDir, uWindGust: WIND.uWindGust })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
uniform float uTime;
attribute vec3 crown;
attribute float flex;
attribute float ao;
varying float vAo;${WIND_PARS}`)
      // the card's normal is the direction out of the crown centre: the crown shades as one round mass
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = normalize(position - crown + vec3(0.0, 0.18, 0.0));\n\tvAo = ao;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${SWAY_GLSL}`)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSunDir;\nvarying float vAo;")
      // DOUBLE_SIDED flips the normal by the winding of a card that was laid down at random, which would light half
      // the crown backwards; put the crown direction back and rebuild the tangent frame the normal map reads from
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
\tnormal = normalize( vNormal );
\tnonPerturbedNormal = normal;${hasNormal ? "\n\ttbn = getTangentFrame( - vViewPosition, normal, vNormalMapUv );" : ""}`)
      // leaves in the heart of the crown never see the sky
      .replace("#include <color_fragment>", `#include <color_fragment>\n\tdiffuseColor.rgb *= mix(${CROWN_AO.toFixed(2)}, 1.0, vAo);`)
      // translucency: against the sun the thin outer leaves glow, the packed core does not
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
\t{
\t\tvec3 v = normalize(vViewPosition);
\t\tvec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
\t\tfloat back = pow(clamp(dot(-v, sunV), 0.0, 1.0), 4.0);
\t\ttotalEmissiveRadiance += diffuseColor.rgb * back * vAo * 1.15;
\t}`)
  }
  m.customProgramCacheKey = () => `tree-leaf-${hasNormal ? "n" : "flat"}`
  m.__shared = true
  leafMats.set(foliage, m)
  return m
}

const farMats = new Map()
function farMaterial(kind, canvas) {
  if (farMats.has(kind)) return farMats.get(kind)
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 8
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: TREE_UNIFORMS.uTime, uWindDir: WIND.uWindDir, uWindGust: WIND.uWindGust })
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nattribute float flex;${WIND_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${SWAY_GLSL}`)
  }
  m.customProgramCacheKey = () => "tree-far"
  m.__shared = true
  farMats.set(kind, m)
  return m
}

// ---- the per-kind variant set, built once on first use -----------------------------------------------------------

const kinds = new Map()
function kindData(kind) {
  if (kinds.has(kind)) return kinds.get(kind)
  const names = (KINDS[kind] ?? KINDS[1]).slice(0, 4)
  const variants = names.map((name, i) => buildVariant(name, 1000 * (kind + 1) + 7919 * i))
  const atlas = paintImpostors(variants)
  // the canvas is painted from the top down while the texture reads from the bottom up, so the second row of cells
  // is the lower half of the v range; get this backwards and every far tree stands on its head
  const data = { names, variants, material: farMaterial(kind, atlas),
                 far: variants.map((v, i) => farGeometry((i % 2) * 0.5, 0.5 - Math.floor(i / 2) * 0.5, v.farWidth)) }
  kinds.set(kind, data)
  return data
}

export const treeVariants = (kind) => kindData(kind).variants
export const treeSpeciesGeometry = (name, seed = 1) => buildVariant(name, seed)
export const treeBarkMaterial = barkMaterial
export const treeLeafMaterial = leafMaterial

// ---- building a tile's trees ---------------------------------------------------------------------------------

const groups = []                     // every live tree group in the world, for the LOD split
let lodX = 0, lodZ = 0, lodOn = false, dirty = 0

export function buildTrees(trees, heightAt, reg) {
  if (!trees?.length) return null
  const group = new THREE.Group()
  const byKind = new Map()
  for (const t of trees) {
    const kind = t[2] ?? 1
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(t)
  }
  const mine = []
  for (const [kind, list] of byKind) {
    const g = buildKind(kind, list, heightAt, reg)
    mine.push(g)
    group.add(...g.meshes)
  }
  groups.push(...mine)
  group.userData.onDispose = () => { for (const g of mine) { const i = groups.indexOf(g); if (i >= 0) groups.splice(i, 1) } }
  for (const g of mine) split(g)
  return group
}

// One kind of one tile: the matrices are composed once here and from then on the LOD only ever memcpys them into
// whichever of the three meshes per variant should be drawing that tree.
function buildKind(kind, list, heightAt, reg) {
  const data = kindData(kind)
  const n = list.length, nv = data.variants.length
  const g = {
    kind, n, data,
    matrix: new Float32Array(n * 16), colour: new Float32Array(n * 3), pos: new Float32Array(n * 2),
    variant: new Uint8Array(n), felled: new Uint8Array(n), perVariant: new Array(nv).fill(0), dirty: false,
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0), colour = new THREE.Color()
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  let tallest = 0
  list.forEach(([x, z, , h], i) => {
    const v = Math.floor(rand(x, z) * nv) % nv
    g.variant[i] = v; g.perVariant[v]++
    const width = (0.86 + 0.3 * rand(x + 1, z)) * (kind === 3 ? 1.15 : 1)
    q.setFromAxisAngle(up, rand(z, x) * Math.PI * 2)
    m.compose(p.set(x, heightAt(x, z) - 0.15, z), q, s.set(h * width, h, h * width))
    m.toArray(g.matrix, i * 16)
    g.pos[i * 2] = x; g.pos[i * 2 + 1] = z
    const tint = 0.86 + 0.28 * rand(x, z + 1)
    colour.setRGB(tint, tint * (0.96 + 0.08 * rand(x, z + 2)), tint * 0.94)
    g.colour[i * 3] = colour.r; g.colour[i * 3 + 1] = colour.g; g.colour[i * 3 + 2] = colour.b
    lo.min(p); hi.max(p); tallest = Math.max(tallest, h * 1.6)
  })
  // InstancedMesh works its bounding sphere out once, the first time anything asks — and it would be asked while a
  // mesh still held no instances at all, which gives a sphere of radius -1 at the world origin and a wood that
  // vanishes the moment the origin leaves the screen. Hand every mesh of the group the same sphere, covering this
  // tile's trees, so culling happens per tile (the granularity that actually pays) and never depends on how the LOD
  // has just shuffled the instances between the three meshes.
  const centre = lo.clone().add(hi).multiplyScalar(0.5)
  g.sphere = new THREE.Sphere(centre, lo.distanceTo(hi) * 0.5 + tallest)
  g.meshes = []
  g.tiers = data.variants.map((variant, v) => {
    const cap = Math.max(1, g.perVariant[v])
    const wood = new THREE.InstancedMesh(variant.wood, barkMaterial(), cap)
    const leaves = new THREE.InstancedMesh(variant.leaves, leafMaterial(SPECIES[data.names[v]].foliage), cap)
    const far = new THREE.InstancedMesh(data.far[v], data.material, cap)
    for (const mesh of [wood, leaves, far]) {
      mesh.castShadow = mesh.receiveShadow = true
      mesh.count = 0; mesh.visible = false
      mesh.boundingSphere = g.sphere
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      g.meshes.push(mesh)
    }
    for (const mesh of [leaves, far]) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3)
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    }
    // no wiring needed for the LOD to work: these meshes are handed the camera every time they are drawn
    leaves.onBeforeRender = far.onBeforeRender = (renderer, scene, camera) => { if (camera.isPerspectiveCamera) noteViewer(camera.position.x, camera.position.z) }
    return { wood, leaves, far }
  })
  list.forEach(([x, z, , h], i) => {
    reg?.(pointKey("t", x, z), { kind: "t", x, z, r: THREE.MathUtils.clamp(0.08 * h, 0.3, 1), h, max: 30,
      remove: () => { g.felled[i] = 1; split(g) }, restore: () => { g.felled[i] = 0; split(g) } })
  })
  return g
}

// ---- the LOD split -------------------------------------------------------------------------------------------

// Drive this from the frame loop with the player's position for the tightest result; without it the tree meshes call
// noteViewer themselves with the render camera, which lags a frame and needs at least one of them on screen.
export function updateTreeLod(x, z) {
  noteViewer(x, z)
  while (dirty > 0) drain(groups.length + 1)
}

function noteViewer(x, z) {
  if (lodOn && (x - lodX) * (x - lodX) + (z - lodZ) * (z - lodZ) < LOD_MOVE * LOD_MOVE) { drain(1); return }
  lodX = x; lodZ = z; lodOn = true
  for (const g of groups) g.dirty = true
  dirty = groups.length
  drain(2)
}

function drain(budget) {
  for (const g of groups) {
    if (!g.dirty) continue
    g.dirty = false; dirty--
    split(g)
    if (--budget <= 0) return
  }
  dirty = 0
}

// Sort every standing tree of the group into its variant's near pair or its far cross by squared distance, as a
// straight copy of the matrix composed when the tile arrived. No trigonometry, no allocation, no per-frame work.
function split(g) {
  const near = g.tiers.map(() => 0), far = g.tiers.map(() => 0)
  const nearSq = LOD_NEAR * LOD_NEAR, dropSq = LOD_DROP * LOD_DROP
  for (let i = 0; i < g.n; i++) {
    if (g.felled[i]) continue
    const dx = g.pos[i * 2] - lodX, dz = g.pos[i * 2 + 1] - lodZ
    const d2 = dx * dx + dz * dz
    if (lodOn && d2 > dropSq) continue
    const v = g.variant[i], t = g.tiers[v], src = i * 16, c = i * 3
    if (!lodOn || d2 < nearSq) {
      const slot = near[v]++
      t.wood.instanceMatrix.array.set(g.matrix.subarray(src, src + 16), slot * 16)
      t.leaves.instanceMatrix.array.set(g.matrix.subarray(src, src + 16), slot * 16)
      t.leaves.instanceColor.array.set(g.colour.subarray(c, c + 3), slot * 3)
    } else {
      const slot = far[v]++
      t.far.instanceMatrix.array.set(g.matrix.subarray(src, src + 16), slot * 16)
      t.far.instanceColor.array.set(g.colour.subarray(c, c + 3), slot * 3)
    }
  }
  g.tiers.forEach((t, v) => {
    t.wood.count = t.leaves.count = near[v]
    t.wood.visible = t.leaves.visible = near[v] > 0
    t.far.count = far[v]
    t.far.visible = far[v] > 0
    t.wood.instanceMatrix.needsUpdate = true
    t.leaves.instanceMatrix.needsUpdate = true
    t.leaves.instanceColor.needsUpdate = true
    t.far.instanceMatrix.needsUpdate = true
    t.far.instanceColor.needsUpdate = true
  })
  return { near, far }
}

// ---- variant generation (deterministic per seed; the tree ends up exactly 1 unit tall) -------------------------

function buildVariant(name, seed) {
  const sp = SPECIES[name] ?? SPECIES.beech
  const rnd = mulberry32(seed)
  const wood = { pos: [], uv: [], col: [], flex: [] }
  const skeleton = [], cards = [], bark = new THREE.Color(sp.bark)
  if (sp.conifer) conifer(wood, skeleton, cards, rnd, sp, bark)
  else if (sp.pollard) pollard(wood, skeleton, cards, rnd, sp, bark)
  else broadleaf(wood, skeleton, cards, rnd, sp, bark)

  // normalise to one unit tall over the geometry and every descriptor that will be measured against it
  let maxY = 0
  for (let i = 1; i < wood.pos.length; i += 3) maxY = Math.max(maxY, wood.pos[i])
  for (const c of cards) maxY = Math.max(maxY, c.at.y + c.size * 0.8)
  const k = 1 / (maxY || 1)
  for (let i = 0; i < wood.pos.length; i++) wood.pos[i] *= k
  for (const c of cards) { c.at.multiplyScalar(k); c.size *= k }
  for (const s of skeleton) { s.a.multiplyScalar(k); s.b.multiplyScalar(k); s.ra *= k; s.rb *= k }

  const centre = new THREE.Vector3()
  for (const c of cards) centre.add(c.at)
  if (cards.length) centre.divideScalar(cards.length)
  let radius = 1e-4
  for (const c of cards) radius = Math.max(radius, c.at.distanceTo(centre))

  // how wide this variant's far card has to be to hold the whole tree: measured, not guessed, so a Lombardy poplar
  // gets a narrow card that fills its atlas cell and a spreading oak gets a wide one that does not clip
  let reach = 0.25
  for (const c of cards) reach = Math.max(reach, Math.hypot(c.at.x, c.at.z) + c.size * 0.8)
  for (const s of skeleton) reach = Math.max(reach, Math.hypot(s.a.x, s.a.z) + s.ra, Math.hypot(s.b.x, s.b.z) + s.rb)
  const farWidth = Math.min(FAR_W_MAX, reach * 2.06)

  const leaf = { pos: [], uv: [], crown: [], flex: [], ao: [] }
  for (const c of cards) emitCard(leaf, rnd, c, centre, radius)

  const wg = new THREE.BufferGeometry()
  wg.setAttribute("position", new THREE.Float32BufferAttribute(wood.pos, 3))
  wg.setAttribute("uv", new THREE.Float32BufferAttribute(wood.uv, 2))
  wg.setAttribute("color", new THREE.Float32BufferAttribute(wood.col, 3))
  wg.setAttribute("flex", new THREE.Float32BufferAttribute(wood.flex, 1))
  wg.computeVertexNormals(); wg.__shared = true
  const lg = new THREE.BufferGeometry()
  lg.setAttribute("position", new THREE.Float32BufferAttribute(leaf.pos, 3))
  lg.setAttribute("uv", new THREE.Float32BufferAttribute(leaf.uv, 2))
  lg.setAttribute("crown", new THREE.Float32BufferAttribute(leaf.crown, 3))
  lg.setAttribute("flex", new THREE.Float32BufferAttribute(leaf.flex, 1))
  lg.setAttribute("ao", new THREE.Float32BufferAttribute(leaf.ao, 1))
  lg.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(leaf.pos.length).fill(0), 3))
  lg.__shared = true
  return { name, sp, wood: wg, leaves: lg, skeleton, cards, centre, radius, farWidth }
}

// a limb and everything that grows out of it; `tips` collects the points the crown gathers around
function limb(wood, skeleton, tips, rnd, sp, bark, origin, dir, len, radius, depth, v0) {
  const segs = depth === 0 ? 3 : 2
  const sides = depth === 0 ? 6 : depth === 1 ? 5 : depth === 2 ? 4 : 3
  let p = origin.clone(), d = dir.clone(), r = radius, v = v0
  for (let s = 0; s < segs; s++) {
    const t1 = (s + 1) / segs
    const next = p.clone().addScaledVector(d, len / segs)
    const r1 = radius * (1 - (1 - sp.taper) * t1)
    v = tube(wood, p, next, r, r1, sides, bark, flexAt(sp, depth, s / segs), flexAt(sp, depth, t1), v)
    skeleton.push({ a: p.clone(), b: next.clone(), ra: r, rb: r1 })
    p = next; r = r1
    d.y += (sp.lift - sp.sag) / segs * 0.55
    d.x += (rnd() - 0.5) * sp.gnarl * 0.5 / segs
    d.z += (rnd() - 0.5) * sp.gnarl * 0.5 / segs
    d.normalize()
  }
  const flex = flexAt(sp, depth, 1)
  const kids = sp.kids[depth]
  if (!kids) { tips.push({ p, d, flex, leader: true }); return }
  const n = kids + (rnd() < 0.35 ? 1 : 0)
  const az0 = rnd() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const az = az0 + i * 2 * Math.PI / n + (rnd() - 0.5) * 0.7
    const nd = tilted(d, az, sp.tilt * (0.7 + rnd() * 0.6), sp.wide)
    limb(wood, skeleton, tips, rnd, sp, bark, p, nd, len * sp.lenK * (0.85 + rnd() * 0.3), r * sp.radK, depth + 1, v)
  }
  if (depth >= 1) tips.push({ p, d, flex, leader: false })
}

function broadleaf(wood, skeleton, cards, rnd, sp, bark) {
  const tips = []
  limb(wood, skeleton, tips, rnd, sp, bark, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), sp.trunk, sp.r0, 0, 0)
  for (const t of tips) {
    const n = t.leader ? sp.cards : Math.max(1, sp.cards - 1)
    for (let i = 0; i < n; i++) {
      cards.push({ at: t.p.clone().addScaledVector(t.d, sp.card * 0.3).add(jitter(rnd, sp.card * 0.55)),
                   size: sp.card * (0.85 + rnd() * 0.45), flex: t.flex })
    }
    if (sp.weep) for (let w = 0; w < sp.weep; w++) {          // the willow's curtain: a chain falling from the tip
      const drift = jitter(rnd, sp.card * 0.5)
      for (let j = 0; j < 6; j++) {
        cards.push({ at: t.p.clone().add(drift).addScaledVector(new THREE.Vector3(0, -1, 0), sp.card * 0.62 * (j + 0.5) + rnd() * 0.02),
                     size: sp.card * (0.8 + rnd() * 0.3) * (1 - j * 0.07), flex: Math.min(1, t.flex + 0.08 * (j + 1)), up: true })
      }
    }
  }
  const fill = Math.round(tips.length * sp.fill)
  for (let i = 0; i < fill; i++) {
    const t = tips[Math.floor(rnd() * tips.length)] ?? { p: new THREE.Vector3(0, 1, 0), flex: 1 }
    cards.push({ at: t.p.clone().add(jitter(rnd, sp.card * 1.3)), size: sp.card * (0.9 + rnd() * 0.5), flex: t.flex * 0.9 })
  }
}

// A pollard willow: a squat knuckled trunk cut back year after year, with a burst of straight shoots out of the head.
// Nothing else in the Limburg landscape is as recognisable at four hundred metres, which is why it gets its own habit.
function pollard(wood, skeleton, cards, rnd, sp, bark) {
  const top = new THREE.Vector3(0, sp.trunk, 0)
  const v = tube(wood, new THREE.Vector3(), top, sp.r0, sp.r0 * sp.taper, 9, bark, 0, 0.1, 0)
  for (let i = 0; i < 7; i++) {                                 // the knuckle: lumps of old callus around the cut
    const a = rnd() * Math.PI * 2, r = sp.r0 * (0.8 + rnd() * 0.7)
    const at = new THREE.Vector3(Math.cos(a) * r * 0.7, sp.trunk - 0.02 + rnd() * 0.06, Math.sin(a) * r * 0.7)
    tube(wood, at.clone().setY(at.y - 0.05), at, r * 0.62, r * 0.5, 5, bark, 0.08, 0.12, v)
  }
  const shoots = sp.pollard
  for (let i = 0; i < shoots; i++) {
    const a = i / shoots * Math.PI * 2 + rnd() * 0.4
    const out = 0.20 + rnd() * 0.35
    const dir = new THREE.Vector3(Math.cos(a) * out * sp.wide, 1, Math.sin(a) * out * sp.wide).normalize()
    const len = 0.42 + rnd() * 0.26
    const base = top.clone().addScaledVector(dir, 0.02)
    const tip = base.clone().addScaledVector(dir, len)
    tube(wood, base, tip, sp.r0 * 0.17, sp.r0 * 0.09, 4, bark, 0.12, 0.95, v)
    skeleton.push({ a: base.clone(), b: tip.clone(), ra: sp.r0 * 0.17, rb: sp.r0 * 0.09 })
    const n = sp.cards + Math.floor(rnd() * 2)
    for (let j = 0; j < n; j++) {
      const t = 0.35 + 0.65 * rnd()
      cards.push({ at: base.clone().lerp(tip, t).add(jitter(rnd, sp.card * 0.5)), size: sp.card * (0.85 + rnd() * 0.4), flex: 0.25 + t * 0.7 })
    }
  }
  skeleton.push({ a: new THREE.Vector3(), b: top.clone(), ra: sp.r0, rb: sp.r0 * sp.taper })
}

// A conifer: one leader all the way up with whorls of boughs hanging off it, narrowing to the top. The boughs are
// real little branches so the silhouette has spikes rather than a smooth cone of sprites.
function conifer(wood, skeleton, cards, rnd, sp, bark) {
  const c = sp.conifer
  const top = new THREE.Vector3(0, c.top, 0)
  tube(wood, new THREE.Vector3(), top, sp.r0, sp.r0 * 0.16, 8, bark, 0, 0.5, 0)
  skeleton.push({ a: new THREE.Vector3(), b: top.clone(), ra: sp.r0, rb: sp.r0 * 0.16 })
  for (let t = 0; t < c.tiers; t++) {
    const f = t / (c.tiers - 1 || 1)
    const y = c.base + (c.top - c.base - 0.04) * f
    const reach = c.r * (c.flat ? 0.55 + 0.45 * Math.sin(Math.PI * f) : Math.pow(1 - f, 0.85)) + 0.02
    const n = Math.max(3, Math.round(c.perTier * (1 - f * 0.45)))
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + t * 0.7 + rnd() * 0.4
      const dir = new THREE.Vector3(Math.cos(a), -c.droop * (0.6 + rnd() * 0.8), Math.sin(a)).normalize()
      const base = new THREE.Vector3(0, y, 0)
      const tip = base.clone().addScaledVector(dir, reach)
      tube(wood, base, tip, sp.r0 * 0.3 * (1 - f * 0.6), sp.r0 * 0.09, 4, bark, 0.15 + f * 0.2, 0.6 + f * 0.4, 0)
      skeleton.push({ a: base.clone(), b: tip.clone(), ra: sp.r0 * 0.3, rb: sp.r0 * 0.09 })
      const per = 2 + (rnd() < 0.6 ? 1 : 0)
      for (let j = 0; j < per; j++) {
        const s = 0.35 + 0.65 * rnd()
        cards.push({ at: base.clone().lerp(tip, s).add(jitter(rnd, c.card * 0.35)),
                     size: c.card * (0.9 + rnd() * 0.5) * (1 - f * 0.3), flex: 0.2 + s * 0.6 + f * 0.2 })
      }
    }
  }
  cards.push({ at: new THREE.Vector3(0, c.top - c.card * 0.2, 0), size: c.card * 0.9, flex: 1 })
}

// ---- geometry emitters -----------------------------------------------------------------------------------------

// A tapered tube with bark UVs in metres: the u repeat is rounded to a whole number of tiles so the seam where the
// ring closes never shows, and v runs along the limb so the grain always points the way the wood grew.
function tube(out, a, b, ra, rb, segs, colour, fa, fb, v0) {
  const axis = b.clone().sub(a)
  const len = axis.length() || 1e-5
  axis.divideScalar(len)
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(axis.x) > 0.9) u.set(0, 0, 1)
  u.cross(axis).normalize()
  const w = new THREE.Vector3().crossVectors(axis, u)
  const ur = Math.max(1, Math.round(2 * Math.PI * Math.max(ra, rb) * NOMINAL / BARK_TILE))
  const v1 = v0 + len * NOMINAL / BARK_TILE
  const ring = (c, r, i) => { const t = i / segs * Math.PI * 2; return c.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(w, Math.sin(t) * r) }
  for (let i = 0; i < segs; i++) {
    const ua = i / segs * ur, ub = (i + 1) / segs * ur
    const a0 = ring(a, ra, i), a1 = ring(a, ra, i + 1), b0 = ring(b, rb, i), b1 = ring(b, rb, i + 1)
    vert(out, a0, ua, v0, fa, colour); vert(out, b0, ua, v1, fb, colour); vert(out, b1, ub, v1, fb, colour)
    vert(out, a0, ua, v0, fa, colour); vert(out, b1, ub, v1, fb, colour); vert(out, a1, ub, v0, fa, colour)
  }
  return v1
}

function vert(out, p, u, v, flex, colour) {
  out.pos.push(p.x, p.y, p.z); out.uv.push(u, v); out.flex.push(flex)
  out.col.push(colour.r, colour.g, colour.b)
}

// One leaf card: a quad at a random tilt taking a random cell of the four in the atlas, with the occlusion of its
// place inside the crown baked in so the middle of the mass goes dark without a single extra instruction at runtime.
function emitCard(out, rnd, c, centre, radius) {
  const n = c.up
    ? new THREE.Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.25, rnd() - 0.5).normalize()
    : new THREE.Vector3(rnd() - 0.5, rnd() - 0.3, rnd() - 0.5).normalize()
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(n.x) > 0.9) u.set(0, 0, 1)
  u.cross(n).normalize()
  const v = new THREE.Vector3().crossVectors(n, u)
  const cell = Math.floor(rnd() * 4), cx = (cell % 2) * 0.5, cy = Math.floor(cell / 2) * 0.5
  const flipU = rnd() < 0.5, flipV = rnd() < 0.5
  const ao = clamp01(Math.pow(c.at.distanceTo(centre) / radius, 0.75))
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]
  const half = c.size * 0.5
  for (const [a, b] of corners) {
    const p = c.at.clone().addScaledVector(u, a * half).addScaledVector(v, b * half)
    out.pos.push(p.x, p.y, p.z)
    out.uv.push(cx + (flipU ? (1 - (a * 0.5 + 0.5)) : (a * 0.5 + 0.5)) * 0.5, cy + (flipV ? (1 - (b * 0.5 + 0.5)) : (b * 0.5 + 0.5)) * 0.5)
    out.crown.push(centre.x, centre.y, centre.z)
    out.flex.push(c.flex)
    out.ao.push(ao)
  }
}

// The far LOD: three quads crossing at sixty degrees, wider than tall so a spreading oak fits its atlas cell,
// with the cell of the atlas that holds this variant baked straight into the UVs. The
// normals radiate from the middle of the crown exactly as the near cards' do, so the light does not jump at the
// switch; the flex rises with height so the card sways like the tree it replaces.
function farGeometry(qx, qy, width) {
  const pos = [], uv = [], nor = [], flex = [], idx = []
  const centre = new THREE.Vector3(0, 0.62, 0)
  for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) {
    const ax = Math.cos(a) * width * 0.5, az = Math.sin(a) * width * 0.5
    const base = pos.length / 3
    for (const [sx, y] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
      const p = new THREE.Vector3(sx * ax, y, sx * az)
      pos.push(p.x, p.y, p.z)
      uv.push(qx + (sx * 0.5 + 0.5) * 0.5, qy + y * 0.5)
      const n = p.clone().sub(centre).add(new THREE.Vector3(0, 0.2, 0)).normalize()
      nor.push(n.x, n.y, n.z)
      flex.push(Math.pow(y, 1.6))
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute("flex", new THREE.Float32BufferAttribute(flex, 1))
  g.setIndex(idx)
  g.__shared = true
  return g
}

// ---- the far-LOD painting --------------------------------------------------------------------------------------

// Each variant is projected orthographically into its own quarter of one canvas: the skeleton stroked as tapered
// limbs, then every leaf card of that tree stamped from its own cluster atlas at the size and place it really has.
// The far tree is therefore a picture of this exact tree rather than a generic blob, which is what lets the switch
// at LOD_NEAR pass unnoticed.
function paintImpostors(variants) {
  const c = document.createElement("canvas")
  c.width = c.height = IMPOSTOR
  const ctx = c.getContext("2d")
  const S = IMPOSTOR * 0.5
  variants.forEach((variant, i) => {
    const ox = (i % 2) * S, oy = Math.floor(i / 2) * S
    const W = variant.farWidth
    const px = (x) => ox + (x / W + 0.5) * S
    const py = (y) => oy + S - y * S
    const bark = new THREE.Color(variant.sp.bark)
    const dark = `rgb(${Math.round(bark.r * 150)},${Math.round(bark.g * 140)},${Math.round(bark.b * 125)})`
    ctx.lineCap = "round"
    for (const s of variant.skeleton) {
      ctx.strokeStyle = dark
      ctx.lineWidth = Math.max(1.2, (s.ra + s.rb) * S / W)
      ctx.beginPath(); ctx.moveTo(px(s.a.x), py(s.a.y)); ctx.lineTo(px(s.b.x), py(s.b.y)); ctx.stroke()
    }
    const atlas = leafAtlas(variant.sp.foliage).canvas
    const cell = (atlas.width || 2) * 0.5
    let seed = 7
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    for (const card of variant.cards) {
      const w = card.size * S / W * 1.55
      const q = Math.floor(rnd() * 4)
      ctx.save()
      ctx.translate(px(card.at.x), py(card.at.y))
      ctx.rotate((rnd() - 0.5) * 1.2)
      ctx.drawImage(atlas, (q % 2) * cell, Math.floor(q / 2) * cell, cell, cell, -w * 0.5, -w * 0.5, w, w)
      ctx.restore()
    }
    // the underside of a crown is always in its own shadow: a gradient laid over only the pixels already painted
    const g = ctx.createLinearGradient(0, oy, 0, oy + S)
    g.addColorStop(0, "rgba(255,255,255,0)")
    g.addColorStop(0.55, "rgba(20,34,16,0.10)")
    g.addColorStop(1, "rgba(14,26,12,0.42)")
    ctx.globalCompositeOperation = "source-atop"
    ctx.fillStyle = g
    ctx.fillRect(ox, oy, S, S)
    ctx.globalCompositeOperation = "source-over"
  })
  bleedAlpha(c, 3)
  return c
}

// ---- small maths -------------------------------------------------------------------------------------------------

const flexAt = (sp, depth, t) => Math.pow((depth + t) / (sp.kids.length + 1), 1.5)
const jitter = (rnd, r) => new THREE.Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.75, rnd() - 0.5).multiplyScalar(2 * r)

function tilted(dir, azimuth, tilt, wide) {
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(dir.x) > 0.9) u.set(0, 0, 1)
  u.cross(dir).normalize()
  const v = new THREE.Vector3().crossVectors(dir, u)
  const out = new THREE.Vector3().addScaledVector(dir, Math.cos(tilt))
    .addScaledVector(u, Math.cos(azimuth) * Math.sin(tilt))
    .addScaledVector(v, Math.sin(azimuth) * Math.sin(tilt))
  out.x *= wide; out.z *= wide
  return out.normalize()
}

// stable pseudo-random in [0, 1) from a position
function rand(a, b) {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return x - Math.floor(x)
}
