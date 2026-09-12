import * as THREE from "three"
import { ChaseCamera } from "game/Camera"
import { off } from "game/Flags"
import { TUNING as T } from "game/Tuning"
import { installHeightFog } from "game/HeightFog"

// Renderer, camera, light and atmosphere. Nothing game-specific lives here.
//
// The height fog is installed before anything else because it rewrites three's shared fog chunks, and a chunk is
// only read when a program is compiled: do it here, at the very first thing the game builds, and every material in
// the session comes out of the compiler already knowing that haze pools in the valleys.
const FOG_NEAR = 900, FOG_FAR = 2700         // m: DayNight drives these through the day; these are the noon values
const SHADOW_NEAR = 120, SHADOW_FAR = 1300   // m along the light: the sun sits 600–710 m out, so this is a tight fit
const SHADOW_BIAS = -0.0004                  // constant depth bias, in the shadow camera's clip units
const SHADOW_NORMAL_BIAS = 0.35              // m the sample is pushed along the normal: enough for 2048 texels over 170 m
installHeightFog()

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
    // Linear fog rather than exponential: DayNight wants to move the wall in and out over the day, and a near/far
    // pair is far easier to reason about than a density. HeightFog.js modulates it per fragment by altitude, so
    // this pair sets how far you can see across the valley floor, not how far you can see full stop.
    this.scene.fog = new THREE.Fog(sky, FOG_NEAR, FOG_FAR)

    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 4000)

    this.hemi = new THREE.HemisphereLight(0xcfe0f2, 0x5b6b4a, 0.5)
    this.sun  = new THREE.DirectionalLight(0xfff6e2, 1.6)
    this.sun.position.set(-300, 500, -200)           // afternoon sun from the south-west; DayNight moves it
    this.sunAnchor = new THREE.Vector3()             // the player: the sun and its shadow camera ride along (DayNight, game.js)
    this.scene.add(this.hemi, this.sun, this.sun.target)
    // Shadows: a single percentage-closer-filtered shadow map (Reeves et al. 1987) over the few hundred metres around
    // the player, following them in texel-sized steps. Cascades would cover the horizon too, at the cost of extra
    // depth passes; one map where the eye actually looks is the cheap 90 %. ?shadows=0 turns it off.
    //
    // Quality.js owns the map size and the filter type at runtime and swaps them as the frame time moves, so what is
    // set here is only the starting point. The two biases are ours to keep: a normal bias of nearly a metre, which
    // is what this had, lifts the sample so far off the surface that small things stop touching their own shadows —
    // the peter-panning that makes a scene look like cardboard. A third of a metre is about two texels at the
    // sizes Quality actually uses and still holds off the acne.
    this.shadows = !off("shadows")
    if (this.shadows) {
      const S = T.look.shadows
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
      this.sun.castShadow = true
      this.sun.shadow.mapSize.set(S.size, S.size)
      const c = this.sun.shadow.camera
      c.left = -S.radius; c.right = S.radius; c.top = S.radius; c.bottom = -S.radius
      c.near = SHADOW_NEAR; c.far = SHADOW_FAR
      this.sun.shadow.bias = SHADOW_BIAS
      this.sun.shadow.normalBias = SHADOW_NORMAL_BIAS
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
