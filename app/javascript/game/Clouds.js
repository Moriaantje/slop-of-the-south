import * as THREE from "three"

// A cloud deck: one 8 km quad 1400 m up that follows the player, shaded by two scrolling layers of value noise
// (one shared 256 px canvas) thresholded into soft cumulus, lit white by day and dimmed with the night, thinning
// towards the horizon so it never shows a hard edge. One draw call, a few texture reads per sky pixel.
const SIZE = 8000, HEIGHT = 1400

function noiseTexture() {
  const n = 256, c = document.createElement("canvas"); c.width = c.height = n
  const ctx = c.getContext("2d"), img = ctx.createImageData(n, n), d = img.data
  let s = 777
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const grid = (m) => { const g = new Float32Array(m * m); for (let i = 0; i < m * m; i++) g[i] = rnd(); return g }
  const octaves = [[4, grid(4), 0.5], [8, grid(8), 0.25], [16, grid(16), 0.15], [32, grid(32), 0.1]]
  const sample = (g, m, x, y) => {
    const fx = x * m, fy = y * m, x0 = Math.floor(fx) % m, y0 = Math.floor(fy) % m, x1 = (x0 + 1) % m, y1 = (y0 + 1) % m
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy), sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    const a = g[y0 * m + x0], b = g[y0 * m + x1], cc = g[y1 * m + x0], dd = g[y1 * m + x1]
    return (a + (b - a) * sx) * (1 - sy) + (cc + (dd - cc) * sx) * sy
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 0
    for (const [m, g, w] of octaves) v += w * sample(g, m, x / n, y / n)
    const p = (y * n + x) * 4, b = Math.round(v * 255)
    d[p] = d[p + 1] = d[p + 2] = b; d[p + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

export class Clouds {
  constructor(scene) {
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uNoise: { value: noiseTexture() }, uTime: { value: 0 }, uDark: { value: 0 }, uCover: { value: 0.5 }, uSun: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying float vDist;
        void main() { vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vDist = length(wp.xz - cameraPosition.xz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uNoise; uniform float uTime, uDark, uCover; uniform vec3 uSun;
        varying vec2 vUv; varying float vDist;
        void main() {
          vec2 uv = vUv * 6.0;
          float a = texture2D(uNoise, uv + vec2(uTime * 0.004, uTime * 0.0015)).r;
          float b = texture2D(uNoise, uv * 2.3 + vec2(-uTime * 0.007, uTime * 0.003) + 0.37).r;
          float n = a * 0.7 + b * 0.45;
          float cloud = smoothstep(0.62 - uCover * 0.25, 0.9 - uCover * 0.2, n);
          float shade = 0.55 + 0.45 * smoothstep(0.55, 1.0, n + 0.12 * b);          // thick parts brighter on top
          vec3 col = mix(vec3(0.75, 0.8, 0.9), vec3(1.0), shade) * uSun;
          col = mix(col, col * vec3(0.16, 0.18, 0.26), uDark);
          float horizon = 1.0 - smoothstep(2200.0, 3800.0, vDist);
          gl_FragColor = vec4(col, cloud * 0.92 * horizon);
        }`,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), this.material)
    this.mesh.rotation.x = Math.PI / 2                     // face down, from above
    this.mesh.renderOrder = -5
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
  }

  // env: DayNight.env (darkness, sunColor); the deck rides with the camera
  update(dt, camera, env) {
    this.material.uniforms.uTime.value += dt
    this.material.uniforms.uDark.value = env.darkness
    this.material.uniforms.uSun.value.copy(env.sunColor).multiplyScalar(0.45).addScalar(0.55 * (1 - env.darkness))
    this.mesh.position.set(camera.position.x, camera.position.y + HEIGHT, camera.position.z)
  }
}
