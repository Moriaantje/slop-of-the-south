import * as THREE from "three"
import { makeCarMesh } from "game/Vehicle"

const DELAY_MS = 120         // render slightly in the past so we can interpolate
const TIMEOUT_MS = 6000
const BEACON_RANGE = 3000   // metres: labels of players farther away are drawn this far out, in their direction
const FONT = "'Avenir Next', 'Segoe UI', system-ui, sans-serif"

// Keeps a short buffer of positions per remote player and interpolates between them. Every other player carries a
// beacon: a label with their name and distance floating in the sky above the car, with a line down to it. The label
// rises higher the farther away the player is (visible from anywhere in the province) and keeps a constant size on screen.
export class RemoteCars {
  constructor(scene) {
    this.scene = scene
    this.cars = new Map()    // id → { mesh, buf: [{t, x, y, z, yaw}], lastSeen, brake, name, label, line }
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
      car = { mesh: makeCarMesh(color), color, buf: [], lastSeen: 0, brake: false, name: "", label: makeLabel(), line: makeLine(color), text: "" }
      this.scene.add(car.mesh, car.label.sprite, car.line)
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
      if (local && camera) this.updateBeacon(car, x, y, z, local, camera)
    }
  }

  // The beacon is always in view: it sits along the true direction to the player, at most BEACON_RANGE out (inside
  // the camera's draw distance), and climbs with the distance — a few metres above a nearby car, hundreds of metres
  // up for someone across the province. The line drops to the car itself, or to the ground in its direction.
  updateBeacon(car, x, y, z, local, camera) {
    const dist = Math.hypot(x - local.x, z - local.z)
    const dx = x - camera.position.x, dz = z - camera.position.z
    const flat = Math.hypot(dx, dz) || 1
    const ux = dx / flat, uz = dz / flat
    const near = flat <= BEACON_RANGE
    const reach = Math.min(flat, BEACON_RANGE)
    const elevation = THREE.MathUtils.degToRad(2 + 10 * THREE.MathUtils.smoothstep(flat, 0, BEACON_RANGE))
    const lx = camera.position.x + ux * reach, lz = camera.position.z + uz * reach
    const groundY = near ? y : local.y
    const ly = groundY + 6 + reach * Math.tan(elevation)
    const s = car.label.sprite
    s.position.set(lx, ly, lz)
    const camDist = camera.position.distanceTo(s.position)
    s.scale.set(camDist * 0.2, camDist * 0.05, 1)                     // ~9% of the screen width whatever the distance
    const text = `${car.name}|${Math.round(dist / 100)}`
    if (text !== car.text) { car.text = text; drawLabel(car.label, car.name, dist, car.color) }
    const pos = car.line.geometry.attributes.position
    if (near) pos.setXYZ(0, x, y + 1.6, z); else pos.setXYZ(0, lx, groundY, lz)
    pos.setXYZ(1, lx, ly - camDist * 0.025, lz)
    pos.needsUpdate = true
  }

  remove(id) {
    const car = this.cars.get(id)
    if (!car) return
    this.scene.remove(car.mesh, car.label.sprite, car.line)
    car.label.sprite.material.map.dispose(); car.label.sprite.material.dispose()
    car.line.geometry.dispose(); car.line.material.dispose()
    this.cars.delete(id)
  }
}

function makeLabel() {
  const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 128
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false }))
  sprite.renderOrder = 20
  return { sprite, canvas, tex }
}

function makeLine(color) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, fog: false }))
  line.renderOrder = 19
  line.frustumCulled = false
  return line
}

// a dark pill: colour dot, name, distance in km
function drawLabel(label, name, dist, color) {
  const ctx = label.canvas.getContext("2d")
  ctx.clearRect(0, 0, 512, 128)
  const km = `${(dist / 1000).toFixed(dist < 9950 ? 1 : 0)} km`
  ctx.font = `bold 44px ${FONT}`; const nameW = Math.min(ctx.measureText(name).width, 260)
  ctx.font = `500 36px ${FONT}`; const kmW = ctx.measureText(km).width
  const w = Math.min(504, 24 + 22 + 16 + nameW + 22 + kmW + 24), x0 = (512 - w) / 2
  ctx.fillStyle = "rgba(18, 22, 30, 0.8)"; roundRect(ctx, x0, 20, w, 88, 44); ctx.fill()
  ctx.lineWidth = 4; ctx.strokeStyle = `#${new THREE.Color(color).getHexString()}`; roundRect(ctx, x0 + 2, 22, w - 4, 84, 42); ctx.stroke()
  ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(x0 + 24 + 11, 64, 11, 0, Math.PI * 2); ctx.fill()
  ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = "#fff"
  ctx.font = `bold 44px ${FONT}`; ctx.fillText(name, x0 + 24 + 22 + 16, 62, 260)
  ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.font = `500 36px ${FONT}`; ctx.fillText(km, x0 + 24 + 22 + 16 + nameW + 22, 64)
  label.tex.needsUpdate = true
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
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
