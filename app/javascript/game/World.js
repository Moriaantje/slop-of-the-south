import * as THREE from "three"

// Renderer, camera, light and atmosphere. Nothing game-specific lives here.
export class World {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    const sky = new THREE.Color(0x9fb8cf)
    this.scene.background = sky
    this.scene.fog = new THREE.Fog(sky, 600, 2200)   // hides tiles popping in at the horizon

    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 4000)

    this.hemi = new THREE.HemisphereLight(0xdfe9f3, 0x5b6b4a, 0.9)
    this.sun  = new THREE.DirectionalLight(0xfff2dc, 1.6)
    this.sun.position.set(-300, 500, -200)           // afternoon sun from the south-west; DayNight moves it
    this.scene.add(this.hemi, this.sun)

    this._camTarget = new THREE.Vector3()
    this._lookAt = new THREE.Vector3()
    addEventListener("resize", () => this.resize())
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(innerWidth, innerHeight)
  }

  // Smooth chase camera behind and above the car.
  followCamera(car, dt) {
    const f = car.forward()
    this._camTarget.set(car.x - f.x * 9, car.y + 3.8, car.z - f.z * 9)
    const k = 1 - Math.exp(-dt * 5)
    if (this.camera.position.lengthSq() === 0) this.camera.position.copy(this._camTarget)
    this.camera.position.lerp(this._camTarget, k)
    this._lookAt.set(car.x + f.x * 4, car.y + 2.0, car.z + f.z * 4)   // a little sky above the horizon
    this.camera.lookAt(this._lookAt)
  }

  render() { this.renderer.render(this.scene, this.camera) }
}
