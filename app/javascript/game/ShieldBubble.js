import * as THREE from "three"
import { expDamp } from "game/Tuning"
import { noAO } from "game/Layers"

// The wizard mech's shield: a translucent sphere lit at the rim (fresnel) with a slow ripple, additive so it glows
// against the sky and the ground alike. Fades in and out over a tenth of a second.
const geo = new THREE.SphereGeometry(1, 28, 18); geo.__shared = true
const VERT = /* glsl */`
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); vP = position;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`
const FRAG = /* glsl */`
  uniform vec3 color; uniform float opacity, time;
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main() {
    float rim = pow(1.0 - abs(dot(vN, vV)), 2.5);
    float ripple = 0.5 + 0.5 * sin(vP.y * 6.0 + time * 4.0) * sin(vP.x * 5.0 - time * 3.0);
    float a = (0.08 + 0.9 * rim + 0.08 * ripple) * opacity;
    gl_FragColor = vec4(color * (0.6 + 0.6 * rim), a);
  }`

export class ShieldBubble {
  constructor(parent, r = 3, y = 2.2, color = 0x6fb8ff) {
    this.material = new THREE.ShaderMaterial({ uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 0 }, time: { value: 0 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.mesh = noAO(new THREE.Mesh(geo, this.material))   // a bubble round the camera would black the AO out
    this.mesh.scale.setScalar(r)
    this.mesh.position.y = y
    this.mesh.visible = false
    this.mesh.renderOrder = 5
    this.k = 0
    parent.add(this.mesh)
  }

  update(on, dt, t) {
    this.k = expDamp(this.k, on ? 1 : 0, 12, dt)
    this.mesh.visible = this.k > 0.02
    this.material.uniforms.opacity.value = this.k
    this.material.uniforms.time.value = t
  }

  dispose() { this.mesh.parent?.remove(this.mesh); this.material.dispose() }
}
