import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { Kit, loft, profile, panel, revolve, strut } from "game/VehicleParts"

// The wizard mech's skeleton and the wizard's wardrobe. Both are built out of the same coachbuilding kit the cars
// are, and — this is the part that matters — both are built straight into the *vehicle's* kit, as pieces of the one
// mesh that is a car at one end of the transformation and a mech at the other. Nothing here is ever added to or
// removed from the scene; in the driving pose these parts are folded down to a few centimetres inside the bodywork
// and switched off, and the transformation is them growing out of it while the car's own panels climb into place
// around them.
//
// The division of labour with Vehicles.js is deliberate. The car's panels supply everything the eye reads as mass:
// the bonnet becomes the chest plate, the roof becomes the hood, the flanks become the pauldrons, the wheels become
// the hips and the knees. What is left for the rig is the frame those panels bolt onto — a pelvis, two telescoping
// legs, two arms, a slim spine and a visored head — plus the one thing a car has no part for, the wizard's kit. So
// the rig is drawn narrow and skeletal on purpose: it is what shows *between* the armour, and a second full torso
// underneath the bonnet would only fight it.
//
// Every articulated piece is a pivot inside a mount. The mount belongs to the morph and nothing else writes to it;
// the pivot belongs to the walk cycle and the morph never touches it. The two animations therefore compose without
// either knowing about the other, which is why the mech can walk while it is still unfolding.
//
// The palette is narrow: dark blued steel with lighter plates, brass filigree and one cold blue light, so the mana
// core is the only saturated thing on the machine and the eye goes straight to it.
const H = T.mech.height          // metres: the machine's standing height, the same figure the camera and Combat use
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
export const LIMB_STOW = new THREE.Vector3(0.55, 0.16, 0.55)   // scale of a limb collapsed into its own joint while driving
export const STEEL = 0x424956, PLATE = 0x666f80, JOINT = 0x23272f, DARK = 0x191c22, BRASS = 0xbb9a4e

// The mech's half of the material set. Vehicles.js merges this with the car's own materials into one Kit, so a
// machine that is both still costs one draw call per material per moving piece.
export const mechMaterials = () => ({
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

// a pivot the walk cycle drives, wrapped in a mount the morph drives
function joint(parent, x = 0, y = 0, z = 0) {
  const mount = new THREE.Group(), pivot = new THREE.Group()
  pivot.position.set(x, y, z)
  mount.add(pivot)
  parent.add(mount)
  return { mount, pivot }
}

// ---- the rig -------------------------------------------------------------------------------------------------

export class MechRig {
  // `kit` and `mats` come from the vehicle when the rig is one half of a transforming machine; on its own it builds
  // and flushes its own, which is what keeps it testable and usable anywhere a plain standing mech is wanted.
  constructor({ kit = null, mats = null } = {}) {
    this.root = new THREE.Group()
    this.mats = mats ?? mechMaterials()
    const own = !kit
    kit = kit ?? new Kit(this.mats)
    const box = profile(1, 1, 0.3)
    this.mounts = {}

    // hips: a pelvic block with armoured skirt plates, the anchor both legs hang from
    const hip = joint(this.root, 0, HIP_Y, 0)
    this.mounts.hips = hip.mount; this.hips = hip.pivot
    const hp = kit.section(this.hips)
    hp.put("armour", loft(box, [
      { z: -0.40, sx: 0.86, sy: 0.46, oy: 0.12 },
      { z: -0.08, sx: 1.06, sy: 0.58, oy: 0.14 },
      { z: 0.26, sx: 0.98, sy: 0.52, oy: 0.12 },
    ]), STEEL)
    for (const sx of [-1, 1]) {
      hp.put("armour", at(panel(0.34, 0.54, 0.30, { r: 0.1 }), sx * 0.54, -0.16, -0.04, 0, 0, sx * 0.16), PLATE)
      hp.put("armour", at(revolve([[0.001, 0], [0.20, 0.04], [0.22, 0.18], [0.16, 0.26]], 12), sx * STANCE, -0.16, 0), JOINT)
    }
    hp.put("armour", at(panel(0.8, 0.06, 0.1, { r: 0.03 }), 0, 0.30, -0.28), BRASS)

    // legs: thigh, then a shin that carries the foot, so the knee folds in the walk cycle. The thigh's mount is
    // what telescopes: collapsing it towards the hip joint stows the whole leg inside the chassis.
    this.legs = []
    for (const sx of [-1, 1]) {
      const leg = joint(this.hips, sx * STANCE, 0, 0)
      const thigh = leg.pivot
      this.mounts[sx < 0 ? "legL" : "legR"] = leg.mount
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

    // torso: a slim spine and a collar rather than a chest, because the car's bonnet is the chest plate
    const tor = joint(this.root, 0, HIP_Y + 0.30, 0)
    this.mounts.torso = tor.mount; this.torso = tor.pivot
    const tq = kit.section(this.torso)
    tq.put("armour", loft(box, [
      { z: -0.34, sx: 0.70, sy: 0.64, oy: 0.42 },
      { z: -0.10, sx: 0.86, sy: 0.78, oy: 0.50 },
      { z: 0.20, sx: 0.82, sy: 0.74, oy: 0.48 },
      { z: 0.42, sx: 0.62, sy: 0.56, oy: 0.42 },
    ]), STEEL)
    tq.put("armour", at(revolve([[0.13, 0], [0.17, 0.30], [0.12, 0.40]], 10), -0.26, 0.86, 0.34), JOINT)      // vents
    tq.put("armour", at(revolve([[0.13, 0], [0.17, 0.30], [0.12, 0.40]], 10), 0.26, 0.86, 0.34), JOINT)
    for (const sx of [-1, 1]) tq.put("armour", at(strut(sx * 0.30, 0.86, 0, sx * 0.74, 1.02, 0, 0.09, 8), 0, 0, 0), PLATE)   // clavicles
    tq.put("armour", at(revolve([[0.26, 0], [0.30, 0.06], [0.26, 0.1]], 14), 0, 0.28, -0.30), BRASS)          // core bezel

    // the mana core: the meter made visible, and the only saturated colour on the machine
    const cor = joint(this.root, 0, HIP_Y + 0.60, -0.36)
    this.mounts.core = cor.mount; this.core = cor.pivot
    const cs = kit.section(this.core)
    cs.put("rune", new THREE.SphereGeometry(0.26, 14, 10))
    cs.put("gold", at(new THREE.TorusGeometry(0.40, 0.03, 6, 20), 0, 0, 0, Math.PI / 2))

    // arms: a pauldron over a shoulder ball, an upper arm and a forearm with a fist
    this.arms = []
    for (const sx of [-1, 1]) {
      const a = joint(this.root, sx * 0.78, SHOULDER_Y, 0)
      const arm = a.pivot
      this.mounts[sx < 0 ? "armL" : "armR"] = a.mount
      const as = kit.section(arm)
      as.put("armour", at(revolve([[0.001, -0.26], [0.26, -0.2], [0.30, 0.0], [0.26, 0.18], [0.001, 0.26]], 12), 0, 0, 0), JOINT)
      as.put("armour", at(panel(0.08, 0.3, 0.4, { r: 0.02 }), sx * 0.27, 0.10, 0), BRASS)
      as.put("armour", at(panel(0.30, 0.62, 0.30, { r: 0.1 }), sx * 0.05, -0.40, 0), STEEL)                    // upper arm
      as.put("armour", at(revolve([[0.17, -0.08], [0.19, 0], [0.17, 0.08]], 10), sx * 0.05, -0.74, 0), JOINT)  // elbow
      as.put("armour", at(panel(0.26, 0.56, 0.26, { r: 0.09 }), sx * 0.05, -1.06, 0.02), STEEL)                // forearm
      as.put("armour", at(panel(0.24, 0.26, 0.26, { r: 0.1 }), sx * 0.05, -1.42, 0.02), DARK)                  // fist
      this.arms.push({ arm, side: sx })
    }

    // head: a faceless visor with two lit slits under a collar, the hood itself being the car's roof panel
    const hd = joint(this.root, 0, HEAD_Y, 0)
    this.mounts.head = hd.mount; this.head = hd.pivot
    const hs = kit.section(this.head)
    hs.put("armour", at(panel(0.42, 0.38, 0.42, { r: 0.14 }), 0, 0.04, 0.02), STEEL)
    hs.put("rune", at(panel(0.32, 0.09, 0.06, { r: 0.03 }), 0, 0.06, -0.21))
    hs.put("armour", at(revolve([[0.28, 0], [0.34, 0.04], [0.28, 0.08]], 14), 0, -0.26, 0.04), BRASS)          // collar ring
    if (own) kit.build()
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
}

// ---- the wizard's kit ----------------------------------------------------------------------------------------

// A cloak and a telekinetically floating staff, and a mana light for a body that has none of its own. The staff is
// held by nothing on purpose: a wizard mech should be visibly cheating at physics. Like the rig, every piece is a
// pivot inside a mount, so the morph can stow the lot inside a car boot while the float and the swing carry on.
const STAFF_LEN = 2.6            // metres
const STAFF_BOB = 0.12           // metres of float
const STAFF_HZ = 0.55

export class WizardKit {
  constructor({ cloak = true, core = false, scale = 1, mats = null, kit = null } = {}) {
    this.root = new THREE.Group()
    this.mats = mats ?? mechMaterials()
    const own = !kit
    kit = kit ?? new Kit(this.mats)
    this.mounts = {}

    const stf = joint(this.root, 1.05 * scale, 2.3 * scale, -0.1 * scale)
    this.mounts.staff = stf.mount; this.staff = stf.pivot
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
      const clk = joint(this.root, 0, 3.30 * scale, 0.18 * scale)
      this.mounts.cloak = clk.mount; this.cloak = clk.pivot
      const sheet = new THREE.Mesh(cloakGeometry(), this.mats.cloth)
      sheet.castShadow = false                              // two-sided cloth self-shadows into mud
      sheet.userData.noShadow = true
      this.cloak.add(sheet)
    }

    this.core = null
    if (core) {
      const cor = joint(this.root, 0, 2.55 * scale, -0.62 * scale)
      this.mounts.core = cor.mount; this.core = cor.pivot
      const cs = kit.section(this.core)
      cs.put("rune", new THREE.SphereGeometry(0.3 * scale, 14, 10))
      cs.put("gold", at(new THREE.TorusGeometry(0.46 * scale, 0.035 * scale, 6, 20), 0, 0, 0, Math.PI / 2))
    }
    if (own) kit.build()
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
    if (this.core) { this.core.scale.setScalar(0.9 + 0.12 * mana * pulse); this.core.rotation.set(t * 0.4, t * 0.7, 0) }
    if (this.cloak) {
      const sway = Math.min(1, Math.abs(speed) / T.mech.walk)
      this.cloak.rotation.x = -0.05 - 0.25 * sway + (airborne ? 0.3 : 0) + Math.sin(t * 2.1) * 0.03
      this.cloak.rotation.z = Math.sin(t * 1.7) * 0.04 * (1 - sway)
    }
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
