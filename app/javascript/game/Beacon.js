import * as THREE from "three"

// A sky beacon: a label with a name and a distance floating above something, with a line down to it. It is always in
// view: it sits along the true direction from the camera, at most RANGE out (inside the draw distance), and climbs
// with the distance — a few metres above a nearby car, hundreds of metres up for something across the province. The
// label keeps a constant size on screen. Other players carry one, and so does the parade float.
const RANGE = 3000
const FONT = "'Avenir Next', 'Segoe UI', system-ui, sans-serif"

export function makeBeacon(scene, color) {
  const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 128
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false }))
  sprite.renderOrder = 20
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, fog: false }))
  line.renderOrder = 19
  line.frustumCulled = false
  scene.add(sprite, line)
  return { scene, sprite, canvas, tex, line, color, text: "" }
}

// (x, y, z): what the beacon marks; local: the player's own car, for the distance; camera: keeps the label's screen size
export function placeBeacon(b, x, y, z, name, local, camera) {
  const dist = Math.hypot(x - local.x, z - local.z)
  const dx = x - camera.position.x, dz = z - camera.position.z
  const flat = Math.hypot(dx, dz) || 1
  const ux = dx / flat, uz = dz / flat
  const near = flat <= RANGE
  const reach = Math.min(flat, RANGE)
  const elevation = THREE.MathUtils.degToRad(2 + 10 * THREE.MathUtils.smoothstep(flat, 0, RANGE))
  const lx = camera.position.x + ux * reach, lz = camera.position.z + uz * reach
  const groundY = near ? y : local.y
  const ly = groundY + 6 + reach * Math.tan(elevation)
  const s = b.sprite
  s.position.set(lx, ly, lz)
  const camDist = camera.position.distanceTo(s.position)
  s.scale.set(camDist * 0.2, camDist * 0.05, 1)                     // ~9% of the screen width whatever the distance
  const text = `${name}|${Math.round(dist / 100)}`
  if (text !== b.text) { b.text = text; drawLabel(b, name, dist) }
  const pos = b.line.geometry.attributes.position
  if (near) pos.setXYZ(0, x, y + 1.6, z); else pos.setXYZ(0, lx, groundY, lz)
  pos.setXYZ(1, lx, ly - camDist * 0.025, lz)
  pos.needsUpdate = true
}

export function showBeacon(b, visible) { b.sprite.visible = b.line.visible = visible }

export function disposeBeacon(b) {
  b.scene.remove(b.sprite, b.line)
  b.tex.dispose(); b.sprite.material.dispose()
  b.line.geometry.dispose(); b.line.material.dispose()
}

// a dark pill: colour dot, name, distance in km
function drawLabel(b, name, dist) {
  const ctx = b.canvas.getContext("2d")
  ctx.clearRect(0, 0, 512, 128)
  const km = `${(dist / 1000).toFixed(dist < 9950 ? 1 : 0)} km`
  ctx.font = `bold 44px ${FONT}`; const nameW = Math.min(ctx.measureText(name).width, 260)
  ctx.font = `500 36px ${FONT}`; const kmW = ctx.measureText(km).width
  const w = Math.min(504, 24 + 22 + 16 + nameW + 22 + kmW + 24), x0 = (512 - w) / 2
  ctx.fillStyle = "rgba(18, 22, 30, 0.8)"; roundRect(ctx, x0, 20, w, 88, 44); ctx.fill()
  ctx.lineWidth = 4; ctx.strokeStyle = `#${new THREE.Color(b.color).getHexString()}`; roundRect(ctx, x0 + 2, 22, w - 4, 84, 42); ctx.stroke()
  ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(x0 + 24 + 11, 64, 11, 0, Math.PI * 2); ctx.fill()
  ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = "#fff"
  ctx.font = `bold 44px ${FONT}`; ctx.fillText(name, x0 + 24 + 22 + 16, 62, 260)
  ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.font = `500 36px ${FONT}`; ctx.fillText(km, x0 + 24 + 22 + 16 + nameW + 22, 64)
  b.tex.needsUpdate = true
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}
