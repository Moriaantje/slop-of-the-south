import * as THREE from "three"
import { makeCarMesh } from "game/Vehicle"
import { makeBeacon, placeBeacon, disposeBeacon } from "game/Beacon"

const DELAY_MS = 120         // render slightly in the past so we can interpolate
const TIMEOUT_MS = 6000

// Keeps a short buffer of positions per remote player and interpolates between them. Every other player carries a
// sky beacon (Beacon.js) with their name and distance.
export class RemoteCars {
  constructor(scene) {
    this.scene = scene
    this.cars = new Map()    // id → { mesh, color, buf: [{t, x, y, z, yaw}], lastSeen, brake, name, beacon }
    this.darkness = 0
  }

  get count() { return this.cars.size }

  // darkness 0..1 (DayNight): headlights and tail lights of everyone else
  setNight(darkness) {
    this.darkness = darkness
    for (const car of this.cars.values()) this.relight(car)
  }

  relight(car) {
    car.mesh.userData.lights.head.emissiveIntensity = 0.35 + 2.2 * this.darkness
    car.mesh.userData.lights.tail.emissiveIntensity = car.brake ? 1.9 : 0.12 + 0.7 * this.darkness
  }

  receive(msg) {
    if (msg.type === "leave") return this.remove(msg.id)
    if (msg.type !== "move") return
    let car = this.cars.get(msg.id)
    if (!car) {
      const color = colorFor(msg.id)
      car = { mesh: makeCarMesh(color), color, buf: [], lastSeen: 0, brake: false, name: "", beacon: makeBeacon(this.scene, color) }
      this.scene.add(car.mesh)
      this.cars.set(msg.id, car)
    }
    car.name = msg.name || "Chauffeur"
    if (!!msg.brake !== car.brake) { car.brake = !!msg.brake; this.relight(car) }
    car.lastSeen = performance.now()
    car.buf.push({ t: performance.now(), x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw })
    if (car.buf.length > 20) car.buf.shift()
  }

  // local: the player's own car (for the distance); camera: to keep the labels a constant size on screen
  update(local, camera) {
    const now = performance.now(), renderT = now - DELAY_MS
    for (const [id, car] of this.cars) {
      if (now - car.lastSeen > TIMEOUT_MS) { this.remove(id); continue }
      const b = car.buf
      if (!b.length) continue
      let i = b.length - 1
      while (i > 0 && b[i - 1].t > renderT) i--
      const a = b[Math.max(i - 1, 0)], c = b[i]
      const k = c.t === a.t ? 1 : THREE.MathUtils.clamp((renderT - a.t) / (c.t - a.t), 0, 1)
      const x = a.x + (c.x - a.x) * k, y = a.y + (c.y - a.y) * k, z = a.z + (c.z - a.z) * k
      car.mesh.position.set(x, y, z)
      car.mesh.rotation.y = lerpAngle(a.yaw, c.yaw, k)
      if (local && camera) placeBeacon(car.beacon, x, y, z, car.name, local, camera)
    }
  }

  remove(id) {
    const car = this.cars.get(id)
    if (!car) return
    this.scene.remove(car.mesh)
    disposeBeacon(car.beacon)
    this.cars.delete(id)
  }
}

function lerpAngle(a, b, k) {
  let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  return a + d * k
}

function colorFor(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return new THREE.Color().setHSL((h % 360) / 360, 0.65, 0.5).getHex()
}
