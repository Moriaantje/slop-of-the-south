import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { LOOK, refreshUniforms as refreshGround } from "game/TerrainTile"
import { tuneWindows } from "game/BuildingMeshes"
import { Sky } from "three/addons/objects/Sky.js"

// A full day every 8 minutes, on the wall clock so every player shares the same time of day: the daylight hours
// (03:45–22:15) take seven of them, the night (22:15–03:45) one, so a night is a short dark minute. Sunrise at 04:30,
// solar noon at 13:00, sunset at 21:30 game time. ?time=23 in the URL freezes the clock at that hour.
//
// The sky is two shells, and the split matters because they are good at opposite ends of the day. Underneath sits
// three's Sky (Preetham et al., "A Practical Analytic Model for Daylight", 1999): a real scattering integral, which
// is the only cheap way to get the graded horizon, the haze banked around the sun and the honest orange of a low
// sun. Over it sits a hand-painted dome that adds what Preetham cannot do at all — the model's earth-shadow hack
// cuts the sky to black about two degrees under the horizon, so the whole of twilight, the stars and the moonlit
// blue of the night have to be painted, and they are blended in additively as the scattering dies.
//
// Preetham's radiance is in absolute-ish units (its own internal exposure is that 0.04 in the shader) and comes out
// between about 5 and 20 at a high sun, which is five to twenty times brighter than a sunlit surface in this scene.
// Under ACES at the exposure this game uses that is a white screen, and worse, every one of those pixels sits far
// above the bloom pass's threshold, so the sky bleeds over the whole frame and takes the ground with it. Two things
// fix it and both are done in patchSkyMaterial below: the output is scaled by SKY_GAIN and then run through a
// luminance-preserving shoulder, which lands the sky between 0.1 and 1.3 — bright against the ground but under the
// bloom threshold, so only the sun disc itself blooms — and the addon's own sun disc is switched off, because it
// emits a radiance of sixty thousand and that single spike is what floods the bloom pyramid. The disc the player
// sees is the sprite this file draws, which has the further advantage that it can ride a flattened arc.
//
// The scattering model is also fed the TRUE sun elevation. The sprite rides a compressed arc so that a chase camera
// looking twenty degrees above the horizon can still see it, but feeding that fake elevation to a scattering model
// tells it the sun is permanently at eighteen degrees, and it dutifully paints a permanent late-afternoon haze over
// the whole sky. The two directions are tracked separately: env.sunDir for light and scattering, env.discDir for
// everything that has to agree with the sprite the player can point at.
export const DAY_SECONDS = 480
const NIGHT_FROM = 22.25, NIGHT_TO = 3.75, NIGHT_SECONDS = 60      // wall seconds the dark hours take
export const SUNRISE = 4.5, SUNSET = 21.5
const SKY_DISTANCE = 3200                                    // inside the camera's far plane, beyond the loaded tiles

// Scattering sky. The gain and shoulder were picked by evaluating the Preetham integral against ACES at this
// project's exposure: they put the noon zenith near sRGB 120/180/230, the noon horizon haze near 200/215/220 and a
// three-degree sun's horizon near 255/175/105, with nothing in the sky above the bloom threshold.
const SKY_GAIN = 0.33, SKY_SHOULDER = 1.2
const TURBIDITY_HIGH = 2.6, TURBIDITY_LOW = 7.5     // haze: clean overhead, thick and warm along a low sun's path
const RAYLEIGH_HIGH = 2.3, RAYLEIGH_LOW = 0.7       // blue scattering, a little stronger when the path is long
const MIE = 0.005, MIE_G = 0.76                     // aerosol amount and how forward-throwing it is (the sun's halo)

// Painted dome: zenith / horizon by phase, plus the glow banked around the sun through twilight. These colours are
// also what the water reflects, what the fog fades into and what the environment map is baked from (EnvMap.js), so
// they have to stay sane all day even while the dome itself is invisible.
const DAY_ZENITH = new THREE.Color(0x5f9ad8), DAY_HORIZON = new THREE.Color(0xc2d6e2)
const DUSK_ZENITH = new THREE.Color(0x1b2a55), DUSK_HORIZON = new THREE.Color(0xf0a05e), DUSK_GLOW = new THREE.Color(0xff6a28)
const NIGHT_ZENITH = new THREE.Color(0x070d22), NIGHT_HORIZON = new THREE.Color(0x16233f)
const DAY_SKY = new THREE.Color(0x9fb8cf), DUSK_SKY = new THREE.Color(0xe39a6c), NIGHT_SKY = new THREE.Color(0x0a0f1d)
// Hemisphere fill. A midday sky bounces cool light down and the ground bounces warm light up; at golden hour both
// go warm. Keeping this fill low is what gives noon its shadow contrast: fill it in and the scene goes flat.
const DAY_HEMI = new THREE.Color(0xcfe0f2), DUSK_HEMI = new THREE.Color(0xffc59a), NIGHT_HEMI = new THREE.Color(0x2a3552)
const DAY_GROUND = new THREE.Color(0x5b6b4a), DUSK_GROUND = new THREE.Color(0x6b5340), NIGHT_GROUND = new THREE.Color(0x0b0d12)
// The disc reddens as its light takes the long way through the atmosphere, and so does everything it lights
const SUN_NOON = new THREE.Color(0xfff6e2), SUN_GOLD = new THREE.Color(0xffb15e), SUN_LOW = new THREE.Color(0xff7433)
const MOON = new THREE.Color(0x9fb4ff)
const HEMI_BASE = 0.24, HEMI_DAY = 0.30, HEMI_DUSK = 0.26     // hemisphere intensity: floor, the day's share, the warm dusk lift
const MOON_LIGHT = 0.12                                        // directional intensity of the moon, once the sun is gone
const FOG_NEAR_DAY = 900, FOG_FAR_DAY = 2700                   // m: aerial perspective by day…
const FOG_NEAR_NIGHT = 380, FOG_FAR_NIGHT = 1700               // …and the much closer wall the night draws
const ZERO = new THREE.Vector3()

export class DayNight {
  constructor(world) {
    this.world = world
    const fixed = Number(new URLSearchParams(location.search).get("time"))
    this.fixedHours = Number.isFinite(fixed) && location.search.includes("time=") ? ((fixed % 24) + 24) % 24 : null
    this.darkness = 0
    this.env = { darkness: 0, sunUp: 1, sunElev: 1, sunDir: new THREE.Vector3(0, 1, 0), discDir: new THREE.Vector3(0, 1, 0),
                 sunColor: new THREE.Color(), zenith: new THREE.Color(), horizon: new THREE.Color() }
    this._sky = new THREE.Color()
    this._c = new THREE.Color()
    this._dir = new THREE.Vector3()
    this._true = new THREE.Vector3()
    // the sun and the moon: sprites far out along the light directions, moved with the camera, outside the fog
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture("sun"), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }))
    this.sunSprite.scale.setScalar(SKY_DISTANCE * 0.16)
    this.moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture("moon"), transparent: true, depthWrite: false, fog: false }))
    this.moonSprite.scale.setScalar(SKY_DISTANCE * 0.07)
    this.sunSprite.renderOrder = this.moonSprite.renderOrder = -1
    world.scene.add(this.sunSprite, this.moonSprite)
    // the painted dome: twilight, the stars and the moonlit night, added over the scattering rather than covering it
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_DISTANCE * 1.1, 32, 16), new THREE.ShaderMaterial({
      uniforms: { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, glow: { value: DUSK_GLOW.clone() },
                  sunDir: { value: new THREE.Vector3(1, 0, 0) }, glowStrength: { value: 0 }, stars: { value: 0 }, groundDim: { value: 1 }, opacity: { value: 1 } },
      vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, side: THREE.BackSide, depthWrite: false, fog: false,
      transparent: true, blending: THREE.AdditiveBlending
    }))
    this.sky.renderOrder = -10
    this.sky.frustumCulled = false
    world.scene.add(this.sky)
    // the scattering sky underneath, always on: black of its own accord once the sun is down
    this.scatter = new Sky()
    this.scatter.scale.setScalar(SKY_DISTANCE * 1.05)
    this.scatter.renderOrder = -11
    this.scatter.frustumCulled = false
    patchSkyMaterial(this.scatter.material)
    world.scene.add(this.scatter)
  }

  // game hours 0..24
  hours() {
    if (this.fixedHours !== null) return this.fixedHours
    return warpHours((Date.now() / 1000) % DAY_SECONDS)
  }

  clock() {
    const h = this.hours()
    return `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`
  }

  // returns darkness 0..1
  update() {
    const w = this.world
    const a = sunAngle(this.hours())
    const elev = Math.sin(a)                                  // sun elevation on the game's arc, -1..1
    const ambient = smoothstep(-0.25, 0.16, elev)             // the general light level; twilight lingers under it
    const direct = sunStrength(elev)                          // the sun itself, out by the time it touches the horizon
    const dusk = duskWarmth(elev)                             // how warm and low everything goes
    const night = 1 - smoothstep(-0.12, 0.05, elev)           // how much of the painted dome shows through

    this._sky.copy(NIGHT_SKY).lerp(DAY_SKY, ambient).lerp(DUSK_SKY, dusk * 0.5)
    w.scene.background.copy(this._sky)
    const u = this.sky.material.uniforms
    u.zenith.value.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, ambient).lerp(DUSK_ZENITH, dusk)
    u.horizon.value.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, ambient).lerp(DUSK_HORIZON, dusk)
    u.glowStrength.value = dusk * 1.1 * (0.35 + 0.65 * night)  // the painted glow only carries once Preetham has given up
    u.stars.value = smoothstep(0.06, 0.30, -elev)
    u.opacity.value = night                                    // additive: the dome contributes nothing by day
    this.sky.visible = night > 0.002                           // …so there is no point rasterising it through the day
    w.scene.fog.color.copy(u.horizon.value)                    // the ground fades into the horizon, not into a flat sky
    w.scene.fog.near = FOG_NEAR_NIGHT + (FOG_NEAR_DAY - FOG_NEAR_NIGHT) * ambient
    w.scene.fog.far = FOG_FAR_NIGHT + (FOG_FAR_DAY - FOG_FAR_NIGHT) * ambient

    // the true arc, which is what the scattering model and the shadows want: east at sunrise, high in the south at
    // noon, west at sunset. The light itself keeps the old dodge of swinging round to a moon once the sun is down.
    this._true.set(Math.cos(a) * 600, elev * 600, Math.sin(a) * 300 + 80).normalize()
    const A = w.sunAnchor ?? ZERO
    if (elev > -0.05) w.sun.position.set(Math.cos(a) * 600, Math.max(elev, 0.02) * 600, Math.sin(a) * 300 + 80)
    else w.sun.position.set(-Math.cos(a) * 400, 500, -Math.sin(a) * 200 + 150)
    this.env.sunDir.copy(w.sun.position).normalize()
    w.sun.position.add(A)                                     // the light (and its shadow camera) rides with the player
    w.sun.target.position.copy(A)

    // sun disc: along the sun's compass direction, on a flattened arc (2° at the horizon, 18° at noon) because the
    // chase camera only ever sees about twenty degrees of sky above the horizon
    const cam = w.camera.position
    const sunAlt = THREE.MathUtils.degToRad(2 + 16 * elev)
    this._dir.set(Math.cos(a), 0, Math.sin(a) * 0.5 + 0.13).normalize().multiplyScalar(Math.cos(sunAlt)).setY(Math.sin(sunAlt))
    this.sunSprite.position.copy(cam).addScaledVector(this._dir, SKY_DISTANCE)
    this.env.discDir.copy(this._dir)
    u.sunDir.value.copy(this._dir)                             // the painted twilight band banks around the visible disc
    this.sky.position.copy(cam)
    this.scatter.position.copy(cam)
    this.scatter.visible = elev > -0.14                        // the model is black well before this; skip the pass
    const su = this.scatter.material.uniforms
    su.sunPosition.value.copy(this._true)
    const low = Math.max(0, 1 - Math.max(elev, 0) * 3.2), lowR = Math.max(0, 1 - Math.max(elev, 0) * 2.5)
    su.turbidity.value = TURBIDITY_HIGH + TURBIDITY_LOW * low
    su.rayleigh.value = RAYLEIGH_HIGH + RAYLEIGH_LOW * lowR
    this.sunSprite.material.opacity = smoothstep(-0.03, 0.06, elev) * (0.55 + 0.45 * direct)
    sunTint(this._c, elev)
    this.sunSprite.material.color.copy(this._c)
    // moon: opposite the sun, up all night, gone by day, on the same flattened arc
    const moonAlt = THREE.MathUtils.degToRad(3 + 13 * Math.max(-elev, 0))
    this._dir.set(-Math.cos(a), 0, -Math.sin(a) * 0.5 + 0.2).normalize().multiplyScalar(Math.cos(moonAlt)).setY(Math.sin(moonAlt))
    this.moonSprite.position.copy(cam).addScaledVector(this._dir, SKY_DISTANCE)
    this.moonSprite.material.opacity = smoothstep(0.02, 0.2, -elev)

    w.sun.color.copy(direct > 0.02 ? this._c : MOON)
    w.sun.intensity = T.look.sun * direct + MOON_LIGHT * (1 - ambient)
    w.hemi.color.copy(this._c.copy(NIGHT_HEMI).lerp(DAY_HEMI, ambient).lerp(DUSK_HEMI, dusk))
    w.hemi.groundColor.copy(this._c.copy(NIGHT_GROUND).lerp(DAY_GROUND, ambient).lerp(DUSK_GROUND, dusk))
    w.hemi.intensity = (HEMI_BASE + HEMI_DAY * ambient + HEMI_DUSK * dusk) * T.look.hemi
    w.renderer.toneMappingExposure = T.look.exposure * (1 + 0.30 * (1 - ambient))
    this.scatter.material.uniforms.uGain.value = T.look.skyGain
    this.scatter.material.uniforms.uShoulder.value = T.look.skyShoulder
    LOOK.uSat.value = T.look.orthoSat; LOOK.uGain.value = T.look.orthoGain
    LOOK.uDark.value = 1 - ambient
    tuneWindows()
    LOOK.uDetailStrength.value = T.look.detail; LOOK.uDetailFar.value = T.look.detailFar
    refreshGround()                                            // the ground packs several knobs into vectors: repack them

    this.darkness = 1 - ambient
    this.env.darkness = this.darkness
    this.env.sunUp = direct
    this.env.sunElev = this._true.y      // the honest elevation: sunDir swings round to the moon after sunset
    this.env.sunColor.copy(w.sun.color).multiplyScalar(w.sun.intensity)
    this.env.zenith.copy(u.zenith.value); this.env.horizon.copy(u.horizon.value)
    return this.darkness
  }
}

// wall seconds into the day → game hours, the night compressed: the day starts at NIGHT_TO (03:45) and runs to
// NIGHT_FROM (22:15) in DAY_SECONDS − NIGHT_SECONDS, then the night to 03:45 in NIGHT_SECONDS
export function warpHours(s) {
  const dayHours = NIGHT_FROM - NIGHT_TO, daySeconds = DAY_SECONDS - NIGHT_SECONDS
  if (s < daySeconds) return NIGHT_TO + dayHours * (s / daySeconds)
  return (NIGHT_FROM + (24 - dayHours) * ((s - daySeconds) / NIGHT_SECONDS)) % 24
}

// How much direct sun there is, given its elevation (sin of the angle above the horizon). It is gone by the time the
// disc touches the horizon, because a sun on the horizon casts no usable shadow and a shadow that lingers past
// sunset is the surest sign of a fake day. Half strength at about six degrees, which is the golden hour.
export function sunStrength(elev) { return smoothstep(-0.015, 0.20, elev) }

// How warm and low the light is: zero with the sun well up, one for the half hour around sunset and sunrise. Drives
// the sun's colour, the hemisphere fill and the painted glow, so they all turn together.
export function duskWarmth(elev) { return (1 - smoothstep(0.0, 0.26, Math.abs(elev))) * smoothstep(-0.30, -0.02, elev) }

// The disc's colour. Two lerps rather than one: the first is the long slow slide from white to gold that runs
// through the whole afternoon, the second the hard red that only the last couple of degrees bring.
export function sunTint(out, elev) {
  const gold = 1 - smoothstep(0.06, 0.42, elev)
  const red = 1 - smoothstep(-0.01, 0.11, elev)
  return out.copy(SUN_NOON).lerp(SUN_GOLD, gold * gold).lerp(SUN_LOW, red * 0.75)
}

// three's Sky, rescaled. The gain lands the model's radiance in the same range as the lit ground; the shoulder is a
// Reinhard curve on luminance alone rather than per channel, because a per-channel curve pulls a saturated orange
// horizon towards white and the orange is the whole point of having a scattering model. The addon's sun disc and
// its own cloud layer are switched off: the disc is a sixty-thousand-unit spike that floods the bloom pass, and the
// clouds are a four-octave fbm per sky pixel that would fight the deck Clouds.js already draws.
export function patchSkyMaterial(material) {
  const u = material.uniforms
  u.uGain = { value: SKY_GAIN }
  u.uShoulder = { value: SKY_SHOULDER }
  u.showSunDisc.value = 0
  u.cloudCoverage.value = 0
  u.mieCoefficient.value = MIE
  u.mieDirectionalG.value = MIE_G
  const target = "gl_FragColor = vec4( texColor, 1.0 );"
  if (!material.fragmentShader.includes(target)) throw new Error("Sky.js shader changed: cannot rescale its output")
  material.fragmentShader = "uniform float uGain;\nuniform float uShoulder;\n" + material.fragmentShader.replace(target, /* glsl */`
      vec3 skyCol = texColor * uGain;
      float skyLum = dot( skyCol, vec3( 0.2126, 0.7152, 0.0722 ) );
      skyCol *= ( skyLum / ( 1.0 + skyLum * uShoulder ) ) / max( skyLum, 0.00001 );
      gl_FragColor = vec4( skyCol, 1.0 );`)
  material.needsUpdate = true
  return material
}

const SKY_VERTEX = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`
const SKY_FRAGMENT = /* glsl */`
  uniform vec3 zenith, horizon, glow, sunDir;
  uniform float glowStrength, stars, groundDim, opacity;
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(horizon, zenith, pow(h, 0.42));
    // dawn/dusk: a warm band along the horizon, strongest towards the sun
    float toSun = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0);
    col += glow * glowStrength * exp(-h * 7.0) * (0.15 + 0.85 * pow(toSun, 4.0));
    col += glow * glowStrength * 0.35 * exp(-h * 2.5) * pow(toSun, 12.0);
    if (d.y < 0.0) col = horizon * groundDim;          // below the horizon (only the environment map looks there)
    // stars: a sparse hash on the direction; each lit cell holds one soft dot, fading out towards the horizon.
    // The dome covers every pixel, so skip the six hashes per fragment while there are no stars to show.
    if (stars > 0.001 && d.y > 0.0) {
      vec3 cell = floor(d * 420.0);
      float r = hash(cell);
      vec3 f = fract(d * 420.0) - 0.5;
      float dot_ = 1.0 - smoothstep(0.05, 0.28, length(f + (vec3(hash(cell + 3.0), hash(cell + 5.0), hash(cell + 7.0)) - 0.5) * 0.4));
      float star = step(0.9985, r) * dot_ * (0.45 + 0.55 * hash(cell + 1.0)) * smoothstep(0.02, 0.22, d.y);
      col += mix(vec3(1.0), vec3(0.8, 0.9, 1.0), hash(cell + 9.0)) * star * stars * 1.5;
    }
    gl_FragColor = vec4(col, opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

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

// 0 at sunrise, π/2 at solar noon, π at sunset, 2π at the next sunrise: the daylight hours are stretched over the
// upper half of the circle and the night hours squeezed into the lower half
function sunAngle(hours) {
  const t = (hours - SUNRISE + 24) % 24, day = SUNSET - SUNRISE
  return t < day ? t / day * Math.PI : Math.PI + (t - day) / (24 - day) * Math.PI
}

function smoothstep(a, b, x) { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
