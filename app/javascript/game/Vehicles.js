import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { softTexture } from "game/Effects"
import { Kit, loft, profile, panel, revolve, strut, arch, tyreGeometry, rimGeometry, vehicleMaterials } from "game/VehicleParts"
import { MorphRig, fitTo } from "game/Morph"
import { MechRig, WizardKit, mechMaterials, LIMB_STOW } from "game/MechRig"

// The six vehicles, fast to slow, each with its own trick, plus the plain car everyone drove before. The numbers
// feed Vehicle.js (physics), Combat.js (ram, clear, push) and Camera.js (cam scales the chase distance and height).
//
// The meshes are coachbuilt out of VehicleParts rather than stacked out of boxes: a lofted shell with a real
// shoulder line and a tapering nose, pressed wheel arches over tyres with sidewalls and tread, a greenhouse of
// pillars and separate glass, chrome trim that catches the sky environment map, lamps with a lens in a bezel, and
// a driver you can see through the screen. Every part lands in a material bucket and the buckets merge, so a car
// that is sixty pieces still costs six draw calls for its body plus two per wheel.
//
// The other thing every one of them is, is half a mech. A vehicle here is not a car that gets swapped for a robot
// at the halfway point of a flash — it is one mesh with two poses. Its panels are grouped onto six mounts, and each
// mount knows where it stands while driving and where it stands while walking: the bonnet is the chest plate, the
// roof is the hood, the flanks are the pauldrons, the chassis is the spine, the rear is the reactor pack, and every
// wheel folds up to become a hip, a knee or a heel. The wizard's frame and wardrobe (MechRig.js) are built into the
// same mesh, stowed down to a few centimetres inside the bodywork while driving, so that nothing is ever created,
// destroyed, hidden or substituted during the transformation. Avatar.js drives it with one number and the parts
// travel, each on its own window of the beat, which is what makes it read as a machine rather than a dissolve.
//
// Where each destination sits is written as "the chest is this big and stands here" and the scale that gets a
// particular bonnet there is solved from that bonnet's own bounding box by Morph.fitTo, because six vehicles from a
// 1.9 m moped to a 6.5 m tank all have to end up as the same four-metre machine and hand-tuned scales for each of
// them would need retuning every time a panel moved.
//
// The contract the rest of the game reads is unchanged: userData.wheels (a pivot per wheel at its corner with its
// radius; Suspension writes pivot.position.y, pivot.rotation.y and mesh.rotation.x), userData.lights (the head and
// tail materials whose emissiveIntensity Vehicle and RemoteCars animate), userData.flames (the exhaust sprites) and
// userData.anim (the turret, the boom). New: userData.pose(u, dir), which poses the machine between driving (u = 0)
// and walking (u = 1), and userData.mech, the rig and wardrobe Mech.js animates once the machine is on its feet.
// Every channel the morph writes belongs to a mount that nothing else touches — the suspension writes the wheel
// pivot inside the wheel mount, the walk writes the limb pivot inside the limb mount, Combat writes the turret
// pivot inside the turret mount — so no two systems ever fight over a transform.
export const VEHICLES = [
  { id: "brommer", naam: "Brommer", blurb: "Snelste van allemaal. Geen wapen, maar plakt een kleefbom die na drie tellen knalt.",
    maxSpeed: 50, accel: 12, brakeForce: 22, maxSteer: 0.6, wheelbase: 1.3, track: 0.6, length: 1.9,
    ram: 0.05, clear: 0.3, push: false, pushMin: 0, cam: { dist: 0.85, height: 0.85 },
    ability: { kind: "sticky", cooldown: 4, hint: "E kleefbom" } },
  { id: "trike", naam: "Trike", blurb: "Snel en wendbaar. Schiet raketten die op het eerste doel ontploffen.",
    maxSpeed: 40, accel: 10, brakeForce: 20, maxSteer: 0.55, wheelbase: 1.9, track: 1.4, length: 2.6,
    ram: 0.08, clear: 0.4, push: false, pushMin: 0, cam: { dist: 0.95, height: 0.95 },
    ability: { kind: "missile", cooldown: 0.8, hint: "E raket" } },
  { id: "monster", naam: "Monstertruck", blurb: "Vlot en hoog op de wielen. Springt en verplettert wat eronder ligt; zwak frontaal.",
    maxSpeed: 32, accel: 9, brakeForce: 18, maxSteer: 0.5, wheelbase: 3.4, track: 2.4, length: 5.0,
    ram: 0.2, clear: 1.0, push: false, pushMin: 0, cam: { dist: 1.25, height: 1.3 },
    ability: { kind: "jump", cooldown: 2.5, hint: "E springen" } },
  { id: "tank", naam: "Tank", blurb: "Traag maar zwaar. Granaten in een boog, veel schade op één doel.",
    maxSpeed: 18, accel: 6, brakeForce: 15, maxSteer: 0.7, wheelbase: 4.5, track: 3.0, length: 6.5,
    ram: 0.6, clear: 1.2, push: false, pushMin: 0, cam: { dist: 1.4, height: 1.4 },
    ability: { kind: "slug", cooldown: 2.0, hint: "E granaat" } },
  { id: "bulldozer", naam: "Bulldozer", blurb: "Traag. Ramt op snelheid dwars door alles heen en veegt puin in één keer weg.",
    maxSpeed: 12, accel: 5, brakeForce: 14, maxSteer: 0.6, wheelbase: 3.2, track: 2.4, length: 5.5,
    ram: 3.0, clear: 50, push: true, pushMin: 2, cam: { dist: 1.3, height: 1.3 },
    ability: { kind: "none", cooldown: 0, hint: "gas geven = slopen" } },
  { id: "sloopkraan", naam: "Sloopkraan", blurb: "Traagst van allemaal. De slingerbal maakt alles binnen vijftien meter vóór je met de grond gelijk.",
    maxSpeed: 8, accel: 4, brakeForce: 12, maxSteer: 0.5, wheelbase: 4.0, track: 2.6, length: 6.0,
    ram: 0.8, clear: 2.0, push: false, pushMin: 0, cam: { dist: 1.5, height: 1.8 },
    ability: { kind: "ball", cooldown: 4.0, hint: "E slingerbal" } },
]
const AUTO = { id: "auto", naam: "Auto", length: 4.1, wheelbase: 2.6, track: 1.6, ram: 0.1, clear: 0.4, push: false, pushMin: 0, cam: { dist: 1, height: 1 }, ability: { kind: "none", cooldown: 0, hint: "" } }

// Where the car's panels stand once the machine is on its feet, in the body frame (x right, y up, -z forward),
// drawn to the same skeleton MechRig is: hips at 2.32, knees at 1.30, shoulders at 3.36, the crown at 4.20. `rot`
// is how the panel is turned to get there — a bonnet has to stand on end to be a chest — `size` is the box it is
// fitted into, `at` is where that box is centred, `max` caps how far a sparse mount may be scaled up (two headlamps
// must not become a chest-sized pair of headlamps), and `t` is the window of the transformation it travels in.
const MECH_POSE = {
  spine:  { rot: [-Math.PI / 2, 0, 0], size: [1.00, 1.44, 0.76], at: [0, 2.84, 0.06], max: 1.8, t: [0.15, 0.70] },
  bonnet: { rot: [-Math.PI / 2, 0, 0], size: [1.24, 1.00, 0.34], at: [0, 3.04, -0.44], max: 1.8, t: [0.30, 0.85] },
  rear:   { rot: [-Math.PI / 2, 0, 0], size: [0.92, 0.78, 0.42], at: [0, 2.96, 0.52], max: 1.8, t: [0.28, 0.82] },
  roof:   { rot: [0.22, 0, 0], size: [0.76, 0.60, 0.72], at: [0, 3.74, 0.06], max: 1.6, t: [0.60, 1.00] },
  flankL: { rot: [0, 0, -0.30], size: [0.44, 0.50, 0.76], at: [-0.94, 3.30, 0.02], max: 1.6, t: [0.38, 0.90] },
  flankR: { rot: [0, 0, 0.30], size: [0.44, 0.50, 0.76], at: [0.94, 3.30, 0.02], max: 1.6, t: [0.38, 0.90] },
}
const CAR_MOUNTS = ["spine", "bonnet", "rear", "roof", "flankL", "flankR"]

// A wheel does not disappear into an arch: it becomes a joint. Each flank's wheels are taken front to back and
// dropped into these slots in order, so a four-wheeler puts its front pair at the knees and its rear pair at the
// hips, a six-wheeler gains a pair of heels, and a moped's two wheels become one knee each. `d` is the diameter the
// wheel ends up at, and the fit is uniform so a wheel stays round whatever it started as.
const WHEEL_SLOTS = [
  { at: [0.47, 1.34, 0.00], d: 0.82, t: [0.05, 0.60] },   // knee
  { at: [0.56, 2.28, 0.02], d: 0.66, t: [0.02, 0.55] },   // hip
  { at: [0.44, 0.40, 0.16], d: 0.56, t: [0.08, 0.64] },   // heel
  { at: [0.98, 2.58, 0.02], d: 0.50, t: [0.44, 0.96] },   // elbow
]

// The wizard's frame while the machine is a car: folded into a box this big, tucked at a point each builder
// nominates as being well inside its own bodywork, and switched off entirely at rest so it costs no draw calls.
// The offsets spread the pieces out along the chassis so they do not all occupy the same cubic decimetre.
const TUCK = 0.24              // metres: the box a stowed mech part folds into
const MECH_STOW = {
  hips:  { off: [0, -0.06, 0.55], t: [0.00, 0.54] },
  torso: { off: [0, 0.05, -0.10], t: [0.20, 0.70] },
  core:  { off: [0, 0.00, -0.30], t: [0.50, 0.92] },
  armL:  { off: [-0.30, 0.03, -0.45], t: [0.44, 0.95] },
  armR:  { off: [0.30, 0.03, -0.45], t: [0.44, 0.95] },
  head:  { off: [0, 0.09, -0.75], t: [0.64, 1.00] },
  staff: { off: [0.36, -0.05, 0.85], t: [0.62, 1.00] },
  cloak: { off: [0, 0.07, 1.00], t: [0.58, 1.00] },
}
const LEG_WINDOW = [0.08, 0.68]   // the thighs telescope out of the hips after the hips have found their place

const CAR_COLOUR = 0xd7412b    // the default red, also the fallback for remotes without one
const PLANT_YELLOW = 0xe8a91c  // construction plant is yellow whoever is driving it
const TYRE = 0x16171b, TRIM = 0x22252b, SEAT = 0x2a2f38, JACKET = 0x2c3a52, SKIN = 0xc79a72

export const vehicleSpec = (id) => VEHICLES.find((v) => v.id === id) ?? (id === "auto" ? AUTO : VEHICLES[1])

// `morph` false builds the driving half only: no wizard frame, no wardrobe, and every panel back in one section, so
// a machine that will never transform costs exactly what it cost before this existed. Remote players' cars are the
// case that wants it — RemoteCars builds a separate body for anyone who is walking — and it defaults on so that a
// caller that has not been told about it still gets a machine that works.
export function makeVehicleMesh(id, color = CAR_COLOUR, { morph = true } = {}) {
  return (BUILDERS[id] ?? makeCarMesh)(color, { morph })
}

// ---- shared parts ------------------------------------------------------------------------------------------------

// rotate then translate a geometry into place; the rotations are applied about the geometry's own origin
function at(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (rz) geo.rotateZ(rz)
  if (rx) geo.rotateX(rx)
  if (ry) geo.rotateY(ry)
  geo.translate(x, y, z)
  return geo
}

// A vehicle under construction. The root is what the game moves; under it sits one body group the morph works
// inside, and under that the six panel mounts, one group per wheel, and the wizard's frame and wardrobe. Every part
// goes into a Kit holding both material sets at once, so a machine that is a car and a mech still merges down to
// one mesh per material per moving piece. `on(name)` points the builder's shorthand at a mount, which is the whole
// of the routing: a builder reads as a list of panels with a heading every few lines saying which part of the mech
// this lot becomes.
function chassis(color, { hide = [0, 0.7, 0], morph = true } = {}) {
  const root = new THREE.Group(), body = new THREE.Group()
  root.add(body)
  const kit = new Kit(morph ? { ...vehicleMaterials(color), ...mechMaterials() } : vehicleMaterials(color))
  const mounts = {}, sections = {}
  if (morph) {
    for (const name of CAR_MOUNTS) {
      const g = new THREE.Group()
      body.add(g); mounts[name] = g; sections[name] = kit.section(g)
    }
  } else {
    const one = kit.section(body)                          // no morph, no mounts: one shell, one set of buckets
    for (const name of CAR_MOUNTS) { mounts[name] = body; sections[name] = one }
  }
  // the wizard half, built standing into the same kit: a frame with telescoping limbs and the cloak and staff
  const rig = morph ? new MechRig({ kit, mats: kit.mats }) : null
  const wizard = morph ? new WizardKit({ cloak: true, core: false, mats: kit.mats, kit }) : null
  if (morph) body.add(rig.root, wizard.root)
  const c = { root, body, kit, mounts, sections, rig, wizard, morph: morph ? new MorphRig() : null, wheels: [], flames: [], extra: [],
              hide: new THREE.Vector3(...hide), cur: sections.spine }
  c.on = (name, sx = 0) => { c.cur = sections[sx ? name + (sx < 0 ? "L" : "R") : name]; return c.cur }
  c.shell = {}
  for (const key of ["put", "paint", "matte", "chrome", "glass", "rubber", "head", "tail"]) c.shell[key] = (...a) => c.cur[key](...a)
  return c
}

// A wheel on a pivot at its corner inside a mount. The pivot is the suspension's — it writes the ride height and the
// steer angle there every frame and reads lx, lz, r off the record — and the mount is the morph's, which is how a
// wheel can be travelling towards a knee joint while the suspension is still holding it on the ground.
function wheel(c, lx, lz, r, width, visible = true) {
  const mount = new THREE.Group()
  const pivot = new THREE.Group(); pivot.position.set(lx, r, lz)
  const mesh = new THREE.Group()
  const s = c.kit.section(mesh)
  s.rubber(tyreGeometry(r, width))
  s.chrome(rimGeometry(r, width, lx <= 0 ? 1 : -1))
  mesh.visible = visible
  pivot.add(mesh)
  mount.add(pivot)
  c.body.add(mount)
  const w = { pivot, mesh, mount, lx, lz, front: lz < 0, r }
  c.wheels.push(w)
  return w
}

// a pressed lip over the wheel, in body colour, so the arch is part of the panel work rather than a hole
function fender(c, lx, lz, r, width, lift = 1.18) {
  c.shell.paint(at(arch(r * lift, 0.055, width * 1.35), lx, r, lz))
}

// a lamp is a lens sitting in a bezel: the bezel is what makes it read as a fitting and not a sticker
function headlamp(c, x, y, z, w = 0.34, h = 0.16) {
  c.shell.chrome(at(panel(w + 0.08, h + 0.08, 0.07, { r: 0.04 }), x, y, z + 0.05))
  c.shell.head(at(panel(w, h, 0.09, { r: 0.035 }), x, y, z))
}
function taillamp(c, x, y, z, w = 0.30, h = 0.14) {
  c.shell.chrome(at(panel(w + 0.07, h + 0.07, 0.07, { r: 0.035 }), x, y, z - 0.05))
  c.shell.tail(at(panel(w, h, 0.08, { r: 0.03 }), x, y, z))
}

// A seated figure: hips, a torso leaning into the wheel, a head, arms reaching forward and knees. All matte, so it
// costs no extra draw call — the whole point of the vertex-coloured bucket.
function driver(c, x, y, z, k = 1, helmet = null) {
  const s = c.shell
  s.matte(at(panel(0.46 * k, 0.30 * k, 0.38 * k, { r: 0.1 * k }), x, y, z), JACKET)
  s.matte(at(panel(0.44 * k, 0.54 * k, 0.30 * k, { r: 0.12 * k }), x, y + 0.38 * k, z - 0.05 * k, -0.2), JACKET)
  s.matte(at(new THREE.SphereGeometry(0.125 * k, 10, 8), x, y + 0.78 * k, z - 0.11 * k), SKIN)
  if (helmet !== null) s.matte(at(new THREE.SphereGeometry(0.16 * k, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.66), x, y + 0.79 * k, z - 0.11 * k), helmet)
  for (const sx of [-1, 1]) {
    s.matte(at(strut(sx * 0.21 * k, 0.5 * k, -0.02 * k, sx * 0.25 * k, 0.3 * k, -0.44 * k, 0.055 * k, 6), x, y, z), JACKET)
    s.matte(at(strut(sx * 0.14 * k, 0.02 * k, -0.1 * k, sx * 0.16 * k, -0.14 * k, -0.44 * k, 0.075 * k, 6), x, y, z), JACKET)
  }
}

// One material per exhaust so each flame can flicker on its own phase; the inner core sprite is the hot white heart
// that only shows up under real boost. They hang off the current mount so they travel with the pipes they come out
// of rather than staying behind in mid-air when the machine stands up.
function flames(c, xs, y, z, size = 1) {
  const target = c.cur.target
  for (const x of xs) {
    const mat = new THREE.SpriteMaterial({ map: softTexture(), color: 0xff8a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    const coreMat = new THREE.SpriteMaterial({ map: softTexture(), color: 0xfff0c0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    const sprite = new THREE.Sprite(mat), core = new THREE.Sprite(coreMat)
    sprite.position.set(x, y, z); core.position.set(x, y, z)
    sprite.scale.setScalar(0); core.scale.setScalar(0)
    sprite.visible = core.visible = false
    target.add(sprite, core)
    c.flames.push({ sprite, mat, core, coreMat, size, phase: Math.random() * 6.283 })
  }
}

// exhaust tips, so the flames come out of something
function exhaust(c, xs, y, z, r = 0.07) {
  for (const x of xs) c.shell.chrome(at(revolve([[r * 0.7, -0.22], [r, -0.2], [r, 0.16], [r * 1.25, 0.2], [r * 1.25, 0.22], [r * 0.9, 0.22]], 10), x, y, z, Math.PI / 2))
}

// A pivot something else animates (the tank's turret, the crane's boom), wrapped in a mount the morph owns, so the
// two never write the same channel. Returns the pivot, which is what goes into userData.anim.
function articulated(c, x, y, z, rx = 0) {
  const mount = new THREE.Group(), pivot = new THREE.Group()
  pivot.position.set(x, y, z); pivot.rotation.x = rx
  mount.add(pivot); c.body.add(mount)
  return { mount, pivot }
}

// ---- finishing: the walking pose ----------------------------------------------------------------------------------

// Which joint each wheel becomes. Wheels are taken a flank at a time, front to back, and handed the slots in order,
// so the assignment falls out of the layout rather than being written down six times. A wheel on the centreline
// (the moped's, the trike's nose wheel) is alternated between the flanks by the order it was built in.
function wheelSlots(wheels) {
  const sides = { "-1": [], 1: [] }
  wheels.forEach((w, i) => sides[w.lx < 0 || (w.lx === 0 && i % 2 === 0) ? -1 : 1].push(w))
  const out = new Map()
  for (const key of ["-1", "1"]) {
    const side = Number(key)
    sides[key].sort((a, b) => a.lz - b.lz).forEach((w, rank) => out.set(w, { side, slot: WHEEL_SLOTS[Math.min(rank, WHEEL_SLOTS.length - 1)] }))
  }
  return out
}

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2])

// Build the kit, work out where every part stands in the walking pose, hand the lot to the morph and leave the
// machine in its driving pose. Everything here runs once, at construction: posing it afterwards is a lerp per part.
function finish(c, extra = null) {
  const mats = c.kit.build()
  const g = c.root
  g.userData.lights = { head: mats.head, tail: mats.tail }
  g.userData.wheels = c.wheels
  g.userData.flames = c.flames
  g.userData.morph = c.morph
  g.userData.mech = c.rig ? { rig: c.rig, wizard: c.wizard } : null
  g.userData.pose = c.morph ? (u, dir) => c.morph.pose(u, dir) : () => {}
  if (!c.morph) return g

  // the car's panels: each mount fitted into the box its destination on the mech occupies
  for (const name of CAR_MOUNTS) {
    const d = MECH_POSE[name]
    c.morph.add(c.mounts[name], { walk: fitTo(c.mounts[name], { rotation: new THREE.Euler(...d.rot), size: v3(d.size), centre: v3(d.at), max: d.max }), t0: d.t[0], t1: d.t[1] })
  }
  // the wheels: each one becomes a joint, kept round by a uniform fit
  const slots = wheelSlots(c.wheels)
  for (const w of c.wheels) {
    const { side, slot } = slots.get(w)
    const centre = new THREE.Vector3(side * slot.at[0], slot.at[1], slot.at[2])
    c.morph.add(w.mount, { walk: fitTo(w.mount, { size: new THREE.Vector3(slot.d, slot.d, slot.d), centre, uniform: true }), t0: slot.t[0], t1: slot.t[1] })
  }
  // the wizard's frame and wardrobe: built standing, stowed into the bodywork for the driving pose
  const stowed = { ...c.rig.mounts, staff: c.wizard.mounts.staff, cloak: c.wizard.mounts.cloak }
  for (const [name, d] of Object.entries(MECH_STOW)) {
    const node = stowed[name]
    if (!node) continue
    const centre = c.hide.clone().add(v3(d.off))
    c.morph.add(node, { drive: fitTo(node, { size: new THREE.Vector3(TUCK, TUCK, TUCK), centre, uniform: true }), t0: d.t[0], t1: d.t[1], hidden: true })
  }
  for (const name of ["legL", "legR"]) {
    c.morph.add(c.rig.mounts[name], { drive: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: LIMB_STOW.clone() }, t0: LEG_WINDOW[0], t1: LEG_WINDOW[1] })
  }
  extra?.(c)
  for (const p of c.extra) c.morph.add(p.mount, p.pose)
  c.morph.pose(0, 1)
  return g
}

// ---- the meshes ----------------------------------------------------------------------------------------------------
//
// Each builder now reads as panels with a heading every few lines saying which part of the standing machine that lot
// becomes. Nothing about the driving pose has changed — the same lofts at the same stations — but the shell is no
// longer one section, because a chest plate that is welded to a rear bumper cannot go anywhere on its own.

// The plain car: everyone's ride before the vastelaovend mode, still the fallback for remotes without a vehicle.
// Length 4.1, wheelbase 2.6, track 1.6 — the spec Combat probes with, so the shell is drawn to those numbers.
export function makeCarMesh(color = CAR_COLOUR, opts = {}) {
  const c = chassis(color, { ...opts, hide: [0, 0.70, 0.10] }), s = c.shell, r = T.susp.wheelRadius
  const sec = profile(1, 1, 0.30)
  // the shell: a nose that tapers, a shoulder line that swells over the arches and a tail that pulls back in
  c.on("spine")
  s.paint(loft(sec, [
    { z: -2.05, sx: 1.40, sy: 0.40, oy: 0.66 },
    { z: -1.72, sx: 1.66, sy: 0.56, oy: 0.62 },
    { z: -1.10, sx: 1.78, sy: 0.72, oy: 0.62 },
    { z: -0.10, sx: 1.82, sy: 0.78, oy: 0.63 },
    { z: 1.05, sx: 1.80, sy: 0.76, oy: 0.63 },
    { z: 1.74, sx: 1.66, sy: 0.60, oy: 0.63 },
    { z: 2.05, sx: 1.44, sy: 0.44, oy: 0.64 },
  ]))
  // the greenhouse becomes the hood: a roof slab on four pillars, glass hung between them
  c.on("roof")
  s.paint(loft(profile(1, 1, 0.35), [
    { z: -0.62, sx: 1.44, sy: 0.13, oy: 1.36 },
    { z: -0.20, sx: 1.52, sy: 0.15, oy: 1.40 },
    { z: 0.62, sx: 1.50, sy: 0.15, oy: 1.39 },
    { z: 0.98, sx: 1.34, sy: 0.12, oy: 1.33 },
  ]))
  for (const sx of [-1, 1]) {
    s.paint(at(strut(sx * 0.66, 1.00, -0.98, sx * 0.62, 1.34, -0.52, 0.065, 6), 0, 0, 0))      // A-pillar
    s.paint(at(strut(sx * 0.74, 1.00, 0.86, sx * 0.66, 1.34, 0.62, 0.07, 6), 0, 0, 0))         // C-pillar
  }
  s.glass(at(panel(1.42, 0.60, 0.04, { r: 0.12, bevel: 0.015 }), 0, 1.18, -0.80, -0.62))        // windscreen
  s.glass(at(panel(1.34, 0.48, 0.04, { r: 0.10, bevel: 0.015 }), 0, 1.20, 0.82, 0.72))          // rear screen
  // the flanks become the pauldrons: side glass, shoulder trim, mirrors
  for (const sx of [-1, 1]) {
    c.on("flank", sx)
    s.chrome(at(panel(0.05, 0.06, 1.30, { r: 0.02 }), sx * 0.90, 1.00, 0.0))                    // shoulder trim strip
    s.glass(at(panel(1.30, 0.34, 0.03, { r: 0.06, bevel: 0.01 }), sx * 0.865, 1.17, 0.06, 0, Math.PI / 2, 0.02))
    s.matte(at(revolve([[0.001, 0], [0.05, 0.02], [0.05, 0.09]], 8), sx * 0.92, 1.06, -0.70, 0, 0, sx * 0.5), TRIM)   // mirror stalk
    s.chrome(at(panel(0.19, 0.12, 0.09, { r: 0.04 }), sx * 1.02, 1.11, -0.70, 0, 0.2, 0))       // mirror shell
  }
  // the nose becomes the chest plate: grille, splitter, number plate, headlamps
  c.on("bonnet")
  s.matte(at(panel(1.16, 0.26, 0.10, { r: 0.05 }), 0, 0.68, -2.06), 0x15171a)
  s.chrome(at(panel(1.22, 0.06, 0.05, { r: 0.02 }), 0, 0.83, -2.06))
  s.matte(at(panel(1.70, 0.16, 0.26, { r: 0.06 }), 0, 0.42, -1.96), TRIM)
  s.matte(at(panel(0.44, 0.13, 0.03, { r: 0.02 }), 0, 0.50, -2.10), 0xdcd8cc)
  headlamp(c, -0.58, 0.80, -2.07); headlamp(c, 0.58, 0.80, -2.07)
  // the tail becomes the reactor pack: bumper, lamps, pipes and the flames out of them
  c.on("rear")
  s.matte(at(panel(1.76, 0.20, 0.24, { r: 0.07 }), 0, 0.46, 1.98), TRIM)
  taillamp(c, -0.60, 0.86, 2.07); taillamp(c, 0.60, 0.86, 2.07)
  exhaust(c, [-0.42, 0.42], 0.42, 2.12)
  flames(c, [-0.42, 0.42], 0.42, 2.26)
  // seats, a driver behind the wheel and the arches: all chassis, all part of the spine
  c.on("spine")
  for (const sx of [-1, 1]) s.matte(at(panel(0.44, 0.76, 0.16, { r: 0.08 }), sx * 0.36, 0.94, 0.40), SEAT)
  s.matte(at(revolve([[0.001, 0], [0.14, 0], [0.16, 0.02], [0.16, 0.04]], 12), -0.36, 0.92, -0.42, 1.2), TRIM)
  driver(c, -0.36, 0.50, 0.26)
  for (const [lx, lz] of [[-0.80, -1.30], [0.80, -1.30], [-0.80, 1.30], [0.80, 1.30]]) {
    wheel(c, lx, lz, r, 0.26)
    fender(c, lx, lz, r, 0.26)
  }
  return finish(c)
}

// The moped: two wheels in line, a tank you could sit astride, a rider leaning over the bars. Its handlebars and
// headlamp are the only thing up high, so they are what becomes the hood.
function makeBrommer(color, opts = {}) {
  const c = chassis(color, { ...opts, hide: [0, 0.80, 0.05] }), s = c.shell
  c.on("spine")
  s.paint(loft(profile(1, 1, 0.34), [                                   // tank and tail unit
    { z: -0.62, sx: 0.26, sy: 0.30, oy: 0.80 },
    { z: -0.30, sx: 0.40, sy: 0.42, oy: 0.80 },
    { z: 0.18, sx: 0.42, sy: 0.44, oy: 0.78 },
    { z: 0.62, sx: 0.34, sy: 0.30, oy: 0.86 },
    { z: 0.90, sx: 0.22, sy: 0.18, oy: 0.88 },
  ]))
  s.matte(at(panel(0.40, 0.12, 0.52, { r: 0.06 }), 0, 0.99, 0.30), SEAT) // saddle
  driver(c, 0, 1.12, 0.18, 1.0, 0x1d2a3a)
  c.on("bonnet")
  s.paint(at(panel(0.34, 0.30, 0.46, { r: 0.12 }), 0, 0.52, -0.62))      // front mudguard fairing
  s.chrome(at(strut(0, 0.95, -0.58, 0, 0.36, -0.66, 0.045, 8), 0, 0, 0)) // fork leg, left
  for (const sx of [-1, 1]) {
    c.on("flank", sx)
    s.chrome(at(strut(sx * 0.1, 0.95, -0.58, sx * 0.1, 0.36, -0.66, 0.035, 6), 0, 0, 0))
    s.matte(at(panel(0.12, 0.05, 0.05, { r: 0.02 }), sx * 0.29, 1.06, -0.60), TRIM)
  }
  c.on("roof")
  s.chrome(at(panel(0.62, 0.045, 0.045, { r: 0.02 }), 0, 1.06, -0.60))   // handlebars
  headlamp(c, 0, 0.92, -0.72, 0.20, 0.20)
  c.on("rear")
  s.chrome(at(revolve([[0.05, -0.34], [0.055, 0.2], [0.075, 0.24], [0.075, 0.3]], 10), 0.13, 0.42, 0.5, Math.PI / 2))  // silencer
  s.matte(at(panel(0.30, 0.18, 0.05, { r: 0.06 }), 0, 0.28, 0.62), TRIM) // rear mudguard
  taillamp(c, 0, 0.88, 0.92, 0.14, 0.10)
  flames(c, [0.13], 0.42, 0.84, 0.6)
  wheel(c, 0, -0.65, 0.30, 0.11)
  wheel(c, 0, 0.65, 0.30, 0.13)
  return finish(c)
}

// The trike: one wheel under a pointed nose, a low pod the rider lies in, a missile tube along each flank.
function makeTrike(color, opts = {}) {
  const c = chassis(color, { ...opts, hide: [0, 0.68, 0.10] }), s = c.shell
  c.on("spine")
  s.paint(loft(profile(1, 1, 0.33), [
    { z: -1.28, sx: 0.30, sy: 0.26, oy: 0.62 },
    { z: -0.85, sx: 0.72, sy: 0.44, oy: 0.60 },
    { z: -0.10, sx: 1.16, sy: 0.62, oy: 0.62 },
    { z: 0.70, sx: 1.26, sy: 0.66, oy: 0.62 },
    { z: 1.24, sx: 1.04, sy: 0.48, oy: 0.64 },
  ]))
  driver(c, 0, 0.84, 0.12, 0.9, 0x7a1414)
  c.on("roof")
  s.glass(at(panel(0.86, 0.46, 0.04, { r: 0.16, bevel: 0.015 }), 0, 1.02, -0.42, -0.5))     // bubble screen
  s.paint(at(panel(0.92, 0.14, 0.56, { r: 0.16 }), 0, 1.14, 0.44))                           // headrest fairing
  for (const sx of [-1, 1]) {
    c.on("flank", sx)
    s.chrome(at(revolve([[0.10, -0.70], [0.11, -0.6], [0.11, 0.58], [0.13, 0.66], [0.13, 0.70]], 10), sx * 0.72, 0.92, -0.10, Math.PI / 2))   // missile tube
    s.matte(at(panel(0.08, 0.20, 0.34, { r: 0.03 }), sx * 0.72, 0.72, 0.10), TRIM)           // tube mount
  }
  c.on("rear")
  for (const sx of [-1, 1]) s.paint(at(panel(0.10, 0.30, 0.70, { r: 0.06 }), sx * 0.60, 0.44, 0.86))   // rear wing endplate
  s.paint(at(panel(1.50, 0.05, 0.30, { r: 0.03 }), 0, 0.58, 0.90))                            // rear wing
  taillamp(c, -0.30, 0.74, 1.26, 0.20, 0.10); taillamp(c, 0.30, 0.74, 1.26, 0.20, 0.10)
  exhaust(c, [-0.26, 0.26], 0.52, 1.24, 0.06)
  flames(c, [-0.26, 0.26], 0.52, 1.38, 0.8)
  c.on("bonnet")
  s.chrome(at(strut(0, 0.86, -1.12, 0, 0.38, -0.98, 0.05, 8), 0, 0, 0))                       // fork
  headlamp(c, 0, 0.70, -1.30, 0.24, 0.14)
  c.on("spine")
  wheel(c, 0, -0.95, 0.34, 0.18); fender(c, 0, -0.95, 0.34, 0.18, 1.30)
  for (const lx of [-0.70, 0.70]) { wheel(c, lx, 0.95, 0.36, 0.28); fender(c, lx, 0.95, 0.36, 0.28) }
  return finish(c)
}

// The monster truck: a pickup cab and bed on a tube chassis, held a metre in the air by four tractor tyres under
// flared arches, with a roll cage, a light bar and two stacks up the back of the cab. The cab is the chest.
function makeMonster(color, opts = {}) {
  const c = chassis(color, { ...opts, hide: [0, 1.90, 0.40] }), s = c.shell, r = 0.90
  c.on("bonnet")
  s.paint(loft(profile(1, 1, 0.28), [                                  // cab
    { z: -2.45, sx: 1.62, sy: 0.42, oy: 1.60 },
    { z: -2.05, sx: 1.84, sy: 0.62, oy: 1.66 },
    { z: -1.20, sx: 1.92, sy: 1.16, oy: 2.02 },
    { z: -0.30, sx: 1.92, sy: 1.20, oy: 2.06 },
    { z: 0.10, sx: 1.86, sy: 1.00, oy: 1.98 },
  ]))
  headlamp(c, -0.60, 1.70, -2.47, 0.40, 0.20); headlamp(c, 0.60, 1.70, -2.47, 0.40, 0.20)
  c.on("spine")
  s.paint(loft(profile(1, 1, 0.22), [                                  // bed
    { z: 0.10, sx: 1.84, sy: 0.66, oy: 1.74 },
    { z: 1.70, sx: 1.84, sy: 0.62, oy: 1.72 },
    { z: 2.55, sx: 1.74, sy: 0.56, oy: 1.72 },
  ]))
  s.matte(at(panel(1.60, 0.44, 2.00, { r: 0.05 }), 0, 1.78, 1.38), 0x30241a)                   // bed floor and its load
  s.matte(at(panel(0.90, 0.34, 3.70, { r: 0.1 }), 0, 1.22, 0.0), 0x3a3d44)                      // chassis rails
  driver(c, -0.44, 1.55, -0.55, 1.0, 0xd8d2c4)
  c.on("roof")
  s.glass(at(panel(1.54, 0.66, 0.04, { r: 0.10, bevel: 0.015 }), 0, 2.30, -1.50, -0.42))       // windscreen
  for (const sx of [-1, 1]) {                                                                   // roll cage
    s.chrome(at(strut(sx * 0.88, 2.30, -0.10, sx * 0.88, 2.92, -0.06, 0.055, 6), 0, 0, 0))
    s.chrome(at(strut(sx * 0.88, 2.92, -0.06, sx * 0.82, 2.40, 1.30, 0.05, 6), 0, 0, 0))
  }
  s.chrome(at(panel(1.84, 0.06, 0.06, { r: 0.03 }), 0, 2.92, -0.06))
  s.matte(at(panel(1.20, 0.14, 0.12, { r: 0.05 }), 0, 3.02, -0.30), TRIM)                       // light bar housing
  for (const x of [-0.42, -0.14, 0.14, 0.42]) c.shell.head(at(panel(0.2, 0.13, 0.08, { r: 0.04 }), x, 3.02, -0.38))
  for (const sx of [-1, 1]) {
    c.on("flank", sx)
    s.glass(at(panel(0.86, 0.58, 0.03, { r: 0.08, bevel: 0.01 }), sx * 0.93, 2.30, -0.86, 0, Math.PI / 2, 0))
    for (const z of [-1.70, 1.70]) {
      s.chrome(at(strut(0, 1.22, z, sx * 1.20 * 0.92, 0.94, z, 0.075, 6), 0, 0, 0))             // trailing arms
      s.matte(at(panel(0.26, 0.70, 0.26, { r: 0.06 }), sx * 1.20 * 0.74, 1.55, z), 0x3a3d44)    // coil-over
    }
  }
  c.on("rear")
  for (const sx of [-1, 1]) s.chrome(at(revolve([[0.075, -0.55], [0.08, 0.4], [0.10, 0.5], [0.10, 0.55]], 10), sx * 0.70, 2.75, 0.14))
  taillamp(c, -0.66, 1.80, 2.57, 0.34, 0.18); taillamp(c, 0.66, 1.80, 2.57, 0.34, 0.18)
  flames(c, [-0.70, 0.70], 3.30, 0.14, 1.2)
  c.on("spine")
  for (const [lx, lz] of [[-1.20, -1.70], [1.20, -1.70], [-1.20, 1.70], [1.20, 1.70]]) {
    wheel(c, lx, lz, r, 0.70)
    fender(c, lx, lz, r, 0.70, 1.12)
  }
  return finish(c)
}

// The tank: a sloped welded hull between two track units, a cast turret with a mantlet and a long gun. The wheels
// the suspension follows the ground with are hidden inside the tracks, exactly as before. Standing up, the track
// units become the pauldrons and the turret becomes the head, gun and all.
function makeTank(color, opts = {}) {
  const c = chassis(color, { ...opts, hide: [0, 1.10, 0.20] }), s = c.shell
  c.on("spine")
  s.paint(loft(profile(1, 1, 0.16), [                                    // hull, glacis sloped at both ends
    { z: -3.20, sx: 2.10, sy: 0.44, oy: 0.98 },
    { z: -2.40, sx: 2.44, sy: 0.86, oy: 1.12 },
    { z: -0.60, sx: 2.60, sy: 1.00, oy: 1.16 },
    { z: 1.60, sx: 2.58, sy: 0.98, oy: 1.16 },
    { z: 2.80, sx: 2.34, sy: 0.78, oy: 1.10 },
    { z: 3.20, sx: 2.06, sy: 0.54, oy: 1.04 },
  ]))
  for (const sx of [-1, 1]) {
    c.on("flank", sx)
    s.matte(loft(profile(1, 1, 0.42), [                                  // track run
      { z: -3.30, sx: 0.78, sy: 0.92, oy: 0.62, ox: sx * 1.50 },
      { z: -2.60, sx: 0.80, sy: 1.14, oy: 0.60, ox: sx * 1.50 },
      { z: 2.60, sx: 0.80, sy: 1.14, oy: 0.60, ox: sx * 1.50 },
      { z: 3.30, sx: 0.78, sy: 0.92, oy: 0.62, ox: sx * 1.50 },
    ]), TYRE)
    for (let i = 0; i < 5; i++) {                                        // road wheels showing through the run
      const z = -2.0 + i
      s.matte(at(revolve([[0.001, -0.16], [0.36, -0.16], [0.42, -0.08], [0.42, 0.08], [0.36, 0.16], [0.001, 0.16]], 12), sx * 1.50, 0.50, z, 0, 0, Math.PI / 2), 0x33363c)
    }
    s.matte(at(panel(0.90, 0.18, 6.50, { r: 0.05 }), sx * 1.50, 1.14, 0), 0x2a2d33)            // track guard
    s.chrome(at(panel(0.10, 0.10, 3.00, { r: 0.04 }), sx * 1.02, 1.42, 0.4))                    // stowage rail
  }
  c.on("bonnet")
  s.matte(at(panel(2.10, 0.12, 0.34, { r: 0.05 }), 0, 1.38, -3.26), TRIM)                       // glacis plate trim
  headlamp(c, -0.92, 1.30, -3.28, 0.28, 0.18); headlamp(c, 0.92, 1.30, -3.28, 0.28, 0.18)
  c.on("rear")
  taillamp(c, -0.92, 1.30, 3.28, 0.24, 0.14); taillamp(c, 0.92, 1.30, 3.28, 0.24, 0.14)
  exhaust(c, [-1.00, 1.00], 1.48, 2.80, 0.10)
  flames(c, [-1.00, 1.00], 1.48, 2.98, 1.0)
  // the turret rides its own mount so Combat can slew the pivot inside it while the morph carries it to the neck
  const tur = articulated(c, 0, 1.62, 0.30)
  const turret = tur.pivot
  const ts = c.kit.section(turret)
  ts.paint(loft(profile(1, 1, 0.44), [                                                          // cast turret, tapering forward
    { z: -1.30, sx: 1.34, sy: 0.52, oy: 0.36 },
    { z: -0.70, sx: 1.90, sy: 0.68, oy: 0.34 },
    { z: 0.30, sx: 2.20, sy: 0.76, oy: 0.34 },
    { z: 1.20, sx: 1.86, sy: 0.62, oy: 0.34 },
  ]))
  ts.matte(at(revolve([[0.34, -0.2], [0.40, -0.12], [0.40, 0.12], [0.34, 0.2]], 12), 0, 0.78, 0.60), 0x3a3d44)  // cupola
  ts.chrome(at(panel(0.9, 0.05, 0.05, { r: 0.02 }), 0, 1.02, 0.60))                             // aerial mount
  ts.paint(at(revolve([[0.34, -0.3], [0.40, -0.2], [0.40, 0.2], [0.34, 0.3]], 12), 0, 0.42, -1.28, Math.PI / 2))  // mantlet
  const barrel = new THREE.Mesh(revolve([[0.001, 0], [0.13, 0], [0.13, 2.90], [0.17, 2.95], [0.17, 3.30], [0.15, 3.35], [0.145, 3.60], [0.001, 3.60]], 14), c.kit.mats.chrome)
  barrel.rotation.x = -Math.PI / 2
  barrel.position.set(0, 0.42, -1.40)
  turret.add(barrel)
  c.on("spine")
  for (const [lx, lz] of [[-1.50, -2.25], [1.50, -2.25], [-1.50, 2.25], [1.50, 2.25]]) wheel(c, lx, lz, 0.45, 0.60, false)
  c.root.userData.anim = { turret, barrel }
  return finish(c, (cc) => cc.extra.push({ mount: tur.mount,
    pose: { walk: fitTo(tur.mount, { rotation: new THREE.Euler(0.18, 0, 0), size: new THREE.Vector3(0.80, 0.66, 1.70), centre: new THREE.Vector3(0, 3.72, 0.34) }), t0: 0.64, t1: 1.0 } }))
}

// The bulldozer: a squat yellow hull on tracks, a glazed ROPS cab, a stack, and a mouldboard blade on two push arms
// with a cutting edge and hydraulic rams. The blade is the chest plate, which is the whole point of a bulldozer.
function makeBulldozer(_color, opts = {}) {
  const c = chassis(PLANT_YELLOW, { ...opts, hide: [0, 1.30, 0.30] }), s = c.shell
  c.on("spine")
  s.paint(loft(profile(1, 1, 0.22), [
    { z: -1.50, sx: 2.10, sy: 0.86, oy: 1.28 },
    { z: -0.60, sx: 2.36, sy: 1.16, oy: 1.34 },
    { z: 1.10, sx: 2.36, sy: 1.20, oy: 1.34 },
    { z: 2.10, sx: 2.06, sy: 0.92, oy: 1.28 },
  ]))
  driver(c, 0, 2.10, 0.60, 1.0, null)
  c.on("roof")
  s.paint(loft(profile(1, 1, 0.26), [                                                         // cab shell
    { z: -0.10, sx: 1.70, sy: 1.30, oy: 2.52 },
    { z: 0.50, sx: 1.80, sy: 1.42, oy: 2.56 },
    { z: 1.30, sx: 1.72, sy: 1.28, oy: 2.50 },
  ]))
  s.glass(at(panel(1.44, 0.92, 0.04, { r: 0.10, bevel: 0.015 }), 0, 2.62, -0.20, -0.18))
  s.glass(at(panel(1.36, 0.80, 0.04, { r: 0.10, bevel: 0.015 }), 0, 2.60, 1.34, 0.16))
  headlamp(c, -0.62, 3.06, -0.34, 0.26, 0.16); headlamp(c, 0.62, 3.06, -0.34, 0.26, 0.16)
  for (const sx of [-1, 1]) {
    c.on("flank", sx)
    s.glass(at(panel(1.10, 0.86, 0.03, { r: 0.08, bevel: 0.01 }), sx * 0.90, 2.60, 0.58, 0, Math.PI / 2, 0))
    s.matte(loft(profile(1, 1, 0.40), [                                                        // track run
      { z: -2.20, sx: 0.72, sy: 0.90, oy: 0.60, ox: sx * 1.22 },
      { z: -1.50, sx: 0.74, sy: 1.22, oy: 0.64, ox: sx * 1.22 },
      { z: 1.60, sx: 0.74, sy: 1.22, oy: 0.64, ox: sx * 1.22 },
      { z: 2.30, sx: 0.72, sy: 0.90, oy: 0.60, ox: sx * 1.22 },
    ]), TYRE)
    s.matte(at(revolve([[0.001, -0.2], [0.44, -0.2], [0.50, -0.1], [0.50, 0.1], [0.44, 0.2], [0.001, 0.2]], 12), sx * 1.22, 0.56, -1.62, 0, 0, Math.PI / 2), 0x33363c)
    s.matte(at(revolve([[0.001, -0.2], [0.44, -0.2], [0.50, -0.1], [0.50, 0.1], [0.44, 0.2], [0.001, 0.2]], 12), sx * 1.22, 0.56, 1.74, 0, 0, Math.PI / 2), 0x33363c)
    s.paint(at(panel(0.86, 0.20, 4.30, { r: 0.06 }), sx * 1.22, 1.24, 0.04))                    // track guard
    s.chrome(at(strut(sx * 1.10, 0.86, -1.20, sx * 1.10, 0.78, -2.70, 0.085, 8), 0, 0, 0))      // push arm
    s.chrome(at(strut(sx * 0.70, 1.72, -0.90, sx * 1.02, 1.12, -2.30, 0.075, 8), 0, 0, 0))      // tilt ram
  }
  // the blade: a curved mouldboard with a cutting edge along the bottom
  c.on("bonnet")
  s.paint(loft(profile(1, 1, 0.10), [
    { z: -0.20, sx: 3.40, sy: 0.30, oy: 0.28 },
    { z: -0.06, sx: 3.44, sy: 0.56, oy: 0.64 },
    { z: 0.08, sx: 3.44, sy: 0.58, oy: 1.02 },
    { z: 0.22, sx: 3.38, sy: 0.34, oy: 1.34 },
  ].map((st) => ({ ...st, z: st.z - 2.92 }))))
  s.matte(at(panel(3.44, 0.16, 0.20, { r: 0.04 }), 0, 0.22, -2.96), 0x4a4d55)
  for (const x of [-1.20, 0, 1.20]) s.matte(at(panel(0.22, 0.26, 0.26, { r: 0.05 }), x, 0.22, -3.04), 0x5a5d65)   // cutting teeth
  c.on("rear")
  s.chrome(at(revolve([[0.09, -0.55], [0.10, 0.42], [0.13, 0.5], [0.13, 0.55]], 10), 0.80, 3.10, 0.90))        // stack
  s.matte(at(revolve([[0.14, 0], [0.14, 0.18], [0.10, 0.22]], 10), 0.80, 3.56, 0.90), TRIM)                        // rain cap
  taillamp(c, -0.72, 2.60, 2.12, 0.22, 0.14); taillamp(c, 0.72, 2.60, 2.12, 0.22, 0.14)
  flames(c, [0.80], 3.66, 0.90, 0.8)
  c.on("spine")
  for (const [lx, lz] of [[-1.20, -1.60], [1.20, -1.60], [-1.20, 1.60], [1.20, 1.60]]) wheel(c, lx, lz, 0.50, 0.50, false)
  return finish(c)
}

// The demolition crane: a six-wheel carrier with outriggers, a slewing house, a lattice boom of real chords and
// bracing, and a wrecking ball on a chain. Standing up, the boom lies back over the shoulder as a lance.
function makeSloopkraan(color, opts = {}) {
  const c = chassis(color, { ...opts, hide: [0, 1.05, 0.40] }), s = c.shell
  c.on("spine")
  s.paint(loft(profile(1, 1, 0.20), [                                    // carrier deck
    { z: -2.70, sx: 2.24, sy: 0.62, oy: 1.00 },
    { z: -2.20, sx: 2.44, sy: 0.86, oy: 1.02 },
    { z: 1.60, sx: 2.44, sy: 0.90, oy: 1.02 },
    { z: 2.80, sx: 2.20, sy: 0.72, oy: 1.00 },
  ]))
  driver(c, -0.44, 1.86, -2.14, 1.0, null)
  c.on("roof")
  s.paint(loft(profile(1, 1, 0.24), [                                    // driving cab, forward on the left
    { z: -2.78, sx: 1.36, sy: 1.20, oy: 2.10 },
    { z: -2.30, sx: 1.48, sy: 1.36, oy: 2.14 },
    { z: -1.40, sx: 1.42, sy: 1.24, oy: 2.08 },
  ].map((st) => ({ ...st, ox: -0.44 }))))
  s.glass(at(panel(1.20, 0.86, 0.04, { r: 0.10, bevel: 0.015 }), -0.44, 2.20, -2.84, -0.16))
  s.glass(at(panel(0.90, 0.80, 0.03, { r: 0.08, bevel: 0.01 }), -1.16, 2.18, -2.10, 0, Math.PI / 2, 0))
  for (const sx of [-1, 1]) {                                            // outriggers, stowed against the deck
    c.on("flank", sx)
    s.matte(at(panel(0.30, 0.30, 0.90, { r: 0.06 }), sx * 1.28, 0.78, -1.90), TRIM)
    s.matte(at(panel(0.30, 0.30, 0.90, { r: 0.06 }), sx * 1.28, 0.78, 2.20), TRIM)
    s.chrome(at(panel(0.16, 0.62, 0.16, { r: 0.04 }), sx * 1.34, 0.60, -1.90))
    s.chrome(at(panel(0.16, 0.62, 0.16, { r: 0.04 }), sx * 1.34, 0.60, 2.20))
  }
  // the slewing house becomes the chest, the counterweight the reactor pack
  c.on("bonnet")
  s.matte(at(revolve([[1.02, 0], [1.02, 0.34], [0.92, 0.42]], 16), 0, 1.42, 0.70), 0x3a3d44)
  s.paint(loft(profile(1, 1, 0.18), [
    { z: -0.10, sx: 1.84, sy: 1.10, oy: 2.42 },
    { z: 1.10, sx: 1.90, sy: 1.16, oy: 2.44 },
    { z: 2.10, sx: 1.72, sy: 1.02, oy: 2.40 },
  ]))
  headlamp(c, -0.86, 1.16, -2.76, 0.28, 0.16); headlamp(c, 0.86, 1.16, -2.76, 0.28, 0.16)
  c.on("rear")
  s.matte(at(panel(2.00, 1.00, 0.44, { r: 0.06 }), 0, 2.30, 2.28), 0x2f333a)                    // counterweight
  s.matte(at(revolve([[0.001, -0.42], [0.34, -0.42], [0.34, 0.42], [0.001, 0.42]], 12), 0, 2.54, 0.80, 0, 0, Math.PI / 2), TRIM)  // winch drum
  taillamp(c, -0.86, 1.16, 2.86, 0.24, 0.14); taillamp(c, 0.86, 1.16, 2.86, 0.24, 0.14)
  exhaust(c, [0.90], 1.60, 1.80, 0.09)
  flames(c, [0.90], 1.60, 1.96, 0.7)
  // the boom: four chords with zigzag bracing, hinged at the house so Combat can dip the pivot inside its mount
  const bm = articulated(c, 0, 2.60, 0.30, 0.75)
  const pivot = bm.pivot
  const bs = c.kit.section(pivot)
  const BAYS = 6, LEN = 7.2, HALF = 0.22
  for (const [ox, oy] of [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]) bs.paint(strut(ox, oy, 0, ox, oy, -LEN, 0.055, 6))
  for (let i = 0; i < BAYS; i++) {
    const z0 = -LEN * (i / BAYS), z1 = -LEN * ((i + 1) / BAYS), flip = i % 2 ? 1 : -1
    bs.chrome(strut(-HALF, -HALF * flip, z0, HALF, HALF * flip, z1, 0.028, 5))
    bs.chrome(strut(-HALF, HALF * flip, z0, HALF, -HALF * flip, z1, 0.028, 5))
    bs.chrome(strut(-HALF, -HALF, z1, -HALF, HALF, z1, 0.028, 5))
    bs.chrome(strut(HALF, -HALF, z1, HALF, HALF, z1, 0.028, 5))
  }
  bs.chrome(at(revolve([[0.001, -0.1], [0.22, -0.1], [0.22, 0.1], [0.001, 0.1]], 10), 0, 0, -LEN, 0, 0, Math.PI / 2))   // head sheave
  const tip = new THREE.Group(); tip.position.set(0, 0, -LEN); tip.rotation.x = -0.75; pivot.add(tip)
  const tipSec = c.kit.section(tip)
  for (let i = 0; i < 7; i++) {                                         // the chain, link by link
    const y = -0.24 - i * 0.34
    tipSec.chrome(at(new THREE.TorusGeometry(0.11, 0.035, 4, 9), 0, y, 0, Math.PI / 2, i % 2 ? Math.PI / 2 : 0))
  }
  tipSec.chrome(at(revolve([[0.001, 0], [0.14, 0.04], [0.14, 0.18], [0.001, 0.22]], 10), 0, -2.44, 0))
  const ball = new THREE.Group(); ball.position.set(0, -3.20, 0); tip.add(ball)
  const ballSec = c.kit.section(ball)
  ballSec.matte(new THREE.SphereGeometry(0.85, 16, 12), 0x2b2e34)
  for (let i = 0; i < 6; i++) ballSec.chrome(at(new THREE.SphereGeometry(0.09, 6, 5), 0, 0.84 * Math.cos(i), 0, 0, 0, 0))
  c.on("spine")
  for (const [lx, lz] of [[-1.30, -2.00], [1.30, -2.00], [-1.30, 0.80], [1.30, 0.80], [-1.30, 2.00], [1.30, 2.00]]) {
    wheel(c, lx, lz, 0.50, 0.42); fender(c, lx, lz, 0.50, 0.42, 1.14)
  }
  c.root.userData.anim = { pivot, tip, ball }
  return finish(c, (cc) => cc.extra.push({ mount: bm.mount,
    pose: { walk: fitTo(bm.mount, { rotation: new THREE.Euler(-0.55, 0, 0), size: new THREE.Vector3(0.34, 2.90, 0.60), centre: new THREE.Vector3(0.30, 3.30, 0.95), max: 1.0 }), t0: 0.58, t1: 1.0 } }))
}

const BUILDERS = { auto: makeCarMesh, brommer: makeBrommer, trike: makeTrike, monster: makeMonster, tank: makeTank, bulldozer: makeBulldozer, sloopkraan: makeSloopkraan }
