import { TUNING as T } from "game/Tuning"
import { Vehicle } from "game/Vehicle"
import { Mech } from "game/Mech"

// The player: a car (Vehicle) and a wizard mech (Mech), one of them active, with the transformation between them.
// Everything that used to talk to `car` talks to this: the properties of the active body are forwarded, so the
// camera, Combat, the HUD and the network code are none the wiser. T starts the morph (grounded, not drifting,
// 2 s cooldown): the old body squashes and spins for half a second, a puff, and the new one unfolds in its place.
// `onMode(mode, body)` fires at the swap so game.js can tell the server (`switch`) and restyle the HUD.
export class Avatar {
  constructor({ spawn, spec, scene, assets = null, heightAt = null, waterAt = null, onMode = null }) {
    this.scene = scene
    this.onMode = onMode
    this.car = new Vehicle(spawn, spec)
    this.mech = new Mech(spawn, { assets, heightAt, waterAt })
    this.mode = "car"
    this.active = this.car
    this.morph = null
    this.cooldown = 0
    for (const m of [this.car.mesh, this.mech.mesh]) m.traverse((o) => { if (o.isMesh && !o.isSprite) o.castShadow = true })
    scene.add(this.car.mesh)
  }

  // ---- the Vehicle contract, forwarded --------------------------------------------------------------------------
  get x() { return this.active.x } set x(v) { this.active.x = v }
  get y() { return this.active.y } set y(v) { this.active.y = v }
  get z() { return this.active.z } set z(v) { this.active.z = v }
  get yaw() { return this.active.yaw } set yaw(v) { this.active.yaw = v }
  get speed() { return this.active.speed } set speed(v) { this.active.speed = v }
  get vx() { return this.active.vx } get vz() { return this.active.vz } get vy() { return this.active.vy }
  get spec() { return this.active.spec }
  get mesh() { return this.active.mesh }
  get maxSpeed() { return this.active.maxSpeed }
  get boostPower() { return this.active.boostPower }
  get boostMeter() { return this.active.boostMeter } set boostMeter(v) { this.active.boostMeter = v }
  get drifting() { return this.active.drifting } get driftMild() { return this.active.driftMild } get chargeLevel() { return this.active.chargeLevel }
  get landed() { return this.active.landed } set landed(v) { this.active.landed = v }
  get smoking() { return this.active.smoking } get braking() { return this.active.braking }
  get transforming() { return !!this.morph }
  forward() { return this.active.forward() }
  reset(spawn) { this.car.reset(spawn); this.mech.reset(spawn); if (this.morph) this.finishMorph() }
  setNight(d) { this.car.setNight(d); this.mech.setNight(d) }
  addBoost(fill, burst = 0) { this.active.addBoost(fill, burst) }
  kick(x, z) { this.active.kick(x, z) }
  jump(v) { this.active.jump(v) }
  state() {
    return { ...this.active.state(), vehicle: this.mode === "mech" ? "mech" : this.car.spec.id, shield: this.mode === "mech" && this.mech.shield, air: this.active.vy !== null }
  }

  // a new car from the picker (the mech is not in the roster: T gets you there)
  setSpec(spec) {
    const old = this.car.setSpec(spec)
    this.car.mesh.traverse((o) => { if (o.isMesh && !o.isSprite) o.castShadow = true })
    if (this.mode === "car") { this.scene.remove(old); this.scene.add(this.car.mesh) }
    return old
  }

  // ---- transformation -------------------------------------------------------------------------------------------
  integrate(dt, input) {
    this.cooldown = Math.max(0, this.cooldown - dt)
    if (this.morph) return this.stepMorph(dt)
    if (input.transform && this.active.vy === null && this.cooldown <= 0 && !this.car.drifting) { input.clearPressed?.(); this.begin(this.mode === "car" ? "mech" : "car"); return }
    this.active.integrate(dt, input)
  }

  settle(heightAt) {
    this.active.settle(heightAt)
    if (this.morph) this.morphVisual()
  }

  begin(mode) {
    const from = this.active, to = mode === "mech" ? this.mech : this.car
    this.carry(from, to)
    this.morph = { t: 0, from, to, mode, swapped: false }
  }

  // instant, without the show: the server says which body you were in, or the picker chose a car while in the mech
  setMode(mode) {
    if (this.morph) this.finishMorph()
    if (mode === this.mode) return
    const from = this.active, to = mode === "mech" ? this.mech : this.car
    this.carry(from, to)
    this.swap(to, mode)
  }

  carry(from, to) {
    to.x = from.x; to.z = from.z; to.y = from.y; to.yaw = from.yaw
    to.speed = 0; to.vx = 0; to.vz = 0
    from.speed = 0; from.vx = 0; from.vz = 0
    if ("lateral" in from) from.lateral = 0
    to.mesh.position.copy(from.mesh.position); to.mesh.rotation.set(0, from.yaw, 0)
  }

  swap(to, mode) {
    this.scene.remove(this.active.mesh)
    this.active.mesh.scale.set(1, 1, 1)
    this.scene.add(to.mesh)
    this.mode = mode; this.active = to
    this.onMode?.(mode, to)
  }

  stepMorph(dt) {
    const R = T.transform, m = this.morph
    m.t += dt
    if (!m.swapped && m.t >= R.swapAt) { m.swapped = true; this.swap(m.to, m.mode) }
    if (m.t >= R.time) this.finishMorph()
  }

  // squash and spin the old body, then unfold the new one (after settle, which places the meshes)
  morphVisual() {
    const R = T.transform, m = this.morph
    if (!m.swapped) {
      const k = Math.min(1, m.t / R.swapAt)
      m.from.mesh.scale.set(1 + 0.3 * k, 1 - 0.8 * k, 1 + 0.3 * k)
      m.from.mesh.rotation.y = m.from.yaw + k * Math.PI * 2
    } else {
      const k = Math.min(1, (m.t - R.swapAt) / (R.time - R.swapAt)), s = 0.2 + 0.8 * k
      m.to.mesh.scale.set(s, s, s)
      m.to.mesh.rotation.y = m.to.yaw + (1 - k) * Math.PI * 2
    }
  }

  finishMorph() {
    const m = this.morph
    if (!m) return
    if (!m.swapped) this.swap(m.to, m.mode)
    m.to.mesh.scale.set(1, 1, 1); m.from.mesh.scale.set(1, 1, 1)
    this.morph = null
    this.cooldown = T.transform.cooldown
  }
}
