import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { VEHICLES, vehicleSpec, makeVehicleMesh, makeCarMesh } from "game/Vehicles"
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
    assert.equal(typeof g.userData.fold, "function", `${id}: no fold`)
    let meshes = 0
    g.traverse((o) => { if (o.isMesh) meshes++ })
    assert.ok(meshes > 0 && meshes < 30, `${id}: ${meshes} draw calls`)   // merging must hold the part count down
  }
})

test("the tank and the crane keep the animated parts Combat drives", () => {
  const tank = makeVehicleMesh("tank")
  assert.ok(tank.userData.anim.turret.isObject3D && tank.userData.anim.barrel.isObject3D)
  const crane = makeVehicleMesh("sloopkraan")
  assert.ok(crane.userData.anim.pivot.isObject3D && crane.userData.anim.tip.isObject3D && crane.userData.anim.ball.isObject3D)
  assert.ok(Math.abs(crane.userData.anim.pivot.rotation.x - 0.75) < 1e-9, "the boom starts at the angle Combat resets it to")
})

test("fold(1) tucks the machine up and fold(0) puts every channel back exactly", () => {
  for (const id of IDS) {
    const g = makeVehicleMesh(id)
    const body = g.children[0]
    const seed = () => { for (const w of g.userData.wheels) w.pivot.position.y = w.r }   // what the suspension writes
    seed(); g.userData.fold(0)
    assert.deepEqual([body.scale.x, body.scale.y, body.scale.z], [1, 1, 1], `${id}: fold(0) is not identity`)
    assert.equal(Math.abs(body.position.y), 0)
    assert.equal(Math.abs(body.rotation.x), 0)

    seed(); g.userData.fold(1)
    assert.ok(body.scale.z < 0.6 && body.scale.y > 1.2, `${id}: the body did not squeeze and stand up`)
    assert.ok(body.position.y > 0.2 && body.rotation.x < -0.4, `${id}: the body did not rear up`)
    for (const w of g.userData.wheels) {
      assert.ok(Math.abs(w.pivot.position.x) < Math.abs(w.lx) + 1e-9, `${id}: wheel did not pull inboard`)
      assert.ok(Math.abs(w.pivot.position.z) < Math.abs(w.lz) + 1e-9)
      assert.ok(w.pivot.position.y > w.r, `${id}: wheel did not climb into the arch`)
      assert.ok(Math.abs(w.pivot.rotation.z) > 0.5 || w.lx === 0)
    }

    seed(); g.userData.fold(0)
    for (const w of g.userData.wheels) {
      assert.ok(Math.abs(w.pivot.position.x - w.lx) < 1e-9 && Math.abs(w.pivot.position.z - w.lz) < 1e-9, `${id}: wheel did not return`)
      assert.equal(Math.abs(w.pivot.rotation.z), 0)
      assert.equal(Math.abs(w.pivot.rotation.x), 0)
      assert.ok(Math.abs(w.pivot.position.y - w.r) < 1e-9, `${id}: the fold left the suspension channel dirty`)
    }
  }
})

test("the fold runs through negative k for the landing squat without inverting", () => {
  const g = makeCarMesh()
  const body = g.children[0]
  g.userData.fold(-0.06)
  assert.ok(body.scale.y < 1 && body.scale.z > 1, "a negative fold must over-extend, not fold")
  assert.ok(body.position.y < 0 && body.rotation.x > 0)
  g.userData.fold(0)
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
