import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { softTexture } from "game/Effects"

// The six vehicles, fast to slow, each with its own trick, plus the plain car everyone drove before. The numbers
// feed Vehicle.js (physics), Combat.js (ram, clear, push) and Camera.js (cam scales the chase distance and height).
// The mesh builders honour the contract the suspension and the effects expect: userData.wheels (a pivot per wheel
// at its corner, with its radius), userData.lights (head and tail materials) and userData.flames (exhaust sprites).
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

export const vehicleSpec = (id) => VEHICLES.find((v) => v.id === id) ?? (id === "auto" ? AUTO : VEHICLES[1])

export function makeVehicleMesh(id, color = 0xd7412b) {
  return (BUILDERS[id] ?? makeCarMesh)(color)
}

// ---- shared parts ------------------------------------------------------------------------------------------------

let flameMat = null
const flameMaterial = () => flameMat ??= new THREE.SpriteMaterial({ map: softTexture(), color: 0xff8a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })

function materials(color) {
  return {
    paint: new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.4 }),
    dark:  new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x6b6f76, metalness: 0.6, roughness: 0.45 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x2a3540, roughness: 0.2, metalness: 0.4 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xf2b21e, roughness: 0.5 }),
    head:  new THREE.MeshStandardMaterial({ color: 0xfff8e6, emissive: 0xfff3cc, emissiveIntensity: 0.35, roughness: 0.3 }),
    tail:  new THREE.MeshStandardMaterial({ color: 0x7a1010, emissive: 0xff1a12, emissiveIntensity: 0.12, roughness: 0.4 }),
  }
}

function box(g, mat, w, h, d, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); return m }

// a wheel on a pivot at its corner; the suspension moves the pivot up and down and steers the front ones
function wheel(g, mat, lx, lz, r, width, visible = true) {
  const pivot = new THREE.Group(); pivot.position.set(lx, r, lz)
  const geo = new THREE.CylinderGeometry(r, r, width, 14); geo.rotateZ(Math.PI / 2)
  const mesh = new THREE.Mesh(geo, mat); mesh.visible = visible
  pivot.add(mesh); g.add(pivot)
  return { pivot, mesh, lx, lz, front: lz < 0, r }
}

// headlights at the nose, tail lights at the back
function lamps(g, m, zFront, zBack, y, xs, w = 0.34) {
  const lamp = new THREE.BoxGeometry(w, 0.16, 0.06)
  for (const x of xs) {
    const h = new THREE.Mesh(lamp, m.head); h.position.set(x, y, zFront); g.add(h)
    const t = new THREE.Mesh(lamp, m.tail); t.position.set(x, y + 0.04, zBack); g.add(t)
  }
}

function flames(g, xs, y, z) {
  return xs.map((x) => { const s = new THREE.Sprite(flameMaterial()); s.position.set(x, y, z); s.scale.setScalar(0); s.visible = false; g.add(s); return s })
}

function finish(g, m, wheels, fl = []) {
  g.userData.lights = { head: m.head, tail: m.tail }
  g.userData.wheels = wheels
  g.userData.flames = fl
  return g
}

// ---- the meshes ----------------------------------------------------------------------------------------------------

// The plain car: everyone's ride before the vastelaovend mode, still the fallback for remotes without a vehicle.
export function makeCarMesh(color = 0xd7412b) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 1.8, 0.55, 4.1, 0, 0.55, 0)
  box(g, m.paint, 1.6, 0.5, 1.9, 0, 1.05, -0.2)
  const r = T.susp.wheelRadius
  const wheels = [[-0.85, -1.3], [0.85, -1.3], [-0.85, 1.3], [0.85, 1.3]].map(([lx, lz]) => wheel(g, m.dark, lx, lz, r, 0.25))
  lamps(g, m, -2.06, 2.06, 0.62, [-0.6, 0.6])
  return finish(g, m, wheels, flames(g, [-0.45, 0.45], 0.42, 2.25))
}

// a moped with a rider: two wheels in line, a slim body, handlebars
function makeBrommer(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 0.4, 0.45, 1.5, 0, 0.62, 0.05)                 // frame and tank
  box(g, m.dark, 0.42, 0.14, 0.7, 0, 0.9, 0.35)                   // saddle
  box(g, m.steel, 0.08, 0.7, 0.08, 0, 0.9, -0.62)                 // steering column
  box(g, m.steel, 0.7, 0.05, 0.05, 0, 1.25, -0.62)                // handlebars
  box(g, m.paint, 0.4, 0.62, 0.32, 0, 1.4, 0.3)                   // rider
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), m.dark); head.position.set(0, 1.9, 0.28); g.add(head)   // helmet
  const wheels = [wheel(g, m.dark, 0, -0.65, 0.3, 0.12), wheel(g, m.dark, 0, 0.65, 0.3, 0.12)]
  lamps(g, m, -0.95, 0.95, 0.75, [0], 0.2)
  return finish(g, m, wheels, flames(g, [0.2], 0.45, 0.95))
}

// a three-wheeler: one wheel up front, a low pod, two missile tubes along the sides
function makeTrike(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 1.2, 0.5, 2.2, 0, 0.6, 0.2)
  box(g, m.glass, 0.9, 0.35, 0.8, 0, 1.0, -0.2)
  box(g, m.steel, 0.14, 0.14, 1.2, 0, 0.9, -0.6)                  // fork
  for (const x of [-0.75, 0.75]) { const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.4, 10), m.steel); tube.rotation.x = Math.PI / 2; tube.position.set(x, 0.95, -0.1); g.add(tube) }
  const wheels = [wheel(g, m.dark, 0, -1.05, 0.34, 0.2), wheel(g, m.dark, -0.7, 0.9, 0.36, 0.3), wheel(g, m.dark, 0.7, 0.9, 0.36, 0.3)]
  lamps(g, m, -1.3, 1.3, 0.7, [0], 0.3)
  return finish(g, m, wheels, flames(g, [-0.35, 0.35], 0.5, 1.35))
}

// a pickup on giant wheels
function makeMonster(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 1.9, 0.6, 4.2, 0, 1.75, 0.1)
  box(g, m.paint, 1.7, 0.6, 1.6, 0, 2.35, -0.6)
  box(g, m.glass, 1.5, 0.4, 0.15, 0, 2.4, -1.42)
  box(g, m.steel, 0.9, 0.3, 3.6, 0, 1.3, 0)                       // chassis
  for (const [x, z] of [[-1.2, -1.7], [1.2, -1.7], [-1.2, 1.7], [1.2, 1.7]]) box(g, m.steel, 0.2, 0.9, 0.2, x * 0.7, 1.15, z)   // axles
  const wheels = [[-1.2, -1.7], [1.2, -1.7], [-1.2, 1.7], [1.2, 1.7]].map(([lx, lz]) => wheel(g, m.dark, lx, lz, 0.9, 0.7))
  lamps(g, m, -2.12, 2.12, 1.85, [-0.6, 0.6])
  return finish(g, m, wheels, flames(g, [-0.5, 0.5], 1.5, 2.3))
}

// a tank: hull between two tracks, a turret with a long barrel; the wheels that follow the ground hide inside the tracks
function makeTank(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 2.6, 1.0, 6.0, 0, 1.05, 0)
  for (const x of [-1.5, 1.5]) box(g, m.dark, 0.8, 0.9, 6.3, x, 0.6, 0)
  const turret = new THREE.Group(); turret.position.set(0, 1.55, 0.3); g.add(turret)
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.7, 16), m.paint); dome.position.y = 0.35; turret.add(dome)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 3.6, 10), m.steel); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.45, -2.5); turret.add(barrel)
  const wheels = [[-1.5, -2.2], [1.5, -2.2], [-1.5, 2.2], [1.5, 2.2]].map(([lx, lz]) => wheel(g, m.dark, lx, lz, 0.45, 0.6, false))
  lamps(g, m, -3.02, 3.02, 1.0, [-0.9, 0.9])
  g.userData.anim = { turret, barrel }
  return finish(g, m, wheels)
}

// a bulldozer: a squat hull on tracks, a cab, and a blade on two arms out front
function makeBulldozer(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.yellow, 2.4, 1.2, 3.6, 0, 1.3, 0.3)
  box(g, m.paint, 1.8, 1.2, 1.6, 0, 2.5, 0.5)
  box(g, m.glass, 1.6, 0.6, 0.15, 0, 2.6, -0.32)
  for (const x of [-1.35, 1.35]) box(g, m.dark, 0.7, 1.0, 4.0, x, 0.6, 0.2)
  for (const x of [-1.2, 1.2]) box(g, m.steel, 0.16, 0.16, 2.2, x, 0.9, -1.7)                      // arms
  box(g, m.steel, 3.4, 1.2, 0.25, 0, 0.75, -2.85)                                                  // blade
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8), m.dark); pipe.position.set(0.8, 2.4, 1.0); g.add(pipe)
  const wheels = [[-1.35, -1.5], [1.35, -1.5], [-1.35, 1.5], [1.35, 1.5]].map(([lx, lz]) => wheel(g, m.dark, lx, lz, 0.5, 0.5, false))
  lamps(g, m, -2.98, 2.1, 2.7, [-0.6, 0.6], 0.3)
  return finish(g, m, wheels)
}

// a crane truck with a raised boom and a wrecking ball on a chain
function makeSloopkraan(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 2.4, 1.0, 5.0, 0, 1.0, 0.4)
  box(g, m.paint, 2.2, 1.4, 1.8, 0, 2.0, -1.8)
  box(g, m.glass, 2.0, 0.7, 0.15, 0, 2.2, -2.72)
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 0.6, 14), m.yellow); base.position.set(0, 1.8, 0.8); g.add(base)
  const pivot = new THREE.Group(); pivot.position.set(0, 2.2, 0.8); pivot.rotation.x = 0.75; g.add(pivot)    // the boom, tilted up
  box(pivot, m.yellow, 0.3, 0.3, 6.5, 0, 0, -3.25)
  const tip = new THREE.Group(); tip.position.set(0, 0, -6.4); tip.rotation.x = -0.75; pivot.add(tip)         // the chain hangs straight down
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6), m.steel); chain.position.y = -1.3; tip.add(chain)
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.85, 14, 10), m.dark); ball.position.y = -3.2; tip.add(ball)
  const wheels = [[-1.2, -1.8], [1.2, -1.8], [-1.2, 0.8], [1.2, 0.8], [-1.2, 2.4], [1.2, 2.4]].map(([lx, lz]) => wheel(g, m.dark, lx, lz, 0.5, 0.45))
  lamps(g, m, -3.02, 2.92, 1.4, [-0.8, 0.8])
  g.userData.anim = { pivot, tip, ball }
  return finish(g, m, wheels)
}

const BUILDERS = { auto: makeCarMesh, brommer: makeBrommer, trike: makeTrike, monster: makeMonster, tank: makeTank, bulldozer: makeBulldozer, sloopkraan: makeSloopkraan }
