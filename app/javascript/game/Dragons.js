import * as THREE from "three"
import { TUNING as T, lerpAngle, wrapAngle } from "game/Tuning"
import { makeBeacon, placeBeacon, showBeacon, disposeBeacon } from "game/Beacon"
import { FireCone } from "game/FireCone"
import { Blob } from "game/Shadows"

// The dragons as the server tells them: `actors` messages at 4 Hz while one is awake (a heartbeat every two seconds
// otherwise) carry position, heading, speed and state; here each dragon is drawn a quarter second behind those
// samples, interpolated between them and extrapolated along its heading for up to a second when the next sample is
// late. The glTF model plays by state (Flying_Idle perched, Fast_Flying on the wing, Headbutt while breathing,
// Death once), banks into turns, breathes a fire cone with a sprite stream, carries a name beacon and a contact
// shadow. `nearest(x, z, yaw)` names the dragon the mech is aiming at; `struck(target, kind)` reports a spell hit.
const DELAY_MS = 250, EXTRAPOLATE_MS = 1000, HIDE_DEAD_MS = 8000

export class Dragons {
  constructor({ scene, assets, effects, session, send, heightAt, hud = null }) {
    this.scene = scene; this.assets = assets; this.effects = effects; this.session = session
    this.send = send; this.heightAt = heightAt; this.hud = hud
    this.list = new Map()          // id → dragon
    this.fireAcc = 0
    this.count = 0
  }

  // list: snapshots; now: server ms of the message
  receive(list, now) {
    const t = performance.now() - Math.max(0, this.session.now() - now)      // the message's age, in our clock
    for (const s of list) {
      let d = this.list.get(s.id)
      if (!d) { d = this.spawn(s); this.list.set(s.id, d) }
      d.name = s.name; d.lair = s.lair; d.max = s.max; d.target = s.target
      if (s.state !== d.state) { d.prevState = d.state; d.state = s.state; d.stateAt = performance.now() }
      d.hp = s.hp
      d.buf.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, speed: s.speed })
      if (d.buf.length > 16) d.buf.shift()
      d.lastSeen = performance.now()
    }
    this.count = this.list.size
  }

  spawn(s) {
    const inst = this.assets.instantiate("dragon")
    const root = new THREE.Group()
    root.add(inst.root)
    this.scene.add(root)
    const head = new THREE.Group(); head.position.set(0, T.mech.height * 0.9, -3.5); root.add(head)   // roughly the mouth
    return { id: s.id, name: s.name, lair: s.lair, state: s.state, prevState: null, stateAt: 0, hp: s.hp, max: s.max, target: s.target,
      buf: [], lastSeen: 0, root, inst, head, cone: new FireCone(head), beacon: makeBeacon(this.scene, 0xff6a3a),
      shadow: new Blob(this.scene, 5, 7), x: s.x, y: s.y, z: s.z, yaw: s.yaw, speed: 0, roll: 0, alive: s.state !== "dead", deathPlayed: false }
  }

  // a `strike` verdict from the server: the room-wide hp
  strike(msg) {
    const d = this.list.get(msg.dragon_id)
    if (!d) return
    d.hp = msg.hp
    if (msg.by === this.session.playerId) { this.hud?.hit?.(); this.effects.flash(d.x, d.y, d.z, 3) }
    if (d.inst.ready && d.state !== "dead") d.inst.play(/hit/i, { once: true, fade: 0.1 })
  }

  // a spell of ours reached a dragon: tell the server, predict the hp
  struck(target, kind) {
    const d = this.list.get(target.id)
    if (!d || !d.alive) return
    const dmg = kind === "fireball" ? T.spells.fireball.dmg : T.spells.lightning.dmg
    d.hp = Math.max(0, d.hp - dmg)
    this.send("strike", { dragon_id: d.id, damage: dmg, kind })
    this.hud?.hit?.()
  }

  // the dragon in front of (x, z, yaw) within the aim cone and range, as a live target for the spells
  nearest(x, z, yaw, cone = T.spells.aimCone, range = T.spells.aimRange) {
    let best = null, bestD = range
    for (const d of this.list.values()) {
      if (!d.alive) continue
      const dx = d.x - x, dz = d.z - z, dist = Math.hypot(dx, dz)
      if (dist > bestD) continue
      const ang = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - yaw))
      if (ang > cone) continue
      bestD = dist; best = d
    }
    return best
  }

  update(local, camera, dt, darkness = 0) {
    const now = performance.now(), renderT = now - DELAY_MS
    let breathStrength = 0, nearestBreather = null, nearestD = Infinity
    for (const d of this.list.values()) {
      const b = d.buf
      if (!b.length) continue
      // interpolate between the two samples around renderT; past the newest one, extrapolate along the heading
      let i = b.length - 1
      while (i > 0 && b[i - 1].t > renderT) i--
      const a = b[Math.max(i - 1, 0)], c = b[i]
      let x, y, z, yaw, pitch
      if (renderT <= c.t || b.length === 1) {
        const k = c.t === a.t ? 1 : THREE.MathUtils.clamp((renderT - a.t) / (c.t - a.t), 0, 1)
        x = a.x + (c.x - a.x) * k; y = a.y + (c.y - a.y) * k; z = a.z + (c.z - a.z) * k
        yaw = lerpAngle(a.yaw, c.yaw, k); pitch = a.pitch + (c.pitch - a.pitch) * k
      } else {
        const ahead = Math.min(EXTRAPOLATE_MS, renderT - c.t) / 1000
        x = c.x - Math.sin(c.yaw) * c.speed * ahead; z = c.z - Math.cos(c.yaw) * c.speed * ahead
        y = c.y + Math.sin(c.pitch) * c.speed * ahead; yaw = c.yaw; pitch = c.pitch
      }
      const yawRate = dt > 0 ? wrapAngle(yaw - d.yaw) / dt : 0
      d.roll += (THREE.MathUtils.clamp(-yawRate * 0.8, -0.7, 0.7) - d.roll) * Math.min(1, dt * 4)
      d.x = x; d.y = y; d.z = z; d.yaw = yaw; d.speed = c.speed
      d.root.position.set(x, y, z)
      d.root.rotation.set(0, yaw, 0)
      d.root.rotateX(-pitch); d.root.rotateZ(d.roll)
      d.alive = d.state !== "dead"
      this.animate(d, dt)
      // breath: the cone from the mouth, the strongest one drives the shared shader; the nearest streams sprites
      const breathing = d.state === "breathe"
      d.cone.set(breathing, dt)
      if (d.cone.k > 0.02) breathStrength = Math.max(breathStrength, d.cone.k)
      if (breathing) { const dist = Math.hypot(x - local.x, z - local.z); if (dist < nearestD) { nearestD = dist; nearestBreather = d } }
      // dead: hidden after the death clip, no beacon
      const dead = d.state === "dead", hide = dead && now - d.stateAt > HIDE_DEAD_MS
      d.root.visible = !hide
      showBeacon(d.beacon, !dead)
      if (!dead) placeBeacon(d.beacon, x, y, z, `${d.name} ${Math.round(d.hp)}♥`, local, camera)
      const g = this.heightAt(x, z)
      d.shadow.place(x, g, z, yaw, Math.max(0, y - g), darkness)
      d.shadow.mesh.visible = !hide && d.shadow.mesh.visible
    }
    FireCone.tick(dt, breathStrength)
    if (nearestBreather) this.stream(nearestBreather, dt)
  }

  animate(d, dt) {
    const inst = d.inst
    if (!inst.ready) return
    if (d.state === "dead") {
      if (!d.deathPlayed) { d.deathPlayed = true; inst.play(/death/i, { once: true, fade: 0.2 }) }
    } else {
      d.deathPlayed = false
      const want = d.state === "perch" ? [/flying_idle/i, /idle/i] : d.state === "breathe" ? [/headbutt/i, /punch/i, /fast/i] : [/fast/i, /fly/i]
      const ts = d.state === "perch" ? 0.6 : d.state === "breathe" ? 1 : Math.max(0.7, d.speed / 25)
      for (const re of want) if (inst.play(re, { timeScale: ts })) break
    }
    inst.update(dt)
  }

  // sprites down the breath of the nearest breathing dragon
  stream(d, dt) {
    this.fireAcc += dt * 60
    const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw)
    const mx = d.x + fx * 3.5, my = d.y + 1.5, mz = d.z + fz * 3.5
    while (this.fireAcc >= 1) {
      this.fireAcc -= 1
      const s = 25 + Math.random() * 15, j = () => (Math.random() - 0.5) * 6
      this.effects.fire.emit(mx, my, mz, fx * s + j(), -6 + j() * 0.5, fz * s + j(), 0.9, 1.5, 5, 0.9)
    }
  }

  // for the HUD: the dragon the player is aiming at, or the nearest awake one within 400 m
  aimed(local) {
    const d = this.nearest(local.x, local.z, local.yaw)
    if (d) return d
    let best = null, bestD = 400
    for (const c of this.list.values()) { if (!c.alive || c.state === "perch") continue; const dist = Math.hypot(c.x - local.x, c.z - local.z); if (dist < bestD) { bestD = dist; best = c } }
    return best
  }

  reset() {
    for (const d of this.list.values()) { this.scene.remove(d.root); disposeBeacon(d.beacon); d.shadow.dispose(); d.inst.dispose() }
    this.list.clear()
  }
}
