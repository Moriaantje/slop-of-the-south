import * as THREE from "three"
import { TUNING as T, lerpAngle, wrapAngle } from "game/Tuning"
import { makeBeacon, placeBeacon, showBeacon, disposeBeacon } from "game/Beacon"
import { FireCone } from "game/FireCone"
import { Blob } from "game/Shadows"

// The dragons as the server tells them: `actors` messages at 4 Hz while one is awake (a heartbeat every two seconds
// otherwise) carry position, heading, speed and state; here each dragon is drawn a quarter second behind those
// samples, interpolated between them and extrapolated along its heading for up to a second when the next sample is
// late. Each is a huge serpent: the winged glTF model (14 m tall, 30 m across) is the head and forebody, and a
// long tapering spine of segments with dorsal fins trails behind along the path the head actually flew, so a
// dragon banking over a town is a hundred metres of body curving through the sky, visible from the next village.
// The model plays by state (Flying_Idle perched, Fast_Flying on the wing, Headbutt while breathing, Death once),
// banks into turns, breathes a fire cone with a sprite stream, carries a name beacon and a contact shadow.
// `nearest(x, z, yaw)` names the dragon the mech is aiming at; `struck(target, kind)` reports a spell hit.
const DELAY_MS = 250, EXTRAPOLATE_MS = 1000, HIDE_DEAD_MS = 8000
// the serpent body: segment count, spacing along the path, radius from the hips to the tail tip, the anchor behind the model
const SEGMENTS = 26, SPACING = 3.6, R0 = 2.6, R1 = 0.35, ANCHOR = 7, HISTORY = 600
const bodyGeo = new THREE.SphereGeometry(1, 12, 9); bodyGeo.__shared = true
const finGeo = (() => { const g = new THREE.ConeGeometry(0.5, 1, 4, 1); g.translate(0, 0.5, 0); g.__shared = true; return g })()
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x7a2a22, roughness: 0.65, metalness: 0.1, emissive: 0x2a0800, emissiveIntensity: 0.4 }); bodyMat.__shared = true
const finMat = new THREE.MeshStandardMaterial({ color: 0xd8b04a, roughness: 0.5, emissive: 0x402800, emissiveIntensity: 0.6, side: THREE.DoubleSide }); finMat.__shared = true

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
    const head = new THREE.Group(); head.position.set(0, 8.5, -9); root.add(head)          // roughly the mouth of the 14 m model
    // the serpent body: segments in world space, following the head's path
    const body = new THREE.Group()
    const segs = []
    for (let i = 0; i < SEGMENTS; i++) {
      const k = i / (SEGMENTS - 1), r = R0 * (1 - k) + R1 * k
      const seg = new THREE.Mesh(bodyGeo, bodyMat)
      seg.scale.set(r, r * 0.85, SPACING * 0.72)
      const fin = new THREE.Mesh(finGeo, finMat)
      fin.scale.set(r * 0.9, r * 1.6 * (1 - 0.5 * k), 1)
      fin.position.y = 0.7                                                         // in the unit sphere: on the back
      seg.add(fin)
      fin.scale.x /= r; fin.scale.y /= (r * 0.85); fin.scale.z /= (SPACING * 0.72)   // undo the parent's stretch
      body.add(seg); segs.push(seg)
    }
    this.scene.add(body)
    return { id: s.id, name: s.name, lair: s.lair, state: s.state, prevState: null, stateAt: 0, hp: s.hp, max: s.max, target: s.target,
      buf: [], lastSeen: 0, root, inst, head, cone: new FireCone(head), beacon: makeBeacon(this.scene, 0xff6a3a),
      shadow: new Blob(this.scene, 8, 14), x: s.x, y: s.y, z: s.z, yaw: s.yaw, speed: 0, roll: 0, alive: s.state !== "dead", deathPlayed: false,
      body, segs, path: [], pathLen: [], t: Math.random() * 10 }
  }

  // the body follows the path the head flew: the anchor point behind the model is pushed onto a history with
  // cumulative arc length; segment i sits i × SPACING back along it, turned towards the segment before, with a slow
  // sideways undulation so the tail is never still. A jump (spawn, teleport, respawn) lays the history out straight.
  serpent(d, yaw, pitch, dt) {
    d.t += dt
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
    const ax = d.x - fx * ANCHOR * Math.cos(pitch), ay = d.y + Math.sin(pitch) * ANCHOR - 1.5, az = d.z - fz * ANCHOR * Math.cos(pitch)
    const P = d.path, L = d.pathLen
    const last = P[P.length - 1]
    if (!last || Math.hypot(ax - last.x, ay - last.y, az - last.z) > 60) {
      P.length = 0; L.length = 0
      for (let i = 0; i <= SEGMENTS + 2; i++) { P.push({ x: ax - fx * i * SPACING, y: ay - i * 0.25, z: az - fz * i * SPACING }); L.push(-i * SPACING) }
      P.reverse(); L.reverse()
      const l0 = L[0]; for (let i = 0; i < L.length; i++) L[i] = L[i] - l0
    } else {
      const step = Math.hypot(ax - last.x, ay - last.y, az - last.z)
      if (step > 0.2) { P.push({ x: ax, y: ay, z: az }); L.push(L[L.length - 1] + step); if (P.length > HISTORY) { P.shift(); L.shift() } }
    }
    const total = L[L.length - 1]
    let j = P.length - 1
    let px = ax, py = ay, pz = az                    // the point ahead of the current segment (the anchor for the first)
    for (let i = 0; i < d.segs.length; i++) {
      const want = total - (i + 1) * SPACING
      while (j > 0 && L[j - 1] > want) j--
      const a = P[Math.max(j - 1, 0)], b = P[j], la = L[Math.max(j - 1, 0)], lb = L[j]
      const k = lb === la ? 0 : THREE.MathUtils.clamp((want - la) / (lb - la), 0, 1)
      let sx = a.x + (b.x - a.x) * k, sy = a.y + (b.y - a.y) * k, sz = a.z + (b.z - a.z) * k
      // undulation: a wave running down the body, sideways to its direction
      const dx = px - sx, dz = pz - sz, len = Math.hypot(dx, dz) || 1
      const wave = Math.sin(d.t * 2.2 - i * 0.55) * (0.25 + 0.06 * i) * (d.speed > 1 ? 1 : 0.4)
      sx += -dz / len * wave; sz += dx / len * wave
      const seg = d.segs[i]
      seg.position.set(sx, sy, sz)
      seg.lookAt(px, py, pz)
      seg.visible = d.root.visible
      px = sx; py = sy; pz = sz
    }
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
      this.serpent(d, yaw, pitch, dt)
      // breath: the cone from the mouth, the strongest one drives the shared shader; the nearest streams sprites
      const breathing = d.state === "breathe"
      d.cone.set(breathing, dt)
      if (d.cone.k > 0.02) breathStrength = Math.max(breathStrength, d.cone.k)
      if (breathing) { const dist = Math.hypot(x - local.x, z - local.z); if (dist < nearestD) { nearestD = dist; nearestBreather = d } }
      // dead: hidden after the death clip, no beacon
      const dead = d.state === "dead", hide = dead && now - d.stateAt > HIDE_DEAD_MS
      d.root.visible = !hide
      d.body.visible = !hide
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
    const mx = d.x + fx * 9, my = d.y + 8, mz = d.z + fz * 9
    while (this.fireAcc >= 1) {
      this.fireAcc -= 1
      const s = 30 + Math.random() * 18, j = () => (Math.random() - 0.5) * 8
      this.effects.fire.emit(mx, my, mz, fx * s + j(), -8 + j() * 0.5, fz * s + j(), 1.1, 2.5, 8, 0.9)
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
    for (const d of this.list.values()) { this.scene.remove(d.root, d.body); disposeBeacon(d.beacon); d.shadow.dispose(); d.inst.dispose() }
    this.list.clear()
  }
}
