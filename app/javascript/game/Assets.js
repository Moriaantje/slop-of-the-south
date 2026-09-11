import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { versioned } from "game/Textures"

// The glTF pipeline for the living things: rigged CC0 models (Quaternius) under public/models/*.glb, loaded once,
// normalised to metres (feet at the origin, facing -z like every vehicle) and cloned per instance with their
// skeletons, each instance with its own AnimationMixer. A missing or broken file yields a stand-in box of the right
// size so the game keeps running; `slop.assets.clips("dragon")` in the console lists the clip names a model ships.
// Quaternius models face +z in glTF (Blender's -Y front), the game's forward is -z: half a turn for all of them.
// Clip names (see CREDITS.md): mech Idle / Walk / Run / Jump / Shoot / Punch / Death; people Idle / Walk / Run /
// PickUp / Victory / Death. The dragons are built from primitives in Dragons.js.
export const MODELS = {
  wizard: { file: "wizard.glb", height: 1.9,  forward: Math.PI, color: 0x3b2f6b },
  mech:   { file: "mech.glb",   height: 4.2,  forward: Math.PI, color: 0x4e5a6e },
  npc_a:  { file: "npc_a.glb",  height: 1.75, forward: Math.PI, color: 0x7a6a4f },
  npc_b:  { file: "npc_b.glb",  height: 1.75, forward: Math.PI, color: 0x5f7a4f },
  npc_c:  { file: "npc_c.glb",  height: 1.75, forward: Math.PI, color: 0x7a4f5f },
  // the town props (Props.js): CC0 kit pieces under public/models/props, sized in metres; a missing file draws nothing
  // Kenney kits are about 1 unit ≈ 2 m: heights are the metres the piece should stand
  well:     { file: "props/well.glb",     height: 2.6, forward: 0, prop: true },
  stall:    { file: "props/stall.glb",    height: 2.7, forward: 0, prop: true },
  barrel:   { file: "props/barrel.glb",   height: 0.9, forward: 0, prop: true },
  crate:    { file: "props/crate.glb",    height: 0.6, forward: 0, prop: true },
  lantern:  { file: "props/lantern.glb",  height: 3.2, forward: 0, prop: true },
  bench:    { file: "props/bench.glb",    height: 0.9, forward: 0, prop: true },
  fence:    { file: "props/fence.glb",    height: 0.9, forward: 0, prop: true },
  planter:  { file: "props/planter.glb",  height: 0.8, forward: 0, prop: true },
  cart:     { file: "props/cart.glb",     height: 1.1, forward: 0, prop: true },
  sign:     { file: "props/sign.glb",     height: 1.9, forward: 0, prop: true },
  hay:      { file: "props/hay.glb",      height: 0.8, forward: 0, prop: true },
  bush:     { file: "props/bush.glb",     height: 1.1, forward: 0, prop: true },
  fountain: { file: "props/fountain.glb", height: 1.3, forward: 0, prop: true },
  wall:     { file: "props/wall.glb",     height: 1.2, forward: 0, prop: true },
  tree:     { file: "props/tree.glb",     height: 4.5, forward: 0, prop: true },
}

export class Assets {
  constructor() {
    this.loader = new GLTFLoader()
    this.models = new Map()      // name → Promise<{ root, clips, size, placeholder }>
  }

  // preload a few models (the ones the spawn hub needs) so the first dragon does not pop in as a box
  warm(names) { for (const n of names) this.load(n) }

  load(name) {
    if (this.models.has(name)) return this.models.get(name)
    const spec = MODELS[name]
    if (!spec) throw new Error(`unknown model ${name}`)
    const p = this.loader.loadAsync(versioned(`/models/${spec.file}`))
      .then((gltf) => normalise(gltf, spec))
      .catch((err) => { console.warn(`models/${spec.file}: ${err.message ?? err}`); return spec.prop ? nothing(spec) : placeholder(spec) })
    this.models.set(name, p)
    return p
  }

  async clips(name) { return (await this.load(name)).clips.map((c) => `${c.name} (${c.duration.toFixed(2)} s)`) }

  // A live copy: { root, mixer, actions, play(name | RegExp, { fade, loop, timeScale, once }), update(dt), current,
  // ready }. `root` is a Group you place and turn; it is returned at once (a stand-in box until the model has loaded)
  // and swaps its contents when the file arrives, so callers never wait.
  instantiate(name, { onReady = null } = {}) {
    const spec = MODELS[name]
    const inst = { root: new THREE.Group(), mixer: null, actions: {}, current: null, ready: false, clips: [], spec,
      play(which, { fade = 0.25, loop = true, timeScale = 1, once = false } = {}) {
        const action = typeof which === "string" ? this.actions[which] : actionFor(this.actions, which)
        if (!action || action === this.current) { if (action) action.timeScale = timeScale; return action }
        action.reset()
        action.setLoop(loop && !once ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        action.clampWhenFinished = once
        action.timeScale = timeScale
        if (this.current) { this.current.crossFadeTo(action, fade, false); action.play() } else action.fadeIn(fade).play()
        this.current = action
        return action
      },
      update(dt) { this.mixer?.update(dt) },
      dispose() { this.mixer?.stopAllAction(); this.root.clear() },
    }
    const box = spec.prop ? null : standIn(spec)
    if (box) inst.root.add(box)
    this.load(name).then((model) => {
      if (model.missing) { inst.ready = true; onReady?.(inst); return }
      const copy = model.placeholder || spec.prop ? model.root.clone() : skeletonClone(model.root)
      if (box) inst.root.remove(box)
      inst.root.add(copy)
      inst.clips = model.clips
      inst.mixer = new THREE.AnimationMixer(copy)
      for (const clip of model.clips) inst.actions[clip.name] = inst.mixer.clipAction(clip)
      inst.ready = true
      onReady?.(inst)
    })
    return inst
  }

  // A prop as instancing wants it: the model's meshes with their transforms baked in, merged per material, so a
  // thousand barrels are one draw call. Resolves to [{ geometry, material }] (empty when the file is missing).
  instanced(name) {
    this.baked ??= new Map()
    if (this.baked.has(name)) return this.baked.get(name)
    const p = this.load(name).then((model) => {
      if (model.missing) return []
      model.root.updateMatrixWorld(true)
      const byMat = new Map()
      model.root.traverse((o) => {
        if (!o.isMesh || o.isSkinnedMesh) return
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        const groups = o.geometry.groups?.length ? o.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }]
        for (const g of groups) {
          const mat = mats[g.materialIndex ?? 0] ?? mats[0]
          const geo = o.geometry.clone().applyMatrix4(o.matrixWorld)
          geo.deleteAttribute("color")                              // instance colour would clash
          if (!byMat.has(mat)) byMat.set(mat, [])
          byMat.get(mat).push(geo)
        }
      })
      return [...byMat].map(([material, geos]) => {
        const geometry = geos.length === 1 ? geos[0] : (mergeGeometries(geos, false) ?? geos[0])
        geometry.__shared = true
        material.__shared = true
        return { geometry, material }
      })
    })
    this.baked.set(name, p)
    return p
  }
}

// pick an action whose clip name matches (case-insensitive): actionFor(actions, /fly|flap/)
export function actionFor(actions, re) {
  for (const [name, a] of Object.entries(actions)) if (re.test(name)) return a
  return null
}

// scale to `height` metres, feet on the origin, centred in x/z, turned so the model's forward is -z
function normalise(gltf, spec) {
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  const size = box.getSize(new THREE.Vector3())
  const k = size.y > 1e-6 ? spec.height / size.y : 1
  const centre = box.getCenter(new THREE.Vector3())
  const inner = new THREE.Group()
  inner.add(scene)
  scene.position.set(-centre.x, -box.min.y, -centre.z)
  inner.scale.setScalar(k)
  inner.rotation.y = spec.forward
  const root = new THREE.Group()
  root.add(inner)
  scene.traverse((o) => {
    if (o.isSkinnedMesh) o.frustumCulled = false       // the bind-pose bounds are wrong once animated; callers cull by distance
    if (!o.isMesh) return
    o.castShadow = true; o.receiveShadow = false
    const fix = (m) => {
      // KHR_materials_unlit (the mech, the wizard) arrives as MeshBasicMaterial: relight it with the same texture
      if (m.isMeshBasicMaterial) { const std = new THREE.MeshStandardMaterial({ map: m.map, color: m.color, roughness: 0.75, metalness: 0.05, side: m.side, transparent: m.transparent, alphaTest: m.alphaTest }); std.name = m.name; return std }
      if (spec.prop) { m.metalness = 0; m.roughness = Math.max(m.roughness ?? 0.7, 0.65) }   // kit palettes come with FBX metalness
      else if (m.metalness > 0.6) m.metalness = 0.4
      return m
    }
    o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material)
  })
  return { root, clips: gltf.animations ?? [], size: size.multiplyScalar(k), placeholder: false }
}

function standIn(spec) {
  const h = spec.height
  const m = new THREE.Mesh(new THREE.BoxGeometry(h * 0.4, h, h * 0.6), new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.8 }))
  m.position.y = h / 2
  return m
}

// a prop whose file is not there draws nothing at all
function nothing(spec) {
  return { root: new THREE.Group(), clips: [], size: new THREE.Vector3(), placeholder: true, missing: true }
}

function placeholder(spec) {
  const root = new THREE.Group(); root.add(standIn(spec))
  return { root, clips: [], size: new THREE.Vector3(spec.height * 0.4, spec.height, spec.height * 0.6), placeholder: true }
}
