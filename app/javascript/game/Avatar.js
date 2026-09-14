import { TUNING as T } from "game/Tuning"
import { Vehicle } from "game/Vehicle"
import { Mech } from "game/Mech"
import { stat } from "game/Skills"
import { TransformFx } from "game/TransformFx"

// The player: one machine with two minds. Vehicle drives it and Mech walks it, one of them in charge at a time, and
// the transformation between them. Everything that used to talk to `car` talks to this: the properties of the active
// body are forwarded, so the camera, Combat, the HUD and the network code are none the wiser. T starts the morph
// (grounded, not drifting, 2 s cooldown). `onMode(mode, body)` fires at the handover so game.js can tell the server
// (`switch`) and restyle the HUD.
//
// The transformation used to be a substitution: the car folded itself into a block, the flash covered a frame in
// which one mesh left the scene and another joined it, and the second mesh unfolded. However well dressed, the eye
// reads that as a swap, because it is one. It is now a single mesh with two poses (Vehicles.js, Morph.js). Both
// bodies share it — Vehicle's suspension writes the wheel pivots, Mech's walk writes the limb pivots, and the morph
// writes the mounts those pivots hang inside, so nobody fights anybody — and the whole beat is one number travelling
// from 0 to 1 while every panel, wheel and limb crosses between its two transforms on its own window of the clock.
// Nothing is added to the scene, nothing is removed from it, and nothing is hidden: the bonnet you were looking at
// is the chest plate you end up looking at.
//
// The timing contract is untouched. TUNING.transform.time is the length of the beat, at the end of which the machine
// is exactly in its new pose; TUNING.transform.swapAt is when control changes hands, which is the moment the physics,
// the HUD and the server switch bodies, and where the flash and the shockwave go — not to hide a substitution any
// more, but to mark the handover, which is a real event with a real discontinuity in it (a car's sprung attitude is
// not a mech's). What the player sees is continuous straight through it.
const SHAKE = 0.34             // camera shake at the handover, when an Effects is wired in
const COLOUR = { mech: 0x7fd2ff, car: 0xffb257 }   // cold arcane going in, warm combustion coming back out

export class Avatar {
  // `assets` is accepted and ignored: the mech used to wear a downloaded glTF robot and no longer does (Mech.js says
  // why). The argument stays so game.js keeps working unchanged.
  constructor({ spawn, spec, scene, assets = null, heightAt = null, waterAt = null, onMode = null, effects = null }) {
    this.scene = scene
    this.onMode = onMode
    this.effects = effects
    this.car = new Vehicle(spawn, spec)
    this.mech = new Mech(spawn, { body: this.car.mesh, heightAt, waterAt })
    this.mode = "car"
    this.active = this.car
    this.morph = null
    this.cooldown = 0
    this.fx = new TransformFx(scene)
    this.fx.build()                               // eagerly: the show must not allocate its sprites mid-transformation
    this._dt = 1 / 60
    this.dress(this.car.mesh)
    scene.add(this.car.mesh)
  }

  // Everything solid casts; the cloak asks not to, because two-sided cloth self-shadows into mud.
  dress(mesh) { mesh.traverse((o) => { if (o.isMesh && !o.isSprite && !o.userData.noShadow) o.castShadow = true }) }

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
  setNight(d) { this.car.setNight(d); this.mech.setNight(d); this.carFittings() }
  addBoost(fill, burst = 0) { this.active.addBoost(fill, burst) }
  kick(x, z) { this.active.kick(x, z) }
  jump(v) { this.active.jump(v) }
  state() {
    return { ...this.active.state(), vehicle: this.mode === "mech" ? "mech" : this.car.spec.id, shield: this.mode === "mech" && this.mech.shield, air: this.active.vy !== null }
  }

  // A new car from the picker (the mech is not in the roster: T gets you there). The mech has to be handed the new
  // body too, because the machine the player walks in is whichever machine they were driving.
  setSpec(spec) {
    const old = this.car.setSpec(spec)
    const mesh = this.car.mesh
    this.dress(mesh)
    if (old) this.scene.remove(old)
    this.scene.add(mesh)
    this.mech.useBody(mesh)
    this.pose(this.mode === "mech" ? 1 : 0)
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

  // pose the one machine: u = 0 is the vehicle, u = 1 is the mech; dir mirrors the deployment order on the way back
  pose(u, dir = u > 0.5 ? 1 : -1) { this.mesh.userData.pose?.(u, dir) }

  begin(mode) {
    const from = this.active, to = mode === "mech" ? this.mech : this.car
    this.carry(from, to)
    this.morph = { scale: Math.max(0.2, stat("transform_time")), t: 0, from, to, mode, swapped: false, colour: COLOUR[mode], dir: mode === "mech" ? 1 : -1 }
  }

  // instant, without the show: the server says which body you were in, or the picker chose a car while in the mech
  setMode(mode) {
    if (this.morph) this.finishMorph()
    if (mode === this.mode) return
    const from = this.active, to = mode === "mech" ? this.mech : this.car
    this.carry(from, to)
    this.swap(to, mode)
    this.pose(mode === "mech" ? 1 : 0, mode === "mech" ? 1 : -1)
  }

  carry(from, to) {
    to.x = from.x; to.z = from.z; to.y = from.y; to.yaw = from.yaw
    to.speed = 0; to.vx = 0; to.vz = 0
    from.speed = 0; from.vx = 0; from.vz = 0
    if ("lateral" in from) from.lateral = 0
  }

  // The handover: which body the game asks about from now on. No scene surgery — both bodies have always been the
  // same mesh — so this is bookkeeping plus the one callback game.js hangs the HUD and the network switch off.
  swap(to, mode) {
    this.mode = mode
    this.active = to
    this.carFittings()
    this.onMode?.(mode, to)
  }

  // The two fittings that used to be switched off for free by the car mesh leaving the scene, and are not any more:
  // the headlight spots, which on a machine standing on two legs would sweep across the sky, and the exhaust flames,
  // which would otherwise be left burning out of the reactor pack by anyone who transformed mid-boost. Re-asserted
  // every frame alongside the night level rather than only at the handover, so it cannot drift out of step.
  carFittings() {
    const driving = this.mode === "car"
    for (const spot of this.car.spots) spot.visible = driving && this.car.darkness > 0.02
    if (driving) return
    for (const f of this.mesh.userData.flames ?? []) { f.sprite.visible = false; if (f.core) f.core.visible = false }
  }

  stepMorph(dt) {
    const R = T.transform, m = this.morph
    m.t += dt / m.scale                      // an unlocked skill shortens the beat; every window keeps its share of it
    if (!m.swapped && m.t >= R.swapAt) {
      m.swapped = true
      const x = m.from.x, y = m.from.y, z = m.from.z
      this.swap(m.to, m.mode)
      this.fx.burst(x, y, z, m.colour)
      this.effects?.shake?.(SHAKE)
    }
    if (m.t >= R.time) this.finishMorph()
  }

  // Drive the one number, after settle() has placed the root. The clock is deliberately linear: every part already
  // leaves and arrives at rest inside its own window, so easing the clock as well would only pile the two curves on
  // top of each other and fling the panels through the middle of the beat at three times the speed they need. Linear
  // also means a window means what it says — the head really does start at seven tenths of the way through.
  morphVisual() {
    const R = T.transform, m = this.morph
    const k = Math.min(1, m.t / R.time)
    this.pose(m.dir > 0 ? k : 1 - k, m.dir)
    if (!m.swapped) this.fx.charge(m.from.x, m.from.mesh.position.y, m.from.z, Math.min(1, m.t / R.swapAt), m.colour)
  }

  finishMorph() {
    const m = this.morph
    if (!m) return
    this.fx?.clear?.()                          // an interrupted morph never reaches burst(), which would clear it
    if (!m.swapped) this.swap(m.to, m.mode)
    this.morph = null
    this.pose(m.dir > 0 ? 1 : 0, m.dir)
    this.cooldown = T.transform.cooldown * stat("transform_time")
  }
}
