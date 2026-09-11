import * as THREE from "three"

// Arcade bicycle-model car. yaw = 0 faces north (-z); positive yaw turns left.
export class Vehicle {
  constructor(spawn) {
    this.wheelbase = 2.6
    this.track = 1.6
    this.maxSpeed = 44          // m/s ≈ 160 km/h
    this.accel = 9
    this.brakeForce = 20
    this.maxSteer = 0.55        // radians at standstill
    this.mesh = makeCarMesh()
    this.lights = this.mesh.userData.lights
    this.braking = false
    this.darkness = 0
    // two spotlights for the player's own car light up the road ahead at night
    this.spots = [-0.6, 0.6].map((x) => {
      const spot = new THREE.SpotLight(0xfff3d6, 0, 65, 0.5, 0.65, 1.7)
      spot.position.set(x, 0.7, -2.0)
      spot.target.position.set(x * 0.7, -0.6, -24)
      this.mesh.add(spot, spot.target)
      return spot
    })
    this.reset(spawn)
  }

  // darkness 0..1 (DayNight): headlights on in the dark, dim running lights by day
  setNight(darkness) {
    this.darkness = darkness
    for (const spot of this.spots) spot.intensity = 140 * darkness * darkness
    this.lights.head.emissiveIntensity = 0.35 + 2.2 * darkness
    this.updateTail()
  }

  updateTail() { this.lights.tail.emissiveIntensity = this.braking ? 1.9 : 0.12 + 0.7 * this.darkness }

  reset(spawn) {
    this.x = spawn.x; this.z = spawn.z; this.y = 0
    this.yaw = spawn.yaw; this.speed = 0; this.steer = 0
  }

  forward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) } }

  update(dt, input, heightAt) {
    // Longitudinal
    const drag = 0.35 * this.speed * Math.abs(this.speed) / this.maxSpeed + 0.8 * Math.sign(this.speed)
    let a = input.throttle * this.accel - drag
    if (input.brake) a -= this.speed > 0.5 ? this.brakeForce : this.accel * 0.6   // brake, then reverse
    if (input.handbrake) a -= 12 * Math.sign(this.speed)
    const braking = (input.brake && this.speed > 0.5) || (input.handbrake && Math.abs(this.speed) > 0.5)
    if (braking !== this.braking) { this.braking = braking; this.updateTail() }
    this.speed = THREE.MathUtils.clamp(this.speed + a * dt, -this.maxSpeed / 4, this.maxSpeed)
    if (Math.abs(this.speed) < 0.05 && !input.throttle && !input.brake) this.speed = 0

    // Steering: less lock at speed, smoothed
    const lock = this.maxSteer * (input.handbrake ? 1.3 : 1) / (1 + Math.abs(this.speed) / 18)
    this.steer += (input.steer * lock - this.steer) * Math.min(1, dt * 8)
    this.yaw += (this.speed / this.wheelbase) * Math.tan(this.steer) * dt

    const f = this.forward()
    this.x += f.x * this.speed * dt
    this.z += f.z * this.speed * dt

    // Terrain contact and body attitude
    const rx = -f.z, rz = f.x                         // right-hand vector
    const hf = heightAt(this.x + f.x * this.wheelbase / 2, this.z + f.z * this.wheelbase / 2)
    const hb = heightAt(this.x - f.x * this.wheelbase / 2, this.z - f.z * this.wheelbase / 2)
    const hl = heightAt(this.x - rx * this.track / 2, this.z - rz * this.track / 2)
    const hr = heightAt(this.x + rx * this.track / 2, this.z + rz * this.track / 2)
    this.y = (hf + hb + hl + hr) / 4

    this.mesh.position.set(this.x, this.y, this.z)
    this.mesh.rotation.set(Math.atan2(hf - hb, this.wheelbase), this.yaw, Math.atan2(hr - hl, this.track), "YXZ")
  }

  state() { return { x: this.x, y: this.y, z: this.z, yaw: this.yaw, speed: this.speed, brake: this.braking } }
}

export function makeCarMesh(color = 0xd7412b) {
  const g = new THREE.Group()
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.4 })
  const dark  = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 })
  const body  = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 4.1), paint); body.position.y = 0.55
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.9), paint); cabin.position.set(0, 1.05, -0.2)
  g.add(body, cabin)
  const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.25, 14); wheel.rotateZ(Math.PI / 2)
  for (const [x, z] of [[-0.85, 1.3], [0.85, 1.3], [-0.85, -1.3], [0.85, -1.3]]) {
    const w = new THREE.Mesh(wheel, dark); w.position.set(x, 0.33, -z); g.add(w)
  }
  // lights: headlights at the front (-z), tail/brake lights at the back; their emissive intensity is animated
  const head = new THREE.MeshStandardMaterial({ color: 0xfff8e6, emissive: 0xfff3cc, emissiveIntensity: 0.35, roughness: 0.3 })
  const tail = new THREE.MeshStandardMaterial({ color: 0x7a1010, emissive: 0xff1a12, emissiveIntensity: 0.12, roughness: 0.4 })
  const lamp = new THREE.BoxGeometry(0.34, 0.16, 0.06)
  for (const x of [-0.6, 0.6]) {
    const h = new THREE.Mesh(lamp, head); h.position.set(x, 0.62, -2.06); g.add(h)
    const t = new THREE.Mesh(lamp, tail); t.position.set(x, 0.66, 2.06); g.add(t)
  }
  g.userData.lights = { head, tail }
  return g
}
