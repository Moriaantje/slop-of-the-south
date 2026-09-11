import { distTo } from "game/Destructibles"

// What the player's vehicle does to the world: ramming, driving over rubble and (later) the weapons. Everything
// here is local prediction plus messages: damage is queued per object and sent to the server in `hit` batches;
// the server decides when something actually falls (Destructibles.apply).
export class Combat {
  constructor({ index, effects, send }) {
    this.index = index
    this.effects = effects
    this.send = send
    this.pending = new Map()        // key → { damage, max } since the last flush
    this.lastRam = new WeakMap()    // object → time of the last ram, so a standing car does not hammer it
    this.enabled = false            // only while a round is running
  }

  // between car.integrate() and car.settle(): the bumper corners against the index. A hit pushes the car out along
  // the contact normal and bounces it; pushing vehicles grind on through; rubble only slows and takes chipping.
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
      if (obj.state === 1) { car.speed *= 1 - 2.5 * dt; this.queue(obj, spec.clear * Math.abs(v) * 4 * dt); continue }
      if (spec.push && Math.abs(v) > spec.pushMin) { car.speed *= 1 - 1.5 * dt; this.queue(obj, spec.ram * Math.abs(v) * 10 * dt); this.effects.shake(0.05); continue }
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

  // damage everything standing within r of (x, z), falling off to half at the edge
  explode(x, y, z, r, dmg) {
    this.effects.explosion(x, y, z, r)
    this.index.near(x, z, r, (obj) => this.queue(obj, dmg * (1 - 0.5 * distTo(x, z, obj) / r)))
  }

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

  reset() { this.pending.clear() }
}
