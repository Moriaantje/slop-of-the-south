import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { stat } from "game/Skills"

// The wizard mech's spells. Fireball (Q): a homing bolt through Combat's projectile path, so it bursts on houses,
// trees and the ground like the tank's slug and levels them through the same `hit` batches; it steers towards the
// aimed dragon and bursts on it. Lightning (F): instant, a jagged bolt to the aimed dragon within 200 m or to a
// point 60 m ahead, a small blast there. Both cost mana and have a cooldown; `targets(x, z, yaw)` (Dragons.js) names
// what the mech is aiming at, `onStrike(target, kind)` reports a hit. Other players' spells arrive through `fire`.
//
// It is the same projectile list the dragons spit into, which is the point: a wizard's fireball and a dragon's are
// one piece of code with two owners, so they arc, shed embers, burst and set the grass alight identically and the
// fight looks like one argument rather than two effects shouting past each other. What differs is authority — ours
// is predicted here and ruled on afterwards, theirs was decided on the server before it was ever drawn.
//
// The arithmetic of a duel, since it is easy to lose track of: a dragon is 900 hp and Game::Dragon caps a strike at
// 60 for a fireball and 45 for lightning, so fifteen clean fireballs kill one. The cooldown is not what paces that —
// mana is. A full bar is five fireballs (300 damage in three seconds), and it refills over `mech.manaRegen`
// seconds, which is one more fireball every five: twelve damage a second sustained. A lone wizard who lands
// everything needs about fifty-five seconds, two wizards about half that. Lightning is the worse deal per mana and
// is there for the moment the dragon is `vulnerable` and you want damage that arrives instantly rather than in
// a second and a half of travel.
const boltMat = new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })
const coreMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })

export class Spells {
  constructor({ combat, effects, send, heightAt, hud = null }) {
    this.combat = combat
    this.effects = effects
    this.send = send
    this.heightAt = heightAt
    this.hud = hud
    this.cd = { fireball: 0, lightning: 0 }
    this.targets = null          // (x, z, yaw) → { id, x, y, z, alive } | null
    this.chainTarget = null      // (from, alreadyHit) → the next dragon a chained bolt walks to, or null
    this.onStrike = null         // (target, kind)
  }

  update(player, input, dt) {
    for (const k in this.cd) this.cd[k] = Math.max(0, this.cd[k] - dt)
    if (player.mode !== "mech" || player.transforming) return
    if (input.fireball) this.cast("fireball", player.mech)
    if (input.lightning) this.cast("lightning", player.mech)
  }

  get cooldownFraction() { return Math.max(this.cd.fireball / T.spells.fireball.cd, this.cd.lightning / T.spells.lightning.cd) }

  cast(kind, mech) {
    const S = T.spells[kind]
    if (this.cd[kind] > 0) return
    // a bigger pool is spent as cheaper casts, so the 0..1 meter the HUD draws stays 0..1
    const cost = S.mana / stat("mana_max")
    if (mech.mana < cost) { this.hud?.nope?.(); return }
    mech.mana -= cost
    const dmg = S.dmg * stat("spell_damage")
    this.cd[kind] = S.cd
    const f = mech.forward()
    const hx = mech.x + f.x * 1.6, hy = mech.mesh.position.y + T.mech.height * 0.62, hz = mech.z + f.z * 1.6   // the hand
    const target = this.targets?.(mech.x, mech.z, mech.yaw) ?? null
    if (kind === "fireball") {
      let vx = f.x * S.speed, vy = 0, vz = f.z * S.speed
      if (target) { const dx = target.x - hx, dy = target.y - hy, dz = target.z - hz, d = Math.hypot(dx, dy, dz) || 1; vx = dx / d * S.speed; vy = dy / d * S.speed; vz = dz / d * S.speed }
      const home = target ? () => (target.alive === false ? null : target) : null
      this.combat.shoot("fireball", hx, hy, hz, vx, vy, vz, 0, S.life, S.r, dmg, true, home, "player")
      // Splijtende vuurbal: the unlocked shards leave the same hand a moment apart, fanned in the ground plane and
      // chasing the same quarry. The loop does not run at all until the skill is bought.
      for (let i = 0; i < stat("fireball_split"); i++) {
        const a = (i % 2 ? 1 : -1) * 0.12 * (1 + (i >> 1))
        const ca = Math.cos(a), sa = Math.sin(a)
        this.combat.shoot("fireball", hx, hy, hz, vx * ca - vz * sa, vy, vx * sa + vz * ca, 0, S.life, S.r, dmg * 0.6, true, home, "player")
      }
      this.effects.flash(hx, hy, hz, 1.2)
    } else {
      const end = this.lightningEnd(mech.x, mech.z, f, target)
      this.bolt(hx, hy, hz, end.x, end.y, end.z)
      this.combat.explode(end.x, end.y, end.z, S.r, dmg, true, false)
      this.combat.fireGout?.(end.x, end.y, end.z, S.r, "player", 1.0)    // it leaves the grass alight, briefly
      if (target) this.onStrike?.(target, "lightning")
      // Kettingbliksem: the bolt walks on to the next dragons in range, weaker each hop. Zero hops until unlocked.
      let from = end, hit = new Set(target ? [target.id] : [])
      for (let i = 0; i < stat("lightning_chain"); i++) {
        const next = this.chainTarget?.(from, hit)
        if (!next) break
        hit.add(next.id)
        this.bolt(from.x, from.y, from.z, next.x, next.y, next.z)
        this.combat.explode(next.x, next.y, next.z, S.r, dmg * 0.7, true, false)
        this.onStrike?.(next, "lightning")
        from = next
      }
    }
    this.effects.shake(0.12)
    this.send("fire", { kind, x: mech.x, y: hy, z: mech.z, yaw: mech.yaw, pitch: 0, target: target?.id })
  }

  lightningEnd(x, z, f, target) {
    if (target) return { x: target.x, y: target.y, z: target.z }
    const ex = x + f.x * T.spells.lightning.ahead, ez = z + f.z * T.spells.lightning.ahead
    return { x: ex, y: this.heightAt(ex, ez) + 1, z: ez }
  }

  // a jagged line with a bright core, gone in a third of a second
  bolt(x0, y0, z0, x1, y1, z1) {
    const n = 12, pts = []
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz) || 1
    const px = -dz / len, pz = dx / len                                                        // a perpendicular in the ground plane
    for (let i = 0; i <= n; i++) {
      const k = i / n, j = i === 0 || i === n ? 0 : (Math.random() - 0.5) * Math.min(3, len * 0.08)
      pts.push(new THREE.Vector3(x0 + dx * k + px * j, y0 + dy * k + (Math.random() - 0.5) * (i === 0 || i === n ? 0 : 1.2), z0 + dz * k + pz * j))
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const group = new THREE.Group()
    const outer = new THREE.Line(geo, boltMat.clone()), core = new THREE.Line(geo, coreMat.clone())
    group.add(outer, core)
    this.effects.add({ mesh: group, t: 0, life: 0.3, shared: true,
      step: (e, k) => { outer.material.opacity = 1 - k; core.material.opacity = (1 - k) * (0.6 + 0.4 * Math.random()) },
    })
    setTimeout(() => { geo.dispose(); outer.material.dispose(); core.material.dispose() }, 600)
    this.effects.flash(x1, y1, z1, 1.6)
  }

  // another player's spell, as seen from here
  remote(msg, mesh) {
    const f = { x: -Math.sin(msg.yaw), z: -Math.cos(msg.yaw) }
    const hx = msg.x + f.x * 1.6, hy = msg.y, hz = msg.z + f.z * 1.6
    if (msg.kind === "fireball") {
      const S = T.spells.fireball
      this.combat.shoot("fireball", hx, hy, hz, f.x * S.speed, 0, f.z * S.speed, 0, S.life, S.r, S.dmg, false, null, "player")
    } else if (msg.kind === "lightning") {
      const end = this.lightningEnd(msg.x, msg.z, f, null)
      this.bolt(hx, hy, hz, end.x, end.y, end.z)
      this.combat.explode(end.x, end.y, end.z, T.spells.lightning.r, 0, false, false)
    }
  }
}
