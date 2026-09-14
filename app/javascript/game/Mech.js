import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { Locomotion } from "game/Locomotion"
import { stat } from "game/Skills"
import { ShieldBubble } from "game/ShieldBubble"

// The wizard mech: the same contract as Vehicle (x, y, z, yaw, speed, vx, vz, spec, mesh, integrate, settle, state,
// reset, setNight, addBoost, kick, jump, boostMeter) so the camera, Combat, the HUD and the network treat it like
// any ride, but it walks: turns in place, climbs anything up to 37°, steps up curbs, jumps (Space) and hovers
// (hold Space after the apex, burning mana), raises a shield (Shift, burning mana, slower). Mana is the boost meter,
// so the road pads refill it and the HUD bar is the same bar in blue. Spells live in Spells.js. Water it wades
// through slowly; deeper than the knee for three seconds and it is "verzopen" (game.js resets it to the hub).
//
// What it no longer owns is a body. The machine standing here is the very same mesh the car was — Vehicles.js builds
// every vehicle as one part set with a driving pose and a walking pose, and this class simply borrows it through
// `useBody` and drives the walking half of it. That is what makes the transformation a transformation rather than a
// substitution: there is nothing to add to the scene and nothing to take out of it, because the wheels that were
// under the car are the knees under the wizard. The frame and the wardrobe it animates (MechRig, WizardKit) are
// pieces of that same mesh, so the walk cycle and the cloak keep running while the machine is still unfolding.
//
// The downloaded glTF robot the mech used to wear is gone with it. A rigged model from a model library cannot be the
// other half of a car — its bones are its own — and keeping it would have meant the transformation was honest for
// half a second and then cross-faded into an import. The generated wizard rig is also simply the better fit for the
// brief: a hooded machine with a cloak, a floating staff and a mana core rather than somebody else's robot.
export const MECH_SPEC = {
  id: "mech", naam: "Tovenaarsmech", blurb: "Loopt overal, springt en zweeft, gooit vuurballen en bliksem. Mana is de boostmeter.",
  length: 2.6, track: 2.2, ram: 0.6, clear: 4, push: true, pushMin: 0.5, pushKinds: ["t", "l", "g", "s"],   // tramples trees and posts, bounces off houses
  cam: { dist: 1.35, height: 1.7, look: 2.2 },
  ability: { kind: "none", cooldown: 0, hint: "Q vuurbal · F bliksem · shift schild · spatie spring/zweef · T terug in de auto" },
}
const BUBBLE_R = 3.2             // metres: the shield sphere's radius
const CROUCH_DROP = 0.9          // metres the body sinks at full leg compression: the jump windup and the landing squat
const NIGHT_GLOW = 1.6           // extra mana-core emissive in the dark, where the mech is the only light source

export class Mech {
  constructor(spawn, { body = null, heightAt = null, waterAt = null } = {}) {
    this.spec = MECH_SPEC
    this.heightAt = heightAt
    this.waterAt = waterAt
    this.maxSpeed = T.mech.walk
    this.rig = null
    this.wizard = null
    this.bubble = null
    this.mesh = null
    this.mana = 0.5                                 // survives resets, like the car's meter
    this.darkness = 0
    this.boostPower = 0; this.drifting = false; this.driftMild = false; this.chargeLevel = 0; this.braking = false; this.smoking = false
    this.t = 0
    // the walking model itself lives in Locomotion: momentum, the feet, the kerb, the jump and the landing
    this.loco = new Locomotion({ heightAt })
    this.useBody(body ?? emptyBody())
    this.reset(spawn)
  }

  // Take over a vehicle mesh as this machine's body. Called once at construction and again whenever the picker
  // swaps the car underneath, because the mech the player walks in is whichever machine they drove in.
  useBody(root) {
    if (this.mesh === root) return
    this.bubble?.dispose()
    this.mesh = root
    const mech = root.userData.mech ?? null
    this.rig = mech?.rig ?? null
    this.wizard = mech?.wizard ?? null
    this.bubble = new ShieldBubble(root, BUBBLE_R, T.mech.height * 0.55)
    this.bubble.mesh.userData.noShadow = true       // a sphere round the machine would cast a sphere-shaped shadow
  }

  get boostMeter() { return this.mana }
  set boostMeter(v) { this.mana = v }

  reset(spawn) {
    this.x = spawn.x; this.z = spawn.z; this.y = 0; this.yaw = spawn.yaw
    this.speed = 0; this.vx = 0; this.vz = 0
    this.vy = null; this.airY = 0; this.landed = false; this.hovering = false
    this.shield = false; this.blocked = false
    this.kickX = 0; this.kickZ = 0
    this.wading = false; this.drownT = 0; this.drowned = false
    this._dt = 1 / 60
    this.jumpsLeft = stat("jumps")
    this.loco?.reset()
  }

  // A second jump is an unlocked ability, so the count comes from the player's own stats and is spent here; the
  // launch itself goes through Locomotion so an explosion's shove gets the same push-off a deliberate jump does.
  jump(v) {
    if (this.jumpsLeft <= 0) return
    this.jumpsLeft--
    if (this.vy === null) this.loco.launch(this, v)
    else { this.vy = v * 0.85; this.hovering = false }
  }
  kick(x, z) { this.kickX += x; this.kickZ += z }
  forward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) } }
  addBoost(fill) { this.mana = Math.min(1, this.mana + fill) }
  setNight(darkness) { this.darkness = darkness }

  // input: throttle, brake, steer (held), jump (tap), hover, shield (held)
  // input: throttle, brake, steer (held), jump (tap), hover, shield (held). Everything that is movement belongs to
  // Locomotion; what stays here is the wizard's half — the mana, the shield and the knockback. Every stat read is
  // 1.0 until a skill point is spent, so an unspent player walks exactly as before.
  integrate(dt, input) {
    const M = T.mech
    this._dt = dt; this.t += dt
    let drain = 0
    this.shield = !!input.shield && this.mana > 0
    if (this.shield) drain += M.shieldDrain * stat("shield_drain") / stat("mana_max")
    const speedScale = (this.shield ? M.shieldSlow : 1) * (this.wading ? 0.5 : 1) * stat("walk_speed")
    this.maxSpeed = M.walk * stat("walk_speed")
    this.loco.integrate(dt, this, {
      throttle: input.throttle, brake: input.brake, steer: input.steer,
      jump: input.jump && !this.drowned, hover: input.hover, canHover: this.mana > 0,
      speedScale, kickX: this.kickX, kickZ: this.kickZ,
    })
    this.blocked = this.loco.blocked
    this.hovering = this.loco.hovering
    if (this.hovering) drain += M.hoverDrain * stat("hover_drain") / stat("mana_max")
    const fade = Math.exp(-dt * 2.3); this.kickX *= fade; this.kickZ *= fade
    if (drain > 0) this.mana = Math.max(0, this.mana - drain * dt)
    else this.mana = Math.min(1, this.mana + dt / (M.manaRegen * stat("mana_regen")))
  }

  // Ground contact: y is the surface under the mech (like car.y) and the mesh floats above it in the air. The water
  // is ours; the ground, the ledge, the landing and the attitude are Locomotion's, which hands back the height the
  // machine should actually be drawn at.
  settle(heightAt) {
    const M = T.mech, dt = this._dt
    const ground = heightAt(this.x, this.z)
    const level = this.waterAt?.(this.x, this.z)
    const depth = typeof level === "number" ? level - ground : 0
    this.wading = depth > 0.3 && this.vy === null
    if (depth > M.drownDepth && this.vy === null) { this.drownT += dt; if (this.drownT > M.drownTime) this.drowned = true }
    else this.drownT = Math.max(0, this.drownT - dt)
    const wasAir = this.vy !== null
    const y = this.loco.settle(dt, this, heightAt)
    if (wasAir && this.vy === null) this.jumpsLeft = stat("jumps")        // landed: the jumps come back
    this.place(y)
  }

  // The body leans into its own acceleration and banks across the slope it stands on, and the legs take the jump
  // windup and the landing out of the machine's height — which is why the crouch drops the whole root rather than
  // scaling it: this.y stays the surface Combat and the shadow read, and only what is drawn moves.
  place(y) {
    const L = this.loco
    this.mesh.position.set(this.x, y - L.compress * CROUCH_DROP, this.z)
    this.mesh.rotation.set(L.lean, this.yaw, L.bank, "YXZ")
    this.bubble.update(this.shield, this._dt, this.t)
    this.animate()
  }

  // The frame's own gait and the wizard's kit. Every channel written here is a pivot inside a morph mount, so this
  // runs unchanged whether the machine is fully stood up or still halfway out of a car. The mana core brightens in
  // the dark: at night the mech is often the only light in the street and its own glow is what keeps it readable.
  animate() {
    if (!this.rig) return
    this.rig.update(this._dt, this.t, this.speed, this.vy !== null)
    this.rig.setMana(this.mana, this.t)
    this.wizard?.update(this._dt, this.t, this.speed, this.mana, this.vy !== null)
    this.rig.mats.rune.emissiveIntensity *= 1 + NIGHT_GLOW * this.darkness
  }

  state() {
    return { x: this.x, y: this.mesh.position.y, z: this.z, yaw: this.yaw, speed: this.speed, brake: false, drift: false, boost: false,
             vehicle: "mech", shield: this.shield, air: this.vy !== null }
  }
}

// A mech without a vehicle to borrow: an empty root that still answers the contract the rest of the game reads off a
// vehicle mesh. Nothing in the game builds one — Avatar always hands over the car — but it keeps the class usable and
// testable on its own instead of requiring a whole coachbuilt vehicle to exist first.
function emptyBody() {
  const g = new THREE.Group()
  g.userData = { wheels: [], flames: [], lights: null }
  return g
}
