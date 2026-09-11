import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js"
import { versioned } from "game/Textures"

// The glTF pipeline for the living things: rigged CC0 models (Quaternius) under public/models/*.glb, loaded once,
// normalised to metres (feet at the origin, facing -z like every vehicle) and cloned per instance with their
// skeletons, each instance with its own AnimationMixer. A missing or broken file yields a stand-in box of the right
// size so the game keeps running; `slop.assets.clips("dragon")` in the console lists the clip names a model ships.
// Quaternius models face +z in glTF (Blender's -Y front), the game's forward is -z: half a turn for all of them.
// Clip names (see CREDITS.md): dragon Fast_Flying / Flying_Idle / Headbutt / Punch / HitReact / Death; mech Idle /
// Walk / Run / Jump / Shoot / Punch / Death; people Idle / Walk / Run / PickUp / Victory / Death.
export const MODELS = {
  dragon: { file: "dragon.glb", height: 7,    forward: Math.PI, color: 0x8b2f2a },
  wizard: { file: "wizard.glb", height: 1.9,  forward: Math.PI, color: 0x3b2f6b },
  mech:   { file: "mech.glb",   height: 4.2,  forward: Math.PI, color: 0x4e5a6e },
  npc_a:  { file: "npc_a.glb",  height: 1.75, forward: Math.PI, color: 0x7a6a4f },
  npc_b:  { file: "npc_b.glb",  height: 1.75, forward: Math.PI, color: 0x5f7a4f },
  npc_c:  { file: "npc_c.glb",  height: 1.75, forward: Math.PI, color: 0x7a4f5f },
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
      .catch((err) => { console.warn(`models/${spec.file}: ${err.message ?? err}`); return placeholder(spec) })
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
    const box = standIn(spec)
    inst.root.add(box)
    this.load(name).then((model) => {
      const copy = model.placeholder ? model.root.clone() : skeletonClone(model.root)
      inst.root.remove(box)
      inst.root.add(copy)
      inst.clips = model.clips
      inst.mixer = new THREE.AnimationMixer(copy)
      for (const clip of model.clips) inst.actions[clip.name] = inst.mixer.clipAction(clip)
      inst.ready = true
      onReady?.(inst)
    })
    return inst
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
    o.castShadow = o.receiveShadow = false
    const fix = (m) => {
      // KHR_materials_unlit (the mech, the wizard) arrives as MeshBasicMaterial: relight it with the same texture
      if (m.isMeshBasicMaterial) { const std = new THREE.MeshStandardMaterial({ map: m.map, color: m.color, roughness: 0.75, metalness: 0.05, side: m.side, transparent: m.transparent, alphaTest: m.alphaTest }); std.name = m.name; return std }
      if (m.metalness > 0.6) m.metalness = 0.4
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

function placeholder(spec) {
  const root = new THREE.Group(); root.add(standIn(spec))
  return { root, clips: [], size: new THREE.Vector3(spec.height * 0.4, spec.height, spec.height * 0.6), placeholder: true }
}
