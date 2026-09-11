import * as THREE from "three"
import { TUNING as T, lerpAngle, wrapAngle } from "game/Tuning"
import { makeBeacon, placeBeacon, showBeacon, disposeBeacon } from "game/Beacon"
import { FireCone } from "game/FireCone"
import { Blob } from "game/Shadows"
import { pbr } from "game/Textures"

// The dragons as the server tells them: `actors` messages at 4 Hz while one is awake (a heartbeat every two seconds
// otherwise) carry position, heading, speed and state; here each dragon is drawn a quarter second behind those
// samples, interpolated between them and extrapolated along its heading for up to a second when the next sample is
// late. Each is a huge serpent built here from primitives, in the spirit of the sky dragons of Breath of the Wild:
// a horned head with glowing eyes and a frill, a long tapering body of scaled segments with dorsal fins that trails
// along the path the head actually flew, and a pair of membrane wings a little way down the neck that beat while
// it flies and fold when it perches. A dragon banking over a town is a hundred metres of body curving through the
// sky, visible from the next village. It breathes a fire cone with a sprite stream (the jaw opens), carries a name
// beacon and a contact shadow, and sinks to the ground when it dies. `nearest(x, z, yaw)` names the dragon the
// mech is aiming at; `struck(target, kind)` reports a spell hit.
const DELAY_MS = 250, EXTRAPOLATE_MS = 1000, HIDE_DEAD_MS = 8000
// the serpent body: segment count, spacing along the path, radius behind the head → the tail tip, history length
const SEGMENTS = 32, SPACING = 3.4, R0 = 2.4, R1 = 0.3, ANCHOR = 4, HISTORY = 700, WING_AT = 4
const bodyGeo = (() => { const g = new THREE.SphereGeometry(1, 14, 10); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 5, uv.getY(i) * 2.5); g.__shared = true; return g })()
const finGeo = (() => { const g = new THREE.ConeGeometry(0.5, 1, 4, 1); g.translate(0, 0.5, 0); g.__shared = true; return g })()
const hornGeo = (() => { const g = new THREE.ConeGeometry(0.45, 3.2, 7); g.translate(0, 1.6, 0); g.__shared = true; return g })()
const eyeGeo = new THREE.SphereGeometry(0.42, 10, 8); eyeGeo.__shared = true
// roof tiles tinted blood-red make a fair scale hide; one shared material for every dragon
const scaleMat = pbr("rooftile", { color: 0x6a2420, tint: 0xa6463a, size: 1, roughness: 0.55, metalness: 0.1 })
const boneMat = new THREE.MeshStandardMaterial({ color: 0xd9cdb0, roughness: 0.5 }); boneMat.__shared = true
const finMat = new THREE.MeshStandardMaterial({ color: 0xd8a03a, roughness: 0.5, emissive: 0x3a2000, emissiveIntensity: 0.5, side: THREE.DoubleSide }); finMat.__shared = true
const wingMat = new THREE.MeshStandardMaterial({ color: 0x5a1c18, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.92, emissive: 0x200600, emissiveIntensity: 0.5 }); wingMat.__shared = true
const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffb040, emissive: 0xff8a10, emissiveIntensity: 3, roughness: 0.3 }); eyeMat.__shared = true
const wingGeo = (() => {
  // a membrane fanned from the shoulder: leading edge out to 17 m, three fingers, scalloped trailing edge; x out, -z forward
  const pts = [[0, 0, 0], [6, 0.6, -1.5], [12, 0.9, -1.0], [17, 0.6, 0.5], [15.5, 0, 4.5], [11, -0.3, 6.5], [6, -0.4, 6.0], [1.5, -0.2, 4.5]]
  const pos = [], idx = []
  for (const p of pts) pos.push(...p)
  for (let i = 1; i < pts.length - 1; i++) idx.push(0, i, i + 1)
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); g.__shared = true
  return g
})()
const wingBoneGeo = (() => { const g = new THREE.CylinderGeometry(0.22, 0.32, 17, 6); g.rotateZ(-Math.PI / 2); g.translate(8.5, 0.3, -0.5); g.__shared = true; return g })()

// the head: skull, snout, jaw (opens while breathing), horns, eyes and a frill of fins; faces -z from its own origin
function makeHead() {
  const head = new THREE.Group()
  const skull = new THREE.Mesh(bodyGeo, scaleMat); skull.scale.set(2.4, 2.0, 3.4); skull.position.set(0, 0, -1.2); head.add(skull)
  const snout = new THREE.Mesh(bodyGeo, scaleMat); snout.scale.set(1.6, 1.15, 3.6); snout.position.set(0, -0.35, -5.0); head.add(snout)
  const jaw = new THREE.Group(); jaw.position.set(0, -1.05, -2.2); head.add(jaw)
  const jawMesh = new THREE.Mesh(bodyGeo, scaleMat); jawMesh.scale.set(1.4, 0.55, 3.2); jawMesh.position.set(0, -0.3, -2.8); jaw.add(jawMesh)
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(hornGeo, boneMat); horn.position.set(s * 1.3, 1.3, 0.6); horn.rotation.set(-0.9, 0, s * 0.35); head.add(horn)
    const eye = new THREE.Mesh(eyeGeo, eyeMat); eye.position.set(s * 1.05, 0.55, -2.9); head.add(eye)
    const brow = new THREE.Mesh(hornGeo, boneMat); brow.scale.set(0.35, 0.35, 0.35); brow.position.set(s * 1.5, 0.9, -2.2); brow.rotation.set(-1.2, 0, s * 0.9); head.add(brow)
  }
  for (let i = 0; i < 7; i++) {                                                     // the frill around the back of the head
    const a = (i / 6 - 0.5) * Math.PI * 1.1
    const fin = new THREE.Mesh(finGeo, finMat); fin.scale.set(1.2, 3.2 - Math.abs(a) * 1.2, 0.4)
    fin.position.set(Math.sin(a) * 2.2, 0.4 + Math.cos(a) * 1.6, 1.4); fin.rotation.set(0.5, 0, -a); head.add(fin)
  }
  return { head, jaw }
}

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
    const root = new THREE.Group()
    const { head, jaw } = makeHead()
    root.add(head)
    this.scene.add(root)
    const mouth = new THREE.Group(); mouth.position.set(0, -0.6, -7.5); head.add(mouth)
    // the serpent body: segments in world space, following the head's path; the wings ride on segment WING_AT
    const body = new THREE.Group()
    const segs = []
    for (let i = 0; i < SEGMENTS; i++) {
      const k = i / (SEGMENTS - 1), r = R0 * (1 - k) + R1 * k
      const seg = new THREE.Mesh(bodyGeo, scaleMat)
      seg.scale.set(r, r * 0.85, SPACING * 0.72)
      const fin = new THREE.Mesh(finGeo, finMat)
      fin.scale.set(0.9, 1.6 * (1 - 0.5 * k) / 0.85, 0.35 / (SPACING * 0.72) * r)   // in the parent's stretched frame
      fin.position.y = 0.7                                                          // in the unit sphere: on the back
      seg.add(fin)
      body.add(seg); segs.push(seg)
    }
    const wings = [-1, 1].map((side) => {
      const w = new THREE.Group()
      const membrane = new THREE.Mesh(wingGeo, wingMat), bone = new THREE.Mesh(wingBoneGeo, boneMat)
      w.add(membrane, bone)
      w.scale.x = side
      body.add(w)
      return w
    })
    this.scene.add(body)
    return { id: s.id, name: s.name, lair: s.lair, state: s.state, prevState: null, stateAt: 0, hp: s.hp, max: s.max, target: s.target,
      buf: [], lastSeen: 0, root, head, jaw, wings, flap: 0, cone: new FireCone(mouth), beacon: makeBeacon(this.scene, 0xff6a3a),
      shadow: new Blob(this.scene, 8, 14), x: s.x, y: s.y, z: s.z, yaw: s.yaw, speed: 0, roll: 0, alive: s.state !== "dead", sink: 0,
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
      if (i === WING_AT) {                                                            // the wings ride this segment, beating or folded
        const flying = d.state !== "perch" && d.state !== "dead"
        d.flap += dt * (flying ? 1.1 : 0.25) * Math.PI * 2
        const beat = flying ? 0.15 + 0.5 * Math.sin(d.flap) : 1.25 + 0.05 * Math.sin(d.flap)
        for (const w of d.wings) {
          w.position.set(sx, sy + 0.8, sz); w.quaternion.copy(seg.quaternion)
          w.rotateZ(-Math.sign(w.scale.x) * beat)
          w.visible = d.root.visible
        }
      }
      px = sx; py = sy; pz = sz
    }
  }

  // a `strike` verdict from the server: the room-wide hp
  strike(msg) {
    const d = this.list.get(msg.dragon_id)
    if (!d) return
    d.hp = msg.hp
    if (msg.by === this.session.playerId) { this.hud?.hit?.(); this.effects.flash(d.x, d.y, d.z, 3) }
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
      d.alive = d.state !== "dead"
      if (!d.alive) { d.sink = Math.min(1, d.sink + dt / 6); y = Math.max(this.heightAt(x, z) + 2, y - d.sink * d.sink * 60) }   // a dead dragon comes down
      else d.sink = 0
      d.x = x; d.y = y; d.z = z; d.yaw = yaw; d.speed = c.speed
      d.root.position.set(x, y, z)
      d.root.rotation.set(0, yaw, 0)
      d.root.rotateX(-pitch); d.root.rotateZ(d.roll)
      d.jaw.rotation.x += ((d.state === "breathe" ? 0.55 : 0.04) - d.jaw.rotation.x) * Math.min(1, dt * 6)
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

  // sprites down the breath of the nearest breathing dragon
  stream(d, dt) {
    this.fireAcc += dt * 60
    const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw)
    const mx = d.x + fx * 8, my = d.y - 0.6, mz = d.z + fz * 8
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
    for (const d of this.list.values()) { this.scene.remove(d.root, d.body); disposeBeacon(d.beacon); d.shadow.dispose() }
    this.list.clear()
  }
}
