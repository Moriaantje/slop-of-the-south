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
    this.reset(spawn)
  }

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

  state() { return { x: this.x, y: this.y, z: this.z, yaw: this.yaw, speed: this.speed } }
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
  return g
}
