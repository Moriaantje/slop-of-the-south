// Every knob of the car feel, camera and effects in one place. Live-tweakable from the console: window.slop.tuning.
// Units: metres, seconds, radians. Rates are 1/s (exponential approach), smooth times are seconds (critically damped).
export const TUNING = {
  car: {
    maxSpeed: 44,          // m/s ≈ 160 km/h
    accel: 9,
    brakeForce: 20,
    maxSteer: 0.55,        // rad at standstill
    steerRate: 8,          // /s: how fast the wheels reach the wanted angle
    reverseFrac: 0.25,     // reverse top speed as a fraction of maxSpeed
  },
  drift: {
    minSpeed: 8,           // m/s needed to start or hold a drift
    gripNormal: 1.0, gripDrift: 0.22, gripMild: 0.55,
    latDampMax: 14,        // /s: sideways speed decays this fast at full grip (≈70 ms to kill a slide)
    gripInRate: 12,        // grip drops this fast when a drift starts
    gripOutRate: 6,        // …and comes back this fast on release (≈0.35–0.5 s)
    maxLatAccel: 14,       // m/s²: the tyres' grip limit; steering that asks for more is capped (and slides mildly)
    driftMaxYaw: 0.9,      // rad/s: steering-driven rotation cap while drifting
    yawGain: 1.6,          // steering counts this much more while drifting
    yawSustain: 0.45,      // rad/s of free rotation in the drift direction at speed (keeps the slide going)
    yawRateSmooth: { grip: 12, drift: 4 },
    redirect: { grip: 0.97, drift: 0.9 },          // share of the scrubbed sideways speed that turns into forward speed (1 = turning is free)
    steerLockBonus: 1.35,
    handbrakeDecel: 2.5,   // m/s² while drifting (a plain handbrake stop scrubs 12)
    slideDrag: 1.0,        // m/s² of extra drag while sliding
    maxSlip: 0.9,          // rad: past this the slide is damped extra so the car never spins out
    naturalDrift: { minSpeed: 22, latAccel: 11 },   // sharp turns at speed slide mildly on their own
    chargeSlip: 0.14,      // rad of slip before drift time counts towards the turbo
    chargeLevels: [0.7, 1.5, 2.5],                  // seconds of drift → level 1, 2, 3
  },
  boost: {
    drainTime: 3.0,        // seconds of nitro in a full meter
    refillTime: 25,        // seconds to trickle back to full
    reengage: 0.12,        // meter needed to start boosting again after running dry
    burst: [0, 0.5, 0.9, 1.4],                      // seconds of free boost per drift charge level
    meterPerLevel: 0.12,
    pickupFill: 0.35, pickupBurst: 0.4,             // a road pad fills 35 % and gives a short free kick
    speedBonus: 0.28,      // top speed +28 % at full boost
    accelBonus: 0.9,       // acceleration +90 %
    powerSmooth: 6,        // /s: boost power ramps in and out
    overspeedBleed: 2,     // /s: speed above the current cap bleeds off instead of snapping
  },
  camera: {
    dist: 8.0, distPerSpeed: 2.5, distBoost: 1.2,
    height: 2.6, heightPerSpeed: 1.0,        // lower and closer at rest: streets framed at eye height, rising with speed
    lookAhead: 4.0, lookHeight: 1.5,
    posSmooth: 0.18, lookSmooth: 0.08, yawSmooth: 0.22,
    velBlend: 0.6, velBlendDrift: 0.85,             // how much the camera sits behind the velocity rather than the nose
    velBlendMinSpeed: 3, velBlendFullSpeed: 11,
    fov: 60, fovPerSpeed: 10, fovBoost: 8, fovMax: 78, fovSmooth: 0.3,
    groundClearance: 1.0,
  },
  susp: {
    heaveHz: 1.8, heaveZeta: 0.35,
    attitudeHz: 2.2, attitudeZeta: 0.4,
    pitchPerAccel: 0.012, rollPerAccel: 0.016,      // rad per m/s²
    maxPitch: 0.12, maxRoll: 0.14,
    travel: 0.35,          // wheel and body travel limit
    maxCornerDrop: 1.0,    // a corner more than this below/above the centre is an unloaded tile: use the centre height
    wheelRadius: 0.33,
    accelSmooth: 10,
  },
  pickups: {
    kinds: ["primary", "secondary", "tertiary", "residential", "unclassified"],
    spacingMin: 300, spacingMax: 500, firstOffset: 60,
    minStraight: 40, maxBend: 0.35,                 // a pad needs 40 m of road bending less than 0.35 rad around it
    radius: 2.2, respawn: 20, height: 0.5, size: 2.4,
  },
  fx: { smokeRate: 28, smokeLife: 0.7, smokeSlip: 0.18, smokePool: 64, flameFlicker: 0.4 },
  mech: {
    walk: 12, reverse: 5,  // m/s
    accelRate: 6,          // /s: speed approaches the wanted walking speed this fast
    turnRate: 2.4,         // rad/s, turning in place
    slopeMax: 0.75,        // tan 37°: steeper than this ahead and the mech stops
    probe: 1.5,            // metres ahead the slope is measured
    jumpV: 18, gravity: 20,          // apex ≈ 8 m
    hoverSink: 1.0,        // m/s sink while hovering (Space held after the apex)
    hoverDrain: 0.25, shieldDrain: 0.15,   // mana per second
    shieldSlow: 0.6,       // walking speed while the shield is up
    manaRegen: 25,         // seconds from empty to full while casting nothing
    ySmooth: 10,           // /s: the body eases onto curbs and steps
    height: 4.2,           // metres, also the model's normalised height (Assets.MODELS.mech)
    drownDepth: 1.5, drownTime: 3,   // water deeper than this for this long: "Verzopen"
  },
  transform: {
    time: 1.2, swapAt: 0.5, cooldown: 2,
    shake: 0.34,           // camera shake at the swap
  },
  spells: {
    fireball:  { mana: 0.2, speed: 60, r: 6, dmg: 60, cd: 0.6, life: 3 },   // the server caps a strike at 60: send what it will honour
    lightning: { mana: 0.35, range: 200, ahead: 60, r: 3, dmg: 30, cd: 1.5 },
    aimCone: 0.44, aimRange: 300,    // auto-aim: a dragon within this angle and range is the target
  },
  // the landscape's own dials: the vegetation LOD distances and the road surface (Trees.js, Grass.js, Roads.js)
  veg: {
    lodNear: 105,          // m: full tree geometry inside this, a cross of painted cards beyond
    lodDrop: 1300,         // m: nothing at all beyond this — it covers the loaded tiles, since the fog starts at 900
  },
  road: {
    crown: 0.022, crownMax: 0.06,   // camber: the fall per metre across the carriageway, and its cap
  },
  look: {
    exposure: 0.95,        // tone mapping exposure by day (the night adds up to +35 %)
    sun: 2.4,              // the sun's intensity at noon. The hemisphere fill dropped to 0.27 to buy shadow
                           // contrast, so the key has to come up: the ratio lands near 5:1 instead of 2:1.
    skyGain: 0.33,         // the scattering sky's output, scaled into the same linear range as the lit ground
    skyShoulder: 1.2,      // the Reinhard shoulder above it: what stops the sky tripping the bloom threshold
    envIntensity: 0.35,    // how much the sky environment map lights standard materials
    hemi: 0.5,             // hemisphere light scale once the environment map supplies ambient (1 without it)
    orthoSat: 1.1, orthoGain: 0.9,   // saturation and gain of the aerial photo on the terrain
    detail: 0.9, detailFar: 260,     // the close-range ground grain: strength, and the distance it has faded out by
    windows: { lit: 0.35, glow: 1.4 }, // share of windows lit at night, and how bright
    buildings: { reveal: 0.13, chamfer: 0.14, plinth: 0.55 },   // m: how deep the glass sits behind the wall, how much corner the chamfer takes, how high the base course
    wind: 0.35,            // 0 still, 1 a fresh breeze: drives the sway of every tree, hedge and tuft
    shadows: { size: 2048, radius: 170 },   // the sun's shadow map: texels, and metres around the player it covers
    post: { ao: 0.9, bloom: 0.28, bloomThreshold: 0.85, contrast: 1.08, saturation: 1.12, warm: 0.06, vignette: 0.28, sharpen: 0.6, grain: 0.018 },   // Post.js
    shafts: 0.25,          // sun shafts through the fog when you look towards the sun
    mist: 0.7,             // ground mist in the low places at dawn and dusk
  },
}

// exponential approach: frame-rate independent first-order smoothing
export function expDamp(cur, tgt, rate, dt) { return cur + (tgt - cur) * (1 - Math.exp(-rate * dt)) }

// critically damped spring (Game Programming Gems 4 / Unity SmoothDamp): never overshoots, frame-rate independent.
// vel is an array holding the velocity at index i (so Vector3-like state can be smoothed per component).
export function smoothDamp(cur, tgt, vel, i, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime), x = omega * dt
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = cur - tgt, temp = (vel[i] + omega * change) * dt
  vel[i] = (vel[i] - omega * temp) * e
  return tgt + (change + temp) * e
}

export function wrapAngle(a) { return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI }
export function lerpAngle(a, b, k) { return a + wrapAngle(b - a) * k }
export function smoothDampAngle(cur, tgt, vel, i, smoothTime, dt) { return smoothDamp(cur, cur + wrapAngle(tgt - cur), vel, i, smoothTime, dt) }
export function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// FNV-1a over a string → 32-bit seed, and a tiny seeded RNG
export function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
