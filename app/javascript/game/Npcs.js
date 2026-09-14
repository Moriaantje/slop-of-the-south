import * as THREE from "three"
import { hash32, mulberry32, wrapAngle } from "game/Tuning"
import { Blob } from "game/Shadows"
import { noAO } from "game/Layers"

// The people at the hubs: the quest givers, standing on the sidewalk where hubs:build put them, one glTF townsperson
// each (three models, recoloured per person), with a contact shadow, a name tag when you are near, and a small life
// of their own. They exist for hubs within 1.5 km and go away beyond 2.5 km.
//
// The life is the point of this file. A row of people rooted to the spot reads as scenery, and scenery is not worth
// driving to, so everybody here has a home spot they never wander far from and a loop of standing, strolling a few
// metres, turning to look at the road, and turning to the neighbour they share a pavement with. It is deliberately
// cheap: one target position, one speed, one timer per person, no path-finding and no collision — they walk on a
// pavement that is five metres wide and nothing they can bump into is ever on it. Only the people within WORK_R do
// any of this; beyond that they stand still and are animated every fourth frame, because a figure two hundred metres
// off is four pixels tall and nobody has ever seen it breathe.
//
// Walking up to somebody is meant to feel like being noticed. Inside GREET_R they turn their head your way and wave
// once, inside TALK_R the prompt appears, and while the conversation is open they face you square on and gesture
// every few seconds so the panel is not the only thing that moves. What they are worth talking to about hangs over
// their head: an amber "!" when the hub has work you have not taken and a green "?" when something of yours ends
// here. That comes from the server's `board` messages, which Quests.js asks for through `hubsNeedingBoard`, and
// until an answer arrives nobody wears a marker — a wrong marker is worse than none.
const SPAWN_R = 1500, DROP_R = 2500, SHOW_R = 600, LABEL_R = 60, MARK_R = 110, TALK_R = 6, TALK_SPEED = 3
const WORK_R = 160          // metres: inside this, people move about and are animated every frame
const GREET_R = 16          // metres: they notice you
const WANDER_R = 5.5        // metres from their home spot they are willing to stray
const WALK_SPEED = 1.15     // m/s, a Sunday pace
const TURN_RATE = 6         // how fast they swing round, per second of blend
const STAND_MS = [3000, 9000], WALK_MS = [2500, 6000], GESTURE_MS = 4200
const MODELS = ["npc_a", "npc_b", "npc_c"]
const ROLE_NL = { burgemeester: "burgemeester", herbergier: "herbergier", smid: "smid", kapelaan: "kapelaan", abt: "abt", jager: "drakenjager", molenaar: "molenaar", koopman: "koopman" }
const SKIN = [0xe8c4a8, 0xd9a986, 0xc48e66, 0x8d5a3b, 0xf0d5c0], SHIRT = [0x8a2f2a, 0x2f4f8a, 0x3f7a3a, 0xd9a13a, 0x7a3f8a, 0x2a7a7a, 0xe0e0d8], PANTS = [0x2a2f3a, 0x4a3a2a, 0x3a4a6a, 0x6a6a6a], HAIR = [0x2a1a10, 0x5a3a20, 0xb08a50, 0xd0d0d0, 0x8a2a1a]
const FONT = "'Avenir Next', 'Segoe UI', system-ui, sans-serif"
const BOARD_REFRESH_MS = 60000      // how often a hub's marker state is asked for again

export class Npcs {
  constructor({ scene, assets, hubs, heightAt }) {
    this.scene = scene; this.assets = assets; this.hubs = hubs; this.heightAt = heightAt
    this.people = new Map()          // npc id → person
    this.byHub = new Map()           // hub key → [person], for the neighbour they turn to
    this.boards = new Map()          // hub key → { offers, turn_in, rank, rank_name, npcs, at }
    this.asked = new Map()           // hub key → when we last asked the server
    this.talking = null
    this.frame = 0
    this.now = 0
    this.near = null                 // the person within talking range this frame
  }

  update(player, camera, dt, darkness = 0) {
    this.frame++
    this.now += dt * 1000
    if (this.frame === 1 || this.frame % 30 === 0) this.stream(player)   // the first frame too: arriving in a town should not take half a second
    let near = null, nearD = TALK_R
    const slow = Math.hypot(player.vx ?? 0, player.vz ?? 0) < TALK_SPEED
    for (const p of this.people.values()) {
      const d = Math.hypot(p.x - player.x, p.z - player.z)
      p.root.visible = d < SHOW_R
      if (!p.root.visible) { p.label.visible = false; if (p.mark) p.mark.visible = false; continue }
      const busy = d < WORK_R
      if (busy) this.live(p, player, d, dt)
      if (!p.placed || busy || this.frame % 60 === 0) { p.y = this.heightAt(p.x, p.z); p.placed = true }
      p.root.position.set(p.x, p.y, p.z)
      const want = this.facing(p, player, d)
      p.root.rotation.y += wrapAngle(want - p.root.rotation.y) * Math.min(1, dt * TURN_RATE)
      p.acc += dt
      if (busy || this.frame % 4 === 0) { this.animate(p, p.acc); p.acc = 0 }
      p.label.visible = d < LABEL_R
      if (p.label.visible) p.label.position.set(p.x, p.y + 2.1, p.z)
      this.mark(p, d)
      p.shadow.place(p.x, p.y, p.z, p.root.rotation.y, 0, darkness)
      if (slow && d < nearD) { nearD = d; near = p }
    }
    this.near = near
  }

  // ---- their little day ---------------------------------------------------------------------------------------

  // where a person wants to be pointed: at you while talking, at you when you have just walked up, at where they
  // are walking, at whoever they are chatting with, and otherwise at the road they were placed facing
  facing(p, player, d) {
    if (this.talking === p || (p.greetT > 0 && d < GREET_R)) return faceYaw(player.x - p.x, player.z - p.z)
    if (p.state === "lopen") return faceYaw(p.tx - p.x, p.tz - p.z)
    if (p.state === "praten" && p.mate) return faceYaw(p.mate.x - p.x, p.mate.z - p.z)
    return p.yaw
  }

  live(p, player, d, dt) {
    if (d < GREET_R && !p.greeted) { p.greeted = true; p.greetT = 2.2; this.wave(p) }
    else if (d > GREET_R * 1.6) p.greeted = false
    if (p.greetT > 0) p.greetT -= dt
    if (this.talking === p) { this.chat(p, dt); return }
    p.untilT -= dt * 1000
    if (p.state === "lopen") {
      const dx = p.tx - p.x, dz = p.tz - p.z, left = Math.hypot(dx, dz)
      if (left < 0.25 || p.untilT <= 0) this.stand(p)
      else {
        const step = Math.min(left, WALK_SPEED * dt)
        p.x += dx / left * step; p.z += dz / left * step
      }
    } else if (p.untilT <= 0) this.decide(p)
  }

  // standing, strolling, or turning to the neighbour: a coin toss with a memory, so nobody paces endlessly
  decide(p) {
    const r = p.rng()
    const mate = this.neighbour(p)
    if (mate && r < 0.35) {
      p.state = "praten"; p.mate = mate
      p.untilT = STAND_MS[0] + p.rng() * (STAND_MS[1] - STAND_MS[0])
      if (p.rng() < 0.5) this.gesture(p)
    } else if (r < 0.75) {
      const a = p.rng() * Math.PI * 2, rad = 1.5 + p.rng() * (WANDER_R - 1.5)
      p.tx = p.home.x + Math.sin(a) * rad
      p.tz = p.home.z + Math.cos(a) * rad
      p.state = "lopen"
      p.untilT = WALK_MS[0] + p.rng() * (WALK_MS[1] - WALK_MS[0])
      if (p.inst.ready) p.inst.play(/walk|loop|move/i, { fade: 0.25 })
    } else this.stand(p)
  }

  stand(p) {
    p.state = "staan"; p.mate = null
    p.untilT = STAND_MS[0] + p.rng() * (STAND_MS[1] - STAND_MS[0])
    if (p.inst.ready && p.gesture <= 0) p.inst.play(/idle/i, { fade: 0.3 })
  }

  // while the dialogue is open they stay put and do something with their hands every few seconds
  chat(p, dt) {
    p.state = "praten"; p.mate = null
    p.chatT -= dt * 1000
    if (p.chatT <= 0) { p.chatT = GESTURE_MS; this.gesture(p) }
  }

  wave(p) { if (p.inst.ready) { p.inst.play(/wave|hello|greet|victory|yes/i, { once: true, fade: 0.2 }) || p.inst.play(/idle/i); p.gesture = 1.6 } }
  gesture(p) { if (p.inst.ready) { p.inst.play(/talk|wave|point|gesture|yes|victory|pickup/i, { once: true, fade: 0.2 }); p.gesture = 1.8 } }

  // the nearest person of the same hub within a few metres, so two people on one pavement turn to each other
  neighbour(p) {
    const mates = this.byHub.get(p.hubKey)
    if (!mates || mates.length < 2) return null
    let best = null, bestD = 6
    for (const o of mates) {
      if (o === p) continue
      const d = Math.hypot(o.x - p.x, o.z - p.z)
      if (d < bestD) { bestD = d; best = o }
    }
    return best
  }

  animate(p, dt) {
    const inst = p.inst
    if (!inst.ready) return
    if (p.gesture > 0) { p.gesture -= dt; if (p.gesture <= 0) inst.play(p.state === "lopen" ? /walk|loop|move/i : /idle/i, { fade: 0.3 }) }
    else if (!inst.current) { const a = inst.play(/idle/i); if (a) a.time = p.phase * (a.getClip().duration || 1) }
    inst.update(dt)
  }

  // ---- what they are worth talking to about ---------------------------------------------------------------------

  // Quests.js hands the server's `board` answers here
  setBoard(hubKey, info) {
    if (!hubKey) return
    this.boards.set(hubKey, { ...info, at: this.now })
  }

  // the hubs whose people are on screen and whose board state is missing or stale; Quests.js asks the server
  hubsNeedingBoard() {
    const out = []
    for (const hubKey of this.byHub.keys()) {
      const had = this.boards.get(hubKey), asked = this.asked.get(hubKey) ?? -Infinity
      if ((!had || this.now - had.at > BOARD_REFRESH_MS) && this.now - asked > 5000) { this.asked.set(hubKey, this.now); out.push(hubKey) }
    }
    return out
  }

  badgeFor(p) {
    const b = this.boards.get(p.hubKey)
    if (!b) return null
    if (b.turn_in && (!b.turn_npcs || b.turn_npcs.includes(p.id))) return "?"
    if (b.offers > 0 && (!b.npcs?.length || b.npcs.includes(p.id))) return "!"
    return null
  }

  // The glyph is only redrawn when it actually changes; range and the open dialogue merely hide it, so driving in
  // and out of a village does not churn a canvas texture per person per lap.
  mark(p, d) {
    const want = this.badgeFor(p)
    if (want !== p.badge) {
      p.badge = want
      if (p.mark) { this.scene.remove(p.mark); p.mark.material.map.dispose(); p.mark.material.dispose(); p.mark = null }
      if (want) { p.mark = makeBadge(want); this.scene.add(p.mark) }
    }
    if (!p.mark) return
    p.mark.visible = d < MARK_R && this.talking !== p
    if (p.mark.visible) p.mark.position.set(p.x, p.y + 2.75 + Math.sin(this.now / 320 + p.phase * 6) * 0.08, p.z)
  }

  // ---- talking ---------------------------------------------------------------------------------------------------

  // "E · praat met Sjeng Meertens (burgemeester) · werk" or null
  get prompt() {
    const p = this.near
    if (!p) return null
    const badge = this.badgeFor(p)
    const tail = badge === "?" ? " · iets af te ronden" : badge === "!" ? " · werk" : ""
    return `E · praat met ${p.name} (${ROLE_NL[p.role] ?? p.role})${tail}`
  }

  // the person you are talking to, for the camera in Quests.js
  get focus() { const p = this.talking; return p ? { x: p.x, y: p.y, z: p.z } : null }

  talkTo(p) {
    this.talking = p
    p.chatT = GESTURE_MS
    this.gesture(p)
  }

  stopTalking() {
    const p = this.talking
    this.talking = null
    if (p) this.stand(p)
  }

  // ---- streaming ---------------------------------------------------------------------------------------------------

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
    const p = { id: n.id, name: n.name, role: n.role, hubKey: hub.key, hubName: hub.name, x: n.x, z: n.z, y: 0, yaw: n.yaw,
      home: { x: n.x, z: n.z }, tx: n.x, tz: n.z, state: "staan", untilT: 500 + rng() * 4000, mate: null,
      inst, root, label, mark: null, badge: null, rng,
      shadow: new Blob(this.scene, 0.5, 0.5), phase: rng(), acc: 0, gesture: 0, greeted: false, greetT: 0, chatT: 0, placed: false }
    this.people.set(n.id, p)
    const list = this.byHub.get(hub.key) ?? []
    list.push(p)
    this.byHub.set(hub.key, list)
  }

  drop(p) {
    this.scene.remove(p.root, p.label)
    if (p.mark) { this.scene.remove(p.mark); p.mark.material.map.dispose(); p.mark.material.dispose() }
    p.label.material.map.dispose(); p.label.material.dispose()
    p.shadow.dispose(); p.inst.dispose()
    if (this.talking === p) this.talking = null
    this.people.delete(p.id)
    const list = (this.byHub.get(p.hubKey) ?? []).filter((o) => o !== p)
    if (list.length) this.byHub.set(p.hubKey, list); else { this.byHub.delete(p.hubKey); this.asked.delete(p.hubKey) }
  }
}

// yaw for something at (dx, dz) from here, in the game's convention: 0 is north, forward is (-sin, -cos)
export function faceYaw(dx, dz) { return Math.atan2(-dx, -dz) }

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
  return noAO(sprite)                       // cut-out sprite: the ambient-occlusion pass must not see the quad
}

// the mark over a head: amber "!" for work, green "?" for something of yours that ends here
function makeBadge(glyph) {
  const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 128
  const ctx = canvas.getContext("2d")
  const amber = glyph === "!"
  ctx.clearRect(0, 0, 128, 128)
  ctx.fillStyle = "rgba(16, 20, 28, 0.8)"
  ctx.beginPath(); ctx.arc(64, 64, 44, 0, Math.PI * 2); ctx.fill()
  ctx.lineWidth = 6; ctx.strokeStyle = amber ? "#ffb000" : "#6ede8a"
  ctx.beginPath(); ctx.arc(64, 64, 44, 0, Math.PI * 2); ctx.stroke()
  ctx.textAlign = "center"; ctx.textBaseline = "middle"
  ctx.fillStyle = amber ? "#ffcc55" : "#9bf0b0"
  ctx.font = `bold 72px ${FONT}`
  ctx.fillText(glyph, 64, 68)
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }))
  sprite.scale.set(0.7, 0.7, 1)
  sprite.renderOrder = 16
  return noAO(sprite)
}
