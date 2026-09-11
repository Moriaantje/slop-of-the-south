import * as THREE from "three"

// A full day every 12 minutes, on the wall clock so every player shares the same time of day. Sunrise at 06:00,
// noon at 12:00, sunset at 18:00 game time. The sun light swings east → south → west and fades out; the sky,
// fog and hemisphere light darken to a moonlit blue; `darkness` (0 day … 1 night) drives street lamps, headlights
// and sign reflectivity. ?time=21.5 in the URL freezes the clock at that hour (handy for looking at the night).
export const DAY_SECONDS = 720
const SKY_DISTANCE = 3200                                    // inside the camera's far plane, beyond the loaded tiles

const DAY_SKY = new THREE.Color(0x9fb8cf), DUSK_SKY = new THREE.Color(0xe39a6c), NIGHT_SKY = new THREE.Color(0x0a0f1d)
const DAY_HEMI = new THREE.Color(0xdfe9f3), NIGHT_HEMI = new THREE.Color(0x2a3552)
const DAY_GROUND = new THREE.Color(0x5b6b4a), NIGHT_GROUND = new THREE.Color(0x0b0d12)
const SUN_DAY = new THREE.Color(0xfff2dc), SUN_LOW = new THREE.Color(0xffb070), MOON = new THREE.Color(0x9fb4ff)

export class DayNight {
  constructor(world) {
    this.world = world
    const fixed = Number(new URLSearchParams(location.search).get("time"))
    this.fixedHours = Number.isFinite(fixed) && location.search.includes("time=") ? ((fixed % 24) + 24) % 24 : null
    this.darkness = 0
    this._sky = new THREE.Color()
    this._c = new THREE.Color()
    this._dir = new THREE.Vector3()
    // the sun and the moon: sprites far out along the light directions, moved with the camera, outside the fog
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture("sun"), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }))
    this.sunSprite.scale.setScalar(SKY_DISTANCE * 0.16)
    this.moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture("moon"), transparent: true, depthWrite: false, fog: false }))
    this.moonSprite.scale.setScalar(SKY_DISTANCE * 0.07)
    this.sunSprite.renderOrder = this.moonSprite.renderOrder = -1
    world.scene.add(this.sunSprite, this.moonSprite)
  }

  // game hours 0..24
  hours() {
    if (this.fixedHours !== null) return this.fixedHours
    return ((Date.now() / 1000) % DAY_SECONDS) / DAY_SECONDS * 24
  }

  clock() {
    const h = this.hours()
    return `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`
  }

  // returns darkness 0..1
  update() {
    const w = this.world
    const a = (this.hours() - 6) / 24 * Math.PI * 2          // 0 at sunrise, π/2 at noon, π at sunset
    const elev = Math.sin(a)                                  // sun elevation, -1..1
    const daylight = smoothstep(-0.22, 0.30, elev)             // twilight lingers ~40 game minutes after sunset
    const dusk = (1 - smoothstep(0, 0.35, Math.abs(elev))) * smoothstep(-0.35, -0.05, elev)   // warm glow around the horizon

    this._sky.copy(NIGHT_SKY).lerp(DAY_SKY, daylight).lerp(DUSK_SKY, dusk * 0.5)
    w.scene.background.copy(this._sky)
    w.scene.fog.color.copy(this._sky)
    w.scene.fog.near = 600 - 300 * (1 - daylight); w.scene.fog.far = 2200 - 900 * (1 - daylight)

    // the sun: east at sunrise, high in the south at noon, west at sunset; at night a faint moon from the other side
    const up = Math.max(elev, 0.02)
    if (elev > -0.05) w.sun.position.set(Math.cos(a) * 600, up * 600, Math.sin(a) * 300 + 80)
    else w.sun.position.set(-Math.cos(a) * 400, 500, -Math.sin(a) * 200 + 150)

    // sun disc: along the sun's compass direction, reddening and fading as it touches the horizon. The chase camera
    // only sees ~20° above the horizon, so the disc rides a flattened arc (2° at the horizon, 18° at noon) instead
    // of the true elevation the light uses
    const cam = w.camera.position
    const sunAlt = THREE.MathUtils.degToRad(2 + 16 * elev)
    this._dir.set(Math.cos(a), 0, Math.sin(a) * 0.5 + 0.13).normalize().multiplyScalar(Math.cos(sunAlt)).setY(Math.sin(sunAlt))
    this.sunSprite.position.copy(cam).addScaledVector(this._dir, SKY_DISTANCE)
    this.sunSprite.material.opacity = smoothstep(-0.03, 0.06, elev)
    this.sunSprite.material.color.copy(this._c.copy(SUN_DAY).lerp(SUN_LOW, dusk))
    // moon: opposite the sun, up all night, gone by day
    const moonAlt = THREE.MathUtils.degToRad(3 + 13 * Math.max(-elev, 0))                      // same flattened arc for the moon
    this._dir.set(-Math.cos(a), 0, -Math.sin(a) * 0.5 + 0.2).normalize().multiplyScalar(Math.cos(moonAlt)).setY(Math.sin(moonAlt))
    this.moonSprite.position.copy(cam).addScaledVector(this._dir, SKY_DISTANCE)
    this.moonSprite.material.opacity = smoothstep(0.02, 0.2, -elev)
    w.sun.color.copy(daylight > 0.02 ? this._c.copy(SUN_DAY).lerp(SUN_LOW, dusk) : MOON)
    w.sun.intensity = 1.6 * daylight + 0.12 * (1 - daylight)
    w.hemi.color.copy(this._c.copy(NIGHT_HEMI).lerp(DAY_HEMI, daylight))
    w.hemi.groundColor.copy(this._c.copy(NIGHT_GROUND).lerp(DAY_GROUND, daylight))
    w.hemi.intensity = 0.22 + 0.68 * daylight
    w.renderer.toneMappingExposure = 1 + 0.35 * (1 - daylight)

    this.darkness = 1 - daylight
    return this.darkness
  }
}

// sun: white core with a warm halo (additive); moon: pale disc with a few maria and a faint glow
function discTexture(kind) {
  const c = document.createElement("canvas"); c.width = c.height = 256
  const ctx = c.getContext("2d")
  if (kind === "sun") {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.16, "rgba(255,250,225,1)"); g.addColorStop(0.2, "rgba(255,235,180,0.55)")
    g.addColorStop(0.45, "rgba(255,200,120,0.14)"); g.addColorStop(1, "rgba(255,180,100,0)")
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256)
  } else {
    const halo = ctx.createRadialGradient(128, 128, 60, 128, 128, 128)
    halo.addColorStop(0, "rgba(200,210,235,0.35)"); halo.addColorStop(1, "rgba(200,210,235,0)")
    ctx.fillStyle = halo; ctx.fillRect(0, 0, 256, 256)
    ctx.fillStyle = "#e6e9f0"; ctx.beginPath(); ctx.arc(128, 128, 62, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = "rgba(150,158,180,0.55)"
    for (const [x, y, r] of [[108, 112, 16], [140, 100, 10], [150, 140, 14], [118, 150, 9], [96, 138, 7]]) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill() }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

function smoothstep(a, b, x) { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
