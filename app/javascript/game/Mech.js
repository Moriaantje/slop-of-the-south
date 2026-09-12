import * as THREE from "three"
import { TUNING as T, expDamp } from "game/Tuning"
import { ShieldBubble } from "game/ShieldBubble"
import { MechRig, WizardKit } from "game/MechRig"

// The wizard mech: the same contract as Vehicle (x, y, z, yaw, speed, vx, vz, spec, mesh, integrate, settle, state,
// reset, setNight, addBoost, kick, jump, boostMeter) so the camera, Combat, the HUD and the network treat it like
// any ride, but it walks: turns in place, climbs anything up to 37°, steps up curbs, jumps (Space) and hovers
// (hold Space after the apex, burning mana), raises a shield (Shift, burning mana, slower). Mana is the boost meter,
// so the road pads refill it and the HUD bar is the same bar in blue. Spells live in Spells.js. Water it wades
// through slowly; deeper than the knee for three seconds and it is "verzopen" (game.js resets it to the hub).
//
// What it looks like is two bodies and one wardrobe. MechRig is a walking biped built from geometry, which is what
// stands here while the CC0 glTF robot is loading and forever if the file never turns up; the old fallback was a
// grey box, which is exactly the kind of placeholder the whole art pass exists to get rid of. When the glTF does
// arrive it takes over — it has a rig and real animation clips, which beats anything hand-posed — but it ships with
// a flat unlit palette texture, so it is relit on the way in: metal enough to pick up the sky environment map, with
// its own texture fed back as a faint emissive so the panel colours still read after dark. Either way the wizard's
// kit (cloak, floating staff, mana core) hangs off the same inner group, and that is what sells it as a sorcerer
// rather than a robot. The inner group also carries the transformation fold, so Avatar can pose the machine without
// fighting the root transform that settle() writes every frame.
export const MECH_SPEC = {
  id: "mech", naam: "Tovenaarsmech", blurb: "Loopt overal, springt en zweeft, gooit vuurballen en bliksem. Mana is de boostmeter.",
  length: 2.6, track: 2.2, ram: 0.6, clear: 4, push: true, pushMin: 0.5, pushKinds: ["t", "l", "g", "s"],   // tramples trees and posts, bounces off houses
  cam: { dist: 1.35, height: 1.7, look: 2.2 },
  ability: { kind: "none", cooldown: 0, hint: "Q vuurbal · F bliksem · shift schild · spatie spring/zweef · T terug in de auto" },
}
const WALK_CLIPS = [/run/i, /walk/i], IDLE_CLIPS = [/idle/i], AIR_CLIPS = [/jump/i, /fall/i, /fly/i, /hover/i]
const FOLD_SINK = 0.80           // metres the folded machine lifts off the ground before the flash
const FOLD_CROUCH = 0.42         // share of its height the body loses as it folds
const FOLD_NARROW = 0.12         // share of its width
const FOLD_LEAN = 0.35           // rad the body tips forward over the tucked legs
const GLTF_METAL = 0.55          // the palette-textured robot needs metal to catch the sky map at all
const GLTF_ROUGH = 0.42
const GLTF_GLOW = 0.22           // its own texture fed back as emissive, so it does not go black at night
const NIGHT_GLOW = 1.6           // extra mana-core emissive in the dark, where the mech is the only light source

export class Mech {
  constructor(spawn, { assets = null, heightAt = null, waterAt = null } = {}) {
    this.spec = MECH_SPEC
    this.heightAt = heightAt
    this.waterAt = waterAt
    this.maxSpeed = T.mech.walk
    this.mesh = new THREE.Group()
    this.mesh.userData = { wheels: [], flames: [], lights: null }
    this.body = new THREE.Group()                   // everything the fold poses; the root stays the game's to move
    this.mesh.add(this.body)
    this.rig = new MechRig()
    this.body.add(this.rig.root)
    this.kit = new WizardKit({ cloak: true, core: true, mats: this.rig.mats })
    this.kit.core.visible = false                   // the rig has a core of its own; this one is for the glTF body
    this.body.add(this.kit.root)
    this.inst = assets?.instantiate("mech", { onReady: (i) => this.adopt(i) }) ?? null
    // Assets hands back a stand-in box until the file lands: keep it hidden, the rig is a far better placeholder
    if (this.inst) { this.inst.root.visible = false; this.body.add(this.inst.root) }
    this.bubble = new ShieldBubble(this.mesh, 3.2, T.mech.height * 0.55)
    this.mana = 0.5                                 // survives resets, like the car's meter
    this.darkness = 0
    this.boostPower = 0; this.drifting = false; this.driftMild = false; this.chargeLevel = 0; this.braking = false; this.smoking = false
    this.t = 0
    this.mesh.userData.fold = (k) => this.fold(k)
    this.reset(spawn)
  }

  // The glTF landed: hand the body over to it and relight it. The stand-in box Assets hands back before the file
  // arrives is not wanted here either — the rig is a better placeholder than any box — so it is dropped as well.
  adopt(inst) {
    if (!inst.clips.length) return                  // no clips means Assets fell back to its own box: keep the rig
    inst.root.visible = true
    this.rig.root.visible = false
    this.kit.core.visible = true
    inst.root.traverse((o) => {
      if (!o.isMesh) return
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || m.__mechLit) continue
        m.__mechLit = true
        m.metalness = GLTF_METAL
        m.roughness = GLTF_ROUGH
        m.envMapIntensity = 1.25
        if (m.map) { m.emissiveMap = m.map; m.emissive = new THREE.Color(0xffffff); m.emissiveIntensity = GLTF_GLOW }
        m.needsUpdate = true
      }
    })
  }

  get boostMeter() { return this.mana }
  set boostMeter(v) { this.mana = v }

  reset(spawn) {
    this.x = spawn.x; this.z = spawn.z; this.y = 0; this.yaw = spawn.yaw
    this.speed = 0; this.vx = 0; this.vz = 0
    this.vy = null; this.airY = 0; this.landed = false; this.hovering = false
    this.shield = false; this.blocked = false
    this.kickX = 0; this.kickZ = 0
    this.wading = false; this.drownT = 0; this.drowned = false
    this._dt = 1 / 60
  }

  jump(v) { if (this.vy === null) { this.vy = v; this.airY = this.y } }
  kick(x, z) { this.kickX += x; this.kickZ += z }
  forward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) } }
  addBoost(fill) { this.mana = Math.min(1, this.mana + fill) }
  setNight(darkness) { this.darkness = darkness }

  // input: throttle, brake, steer (held), jump (tap), hover, shield (held)
  integrate(dt, input) {
    const M = T.mech
    this._dt = dt; this.t += dt
    this.yaw += input.steer * M.turnRate * (this.vy === null ? 1 : 0.6) * dt
    let drain = 0
    this.shield = !!input.shield && this.mana > 0
    if (this.shield) drain += M.shieldDrain
    const cap = (this.shield ? M.shieldSlow : 1) * (this.wading ? 0.5 : 1)
    const want = (input.throttle * M.walk - input.brake * M.reverse) * cap
    this.speed = expDamp(this.speed, want, this.vy === null ? M.accelRate : 1.5, dt)
    if (Math.abs(this.speed) < 0.05 && !input.throttle && !input.brake) this.speed = 0
    const f = this.forward()
    // the slope gate: measure the ground ahead in the walking direction; too steep and the mech stops
    this.blocked = false
    if (this.heightAt && this.vy === null && Math.abs(this.speed) > 0.1) {
      const dir = Math.sign(this.speed)
      const h0 = this.heightAt(this.x, this.z), h1 = this.heightAt(this.x + f.x * dir * M.probe, this.z + f.z * dir * M.probe)
      if ((h1 - h0) / M.probe > M.slopeMax) { this.blocked = true; this.speed = 0 }
    }
    this.vx = f.x * this.speed + this.kickX; this.vz = f.z * this.speed + this.kickZ
    this.x += this.vx * dt; this.z += this.vz * dt
    const fade = Math.exp(-dt * 2.3); this.kickX *= fade; this.kickZ *= fade
    // jump and hover
    if (input.jump && this.vy === null && !this.drowned) this.jump(M.jumpV)
    this.hovering = false
    if (this.vy !== null) {
      this.vy -= M.gravity * dt
      if (input.hover && this.vy < 0 && this.mana > 0) { this.vy = Math.max(this.vy, -M.hoverSink); this.hovering = true; drain += M.hoverDrain }
      this.airY += this.vy * dt
    }
    if (drain > 0) this.mana = Math.max(0, this.mana - drain * dt)
    else this.mana = Math.min(1, this.mana + dt / M.manaRegen)
  }

  // ground contact: y is the driving surface under the mech (like car.y); the mesh floats above it in the air
  settle(heightAt) {
    const M = T.mech, dt = this._dt
    const ground = heightAt(this.x, this.z)
    const level = this.waterAt?.(this.x, this.z)
    const depth = typeof level === "number" ? level - ground : 0
    this.wading = depth > 0.3 && this.vy === null
    if (depth > M.drownDepth && this.vy === null) { this.drownT += dt; if (this.drownT > M.drownTime) this.drowned = true }
    else this.drownT = Math.max(0, this.drownT - dt)
    if (this.vy === null && ground < this.y - 1.2 && this.y !== 0) { this.vy = 0; this.airY = this.y }   // walked off a roof: fall
    if (this.vy !== null) {
      if (this.airY <= ground && this.vy < 0) { this.vy = null; this.landed = true; this.y = ground }
      else { this.y = ground; this.place(this.airY); return }
    }
    // the body eases onto steps and curbs and never sinks into the ground; a big gap means a teleport: snap
    this.y = Math.abs(this.y - ground) > 2 ? ground : Math.max(ground - 0.4, expDamp(this.y, ground, M.ySmooth, dt))
    this.place(this.y)
  }

  place(y) {
    this.mesh.position.set(this.x, y, this.z)
    this.mesh.rotation.y = this.yaw
    this.bubble.update(this.shield, this._dt, this.t)
    this.animate()
  }

  // The glTF's mixer when there is one, the rig's own gait when there is not, and the wizard's kit either way. The
  // mana core brightens in the dark: at night the mech is often the only light in the street and its own glow is
  // what keeps its silhouette readable.
  animate() {
    const inst = this.inst, air = this.vy !== null
    const glTF = inst?.ready && inst.clips.length
    if (glTF) {
      const moving = Math.abs(this.speed) > 0.5
      const want = air ? AIR_CLIPS : moving ? WALK_CLIPS : IDLE_CLIPS
      for (const re of want) if (inst.play(re, { timeScale: moving && !air ? Math.max(0.6, Math.abs(this.speed) / 6) : 1 })) break
      inst.update(this._dt)
    } else {
      this.rig.update(this._dt, this.t, this.speed, air)
      this.rig.setMana(this.mana, this.t)
    }
    this.kit.update(this._dt, this.t, this.speed, this.mana, air)
    const glow = 1 + NIGHT_GLOW * this.darkness
    this.rig.mats.rune.emissiveIntensity *= glow
  }

  // k = 0 is standing, k = 1 the folded machine: legs tucked under a crouched body that has lifted clear of the
  // ground, the cloak drawn in and the staff pulled against the flank. Avatar supplies the easing.
  fold(k) {
    this.body.scale.set(1 - FOLD_NARROW * k, 1 - FOLD_CROUCH * k, 1 - FOLD_NARROW * k)
    this.body.position.y = FOLD_SINK * k
    this.body.rotation.x = FOLD_LEAN * k
    this.rig.fold(k)
    this.kit.fold(k)
  }

  state() {
    return { x: this.x, y: this.mesh.position.y, z: this.z, yaw: this.yaw, speed: this.speed, brake: false, drift: false, boost: false,
             vehicle: "mech", shield: this.shield, air: this.vy !== null }
  }
}
