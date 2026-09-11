import * as THREE from "three"
import { hash32, mulberry32, wrapAngle } from "game/Tuning"
import { Blob } from "game/Shadows"

// The people at the hubs: the quest givers, standing on the sidewalk where hubs:build put them, one glTF townsperson
// each (three models, recoloured per person), idling with a random phase, a small name tag when you are near, a
// contact shadow. They exist for hubs within 1.5 km and go away beyond 2.5 km. Within 6 m at walking pace the talk
// prompt shows and E talks: the person turns to you and gestures while the dialogue is open (Quests.js).
const SPAWN_R = 1500, DROP_R = 2500, SHOW_R = 600, LABEL_R = 60, TALK_R = 6, TALK_SPEED = 3
const MODELS = ["npc_a", "npc_b", "npc_c"]
const ROLE_NL = { burgemeester: "burgemeester", herbergier: "herbergier", smid: "smid", kapelaan: "kapelaan", abt: "abt", jager: "drakenjager", molenaar: "molenaar", koopman: "koopman" }
const SKIN = [0xe8c4a8, 0xd9a986, 0xc48e66, 0x8d5a3b, 0xf0d5c0], SHIRT = [0x8a2f2a, 0x2f4f8a, 0x3f7a3a, 0xd9a13a, 0x7a3f8a, 0x2a7a7a, 0xe0e0d8], PANTS = [0x2a2f3a, 0x4a3a2a, 0x3a4a6a, 0x6a6a6a], HAIR = [0x2a1a10, 0x5a3a20, 0xb08a50, 0xd0d0d0, 0x8a2a1a]
const FONT = "'Avenir Next', 'Segoe UI', system-ui, sans-serif"

export class Npcs {
  constructor({ scene, assets, hubs, heightAt }) {
    this.scene = scene; this.assets = assets; this.hubs = hubs; this.heightAt = heightAt
    this.people = new Map()          // npc id → person
    this.talking = null
    this.frame = 0
    this.near = null                 // the person within talking range this frame
  }

  update(player, camera, dt, darkness = 0) {
    this.frame++
    if (this.frame % 30 === 0) this.stream(player)
    let near = null, nearD = TALK_R
    const slow = Math.hypot(player.vx ?? 0, player.vz ?? 0) < TALK_SPEED
    for (const p of this.people.values()) {
      const d = Math.hypot(p.x - player.x, p.z - player.z)
      p.root.visible = d < SHOW_R
      if (!p.root.visible) { p.label.visible = false; continue }
      if (!p.placed || this.frame % 60 === 0) { p.y = this.heightAt(p.x, p.z); p.root.position.y = p.y; p.placed = true }
      // face the player while talking, else the road
      const want = this.talking === p ? Math.atan2(-(player.x - p.x), -(player.z - p.z)) : p.yaw
      p.root.rotation.y += wrapAngle(want - p.root.rotation.y) * Math.min(1, dt * 6)
      // animation: every frame when close, every fourth frame further out
      p.acc += dt
      if (d < 150 || this.frame % 4 === 0) { this.animate(p, p.acc); p.acc = 0 }
      p.label.visible = d < LABEL_R
      if (p.label.visible) p.label.position.set(p.x, p.y + 2.1, p.z)
      p.shadow.place(p.x, p.y, p.z, p.root.rotation.y, 0, darkness)
      if (slow && d < nearD) { nearD = d; near = p }
    }
    this.near = near
  }

  // "E · praat met Sjeng Meertens (burgemeester)" or null
  get prompt() { return this.near ? `E · praat met ${this.near.name} (${ROLE_NL[this.near.role] ?? this.near.role})` : null }

  talkTo(p) {
    this.talking = p
    if (p.inst.ready) { p.inst.play(/pickup|victory|wave|hello/i, { once: true, fade: 0.2 }); p.gesture = 1.6 }
  }

  stopTalking() { this.talking = null }

  animate(p, dt) {
    const inst = p.inst
    if (!inst.ready) return
    if (p.gesture > 0) { p.gesture -= dt; if (p.gesture <= 0) inst.play(/idle/i, { fade: 0.3 }) }
    else if (!inst.current) { const a = inst.play(/idle/i); if (a) a.time = p.phase * (a.getClip().duration || 1) }
    inst.update(dt)
  }

  // spawn the people of hubs within SPAWN_R, drop those beyond DROP_R
  stream(player) {
    for (const hub of this.hubs) {
      const d = Math.hypot(hub.x - player.x, hub.z - player.z)
      for (const n of hub.npcs ?? []) {
        const have = this.people.get(n.id)
        if (!have && d < SPAWN_R) this.spawn(hub, n)
        else if (have && d > DROP_R) this.drop(have)
      }
    }
  }

  spawn(hub, n) {
    const seed = hash32(n.id), rng = mulberry32(seed)
    const inst = this.assets.instantiate(MODELS[seed % MODELS.length], { onReady: (i) => recolour(i.root, rng) })
    const root = new THREE.Group()
    root.add(inst.root)
    root.traverse((o) => { if (o.isMesh) o.castShadow = true })
    root.position.set(n.x, 0, n.z)
    root.rotation.y = n.yaw
    this.scene.add(root)
    const label = makeLabel(n.name, ROLE_NL[n.role] ?? n.role)
    label.visible = false
    this.scene.add(label)
    const p = { id: n.id, name: n.name, role: n.role, hubKey: hub.key, hubName: hub.name, x: n.x, z: n.z, y: 0, yaw: n.yaw, inst, root, label,
      shadow: new Blob(this.scene, 0.5, 0.5), phase: rng(), acc: 0, gesture: 0, placed: false }
    this.people.set(n.id, p)
  }

  drop(p) {
    this.scene.remove(p.root, p.label)
    p.label.material.map.dispose(); p.label.material.dispose()
    p.shadow.dispose(); p.inst.dispose()
    if (this.talking === p) this.talking = null
    this.people.delete(p.id)
  }
}

// the Quaternius townsfolk ship with near-black flat colours: give every person their own outfit by material name
function recolour(root, rng) {
  const pick = (list) => list[Math.floor(rng() * list.length)]
  const skin = pick(SKIN), shirt = pick(SHIRT), pants = pick(PANTS), hair = pick(HAIR)
  root.traverse((o) => {
    if (!o.isMesh) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    const fixed = mats.map((m) => {
      const c = m.clone(), name = (m.name || "").toLowerCase()
      if (name.includes("skin") || name.includes("face")) c.color.set(skin)
      else if (name.includes("shirt") || name.includes("detail")) c.color.set(shirt)
      else if (name.includes("pants")) c.color.set(pants)
      else if (name.includes("hair") || name.includes("hat")) c.color.set(hair)
      else if (name.includes("belt") || name.includes("shoe")) c.color.set(0x3a2a1a)
      else if (c.color.r + c.color.g + c.color.b < 0.1) c.color.set(0x8a7a6a)
      c.roughness = 0.85; c.metalness = 0
      return c
    })
    o.material = Array.isArray(o.material) ? fixed : fixed[0]
  })
}

// a small dark pill with the name and the role, a sprite about 2.4 m wide
function makeLabel(name, role) {
  const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 128
  const ctx = canvas.getContext("2d")
  ctx.clearRect(0, 0, 512, 128)
  ctx.fillStyle = "rgba(18, 22, 30, 0.75)"
  ctx.beginPath(); ctx.roundRect?.(16, 12, 480, 104, 30); if (!ctx.roundRect) ctx.rect(16, 12, 480, 104); ctx.fill()
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff"
  ctx.font = `bold 44px ${FONT}`; ctx.fillText(name, 256, 50, 440)
  ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.font = `500 30px ${FONT}`; ctx.fillText(role, 256, 92, 440)
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }))
  sprite.scale.set(2.4, 0.6, 1)
  sprite.renderOrder = 15
  return sprite
}
