import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { softTexture } from "game/Effects"
import { Kit, loft, profile, panel, revolve, strut, arch, tyreGeometry, rimGeometry } from "game/VehicleParts"

// The six vehicles, fast to slow, each with its own trick, plus the plain car everyone drove before. The numbers
// feed Vehicle.js (physics), Combat.js (ram, clear, push) and Camera.js (cam scales the chase distance and height).
//
// The meshes are coachbuilt out of VehicleParts rather than stacked out of boxes: a lofted shell with a real
// shoulder line and a tapering nose, pressed wheel arches over tyres with sidewalls and tread, a greenhouse of
// pillars and separate glass, chrome trim that catches the sky environment map, lamps with a lens in a bezel, and
// a driver you can see through the screen. Every part lands in a material bucket and the buckets merge, so a car
// that is sixty pieces still costs six draw calls for its body plus two per wheel.
//
// The contract the rest of the game reads is unchanged: userData.wheels (a pivot per wheel at its corner with its
// radius; Suspension writes pivot.position.y, pivot.rotation.y and mesh.rotation.x), userData.lights (the head and
// tail materials whose emissiveIntensity Vehicle and RemoteCars animate), userData.flames (the exhaust sprites) and
// userData.anim (the turret, the boom). New: userData.fold(k), which poses the machine between driving (k = 0) and
// a folded block (k = 1) for the transformation in Avatar.js. Everything a fold moves hangs off one inner group, so
// the root transform that Suspension writes every frame is never fought over.
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

// The fold: how far each degree of freedom travels between driving and a folded block. k is linear here on purpose —
// Avatar.js supplies the easing, and the unfold curve deliberately passes through negative k for the landing squat,
// which a smoothstep inside this function would turn back into a positive fold.
const FOLD_PITCH = 0.60        // rad the shell rears up as it folds
const FOLD_RISE = 0.45         // metres the folded block lifts off its wheels
const FOLD_SQUEEZE = 0.55      // share of the length folded away
const FOLD_NARROW = 0.20       // share of the width pulled in
const FOLD_TALL = 0.50         // share of extra height as the shell stands on end
const FOLD_TUCK = 0.62         // share of the track the wheels pull in by
const FOLD_CAMBER = 1.35       // rad the wheels lie over as they stow
const FOLD_HUNCH = 0.5         // rad the stowed wheels rotate about the axle
const FOLD_LIFT = 0.55         // wheel radii the stowed wheels climb into the arches

const CAR_COLOUR = 0xd7412b    // the default red, also the fallback for remotes without one
const PLANT_YELLOW = 0xe8a91c  // construction plant is yellow whoever is driving it
const TYRE = 0x16171b, TRIM = 0x22252b, SEAT = 0x2a2f38, JACKET = 0x2c3a52, SKIN = 0xc79a72

export const vehicleSpec = (id) => VEHICLES.find((v) => v.id === id) ?? (id === "auto" ? AUTO : VEHICLES[1])

export function makeVehicleMesh(id, color = CAR_COLOUR) {
  return (BUILDERS[id] ?? makeCarMesh)(color)
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

// A vehicle under construction: the root the game moves, one inner group that the fold poses, and the kit that
// collects every part per material.
function chassis(color) {
  const root = new THREE.Group(), body = new THREE.Group()
  root.add(body)
  const kit = new Kit(color)
  return { root, body, kit, shell: kit.section(body), wheels: [], flames: [] }
}

// a wheel on a pivot at its corner; the suspension moves the pivot up and down and steers the front ones
function wheel(c, lx, lz, r, width, visible = true) {
  const pivot = new THREE.Group(); pivot.position.set(lx, r, lz)
  const mesh = new THREE.Group()
  const s = c.kit.section(mesh)
  s.rubber(tyreGeometry(r, width))
  s.chrome(rimGeometry(r, width, lx <= 0 ? 1 : -1))
  mesh.visible = visible
  pivot.add(mesh)
  c.body.add(pivot)
  const w = { pivot, mesh, lx, lz, front: lz < 0, r }
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
// that only shows up under real boost.
function flames(c, xs, y, z, size = 1) {
  for (const x of xs) {
    const mat = new THREE.SpriteMaterial({ map: softTexture(), color: 0xff8a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    const coreMat = new THREE.SpriteMaterial({ map: softTexture(), color: 0xfff0c0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    const sprite = new THREE.Sprite(mat), core = new THREE.Sprite(coreMat)
    sprite.position.set(x, y, z); core.position.set(x, y, z)
    sprite.scale.setScalar(0); core.scale.setScalar(0)
    sprite.visible = core.visible = false
    c.body.add(sprite, core)
    c.flames.push({ sprite, mat, core, coreMat, size, phase: Math.random() * 6.283 })
  }
}

// exhaust tips, so the flames come out of something
function exhaust(c, xs, y, z, r = 0.07) {
  for (const x of xs) c.shell.chrome(at(revolve([[r * 0.7, -0.22], [r, -0.2], [r, 0.16], [r * 1.25, 0.2], [r * 1.25, 0.22], [r * 0.9, 0.22]], 10), x, y, z, Math.PI / 2))
}

function finish(c, extra = null) {
  const mats = c.kit.build()
  const g = c.root
  g.userData.lights = { head: mats.head, tail: mats.tail }
  g.userData.wheels = c.wheels
  g.userData.flames = c.flames
  g.userData.fold = makeFold(c, extra)
  return g
}

// k = 0 is the driving pose, k = 1 the folded block. Called once a frame after the suspension has written the
// wheels and the root, so everything it touches is either the inner group (which nothing else writes) or a wheel
// pivot channel the suspension leaves alone.
function makeFold(c, extra) {
  const body = c.body, base = c.wheels.map((w) => ({ w, lx: w.lx, lz: w.lz }))
  return (k) => {
    for (const { w, lx, lz } of base) {
      w.pivot.position.x = lx * (1 - FOLD_TUCK * k)
      w.pivot.position.z = lz * (1 - FOLD_TUCK * 0.85 * k)
      w.pivot.position.y += FOLD_LIFT * w.r * k
      w.pivot.rotation.z = (lx < 0 ? -1 : 1) * FOLD_CAMBER * k
      w.pivot.rotation.x = FOLD_HUNCH * k
    }
    body.scale.set(1 - FOLD_NARROW * k, 1 + FOLD_TALL * k, 1 - FOLD_SQUEEZE * k)
    body.position.y = FOLD_RISE * k
    body.rotation.x = -FOLD_PITCH * k
    extra?.(k)
  }
}

// ---- the meshes ----------------------------------------------------------------------------------------------------

// The plain car: everyone's ride before the vastelaovend mode, still the fallback for remotes without a vehicle.
// Length 4.1, wheelbase 2.6, track 1.6 — the spec Combat probes with, so the shell is drawn to those numbers.
export function makeCarMesh(color = CAR_COLOUR) {
  const c = chassis(color), s = c.shell, r = T.susp.wheelRadius
  const sec = profile(1, 1, 0.30)
  // the shell: a nose that tapers, a shoulder line that swells over the arches and a tail that pulls back in
  s.paint(loft(sec, [
    { z: -2.05, sx: 1.40, sy: 0.40, oy: 0.66 },
    { z: -1.72, sx: 1.66, sy: 0.56, oy: 0.62 },
    { z: -1.10, sx: 1.78, sy: 0.72, oy: 0.62 },
    { z: -0.10, sx: 1.82, sy: 0.78, oy: 0.63 },
    { z: 1.05, sx: 1.80, sy: 0.76, oy: 0.63 },
    { z: 1.74, sx: 1.66, sy: 0.60, oy: 0.63 },
    { z: 2.05, sx: 1.44, sy: 0.44, oy: 0.64 },
  ]))
  // the greenhouse: a roof slab on four pillars, glass hung between them
  s.paint(loft(profile(1, 1, 0.35), [
    { z: -0.62, sx: 1.44, sy: 0.13, oy: 1.36 },
    { z: -0.20, sx: 1.52, sy: 0.15, oy: 1.40 },
    { z: 0.62, sx: 1.50, sy: 0.15, oy: 1.39 },
    { z: 0.98, sx: 1.34, sy: 0.12, oy: 1.33 },
  ]))
  for (const sx of [-1, 1]) {
    s.paint(at(strut(sx * 0.66, 1.00, -0.98, sx * 0.62, 1.34, -0.52, 0.065, 6), 0, 0, 0))      // A-pillar
    s.paint(at(strut(sx * 0.74, 1.00, 0.86, sx * 0.66, 1.34, 0.62, 0.07, 6), 0, 0, 0))         // C-pillar
    s.chrome(at(panel(0.05, 0.06, 1.30, { r: 0.02 }), sx * 0.90, 1.00, 0.0))                    // shoulder trim strip
    s.glass(at(panel(1.30, 0.34, 0.03, { r: 0.06, bevel: 0.01 }), sx * 0.865, 1.17, 0.06, 0, Math.PI / 2, 0.02))
    s.matte(at(revolve([[0.001, 0], [0.05, 0.02], [0.05, 0.09]], 8), sx * 0.92, 1.06, -0.70, 0, 0, sx * 0.5), TRIM)   // mirror stalk
    s.chrome(at(panel(0.19, 0.12, 0.09, { r: 0.04 }), sx * 1.02, 1.11, -0.70, 0, 0.2, 0))       // mirror shell
  }
  s.glass(at(panel(1.42, 0.60, 0.04, { r: 0.12, bevel: 0.015 }), 0, 1.18, -0.80, -0.62))        // windscreen
  s.glass(at(panel(1.34, 0.48, 0.04, { r: 0.10, bevel: 0.015 }), 0, 1.20, 0.82, 0.72))          // rear screen
  // nose: grille, splitter, number plate; tail: bumper and a diffuser
  s.matte(at(panel(1.16, 0.26, 0.10, { r: 0.05 }), 0, 0.68, -2.06), 0x15171a)
  s.chrome(at(panel(1.22, 0.06, 0.05, { r: 0.02 }), 0, 0.83, -2.06))
  s.matte(at(panel(1.70, 0.16, 0.26, { r: 0.06 }), 0, 0.42, -1.96), TRIM)
  s.matte(at(panel(1.76, 0.20, 0.24, { r: 0.07 }), 0, 0.46, 1.98), TRIM)
  s.matte(at(panel(0.44, 0.13, 0.03, { r: 0.02 }), 0, 0.50, -2.10), 0xdcd8cc)
  // seats and a driver behind the wheel, visible through the screen
  for (const sx of [-1, 1]) s.matte(at(panel(0.44, 0.76, 0.16, { r: 0.08 }), sx * 0.36, 0.94, 0.40), SEAT)
  s.matte(at(revolve([[0.001, 0], [0.14, 0], [0.16, 0.02], [0.16, 0.04]], 12), -0.36, 0.92, -0.42, 1.2), TRIM)
  driver(c, -0.36, 0.50, 0.26)
  // wheels at the spec's wheelbase and track, each under its own pressed arch
  for (const [lx, lz] of [[-0.80, -1.30], [0.80, -1.30], [-0.80, 1.30], [0.80, 1.30]]) {
    wheel(c, lx, lz, r, 0.26)
    fender(c, lx, lz, r, 0.26)
  }
  headlamp(c, -0.58, 0.80, -2.07); headlamp(c, 0.58, 0.80, -2.07)
  taillamp(c, -0.60, 0.86, 2.07); taillamp(c, 0.60, 0.86, 2.07)
  exhaust(c, [-0.42, 0.42], 0.42, 2.12)
  flames(c, [-0.42, 0.42], 0.42, 2.26)
  return finish(c)
}

// The moped: two wheels in line, a tank you could sit astride, a rider leaning over the bars.
function makeBrommer(color) {
  const c = chassis(color), s = c.shell
  s.paint(loft(profile(1, 1, 0.34), [                                   // tank and tail unit
    { z: -0.62, sx: 0.26, sy: 0.30, oy: 0.80 },
    { z: -0.30, sx: 0.40, sy: 0.42, oy: 0.80 },
    { z: 0.18, sx: 0.42, sy: 0.44, oy: 0.78 },
    { z: 0.62, sx: 0.34, sy: 0.30, oy: 0.86 },
    { z: 0.90, sx: 0.22, sy: 0.18, oy: 0.88 },
  ]))
  s.paint(at(panel(0.34, 0.30, 0.46, { r: 0.12 }), 0, 0.52, -0.62))      // front mudguard fairing
  s.matte(at(panel(0.40, 0.12, 0.52, { r: 0.06 }), 0, 0.99, 0.30), SEAT) // saddle
  s.chrome(at(strut(0, 0.95, -0.58, 0, 0.36, -0.66, 0.045, 8), 0, 0, 0)) // fork leg, left
  s.chrome(at(strut(-0.1, 0.95, -0.58, -0.1, 0.36, -0.66, 0.035, 6), 0, 0, 0))
  s.chrome(at(strut(0.1, 0.95, -0.58, 0.1, 0.36, -0.66, 0.035, 6), 0, 0, 0))
  s.chrome(at(panel(0.62, 0.045, 0.045, { r: 0.02 }), 0, 1.06, -0.60))   // handlebars
  for (const sx of [-1, 1]) s.matte(at(panel(0.12, 0.05, 0.05, { r: 0.02 }), sx * 0.29, 1.06, -0.60), TRIM)
  s.chrome(at(revolve([[0.05, -0.34], [0.055, 0.2], [0.075, 0.24], [0.075, 0.3]], 10), 0.13, 0.42, 0.5, Math.PI / 2))  // silencer
  s.matte(at(panel(0.30, 0.18, 0.05, { r: 0.06 }), 0, 0.28, 0.62), TRIM) // rear mudguard
  driver(c, 0, 1.12, 0.18, 1.0, 0x1d2a3a)
  wheel(c, 0, -0.65, 0.30, 0.11)
  wheel(c, 0, 0.65, 0.30, 0.13)
  headlamp(c, 0, 0.92, -0.72, 0.20, 0.20)
  taillamp(c, 0, 0.88, 0.92, 0.14, 0.10)
  flames(c, [0.13], 0.42, 0.84, 0.6)
  return finish(c)
}

// The trike: one wheel under a pointed nose, a low pod the rider lies in, a missile tube along each flank.
function makeTrike(color) {
  const c = chassis(color), s = c.shell
  s.paint(loft(profile(1, 1, 0.33), [
    { z: -1.28, sx: 0.30, sy: 0.26, oy: 0.62 },
    { z: -0.85, sx: 0.72, sy: 0.44, oy: 0.60 },
    { z: -0.10, sx: 1.16, sy: 0.62, oy: 0.62 },
    { z: 0.70, sx: 1.26, sy: 0.66, oy: 0.62 },
    { z: 1.24, sx: 1.04, sy: 0.48, oy: 0.64 },
  ]))
  s.glass(at(panel(0.86, 0.46, 0.04, { r: 0.16, bevel: 0.015 }), 0, 1.02, -0.42, -0.5))     // bubble screen
  s.paint(at(panel(0.92, 0.14, 0.56, { r: 0.16 }), 0, 1.14, 0.44))                           // headrest fairing
  for (const sx of [-1, 1]) {
    s.chrome(at(revolve([[0.10, -0.70], [0.11, -0.6], [0.11, 0.58], [0.13, 0.66], [0.13, 0.70]], 10), sx * 0.72, 0.92, -0.10, Math.PI / 2))   // missile tube
    s.matte(at(panel(0.08, 0.20, 0.34, { r: 0.03 }), sx * 0.72, 0.72, 0.10), TRIM)           // tube mount
    s.paint(at(panel(0.10, 0.30, 0.70, { r: 0.06 }), sx * 0.60, 0.44, 0.86))                 // rear wing endplate
  }
  s.paint(at(panel(1.50, 0.05, 0.30, { r: 0.03 }), 0, 0.58, 0.90))                            // rear wing
  s.chrome(at(strut(0, 0.86, -1.12, 0, 0.38, -0.98, 0.05, 8), 0, 0, 0))                       // fork
  driver(c, 0, 0.84, 0.12, 0.9, 0x7a1414)
  wheel(c, 0, -0.95, 0.34, 0.18); fender(c, 0, -0.95, 0.34, 0.18, 1.30)
  for (const lx of [-0.70, 0.70]) { wheel(c, lx, 0.95, 0.36, 0.28); fender(c, lx, 0.95, 0.36, 0.28) }
  headlamp(c, 0, 0.70, -1.30, 0.24, 0.14)
  taillamp(c, -0.30, 0.74, 1.26, 0.20, 0.10); taillamp(c, 0.30, 0.74, 1.26, 0.20, 0.10)
  exhaust(c, [-0.26, 0.26], 0.52, 1.24, 0.06)
  flames(c, [-0.26, 0.26], 0.52, 1.38, 0.8)
  return finish(c)
}

// The monster truck: a pickup cab and bed on a tube chassis, held a metre in the air by four tractor tyres under
// flared arches, with a roll cage, a light bar and two stacks up the back of the cab.
function makeMonster(color) {
  const c = chassis(color), s = c.shell, r = 0.90
  s.paint(loft(profile(1, 1, 0.28), [                                  // cab
    { z: -2.45, sx: 1.62, sy: 0.42, oy: 1.60 },
    { z: -2.05, sx: 1.84, sy: 0.62, oy: 1.66 },
    { z: -1.20, sx: 1.92, sy: 1.16, oy: 2.02 },
    { z: -0.30, sx: 1.92, sy: 1.20, oy: 2.06 },
    { z: 0.10, sx: 1.86, sy: 1.00, oy: 1.98 },
  ]))
  s.paint(loft(profile(1, 1, 0.22), [                                  // bed
    { z: 0.10, sx: 1.84, sy: 0.66, oy: 1.74 },
    { z: 1.70, sx: 1.84, sy: 0.62, oy: 1.72 },
    { z: 2.55, sx: 1.74, sy: 0.56, oy: 1.72 },
  ]))
  s.matte(at(panel(1.60, 0.44, 2.00, { r: 0.05 }), 0, 1.78, 1.38), 0x30241a)                   // bed floor and its load
  s.glass(at(panel(1.54, 0.66, 0.04, { r: 0.10, bevel: 0.015 }), 0, 2.30, -1.50, -0.42))       // windscreen
  for (const sx of [-1, 1]) s.glass(at(panel(0.86, 0.58, 0.03, { r: 0.08, bevel: 0.01 }), sx * 0.93, 2.30, -0.86, 0, Math.PI / 2, 0))
  for (const sx of [-1, 1]) {                                                                   // roll cage
    s.chrome(at(strut(sx * 0.88, 2.30, -0.10, sx * 0.88, 2.92, -0.06, 0.055, 6), 0, 0, 0))
    s.chrome(at(strut(sx * 0.88, 2.92, -0.06, sx * 0.82, 2.40, 1.30, 0.05, 6), 0, 0, 0))
  }
  s.chrome(at(panel(1.84, 0.06, 0.06, { r: 0.03 }), 0, 2.92, -0.06))
  s.matte(at(panel(1.20, 0.14, 0.12, { r: 0.05 }), 0, 3.02, -0.30), TRIM)                       // light bar housing
  for (const x of [-0.42, -0.14, 0.14, 0.42]) c.shell.head(at(panel(0.2, 0.13, 0.08, { r: 0.04 }), x, 3.02, -0.38))
  s.matte(at(panel(0.90, 0.34, 3.70, { r: 0.1 }), 0, 1.22, 0.0), 0x3a3d44)                      // chassis rails
  for (const [x, z] of [[-1.20, -1.70], [1.20, -1.70], [-1.20, 1.70], [1.20, 1.70]]) {
    s.chrome(at(strut(0, 1.22, z, x * 0.92, 0.94, z, 0.075, 6), 0, 0, 0))                       // trailing arms
    s.matte(at(panel(0.26, 0.70, 0.26, { r: 0.06 }), x * 0.74, 1.55, z), 0x3a3d44)              // coil-over
  }
  for (const sx of [-1, 1]) s.chrome(at(revolve([[0.075, -0.55], [0.08, 0.4], [0.10, 0.5], [0.10, 0.55]], 10), sx * 0.70, 2.75, 0.14))
  driver(c, -0.44, 1.55, -0.55, 1.0, 0xd8d2c4)
  for (const [lx, lz] of [[-1.20, -1.70], [1.20, -1.70], [-1.20, 1.70], [1.20, 1.70]]) {
    wheel(c, lx, lz, r, 0.70)
    fender(c, lx, lz, r, 0.70, 1.12)
  }
  headlamp(c, -0.60, 1.70, -2.47, 0.40, 0.20); headlamp(c, 0.60, 1.70, -2.47, 0.40, 0.20)
  taillamp(c, -0.66, 1.80, 2.57, 0.34, 0.18); taillamp(c, 0.66, 1.80, 2.57, 0.34, 0.18)
  flames(c, [-0.70, 0.70], 3.30, 0.14, 1.2)
  return finish(c)
}

// The tank: a sloped welded hull between two track units, a cast turret with a mantlet and a long gun. The wheels
// the suspension follows the ground with are hidden inside the tracks, exactly as before.
function makeTank(color) {
  const c = chassis(color), s = c.shell
  s.paint(loft(profile(1, 1, 0.16), [                                    // hull, glacis sloped at both ends
    { z: -3.20, sx: 2.10, sy: 0.44, oy: 0.98 },
    { z: -2.40, sx: 2.44, sy: 0.86, oy: 1.12 },
    { z: -0.60, sx: 2.60, sy: 1.00, oy: 1.16 },
    { z: 1.60, sx: 2.58, sy: 0.98, oy: 1.16 },
    { z: 2.80, sx: 2.34, sy: 0.78, oy: 1.10 },
    { z: 3.20, sx: 2.06, sy: 0.54, oy: 1.04 },
  ]))
  for (const sx of [-1, 1]) {
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
  s.matte(at(panel(2.10, 0.12, 0.34, { r: 0.05 }), 0, 1.38, -3.26), TRIM)                       // glacis plate trim
  const turret = new THREE.Group(); turret.position.set(0, 1.62, 0.30); c.body.add(turret)
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
  const wheels = [[-1.50, -2.25], [1.50, -2.25], [-1.50, 2.25], [1.50, 2.25]]
  for (const [lx, lz] of wheels) wheel(c, lx, lz, 0.45, 0.60, false)
  headlamp(c, -0.92, 1.30, -3.28, 0.28, 0.18); headlamp(c, 0.92, 1.30, -3.28, 0.28, 0.18)
  taillamp(c, -0.92, 1.30, 3.28, 0.24, 0.14); taillamp(c, 0.92, 1.30, 3.28, 0.24, 0.14)
  exhaust(c, [-1.00, 1.00], 1.48, 2.80, 0.10)
  flames(c, [-1.00, 1.00], 1.48, 2.98, 1.0)
  c.root.userData.anim = { turret, barrel }
  return finish(c)
}

// The bulldozer: a squat yellow hull on tracks, a glazed ROPS cab, a stack, and a mouldboard blade on two push arms
// with a cutting edge and hydraulic rams.
function makeBulldozer() {
  const c = chassis(PLANT_YELLOW), s = c.shell
  s.paint(loft(profile(1, 1, 0.22), [
    { z: -1.50, sx: 2.10, sy: 0.86, oy: 1.28 },
    { z: -0.60, sx: 2.36, sy: 1.16, oy: 1.34 },
    { z: 1.10, sx: 2.36, sy: 1.20, oy: 1.34 },
    { z: 2.10, sx: 2.06, sy: 0.92, oy: 1.28 },
  ]))
  s.paint(loft(profile(1, 1, 0.26), [                                                         // cab shell
    { z: -0.10, sx: 1.70, sy: 1.30, oy: 2.52 },
    { z: 0.50, sx: 1.80, sy: 1.42, oy: 2.56 },
    { z: 1.30, sx: 1.72, sy: 1.28, oy: 2.50 },
  ]))
  s.glass(at(panel(1.44, 0.92, 0.04, { r: 0.10, bevel: 0.015 }), 0, 2.62, -0.20, -0.18))
  for (const sx of [-1, 1]) s.glass(at(panel(1.10, 0.86, 0.03, { r: 0.08, bevel: 0.01 }), sx * 0.90, 2.60, 0.58, 0, Math.PI / 2, 0))
  s.glass(at(panel(1.36, 0.80, 0.04, { r: 0.10, bevel: 0.015 }), 0, 2.60, 1.34, 0.16))
  for (const sx of [-1, 1]) {
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
  s.paint(loft(profile(1, 1, 0.10), [
    { z: -0.20, sx: 3.40, sy: 0.30, oy: 0.28 },
    { z: -0.06, sx: 3.44, sy: 0.56, oy: 0.64 },
    { z: 0.08, sx: 3.44, sy: 0.58, oy: 1.02 },
    { z: 0.22, sx: 3.38, sy: 0.34, oy: 1.34 },
  ].map((st) => ({ ...st, z: st.z - 2.92 }))))
  s.matte(at(panel(3.44, 0.16, 0.20, { r: 0.04 }), 0, 0.22, -2.96), 0x4a4d55)
  for (const x of [-1.20, 0, 1.20]) s.matte(at(panel(0.22, 0.26, 0.26, { r: 0.05 }), x, 0.22, -3.04), 0x5a5d65)   // cutting teeth
  s.chrome(at(revolve([[0.09, -0.55], [0.10, 0.42], [0.13, 0.5], [0.13, 0.55]], 10), 0.80, 3.10, 0.90))        // stack
  s.matte(at(revolve([[0.14, 0], [0.14, 0.18], [0.10, 0.22]], 10), 0.80, 3.56, 0.90), TRIM)                        // rain cap
  driver(c, 0, 2.10, 0.60, 1.0, null)
  const wheels = [[-1.20, -1.60], [1.20, -1.60], [-1.20, 1.60], [1.20, 1.60]]
  for (const [lx, lz] of wheels) wheel(c, lx, lz, 0.50, 0.50, false)
  headlamp(c, -0.62, 3.06, -0.34, 0.26, 0.16); headlamp(c, 0.62, 3.06, -0.34, 0.26, 0.16)
  taillamp(c, -0.72, 2.60, 2.12, 0.22, 0.14); taillamp(c, 0.72, 2.60, 2.12, 0.22, 0.14)
  flames(c, [0.80], 3.66, 0.90, 0.8)
  return finish(c)
}

// The demolition crane: a six-wheel carrier with outriggers, a slewing house, a lattice boom of real chords and
// bracing, and a wrecking ball on a chain.
function makeSloopkraan(color) {
  const c = chassis(color), s = c.shell
  s.paint(loft(profile(1, 1, 0.20), [                                    // carrier deck
    { z: -2.70, sx: 2.24, sy: 0.62, oy: 1.00 },
    { z: -2.20, sx: 2.44, sy: 0.86, oy: 1.02 },
    { z: 1.60, sx: 2.44, sy: 0.90, oy: 1.02 },
    { z: 2.80, sx: 2.20, sy: 0.72, oy: 1.00 },
  ]))
  s.paint(loft(profile(1, 1, 0.24), [                                    // driving cab, forward on the left
    { z: -2.78, sx: 1.36, sy: 1.20, oy: 2.10 },
    { z: -2.30, sx: 1.48, sy: 1.36, oy: 2.14 },
    { z: -1.40, sx: 1.42, sy: 1.24, oy: 2.08 },
  ].map((st) => ({ ...st, ox: -0.44 }))))
  s.glass(at(panel(1.20, 0.86, 0.04, { r: 0.10, bevel: 0.015 }), -0.44, 2.20, -2.84, -0.16))
  s.glass(at(panel(0.90, 0.80, 0.03, { r: 0.08, bevel: 0.01 }), -1.16, 2.18, -2.10, 0, Math.PI / 2, 0))
  for (const sx of [-1, 1]) {                                            // outriggers, stowed against the deck
    s.matte(at(panel(0.30, 0.30, 0.90, { r: 0.06 }), sx * 1.28, 0.78, -1.90), TRIM)
    s.matte(at(panel(0.30, 0.30, 0.90, { r: 0.06 }), sx * 1.28, 0.78, 2.20), TRIM)
    s.chrome(at(panel(0.16, 0.62, 0.16, { r: 0.04 }), sx * 1.34, 0.60, -1.90))
    s.chrome(at(panel(0.16, 0.62, 0.16, { r: 0.04 }), sx * 1.34, 0.60, 2.20))
  }
  // the slewing house and the counterweight
  s.matte(at(revolve([[1.02, 0], [1.02, 0.34], [0.92, 0.42]], 16), 0, 1.42, 0.70), 0x3a3d44)
  s.paint(loft(profile(1, 1, 0.18), [
    { z: -0.10, sx: 1.84, sy: 1.10, oy: 2.42 },
    { z: 1.10, sx: 1.90, sy: 1.16, oy: 2.44 },
    { z: 2.10, sx: 1.72, sy: 1.02, oy: 2.40 },
  ]))
  s.matte(at(panel(2.00, 1.00, 0.44, { r: 0.06 }), 0, 2.30, 2.28), 0x2f333a)                    // counterweight
  s.matte(at(revolve([[0.001, -0.42], [0.34, -0.42], [0.34, 0.42], [0.001, 0.42]], 12), 0, 2.54, 0.80, 0, 0, Math.PI / 2), TRIM)  // winch drum
  // the boom: four chords with zigzag bracing, hinged at the house so Combat can dip it
  const pivot = new THREE.Group(); pivot.position.set(0, 2.60, 0.30); pivot.rotation.x = 0.75; c.body.add(pivot)
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
  driver(c, -0.44, 1.86, -2.14, 1.0, null)
  const wheels = [[-1.30, -2.00], [1.30, -2.00], [-1.30, 0.80], [1.30, 0.80], [-1.30, 2.00], [1.30, 2.00]]
  for (const [lx, lz] of wheels) { wheel(c, lx, lz, 0.50, 0.42); fender(c, lx, lz, 0.50, 0.42, 1.14) }
  headlamp(c, -0.86, 1.16, -2.76, 0.28, 0.16); headlamp(c, 0.86, 1.16, -2.76, 0.28, 0.16)
  taillamp(c, -0.86, 1.16, 2.86, 0.24, 0.14); taillamp(c, 0.86, 1.16, 2.86, 0.24, 0.14)
  exhaust(c, [0.90], 1.60, 1.80, 0.09)
  flames(c, [0.90], 1.60, 1.96, 0.7)
  c.root.userData.anim = { pivot, tip, ball }
  // the boom and its ball unfold with the rest: the boom lies down and the chain swings in against the carrier
  return finish(c, (k) => { pivot.rotation.x = 0.75 + 0.85 * k; tip.rotation.x = -0.75 - 0.85 * k })
}

const BUILDERS = { auto: makeCarMesh, brommer: makeBrommer, trike: makeTrike, monster: makeMonster, tank: makeTank, bulldozer: makeBulldozer, sloopkraan: makeSloopkraan }
