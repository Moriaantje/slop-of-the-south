import * as THREE from "three"

// Short-lived visuals: explosion flashes, flying debris, dust clouds and a camera shake. Everything here is
// cosmetic and local; the world state comes from the server.
const MAX_LIVE = 40
const flashGeo = new THREE.SphereGeometry(1, 12, 8)
const debrisGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5)
const debrisMat = new THREE.MeshStandardMaterial({ color: 0x8a8078, roughness: 1 })
let dustTex = null

export class Effects {
  constructor(scene) {
    this.scene = scene
    this.live = []
    this.shakeAmt = 0
  }

  // a flash growing to r, debris flying out of it, dust spreading on the ground
  explosion(x, y, z, r) {
    this.flash(x, y, z, r)
    this.debris(x, y, z, r * 0.6, 10)
    this.dust(x, y, z, r * 2)
  }

  // a building came down: debris over its footprint and a dust sheet the size of the house
  collapse(obj, ground) {
    const cx = (obj.minX + obj.maxX) / 2, cz = (obj.minZ + obj.maxZ) / 2
    const size = Math.max(obj.maxX - obj.minX, obj.maxZ - obj.minZ, 3)
    this.debris(cx, ground + (obj.h ?? 6) / 2, cz, size / 2, THREE.MathUtils.clamp(Math.round(size), 6, 24))
    this.dust(cx, ground, cz, size)
    this.shake(0.3)
  }

  flash(x, y, z, r) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const mesh = new THREE.Mesh(flashGeo, mat)
    mesh.position.set(x, y, z)
    this.add({ mesh, life: 0.35, t: 0, step: (e, k) => { e.mesh.scale.setScalar(r * (0.3 + 0.7 * k)); mat.opacity = 0.9 * (1 - k) } })
  }

  debris(x, y, z, r, n) {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(debrisGeo, debrisMat)
      mesh.position.set(x + (Math.random() - 0.5) * r, y, z + (Math.random() - 0.5) * r)
      mesh.scale.setScalar(0.6 + Math.random() * 1.2)
      const v = new THREE.Vector3((Math.random() - 0.5) * r * 1.5, 4 + Math.random() * r, (Math.random() - 0.5) * r * 1.5)
      const spin = new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(6)
      this.add({ mesh, life: 1.4, t: 0, shared: true, step: (e, k, dt) => { v.y -= 20 * dt; e.mesh.position.addScaledVector(v, dt); e.mesh.rotation.x += spin.x * dt; e.mesh.rotation.z += spin.z * dt } })
    }
  }

  dust(x, y, z, r) {
    const mat = new THREE.SpriteMaterial({ map: dustTexture(), transparent: true, opacity: 0.7, depthWrite: false, color: 0xbfb6a8 })
    const mesh = new THREE.Sprite(mat)
    mesh.position.set(x, y + r * 0.25, z)
    this.add({ mesh, life: 1.3, t: 0, step: (e, k) => { e.mesh.scale.setScalar(r * (0.5 + k)); mat.opacity = 0.7 * (1 - k) } })
  }

  shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a) }

  add(e) {
    if (this.live.length >= MAX_LIVE) this.dispose(this.live.shift())
    this.scene.add(e.mesh)
    this.live.push(e)
  }

  dispose(e) {
    this.scene.remove(e.mesh)
    if (!e.shared) e.mesh.material.dispose()
  }

  // once per frame, after the camera has moved
  update(dt, camera) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i]
      e.t += dt
      if (e.t >= e.life) { this.dispose(e); this.live.splice(i, 1); continue }
      e.step(e, e.t / e.life, dt)
    }
    if (this.shakeAmt > 0.001) {
      camera.position.x += (Math.random() - 0.5) * this.shakeAmt
      camera.position.y += (Math.random() - 0.5) * this.shakeAmt
      this.shakeAmt *= Math.exp(-dt * 6)
    }
  }
}

function dustTexture() {
  if (dustTex) return dustTex
  const c = document.createElement("canvas"); c.width = c.height = 128
  const ctx = c.getContext("2d")
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(0.5, "rgba(255,255,255,0.35)"); g.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
  dustTex = new THREE.CanvasTexture(c)
  return dustTex
}
