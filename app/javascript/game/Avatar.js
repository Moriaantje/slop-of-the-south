import { TUNING as T, smoothstep } from "game/Tuning"
import { Vehicle } from "game/Vehicle"
import { Mech } from "game/Mech"
import { TransformFx } from "game/TransformFx"

// The player: a car (Vehicle) and a wizard mech (Mech), one of them active, with the transformation between them.
// Everything that used to talk to `car` talks to this: the properties of the active body are forwarded, so the
// camera, Combat, the HUD and the network code are none the wiser. T starts the morph (grounded, not drifting,
// 2 s cooldown). `onMode(mode, body)` fires at the swap so game.js can tell the server (`switch`) and restyle the HUD.
//
// The transformation used to spin the old body a full turn while squashing it flat and then spin the new one back,
// which read as a cheap sprite trick rather than as a machine changing shape. It is now a fold. Each body owns a
// `userData.fold(k)` that poses it between driving (k = 0) and a compact block (k = 1) — the car tucks its wheels
// inboard and up under its arches, narrows, squeezes along its length and rears onto its tail; the mech crouches,
// draws its legs under itself, folds its arms across the core and pulls the cloak in. The first half of the beat
// runs that fold in on a smoothstep while a glow gathers; at the swap the bodies are exchanged inside a flash, a
// ground shockwave and a column of light, which is what hides the exchange; the second half runs the new body's
// fold out on a damped spring whose tail crosses zero, so the machine over-extends a little and settles back rather
// than arriving at its pose and stopping dead. The timing contract is untouched: TUNING.transform.swapAt is when
// the bodies swap, TUNING.transform.time is when the whole thing is over and both scales are exactly one again.
const UNFOLD_DAMP = 4.2        // /unit: how fast the unfold spring loses its energy
const UNFOLD_FREQ = 4.6        // rad over the unfold: crosses zero around two thirds through, then rings once
const SHAKE = 0.34             // camera shake at the swap, when an Effects is wired in
const COLOUR = { mech: 0x7fd2ff, car: 0xffb257 }   // cold arcane going in, warm combustion coming back out

export class Avatar {
  constructor({ spawn, spec, scene, assets = null, heightAt = null, waterAt = null, onMode = null, effects = null }) {
    this.scene = scene
    this.onMode = onMode
    this.effects = effects
    this.car = new Vehicle(spawn, spec)
    this.mech = new Mech(spawn, { assets, heightAt, waterAt })
    this.mode = "car"
    this.active = this.car
    this.morph = null
    this.cooldown = 0
    this.fx = new TransformFx(scene)
    this._dt = 1 / 60
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
    this._dt = dt
    this.cooldown = Math.max(0, this.cooldown - dt)
    if (this.morph) return this.stepMorph(dt)
    if (input.transform && this.active.vy === null && this.cooldown <= 0 && !this.car.drifting) { input.clearPressed?.(); this.begin(this.mode === "car" ? "mech" : "car"); return }
    this.active.integrate(dt, input)
  }

  settle(heightAt) {
    this.active.settle(heightAt)
    if (this.morph) this.morphVisual()
    this.fx.update(this._dt)
  }

  begin(mode) {
    const from = this.active, to = mode === "mech" ? this.mech : this.car
    this.carry(from, to)
    this.morph = { t: 0, from, to, mode, swapped: false, colour: COLOUR[mode] }
  }

  // instant, without the show: the server says which body you were in, or the picker chose a car while in the mech
  setMode(mode) {
    if (this.morph) this.finishMorph()
    if (mode === this.mode) return
    const from = this.active, to = mode === "mech" ? this.mech : this.car
    this.carry(from, to)
    this.swap(to, mode)
    from.mesh.userData.fold?.(0)
    to.mesh.userData.fold?.(0)
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
    if (!m.swapped && m.t >= R.swapAt) {
      m.swapped = true
      const x = m.from.x, y = m.from.y, z = m.from.z
      this.swap(m.to, m.mode)
      this.fx.burst(x, y, z, m.colour)
      this.effects?.shake?.(SHAKE)
    }
    if (m.t >= R.time) this.finishMorph()
  }

  // fold the old body in, then let the new one spring out and settle (after settle, which places the meshes)
  morphVisual() {
    const R = T.transform, m = this.morph
    if (!m.swapped) {
      const k = smoothstep(0, 1, Math.min(1, m.t / R.swapAt))
      m.from.mesh.userData.fold?.(k)
      this.fx.charge(m.from.x, m.from.mesh.position.y, m.from.z, k, m.colour)
    } else {
      const u = Math.min(1, (m.t - R.swapAt) / (R.time - R.swapAt))
      m.to.mesh.userData.fold?.(Math.exp(-UNFOLD_DAMP * u) * Math.cos(UNFOLD_FREQ * u))
    }
  }

  finishMorph() {
    const m = this.morph
    if (!m) return
    this.fx?.clear?.()                          // an interrupted fold never reaches burst(), which would clear it
    if (!m.swapped) this.swap(m.to, m.mode)
    m.to.mesh.scale.set(1, 1, 1); m.from.mesh.scale.set(1, 1, 1)
    m.to.mesh.userData.fold?.(0); m.from.mesh.userData.fold?.(0)
    this.morph = null
    this.cooldown = T.transform.cooldown
  }
}
