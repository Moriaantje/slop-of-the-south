import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { Kit, loft, profile, panel, revolve, strut } from "game/VehicleParts"

// The wizard mech's own body, built from geometry rather than downloaded, and the wizard's kit that hangs off it.
// Two things live here. The rig is a walking biped with a hip, two thighs, two shins with feet, a chest, two arms
// and a hooded head, each on its own pivot so it can actually walk instead of sliding along bobbing; it is what the
// player sees while the CC0 glTF robot is still in flight, and what they see forever if the file never arrives, so
// it has to stand on its own. The kit is the wizard half — a cloak, a telekinetically floating staff and a mana
// core that pulses with the meter — and that goes on whichever body is present, because it is the thing that makes
// a robot read as a sorcerer rather than as a machine borrowed from another game.
//
// The palette is deliberately narrow: dark blued steel with lighter shoulder plates, gold filigree and one cold
// blue light source, so the emissive core is the only saturated thing on the model and the eye goes straight to it.
// Everything armoured shares one vertex-coloured material, which is why a rig of a hundred pieces is a dozen draws.
const H = T.mech.height          // metres: the rig is drawn to the same height as the glTF model is normalised to
const HIP_Y = 2.32               // metres: hip joint height
const KNEE_Y = 1.30              // metres: knee joint height
const SHOULDER_Y = 3.36          // metres: shoulder ball height
const HEAD_Y = H - 0.58          // metres: the neck, so the hood's crown lands on the model height
const STANCE = 0.42              // metres: half the distance between the feet
const STEP_SWING = 0.62          // rad the thigh swings at full walking speed
const STEP_KNEE = 1.05           // rad the knee folds at the top of its swing
const ARM_SWING = 0.44           // rad the arms counter-swing
const BOB = 0.085                // metres the hips drop on each footfall
const SWAY = 0.055               // rad the hips roll from side to side
const CADENCE = 0.13             // strides per second per m/s of walking speed (a 4.2 m machine strides slowly)
const IDLE_HZ = 0.45             // breathing rate when standing still
const CORE_HZ = 0.8              // mana core pulse
const CLOAK_SEG = 16, CLOAK_ROWS = 7
const STEEL = 0x424956, PLATE = 0x666f80, JOINT = 0x23272f, DARK = 0x191c22, BRASS = 0xbb9a4e

const materials = () => ({
  armour: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.82, roughness: 0.36, envMapIntensity: 1.2 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xc6a251, metalness: 1, roughness: 0.26, envMapIntensity: 1.5 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0x2b2050, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
  rune: new THREE.MeshStandardMaterial({ color: 0x0a1a2e, emissive: 0x59cfff, emissiveIntensity: 2.4, roughness: 0.35, metalness: 0 }),
})

// place a geometry: rotations about its own origin, then a translation
function at(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (rz) geo.rotateZ(rz)
  if (rx) geo.rotateX(rx)
  if (ry) geo.rotateY(ry)
  geo.translate(x, y, z)
  return geo
}

// ---- the rig -------------------------------------------------------------------------------------------------

export class MechRig {
  constructor() {
    this.root = new THREE.Group()
    this.mats = materials()
    const kit = new Kit(this.mats)
    const box = profile(1, 1, 0.3)

    // hips: a pelvic block with armoured skirt plates, the anchor both legs hang from
    this.hips = new THREE.Group(); this.hips.position.y = HIP_Y; this.root.add(this.hips)
    const hp = kit.section(this.hips)
    hp.put("armour", loft(box, [
      { z: -0.42, sx: 1.02, sy: 0.52, oy: 0.14 },
      { z: -0.10, sx: 1.26, sy: 0.66, oy: 0.16 },
      { z: 0.28, sx: 1.18, sy: 0.60, oy: 0.14 },
    ]), STEEL)
    for (const sx of [-1, 1]) {
      hp.put("armour", at(panel(0.46, 0.62, 0.34, { r: 0.1 }), sx * 0.60, -0.14, -0.04, 0, 0, sx * 0.16), PLATE)
      hp.put("armour", at(revolve([[0.001, 0], [0.20, 0.04], [0.22, 0.18], [0.16, 0.26]], 12), sx * STANCE, -0.16, 0), JOINT)
    }
    hp.put("armour", at(panel(0.9, 0.06, 0.1, { r: 0.03 }), 0, 0.34, -0.32), BRASS)

    // legs: thigh, then a shin that carries the foot, so the knee folds in the walk cycle
    this.legs = []
    for (const sx of [-1, 1]) {
      const thigh = new THREE.Group(); thigh.position.set(sx * STANCE, 0, 0); this.hips.add(thigh)
      const ts = kit.section(thigh)
      // lofts sweep along z, so a limb is drawn lying down and then stood up on its end
      ts.put("armour", at(loft(box, [
        { z: -(HIP_Y - KNEE_Y) + 0.06, sx: 0.40, sy: 0.42 },
        { z: -0.62, sx: 0.50, sy: 0.54 },
        { z: -0.18, sx: 0.52, sy: 0.56 },
        { z: 0.06, sx: 0.46, sy: 0.48 },
      ]), 0, 0, 0, -Math.PI / 2), STEEL)
      ts.put("armour", at(panel(0.40, 0.70, 0.30, { r: 0.1 }), 0, -0.52, -0.06), PLATE)
      ts.put("armour", at(panel(0.1, 0.36, 0.06, { r: 0.02 }), sx * 0.2, -0.52, -0.2), BRASS)

      const shin = new THREE.Group(); shin.position.y = -(HIP_Y - KNEE_Y); thigh.add(shin)
      const ss = kit.section(shin)
      ss.put("armour", at(revolve([[0.22, -0.16], [0.26, -0.06], [0.22, 0.02]], 12), 0, 0, 0), JOINT)         // knee
      ss.put("armour", at(panel(0.36, KNEE_Y - 0.30, 0.34, { r: 0.1 }), 0, -(KNEE_Y - 0.30) / 2 - 0.1, 0.01), STEEL)
      ss.put("armour", at(panel(0.30, 0.44, 0.22, { r: 0.08 }), 0, -0.46, -0.16), PLATE)                     // shin guard
      ss.put("armour", loft(box, [                                                                           // foot
        { z: -0.46, sx: 0.36, sy: 0.22, oy: -KNEE_Y + 0.11 },
        { z: -0.10, sx: 0.50, sy: 0.34, oy: -KNEE_Y + 0.17 },
        { z: 0.26, sx: 0.46, sy: 0.30, oy: -KNEE_Y + 0.15 },
      ]), DARK)
      ss.put("armour", at(panel(0.34, 0.05, 0.08, { r: 0.02 }), 0, -KNEE_Y + 0.26, -0.40), BRASS)
      this.legs.push({ thigh, shin, side: sx })
    }

    // torso: a chest that swells at the shoulders, a reactor housing on the back, a collar for the hood
    this.torso = new THREE.Group(); this.torso.position.y = HIP_Y + 0.30; this.root.add(this.torso)
    const tq = kit.section(this.torso)
    tq.put("armour", loft(box, [
      { z: -0.46, sx: 1.12, sy: 0.86, oy: 0.42 },
      { z: -0.16, sx: 1.50, sy: 1.02, oy: 0.52 },
      { z: 0.22, sx: 1.44, sy: 0.96, oy: 0.50 },
      { z: 0.50, sx: 1.06, sy: 0.74, oy: 0.44 },
    ]), STEEL)
    tq.put("armour", at(panel(0.86, 0.72, 0.30, { r: 0.12 }), 0, 0.62, 0.44), PLATE)                          // backpack
    tq.put("armour", at(revolve([[0.16, 0], [0.20, 0.36], [0.14, 0.46]], 10), -0.30, 0.92, 0.42), JOINT)       // vents
    tq.put("armour", at(revolve([[0.16, 0], [0.20, 0.36], [0.14, 0.46]], 10), 0.30, 0.92, 0.42), JOINT)
    tq.put("armour", at(panel(0.5, 0.08, 0.1, { r: 0.03 }), 0, 0.18, -0.5), BRASS)
    tq.put("armour", at(revolve([[0.30, 0], [0.34, 0.06], [0.30, 0.1]], 14), 0, 0.30, -0.34), BRASS)           // core bezel
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 10), this.mats.rune)
    this.core.position.set(0, HIP_Y + 0.60, -0.36); this.root.add(this.core)

    // arms: a pauldron over a shoulder ball, an upper arm and a forearm with a fist
    this.arms = []
    for (const sx of [-1, 1]) {
      const arm = new THREE.Group(); arm.position.set(sx * 0.78, SHOULDER_Y, 0); this.root.add(arm)
      const as = kit.section(arm)
      as.put("armour", at(revolve([[0.001, -0.26], [0.26, -0.2], [0.30, 0.0], [0.26, 0.18], [0.001, 0.26]], 12), 0, 0, 0), JOINT)
      as.put("armour", at(panel(0.46, 0.42, 0.62, { r: 0.16 }), sx * 0.16, 0.10, 0, 0, 0, sx * 0.25), PLATE)   // pauldron
      as.put("armour", at(panel(0.08, 0.3, 0.4, { r: 0.02 }), sx * 0.33, 0.14, 0), BRASS)
      as.put("armour", at(panel(0.30, 0.62, 0.30, { r: 0.1 }), sx * 0.05, -0.40, 0), STEEL)                    // upper arm
      as.put("armour", at(revolve([[0.17, -0.08], [0.19, 0], [0.17, 0.08]], 10), sx * 0.05, -0.74, 0), JOINT)  // elbow
      as.put("armour", at(panel(0.26, 0.56, 0.26, { r: 0.09 }), sx * 0.05, -1.06, 0.02), STEEL)                // forearm
      as.put("armour", at(panel(0.24, 0.26, 0.26, { r: 0.1 }), sx * 0.05, -1.42, 0.02), DARK)                  // fist
      this.arms.push({ arm, side: sx })
    }

    // head: a hood over a faceless visor with two lit slits, the one place the silhouette says wizard
    this.head = new THREE.Group(); this.head.position.y = HEAD_Y; this.root.add(this.head)
    const hs = kit.section(this.head)
    hs.put("armour", at(panel(0.46, 0.40, 0.44, { r: 0.14 }), 0, 0.06, 0.02), STEEL)
    hs.put("rune", at(panel(0.34, 0.09, 0.06, { r: 0.03 }), 0, 0.08, -0.22))
    hs.put("cloth", at(revolve([[0.30, -0.30], [0.44, -0.22], [0.40, 0.02], [0.24, 0.34], [0.001, 0.46]], 14), 0, 0.02, 0.06))
    hs.put("armour", at(revolve([[0.30, 0], [0.36, 0.04], [0.30, 0.08]], 14), 0, -0.26, 0.04), BRASS)          // collar ring
    kit.build()

    // shadow casting is set by Avatar, but the cloak is two-sided and would self-shadow into mud
    this.root.traverse((o) => { if (o.isMesh && o.material === this.mats.cloth) o.castShadow = false })
    this.phase = 0
  }

  // Drive the walk from distance travelled rather than from wall time, so the feet do not skate: the cadence is
  // proportional to speed, which is what makes a stride look like it is pushing the machine along.
  update(dt, t, speed, airborne) {
    const v = Math.abs(speed)
    const moving = v > 0.4 && !airborne
    this.phase += (moving ? Math.max(0.55, v * CADENCE) : IDLE_HZ) * Math.PI * 2 * dt
    const p = this.phase
    const gait = Math.min(1, 0.35 + v / T.mech.walk)
    for (const { thigh, shin, side } of this.legs) {
      const s = Math.sin(p + (side > 0 ? Math.PI : 0))
      if (airborne) { thigh.rotation.x = 0.5; shin.rotation.x = -0.9; continue }
      thigh.rotation.x = s * STEP_SWING * gait
      shin.rotation.x = -Math.max(0, -Math.sin(p + 0.7 + (side > 0 ? Math.PI : 0))) * STEP_KNEE * gait
    }
    for (const { arm, side } of this.arms) {
      const s = Math.sin(p + (side > 0 ? 0 : Math.PI))
      arm.rotation.x = airborne ? -0.55 : s * ARM_SWING * gait
      arm.rotation.z = side * (0.1 + (airborne ? 0.35 : 0.04 * Math.sin(p * 2)))
    }
    const bob = airborne ? 0 : -Math.abs(Math.cos(p)) * BOB * gait
    const breathe = moving ? 0 : Math.sin(p) * 0.025
    this.hips.position.y = HIP_Y + bob + breathe
    this.hips.rotation.z = Math.sin(p) * SWAY * gait
    this.torso.position.y = HIP_Y + 0.30 + bob * 0.6 + breathe
    this.torso.rotation.y = -Math.sin(p) * 0.09 * gait
    this.head.position.y = HEAD_Y + bob * 0.4 + breathe
    this.head.rotation.y = Math.sin(p) * 0.05 * gait
    this.core.position.y = HIP_Y + 0.60 + bob * 0.6 + breathe
  }

  // mana 0..1: the core is the meter, so a drained wizard visibly goes dark
  setMana(mana, t) {
    const pulse = 0.75 + 0.25 * Math.sin(t * Math.PI * 2 * CORE_HZ)
    this.mats.rune.emissiveIntensity = (0.25 + 2.6 * mana) * pulse
    this.core.scale.setScalar(0.92 + 0.1 * mana * pulse)
  }

  // the fold: the rig crouches, tucks its arms across the core and drops its head, which is the pose the flash
  // hides at the swap and the pose it springs out of on the way back
  fold(k) {
    for (const { thigh, shin } of this.legs) { thigh.rotation.x = 1.25 * k; shin.rotation.x = -2.1 * k }
    for (const { arm, side } of this.arms) { arm.rotation.x = -1.5 * k; arm.rotation.z = side * (0.1 + 1.0 * k) }
    this.hips.position.y = HIP_Y - 0.95 * k
    this.torso.position.y = HIP_Y + 0.30 - 1.0 * k
    this.torso.rotation.x = 0.7 * k
    this.head.position.y = HEAD_Y - 1.15 * k
    this.head.rotation.x = 0.8 * k
    this.core.position.y = HIP_Y + 0.60 - 1.0 * k
  }
}

// ---- the wizard's kit ----------------------------------------------------------------------------------------

// A cloak, a floating staff and (when the body underneath has no core of its own) a mana light. The staff is held
// by nothing on purpose: a wizard mech should be visibly cheating at physics, and it also sidesteps having to bind
// anything to the glTF skeleton's hand bone, which would break the moment the model is swapped.
const STAFF_LEN = 2.6            // metres
const STAFF_BOB = 0.12           // metres of float
const STAFF_HZ = 0.55

export class WizardKit {
  constructor({ cloak = true, core = false, scale = 1, mats = null } = {}) {
    this.root = new THREE.Group()
    this.mats = mats ?? materials()
    const kit = new Kit(this.mats)

    this.staff = new THREE.Group()
    this.staff.position.set(1.05 * scale, 2.3 * scale, -0.1 * scale)
    this.root.add(this.staff)
    const st = kit.section(this.staff)
    st.put("armour", at(revolve([[0.045, -STAFF_LEN / 2], [0.055, -STAFF_LEN / 2 + 0.2], [0.05, STAFF_LEN / 2 - 0.5], [0.07, STAFF_LEN / 2 - 0.35], [0.05, STAFF_LEN / 2 - 0.2]], 10), 0, 0, 0), DARK)
    st.put("gold", at(revolve([[0.08, 0], [0.11, 0.05], [0.11, 0.14], [0.08, 0.19]], 12), 0, STAFF_LEN / 2 - 0.34, 0))
    st.put("gold", at(revolve([[0.06, 0], [0.09, 0.04], [0.09, 0.1], [0.06, 0.14]], 12), 0, -STAFF_LEN / 2 + 0.18, 0))
    for (let i = 0; i < 3; i++) {                                                      // the claw that holds the stone
      const a = (i / 3) * Math.PI * 2
      st.put("gold", at(strut(0, STAFF_LEN / 2 - 0.14, 0, Math.cos(a) * 0.13, STAFF_LEN / 2 + 0.12, Math.sin(a) * 0.13, 0.022, 5), 0, 0, 0))
    }
    this.crystal = new THREE.Mesh(at(revolve([[0.001, -0.22], [0.13, -0.04], [0.11, 0.1], [0.001, 0.3]], 8), 0, STAFF_LEN / 2 + 0.14, 0), this.mats.rune)
    this.staff.add(this.crystal)

    // the cloak: a wrapped sheet with a rippled hem, hung off the collar and swung by the walk
    this.cloak = null
    if (cloak) {
      this.cloak = new THREE.Group()
      this.cloak.position.set(0, 3.30 * scale, 0.18 * scale)
      this.root.add(this.cloak)
      this.cloak.add(new THREE.Mesh(cloakGeometry(), this.mats.cloth))
      this.cloak.children[0].castShadow = false
    }

    this.core = null
    if (core) {
      this.core = new THREE.Mesh(new THREE.SphereGeometry(0.3 * scale, 14, 10), this.mats.rune)
      this.core.position.set(0, 2.55 * scale, -0.62 * scale)
      this.root.add(this.core)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.46 * scale, 0.035 * scale, 6, 20), this.mats.gold)
      this.core.add(ring)
      this.ring = ring
    }
    kit.build()
    this.t = 0
  }

  update(dt, t, speed, mana, airborne) {
    this.t = t
    const pulse = 0.75 + 0.25 * Math.sin(t * Math.PI * 2 * CORE_HZ)
    this.mats.rune.emissiveIntensity = (0.3 + 2.8 * mana) * pulse
    this.staff.position.y += (2.3 + Math.sin(t * Math.PI * 2 * STAFF_HZ) * STAFF_BOB - this.staff.position.y) * Math.min(1, dt * 6)
    this.staff.rotation.y = t * 0.5
    this.staff.rotation.z = -0.18 + Math.sin(t * 1.3) * 0.06
    this.crystal.rotation.y = -t * 1.6
    if (this.ring) { this.ring.rotation.x = t * 1.1; this.ring.rotation.y = t * 0.7 }
    if (this.core) this.core.scale.setScalar(0.9 + 0.12 * mana * pulse)
    if (this.cloak) {
      const sway = Math.min(1, Math.abs(speed) / T.mech.walk)
      this.cloak.rotation.x = -0.05 - 0.25 * sway + (airborne ? 0.3 : 0) + Math.sin(t * 2.1) * 0.03
      this.cloak.rotation.z = Math.sin(t * 1.7) * 0.04 * (1 - sway)
    }
  }

  fold(k) {
    this.staff.position.set(1.05 * (1 - 0.8 * k), 2.3 - 0.9 * k, -0.1)
    this.staff.rotation.z = -0.18 - 1.2 * k
    if (this.cloak) { this.cloak.scale.setScalar(1 - 0.55 * k); this.cloak.position.y = 3.30 - 1.1 * k }
    if (this.core) this.core.position.set(0, 2.55 - 0.8 * k, -0.62 + 0.3 * k)
  }
}

// A cloak is a cone segment wrapped round the back with a hem that is not a circle: the radius wobbles round the
// sweep and the bottom row drops unevenly, which is all it takes for a swept surface to read as heavy cloth.
function cloakGeometry() {
  const g = new THREE.CylinderGeometry(0.62, 1.25, 2.5, CLOAK_SEG, CLOAK_ROWS, true, -2.1, 4.2)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const a = Math.atan2(x, z), down = (1.25 - y) / 2.5                       // 0 at the collar, 1 at the hem
    const r = 1 + 0.14 * Math.sin(a * 5) * down + 0.05 * Math.sin(a * 11)
    pos.setXYZ(i, x * r, y - 0.22 * down * down * (0.5 + 0.5 * Math.sin(a * 5 + 1.2)), z * r + 0.18 * down * down)
  }
  g.computeVertexNormals()
  return g
}
