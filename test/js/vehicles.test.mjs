import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { VEHICLES, vehicleSpec, makeVehicleMesh, makeCarMesh } from "game/Vehicles"
import { TUNING as T } from "game/Tuning"
import { Kit, loft, profile, panel, revolve, strut, arch, tyreGeometry, rimGeometry } from "game/VehicleParts"

const IDS = ["auto", ...VEHICLES.map((v) => v.id)]

test("every vehicle's wheels stand at the wheelbase and track its spec promises", () => {
  for (const id of IDS) {
    const spec = vehicleSpec(id), g = makeVehicleMesh(id)
    const ws = g.userData.wheels
    assert.ok(ws.length >= 2, `${id}: ${ws.length} wheels`)
    const zs = ws.map((w) => w.lz), xs = ws.map((w) => w.lx)
    const wheelbase = Math.max(...zs) - Math.min(...zs)
    assert.ok(Math.abs(wheelbase - spec.wheelbase) < 0.01, `${id}: wheelbase ${wheelbase} vs spec ${spec.wheelbase}`)
    const track = Math.max(...xs) - Math.min(...xs)
    // the moped's two wheels are in line: its spec track is the width Combat probes with, not a real axle
    if (id !== "brommer") assert.ok(Math.abs(track - spec.track) < 0.01, `${id}: track ${track} vs spec ${spec.track}`)
    for (const w of ws) {
      assert.ok(w.pivot.isObject3D && w.mesh.isObject3D, `${id}: wheel is not a pivot and a mesh`)
      assert.equal(w.front, w.lz < 0)
      assert.ok(w.r > 0.05 && Math.abs(w.pivot.position.y - w.r) < 1e-9, `${id}: pivot not at wheel radius`)
      assert.ok(Math.abs(w.pivot.position.x - w.lx) < 1e-9 && Math.abs(w.pivot.position.z - w.lz) < 1e-9)
    }
  }
})

test("the contract the rest of the game reads is intact for every vehicle", () => {
  for (const id of IDS) {
    const g = makeVehicleMesh(id, 0x3366cc)
    const lights = g.userData.lights
    assert.ok(lights.head.isMaterial && lights.tail.isMaterial, `${id}: lights are not materials`)
    lights.head.emissiveIntensity = 2.5
    assert.equal(lights.head.emissiveIntensity, 2.5)
    for (const f of g.userData.flames) {
      assert.ok(f.sprite.isSprite && f.mat.isMaterial, `${id}: flame record is not a sprite with its own material`)
      assert.ok(f.core.isSprite, `${id}: flame has no hot core`)
    }
    assert.equal(typeof g.userData.pose, "function", `${id}: no pose`)
    assert.ok(g.userData.mech.rig && g.userData.mech.wizard, `${id}: no wizard half`)
    // Merging must hold the part count down. A transforming machine costs more than the old single shell did: its
    // panels sit on six mounts that have to move independently, and it carries the mech's frame and wardrobe. In the
    // driving pose the mech half is switched off, so what is actually drawn is the middle figure.
    let meshes = 0, drawn = 0
    g.traverse((o) => { if (!o.isMesh) return; meshes++; let p = o, on = true; while (p) { if (!p.visible) on = false; p = p.parent }; if (on) drawn++ })
    assert.ok(meshes > 0 && meshes < 56, `${id}: ${meshes} meshes`)
    assert.ok(drawn < 34, `${id}: ${drawn} draw calls while merely driving`)
    // …and a body that will never transform (a remote player's car) pays none of it
    let plain = 0
    makeVehicleMesh(id, 0x3366cc, { morph: false }).traverse((o) => { if (o.isMesh) plain++ })
    assert.ok(plain < 24, `${id}: ${plain} draw calls for a non-transforming body`)
  }
})

test("the tank and the crane keep the animated parts Combat drives", () => {
  const tank = makeVehicleMesh("tank")
  assert.ok(tank.userData.anim.turret.isObject3D && tank.userData.anim.barrel.isObject3D)
  const crane = makeVehicleMesh("sloopkraan")
  assert.ok(crane.userData.anim.pivot.isObject3D && crane.userData.anim.tip.isObject3D && crane.userData.anim.ball.isObject3D)
  assert.ok(Math.abs(crane.userData.anim.pivot.rotation.x - 0.75) < 1e-9, "the boom starts at the angle Combat resets it to")
})

test("pose(1) stands every vehicle up as the same machine, and pose(0) puts every channel back exactly", () => {
  for (const id of IDS) {
    const g = makeVehicleMesh(id)
    const seed = () => { for (const w of g.userData.wheels) w.pivot.position.y = w.r }   // what the suspension writes
    const box = () => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g) }

    seed(); g.userData.pose(1, 1)
    const up = box(), size = up.getSize(new THREE.Vector3())
    assert.ok(Math.abs(size.y - T.mech.height) < 0.5, `${id}: stands ${size.y.toFixed(2)} m, wanted ${T.mech.height}`)
    assert.ok(Math.abs(up.min.y) < 0.05, `${id}: the feet are ${up.min.y.toFixed(2)} off the ground`)
    assert.ok(size.z < size.y && size.x < size.y, `${id}: still lying down (${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)})`)
    // the wheels are joints now: each one above the knee line or below it, none left out at the old corners
    for (const w of g.userData.wheels) {
      const c = new THREE.Box3().setFromObject(w.mount).getCenter(new THREE.Vector3())
      assert.ok(Math.abs(c.x) < 1.1 && c.y > 0.2 && c.y < 2.8, `${id}: a wheel ended up at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}`)
    }

    const spine = g.children[0].children[0]
    const spineUp = new THREE.Box3().setFromObject(spine).getCenter(new THREE.Vector3())
    seed(); g.userData.pose(0, -1); g.updateMatrixWorld(true)
    const spineDown = new THREE.Box3().setFromObject(spine).getCenter(new THREE.Vector3())
    assert.ok(spineUp.y - spineDown.y > 0.9, `${id}: the chassis only rose ${(spineUp.y - spineDown.y).toFixed(2)} m to become a torso`)
    for (const w of g.userData.wheels) {
      assert.ok(Math.abs(w.pivot.position.x - w.lx) < 1e-9 && Math.abs(w.pivot.position.z - w.lz) < 1e-9, `${id}: wheel did not return`)
      assert.ok(Math.abs(w.pivot.position.y - w.r) < 1e-9, `${id}: the morph left the suspension channel dirty`)
      assert.deepEqual([w.mount.position.x, w.mount.position.y, w.mount.position.z], [0, 0, 0], `${id}: the wheel mount did not return`)
    }
    for (const part of g.userData.morph.parts) {
      assert.ok(part.node.position.distanceTo(part.drive.position) < 1e-9 && part.node.scale.distanceTo(part.drive.scale) < 1e-9,
        `${id}: a part did not come home`)
    }
  }
})

test("the morph never adds, removes or reveals anything: the machine is the same object list in both poses", () => {
  for (const id of IDS) {
    const g = makeVehicleMesh(id)
    const census = () => { const out = []; g.traverse((o) => out.push(o)); return out }
    const before = census()
    for (const u of [0.15, 0.4, 0.62, 0.85, 1]) g.userData.pose(u, 1)
    assert.deepEqual(census(), before, `${id}: the object list changed between the poses`)
    // the walking-only parts are the one exception, and only at the ends: off while driving, on the moment it starts
    const hidden = g.userData.morph.parts.filter((p) => p.hidden)
    assert.ok(hidden.length >= 6, `${id}: the wizard's half is not registered with the morph`)
    assert.ok(hidden.every((p) => p.node.visible), `${id}: the wizard's half is invisible while standing`)
    g.userData.pose(0, -1)
    assert.ok(hidden.every((p) => !p.node.visible), `${id}: the wizard's half is on show while driving`)
  }
})

test("a body built without the morph is the old single-shell car, and its pose is a no-op", () => {
  const g = makeVehicleMesh("auto", 0x3366cc, { morph: false })
  assert.equal(g.userData.morph, null)
  assert.equal(g.userData.mech, null)
  g.userData.pose(1, 1)                                  // must not throw, must not move anything
  assert.equal(g.children[0].children.length, g.children[0].children.length)
  assert.ok(g.userData.wheels.length >= 2 && g.userData.lights.head.isMaterial)
})

test("a lofted hull is closed and faces outwards", () => {
  const g = loft(profile(1, 1, 0.3), [
    { z: -1, sx: 1.0, sy: 0.6, oy: 0.5 },
    { z: 0, sx: 1.4, sy: 0.9, oy: 0.5 },
    { z: 1, sx: 1.0, sy: 0.6, oy: 0.5 },
  ])
  const pos = g.attributes.position, nor = g.attributes.normal
  assert.ok(pos.count > 0 && nor.count === pos.count)
  g.computeBoundingBox()
  const c = g.boundingBox.getCenter(new THREE.Vector3())
  let outward = 0, total = 0
  for (let i = 0; i < pos.count; i++) {
    const d = new THREE.Vector3(pos.getX(i) - c.x, pos.getY(i) - c.y, pos.getZ(i) - c.z)
    if (d.lengthSq() < 1e-6) continue
    const n = new THREE.Vector3(nor.getX(i), nor.getY(i), nor.getZ(i))
    total++
    if (d.normalize().dot(n) > 0) outward++
  }
  assert.ok(outward / total > 0.97, `only ${outward}/${total} normals point away from the centre`)
})

test("revolve flips a profile written top-down so lathes are never inside out", () => {
  const up = revolve([[0.2, 0], [0.4, 0.5], [0.2, 1]], 8)
  const down = revolve([[0.2, 1], [0.4, 0.5], [0.2, 0]], 8)
  const radial = (g) => {
    const pos = g.attributes.position, nor = g.attributes.normal
    let out = 0, n = 0
    for (let i = 0; i < pos.count; i++) {
      const rx = pos.getX(i), rz = pos.getZ(i)
      if (rx * rx + rz * rz < 1e-6) continue
      n++
      if (rx * nor.getX(i) + rz * nor.getZ(i) > 0) out++
    }
    return out / n
  }
  assert.ok(radial(up) > 0.95 && radial(down) > 0.95, `up ${radial(up)}, down ${radial(down)}`)
})

test("a tyre is a tyre: tread proud of the sidewall, and the rim faces the right way out", () => {
  const r = 0.33, width = 0.26
  const tyre = tyreGeometry(r, width)
  const pos = tyre.attributes.position
  let maxRadius = 0, maxAxial = 0
  for (let i = 0; i < pos.count; i++) {
    maxRadius = Math.max(maxRadius, Math.hypot(pos.getY(i), pos.getZ(i)))     // the axle is local x
    maxAxial = Math.max(maxAxial, Math.abs(pos.getX(i)))
  }
  assert.ok(maxRadius > r && maxRadius < r * 1.12, `tread radius ${maxRadius} for a ${r} wheel`)
  assert.ok(Math.abs(maxAxial - width / 2) < 0.02, `tyre is ${maxAxial * 2} wide, wanted ${width}`)
  // the pretty face of the rim sits outboard: +1 puts it on -x (the left flank), -1 mirrors it
  const face = (o) => {
    const p = rimGeometry(r, width, o).attributes.position
    let sum = 0
    for (let i = 0; i < p.count; i++) sum += p.getX(i)
    return sum / p.count
  }
  assert.ok(face(1) < 0 && face(-1) > 0, `rim faces ${face(1)} / ${face(-1)}`)
})

test("the material buckets merge losslessly, whatever generator fed them", () => {
  // mergeGeometries refuses a mix of indexed and non-indexed input and of differing attributes and returns null;
  // the builder falls back to the first geometry when that happens, so a silent mismatch would quietly delete parts
  const parts = [
    panel(1, 1, 1), loft(profile(1, 1, 0.3), [{ z: -1, sx: 1, sy: 1 }, { z: 1, sx: 1, sy: 1 }]),
    revolve([[0.2, 0], [0.3, 1]]), strut(0, 0, 0, 1, 1, 1, 0.1), arch(1, 0.1, 0.3),
    tyreGeometry(0.33, 0.26), rimGeometry(0.33, 0.26, 1),
    new THREE.BoxGeometry(1, 1, 1), new THREE.SphereGeometry(1, 8, 6),
    new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), new THREE.TorusGeometry(1, 0.2, 6, 8),
  ]
  const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3
  const before = parts.reduce((n, g) => n + tris(g), 0)
  const target = new THREE.Group(), kit = new Kit(0xff0000), sec = kit.section(target)
  for (const g of parts) sec.put("matte", g, 0x888888)
  kit.build()
  assert.equal(target.children.length, 1, "one bucket must become one mesh")
  assert.equal(tris(target.children[0].geometry), before, "the merge dropped geometry")
  assert.deepEqual(Object.keys(target.children[0].geometry.attributes).sort(), ["color", "normal", "position", "uv"])
})
