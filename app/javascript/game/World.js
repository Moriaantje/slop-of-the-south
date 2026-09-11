import * as THREE from "three"
import { ChaseCamera } from "game/Camera"
import { off } from "game/Flags"
import { TUNING as T } from "game/Tuning"

// Renderer, camera, light and atmosphere. Nothing game-specific lives here.
export class World {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))   // 2× on a Retina screen quadruples the fill cost for little gain with MSAA on
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
    this.sunAnchor = new THREE.Vector3()             // the player: the sun and its shadow camera ride along (DayNight, game.js)
    this.scene.add(this.hemi, this.sun, this.sun.target)
    // Shadows: a single percentage-closer-filtered shadow map (Reeves et al. 1987) over the few hundred metres around
    // the player, following them in texel-sized steps. Cascades would cover the horizon too, at the cost of extra
    // depth passes; one map where the eye actually looks is the cheap 90 %. ?shadows=0 turns it off.
    this.shadows = !off("shadows")
    if (this.shadows) {
      const S = T.look.shadows
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
      this.sun.castShadow = true
      this.sun.shadow.mapSize.set(S.size, S.size)
      const c = this.sun.shadow.camera
      c.left = -S.radius; c.right = S.radius; c.top = S.radius; c.bottom = -S.radius; c.near = 20; c.far = 1600
      this.sun.shadow.bias = -0.00035
      this.sun.shadow.normalBias = 0.8
      this.sun.shadow.radius = 2
    }

    this.chase = new ChaseCamera(this.camera)
    addEventListener("resize", () => this.resize())
  }

  // ground height function so the camera never sinks into the terrain
  setHeightAt(fn) { this.chase.heightAt = fn }

  resize() {
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(innerWidth, innerHeight)
  }

  // Spring-damped chase camera (game/Camera). A huge dt (spawn, teleport) snaps it straight into place.
  followCamera(car, dt) { dt >= 10 ? this.chase.snap(car) : this.chase.update(car, dt) }
  snapCamera(car) { this.chase.snap(car) }

  render() { this.renderer.render(this.scene, this.camera) }
}
