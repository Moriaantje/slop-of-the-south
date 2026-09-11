import * as THREE from "three"
import { hash32, mulberry32 } from "game/Tuning"

// Dressing for the hubs: a small market on the sidewalk where the people stand — stalls behind the merchants,
// barrels and crates by the smith, a well or a fountain behind the mayor, lanterns along the curb, planters,
// benches, a sign post at the spawn, hay by the miller, a bush or two. Everything is placed in the spawn road's
// frame (along the road, the people's side of it) from a seed of the hub key, so a town always looks the same,
// and only for hubs within 1.5 km. The pieces are CC0 kit props (Assets.MODELS, public/models/props).
const SPAWN_R = 1500, DROP_R = 2500
const BY_ROLE = {
  burgemeester: ["well", "bench", "planter"], herbergier: ["stall", "barrel", "barrel", "bench"], smid: ["crate", "barrel", "cart"],
  kapelaan: ["planter", "bench"], abt: ["planter", "planter", "bench"], jager: ["crate", "hay", "sign"], koopman: ["stall", "crate", "planter"],
  molenaar: ["hay", "hay", "cart"],
}

export class Props {
  constructor({ scene, assets, hubs, heightAt }) {
    this.scene = scene; this.assets = assets; this.hubs = hubs; this.heightAt = heightAt
    this.placed = new Map()          // hub key → { group, insts }
    this.frame = 0
  }

  update(player) {
    if (++this.frame % 45) return
    for (const hub of this.hubs) {
      const d = Math.hypot(hub.x - player.x, hub.z - player.z)
      const have = this.placed.get(hub.key)
      if (!have && d < SPAWN_R) this.dress(hub)
      else if (have && d > DROP_R) { this.scene.remove(have.group); for (const i of have.insts) i.dispose(); this.placed.delete(hub.key) }
    }
  }

  dress(hub) {
    const rng = mulberry32(hash32(hub.key))
    const s = hub.spawn, yaw = s.yaw
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw)                              // along the road
    const rx = -fz, rz = fx                                                      // to its right
    // the people's side of the road, and how far out the sidewalk lies
    const npcs = hub.npcs ?? []
    let side = 1, off = 6
    if (npcs.length) {
      const n = npcs[0], dx = n.x - s.x, dz = n.z - s.z
      side = Math.sign(dx * rx + dz * rz) || 1
      off = Math.abs(dx * rx + dz * rz)
    }
    const group = new THREE.Group(), insts = []
    const put = (name, along, out, turn = 0, scale = 1) => {
      const x = s.x + fx * along + rx * side * out, z = s.z + fz * along + rz * side * out
      const inst = this.assets.instantiate(name)
      inst.root.position.set(x, this.heightAt(x, z), z)
      inst.root.rotation.y = Math.atan2(-(rx * side), -(rz * side)) + turn       // face the road
      inst.root.scale.setScalar(scale)
      inst.root.traverse((o) => { if (o.isMesh) o.castShadow = true })
      group.add(inst.root); insts.push(inst)
    }
    // behind each person: their trade
    npcs.forEach((n, i) => {
      const dx = n.x - s.x, dz = n.z - s.z, along = dx * fx + dz * fz
      const list = BY_ROLE[n.role] ?? ["crate"]
      list.forEach((name, k) => put(name, along + (k - (list.length - 1) / 2) * 2.4 + (rng() - 0.5), off + 3.2 + rng() * 1.2, (rng() - 0.5) * 0.6, 0.9 + rng() * 0.2))
    })
    // lanterns along the curb on both sides, a sign at the spawn, a bench and a bush or two for the empty stretches
    for (let a = -24; a <= 24; a += 12) { put("lantern", a + 6, off - 1.2); put("lantern", a, -(off - 1.2) * 1) }
    put("sign", -8, off - 0.6, 0.3)
    put("bench", 14 + rng() * 4, off + 0.8)
    put("bush", -16 - rng() * 6, off + 3.5, rng() * 6, 1.1)
    put("bush", 22, off + 4, rng() * 6, 0.9)
    if (hub.role === "town" && rng() < 0.5) put("fountain", 0, off + 9, 0, 1.1)
    this.scene.add(group)
    this.placed.set(hub.key, { group, insts })
  }
}
