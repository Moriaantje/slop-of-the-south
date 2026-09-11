import * as THREE from "three"
import { off } from "game/Flags"
import { softTexture } from "game/Effects"

// Contact shadows: a soft dark disc on the ground under each actor (cars, later the mech, dragons and people). No
// shadow maps — a directional shadow over the loaded kilometres would need cascades and a depth pass of every tile —
// but a blob under a moving thing is most of what the eye wants. ?shadows=0 hides them.
const geo = new THREE.CircleGeometry(1, 24); geo.rotateX(-Math.PI / 2); geo.__shared = true
const ENABLED = !off("shadows")

export class Blob {
  constructor(scene, w = 1.2, l = 2.4) {
    this.scene = scene
    this.material = new THREE.MeshBasicMaterial({ map: softTexture(), color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.renderOrder = 1
    this.mesh.visible = ENABLED
    this.size(w, l)
    scene.add(this.mesh)
  }

  size(w, l) { this.w = w; this.l = l }

  // groundY: the ground under the actor; height: how far above it the actor floats (the blob grows and fades)
  place(x, groundY, z, yaw, height = 0, darkness = 0) {
    if (!ENABLED) return
    const m = this.mesh
    m.position.set(x, groundY + 0.03, z)
    m.rotation.y = yaw
    const g = 1 + Math.max(0, height) / 20
    m.scale.set(this.w * g, 1, this.l * g)
    this.material.opacity = 0.45 * (1 - 0.5 * darkness) * THREE.MathUtils.clamp(1 - height / 40, 0, 1)
  }

  dispose() {
    this.scene.remove(this.mesh)
    this.material.dispose()
  }
}
