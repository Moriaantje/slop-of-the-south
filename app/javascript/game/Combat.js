import * as THREE from "three"
import { distTo } from "game/Destructibles"
import { makeFireball, aimFireball, tickFireballs } from "game/Fireball"

// What the player's vehicle does to the world: ramming, driving over rubble, and the six tricks on E: missiles
// and slugs that fly and burst, a sticky charge on a fuse, the monster truck's jump, the crane's wrecking ball and
// the bulldozer's blade (which is just ramming with a big number). Everything here is local prediction plus
// messages: damage is queued per object and sent to the server in `hit` batches, the server decides when something
// falls (Destructibles.apply), and `fire` tells the other players what to draw. Explosions also shove nearby cars.
const GRAVITY = 20                   // m/s² for jumps and knockback hops, arcade-heavy
const STEP = 1.5                     // metres a shot may travel between hit tests
const shotMats = { missile: new THREE.MeshStandardMaterial({ color: 0xd8d8d0, metalness: 0.5, roughness: 0.4 }), slug: new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.5 }) }
const chargeMat = new THREE.MeshStandardMaterial({ color: 0xb01010, emissive: 0xff2020, emissiveIntensity: 1 })
const missileGeo = (() => { const body = new THREE.CylinderGeometry(0.12, 0.12, 1.1, 8); body.rotateX(Math.PI / 2); return body })()
const slugGeo = new THREE.SphereGeometry(0.28, 10, 8)
const chargeGeo = new THREE.BoxGeometry(0.5, 0.35, 0.5)

export class Combat {
  constructor({ scene, index, effects, heightAt, car, send }) {
    this.scene = scene
    this.index = index
    this.effects = effects
    this.heightAt = heightAt
    this.car = car
    this.send = send
    this.pending = new Map()        // key → { damage, max } since the last flush
    this.lastRam = new WeakMap()    // object → time of the last ram, so a standing car does not hammer it
    this.enabled = true             // the world is always live; a heal (empty room) resets it
    this.shots = []                 // { mesh, x, y, z, vx, vy, vz, gravity, life, r, dmg, own }
    this.charge = null              // the brommer's sticky bomb, one at a time
    this.swing = null               // the crane's swing in progress
    this.cd = 0                     // seconds until the trick is ready again
    this.onStrike = null            // (target, kind) when a homing shot reaches its target (Dragons.js listens)
  }

  // between car.integrate() and car.settle(): the bumper corners against the index. A hit pushes the car out along
  // the contact normal and bounces it; pushing vehicles grind on through; rubble only slows and takes chipping; an
  // airborne car clears posts and trees but not houses.
  collide(car, dt) {
    const spec = car.spec, f = car.forward(), rx = -f.z, rz = f.x
    const v = car.speed, along = v >= 0 ? spec.length / 2 : -spec.length / 2
    const probes = [[-1, along], [1, along], [0, along]]
    if (Math.abs(v) * dt > 1) probes.push([0, along - Math.sign(v) * Math.abs(v) * dt / 2])   // swept: fast cars skip no wall
    for (const [side, a] of probes) {
      const px = car.x + f.x * a + rx * side * spec.track / 2, pz = car.z + f.z * a + rz * side * spec.track / 2
      const hit = this.index.hitPoint(px, pz, 0.3)
      if (!hit) continue
      const { obj, nx, nz, depth } = hit
      if (car.vy !== null && !obj.rings) continue
      if (obj.rings && car.mesh.position.y >= this.index.groundOf(obj) + (obj.h ?? 3) - 0.8) continue   // on its roof, not against its wall
      if (obj.state === 1) { car.speed *= 1 - 2.5 * dt; this.queue(obj, spec.clear * Math.abs(v) * 4 * dt); continue }
      if (spec.push && Math.abs(v) > spec.pushMin && (!spec.pushKinds || spec.pushKinds.includes(obj.kind))) { car.speed *= 1 - 1.5 * dt; this.queue(obj, spec.ram * Math.abs(v) * 10 * dt); this.effects.shake(0.05); continue }
      car.x += nx * depth; car.z += nz * depth
      const impact = Math.abs(v)
      car.speed = -0.2 * v
      if (impact > 2 && this.rammed(obj)) {
        this.queue(obj, spec.ram * impact * impact)
        this.effects.dust(px, car.y + 0.6, pz, 1.5)
        this.effects.shake(Math.min(0.6, impact / 30))
      }
      break
    }
  }

  rammed(obj) {
    const t = performance.now()
    if (t - (this.lastRam.get(obj) ?? 0) < 250) return false
    this.lastRam.set(obj, t)
    return true
  }

  // ---- the tricks --------------------------------------------------------------------------------------------------

  // E fires the vehicle's trick when its cooldown has run out; landings and swings in progress resolve here too
  abilities(car, input, dt) {
    this.cd = Math.max(0, this.cd - dt)
    if (car.landed) { car.landed = false; this.explode(car.x, car.y + 0.5, car.z, 4, 90, true, false); this.effects.shake(0.5) }
    if (this.swing) this.swingStep(car, dt)
    const a = car.spec.ability
    if (a.kind === "none" || !input.ability || this.cd > 0 || !this.enabled) return
    const f = car.forward(), nose = car.spec.length / 2 + 0.6
    switch (a.kind) {
      case "missile": this.shoot("missile", car.x + f.x * nose, car.y + 0.9, car.z + f.z * nose, f.x * 60, 0, f.z * 60, 0, 3, 6, 70, true); break
      case "slug":    this.shoot("slug", car.x + f.x * 4, car.y + 2.2, car.z + f.z * 4, f.x * 45, 6, f.z * 45, 9.8, 4, 3, 150, true); break
      case "sticky":  if (this.charge) return; this.plant(car.x, car.y, car.z, true); break
      case "jump":    if (car.vy !== null) return; car.jump(9); break
      case "ball":    this.swing = { t: 0, hit: false, mesh: car.mesh, own: true }; break
    }
    this.cd = a.cooldown
    this.send("fire", { kind: a.kind, x: car.x, y: car.y, z: car.z, yaw: car.yaw })
  }

  get cooldownFraction() { const c = this.car?.spec.ability.cooldown; return c ? this.cd / c : 0 }

  // home: optional () → { x, y, z } | null, the live position a shot steers towards (and bursts on within 8 m)
  shoot(kind, x, y, z, vx, vy, vz, gravity, life, r, dmg, own, home = null) {
    const mesh = kind === "fireball" ? makeFireball(1.1) : new THREE.Mesh(kind === "missile" ? missileGeo : slugGeo, shotMats[kind])
    mesh.position.set(x, y, z)
    if (kind === "missile") mesh.lookAt(x + vx, y + vy, z + vz)
    if (kind === "fireball") aimFireball(mesh, vx, vy, vz)
    this.scene.add(mesh)
    this.shots.push({ kind, mesh, x, y, z, vx, vy, vz, gravity, life, r, dmg, own, home, struck: null })
  }

  plant(x, y, z, own) {
    const mesh = new THREE.Mesh(chargeGeo, chargeMat)
    mesh.position.set(x, y + 0.2, z)
    this.scene.add(mesh)
    const charge = { mesh, x, y, z, t: 3, own }
    if (own) this.charge = charge
    this.shots.push({ ...charge, fuse: true })
  }

  // every frame: shots fly in substeps no longer than STEP and burst on the first object or the ground; charges
  // blink down their fuse
  projectiles(dt) {
    tickFireballs(dt)
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      if (s.fuse) {
        s.t -= dt
        s.mesh.material.emissiveIntensity = 1 + Math.max(0, Math.sin(performance.now() / (60 + 100 * s.t)))
        if (s.t <= 0) { this.explode(s.x, s.y + 0.5, s.z, 10, 120, s.own); this.drop(i); if (s.own) this.charge = null }
        continue
      }
      const target = s.home?.() ?? null
      if (target) {                                              // steer towards the target, a quarter of the way per frame
        const sp = Math.hypot(s.vx, s.vy, s.vz), dx = target.x - s.x, dy = target.y - s.y, dz = target.z - s.z, d = Math.hypot(dx, dy, dz) || 1
        s.vx += (dx / d * sp - s.vx) * 0.25; s.vy += (dy / d * sp - s.vy) * 0.25; s.vz += (dz / d * sp - s.vz) * 0.25
      }
      const n = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vy, s.vz) * dt / STEP)), h = dt / n
      let burst = false
      for (let k = 0; k < n && !burst; k++) {
        s.vy -= s.gravity * h
        s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h
        const ground = this.heightAt(s.x, s.z)
        const hit = this.index.hitPoint(s.x, s.z, 0.5)
        if (s.y <= ground || (hit && s.y <= ground + (hit.obj.h ?? 3) + 0.5)) burst = true
        if (target && Math.hypot(target.x - s.x, target.y - s.y, target.z - s.z) < 8) { burst = true; s.struck = target }
      }
      if (burst) { this.explode(s.x, s.y, s.z, s.r, s.dmg, s.own); if (s.struck && s.own) this.onStrike?.(s.struck, "fireball"); this.drop(i); continue }
      if ((s.life -= dt) <= 0) { this.drop(i); continue }
      s.mesh.position.set(s.x, s.y, s.z)
      if (s.kind === "fireball") {
        aimFireball(s.mesh, s.vx, s.vy, s.vz)
        // a few embers shed behind it, not a solid rope of sprites
        if ((s.ember = (s.ember ?? 0) + dt) > 0.05) {
          s.ember = 0
          const k = 6 / (Math.hypot(s.vx, s.vy, s.vz) || 1)
          this.effects.fire.emit(s.x - s.vx * 0.02, s.y - s.vy * 0.02, s.z - s.vz * 0.02,
            -s.vx * k + (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, -s.vz * k + (Math.random() - 0.5) * 3, 0.5, 1.1, 0.15, 0.75)
        }
      } else if (s.gravity) s.mesh.lookAt(s.x + s.vx, s.y + s.vy, s.z + s.vz)
    }
  }

  drop(i) { this.scene.remove(this.shots[i].mesh); this.shots.splice(i, 1) }

  // the boom dips forward and comes back over 0.6 s; the ball lands eight metres ahead at the bottom of the swing
  swingStep(car, dt) {
    const sw = this.swing, anim = sw.mesh.userData.anim
    sw.t += dt
    const k = Math.min(1, sw.t / 0.6)
    if (anim?.pivot) anim.pivot.rotation.x = 0.75 - 0.55 * Math.sin(k * Math.PI)
    if (!sw.hit && sw.t >= 0.3) {
      sw.hit = true
      const yaw = sw.mesh.rotation.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      const x = sw.mesh.position.x + fx * 8, z = sw.mesh.position.z + fz * 8
      this.explode(x, this.heightAt(x, z) + 1, z, 8, 500, sw.own, !sw.own)
    }
    if (k >= 1) { if (anim?.pivot) anim.pivot.rotation.x = 0.75; this.swing = null }
  }

  // damage everything standing within r of (x, z), falling off to half at the edge, and shove the player's car if it
  // stands close; `own` false replays another player's shot: looks and knockback only, the damage is theirs. A
  // landing or a swing of your own does not shove you (`shove` false), or the monster truck would bounce forever.
  explode(x, y, z, r, dmg, own = true, shove = true) {
    this.effects.explosion(x, y, z, r)
    if (own) this.index.near(x, z, r, (obj) => this.queue(obj, dmg * (1 - 0.5 * distTo(x, z, obj) / r)))
    const car = this.car
    if (!car || !shove) return
    const d = Math.hypot(car.x - x, car.z - z)
    if (d < 1.5 * r) {
      const k = (1 - d / (1.5 * r)) * Math.min(14, dmg / 10)
      car.kick((car.x - x) / (d || 1) * k, (car.z - z) / (d || 1) * k)
      if (k > 4 && car.vy === null) car.jump(Math.min(6, k * 0.5))
    }
  }

  // another player's trick, as seen from here
  remoteFire(msg, mesh) {
    const fx = -Math.sin(msg.yaw), fz = -Math.cos(msg.yaw)
    switch (msg.kind) {
      case "missile": this.shoot("missile", msg.x + fx * 2, msg.y + 0.9, msg.z + fz * 2, fx * 60, 0, fz * 60, 0, 3, 6, 70, false); break
      case "slug":    this.shoot("slug", msg.x + fx * 4, msg.y + 2.2, msg.z + fz * 4, fx * 45, 6, fz * 45, 9.8, 4, 3, 150, false); break
      case "sticky":  this.plant(msg.x, msg.y, msg.z, false); break
      case "ball":    if (mesh && !this.swing) this.swing = { t: 0, hit: false, mesh, own: false }; break
    }
  }

  // ---- the hit queue -----------------------------------------------------------------------------------------------

  queue(obj, dmg) {
    if (!this.enabled || dmg < 0.5 || obj.state === 2) return
    for (const key of obj.keys ?? [obj.key]) {
      const q = this.pending.get(key) ?? { damage: 0, max: obj.max }
      q.damage += dmg
      this.pending.set(key, q)
    }
  }

  // every 100 ms from game.js, next to the position update
  flush() {
    if (!this.pending.size) return
    const hits = [...this.pending].map(([key, h]) => ({ key, damage: Math.round(h.damage * 10) / 10, max: h.max }))
    this.pending.clear()
    for (let i = 0; i < hits.length; i += 32) this.send("hit", { hits: hits.slice(i, i + 32) })
  }

  reset() {
    this.pending.clear()
    while (this.shots.length) this.drop(this.shots.length - 1)
    this.charge = null; this.swing = null; this.cd = 0
  }
}
