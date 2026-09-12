import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { Sky } from "three/addons/objects/Sky.js"
import { patchSkyMaterial, sunStrength, duskWarmth, sunTint, DayNight } from "game/DayNight"
import { heightFogFactor, installHeightFog, FOG_VERTEX, FOG_PARS_VERTEX, FOG_PARS_FRAGMENT, FOG_FRAGMENT, FOG_BASE } from "game/HeightFog"
import { weatherCover, sunStep } from "game/Clouds"
import { Atmosphere } from "game/Atmosphere"

// GLSL is never compiled in these tests, so the least we can do is check that a shader string is well formed:
// balanced delimiters, and no bare integer where the language demands a float.
function balanced(src) {
  const pairs = { "}": "{", ")": "(" }
  const stack = []
  for (const ch of src) {
    if (ch === "{" || ch === "(") stack.push(ch)
    else if (pairs[ch]) { if (stack.pop() !== pairs[ch]) return false }
  }
  return stack.length === 0
}

test("the Preetham sky is rescaled into the renderer's range, and its own sun disc switched off", () => {
  const m = patchSkyMaterial(new Sky().material)
  assert.equal(m.uniforms.showSunDisc.value, 0)        // a 60 000-unit spike straight into the bloom pass
  assert.equal(m.uniforms.cloudCoverage.value, 0)      // Clouds.js draws the deck; this one would fight it
  assert.ok(m.uniforms.uGain.value > 0 && m.uniforms.uGain.value < 1)
  assert.ok(m.uniforms.uShoulder.value > 0)
  assert.ok(!m.fragmentShader.includes("gl_FragColor = vec4( texColor, 1.0 );"), "the raw output must be gone")
  assert.ok(m.fragmentShader.includes("gl_FragColor = vec4( skyCol, 1.0 );"))
  assert.ok(balanced(m.fragmentShader), "braces and brackets balanced")
  // every uniform the injected code reads has to be declared in the same stage
  for (const name of ["uGain", "uShoulder"]) {
    assert.ok(new RegExp(`uniform float ${name};`).test(m.fragmentShader), `${name} declared`)
  }
})

test("patching a shader three has changed under us fails loudly rather than silently", () => {
  const m = new Sky().material
  m.fragmentShader = "void main() { gl_FragColor = vec4(1.0); }"
  assert.throws(() => patchSkyMaterial(m), /Sky\.js shader changed/)
})

test("the sun is out by the time it touches the horizon, and full strength at noon", () => {
  assert.equal(sunStrength(-0.5), 0)
  assert.equal(sunStrength(-0.015), 0)
  assert.ok(sunStrength(0) < 0.05, "a sun on the horizon casts no usable shadow")
  assert.ok(sunStrength(0.10) > 0.3 && sunStrength(0.10) < 0.8, "golden hour is half lit")
  assert.equal(sunStrength(0.85), 1)
  let last = -1
  for (let e = -0.3; e <= 1; e += 0.01) { const s = sunStrength(e); assert.ok(s >= last - 1e-9); last = s }
})

test("dusk warmth peaks around the horizon and is gone at noon and at midnight", () => {
  assert.ok(duskWarmth(0.85) < 0.001)
  assert.ok(duskWarmth(-0.9) < 0.001)
  const peak = duskWarmth(-0.02)
  assert.ok(peak > 0.7, `expected a strong dusk, got ${peak}`)
  assert.ok(duskWarmth(0.3) < peak)
})

test("the sun reddens as it drops", () => {
  const hot = new THREE.Color(), low = new THREE.Color()
  sunTint(hot, 0.85); sunTint(low, 0.02)
  const warmth = (c) => c.r / Math.max(c.b, 1e-6)
  assert.ok(warmth(low) > warmth(hot) * 2, "a setting sun is far redder than a noon sun")
  assert.ok(hot.r >= hot.g && hot.g >= hot.b, "even at noon the disc is a touch warm")
})

test("height fog pools in the valleys and thins on the plateaus", () => {
  const near = 900, far = 2700
  const valley = heightFogFactor(1500, 30, near, far)      // Maas valley floor
  const plateau = heightFogFactor(1500, 114, near, far)    // the highest ground in the province
  assert.ok(valley > plateau * 1.6, `valley ${valley} should be much hazier than plateau ${plateau}`)
  assert.ok(heightFogFactor(0, 30, near, far) < 0.05, "nothing right in front of the camera")
  for (const [d, h] of [[0, 0], [500, 40], [4000, 200], [4000, 0]]) {
    const f = heightFogFactor(d, h, near, far)
    assert.ok(f >= 0 && f <= 1, `factor in range at ${d} m / ${h} m: ${f}`)
  }
  // below the pooling level the haze cannot get any thicker: a riverbed is as hazy as the bank
  assert.equal(heightFogFactor(1500, FOG_BASE - 20, near, far), heightFogFactor(1500, FOG_BASE, near, far))
  let last = -1
  for (let d = 0; d < 4000; d += 25) { const f = heightFogFactor(d, 30, near, far); assert.ok(f >= last - 1e-9); last = f }
})

test("the height fog chunks declare their varying in both stages and are installed once", () => {
  assert.ok(FOG_PARS_VERTEX.includes("varying float vFogHeight;"))
  assert.ok(FOG_PARS_FRAGMENT.includes("varying float vFogHeight;"))
  assert.ok(FOG_VERTEX.includes("vFogHeight ="), "written in the vertex stage")
  assert.ok(FOG_FRAGMENT.includes("vFogHeight"), "read in the fragment stage")
  for (const src of [FOG_PARS_VERTEX, FOG_VERTEX, FOG_PARS_FRAGMENT, FOG_FRAGMENT]) assert.ok(balanced(src))
  // no bare integers: "32" where GLSL needs "32.0" is a compile error against a float
  assert.ok(!/[^.\w]\d+\s*[,)]/.test(FOG_FRAGMENT.replace(/vec3|vec2/g, "")), "every literal carries a decimal point")
  installHeightFog()
  assert.equal(THREE.ShaderChunk.fog_fragment, FOG_FRAGMENT)
  assert.equal(installHeightFog(), false, "installing twice is a no-op")
})

test("the weather wanders on the wall clock, the same for everyone", () => {
  for (const t of [0, 137, 5000, 1e6]) {
    const c = weatherCover(t)
    assert.ok(c > 0.25 && c < 0.7, `coverage ${c} stays between a clear and a dull day`)
  }
  assert.equal(weatherCover(1234), weatherCover(1234))                    // a pure function of the clock
  assert.ok(Math.abs(weatherCover(0) - weatherCover(900)) < 1e-9)         // one period apart
  assert.ok(Math.abs(weatherCover(0) - weatherCover(225)) > 0.05)         // and it actually moves
})

test("the cloud self-shadow march rakes out as the sun drops", () => {
  const at = (y) => { const d = new THREE.Vector3(1, y, 0).normalize(); const s = sunStep(d); return Math.hypot(s.x, s.y) }
  assert.ok(at(0.15) > at(0.9), "a low sun throws its shadow much further across the deck")
  assert.equal(Math.hypot(...Object.values(sunStep(new THREE.Vector3(0, 1, 0)))), 0, "a sun straight up has no offset")
  assert.ok(at(0.02) < Infinity && at(0.02) > 0, "and a sun on the horizon is clamped, not infinite")
})

// A headless smoke test of the whole day: build the real DayNight against a stub world and walk the clock, so that
// a fumbled uniform name or a NaN in the light curves shows up here rather than as a black screen.
function stubWorld() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color()
  scene.fog = new THREE.Fog(0xffffff, 900, 2700)
  const world = {
    scene, camera: new THREE.PerspectiveCamera(), sunAnchor: new THREE.Vector3(),
    sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(), renderer: { toneMappingExposure: 1 },
  }
  scene.add(world.sun, world.sun.target, world.hemi)
  return world
}

test("a whole day runs without a NaN, and the light behaves at each phase", () => {
  const world = stubWorld()
  const dn = new DayNight(world)
  const seen = []
  for (let h = 0; h < 24; h += 0.25) {
    dn.fixedHours = h
    const darkness = dn.update()
    assert.ok(Number.isFinite(darkness) && darkness >= 0 && darkness <= 1, `darkness at ${h}h`)
    for (const v of [world.sun.intensity, world.hemi.intensity, world.renderer.toneMappingExposure,
                     world.scene.fog.near, world.scene.fog.far, dn.scatter.material.uniforms.turbidity.value]) {
      assert.ok(Number.isFinite(v), `finite value at ${h}h`)
    }
    assert.ok(Math.abs(dn.scatter.material.uniforms.sunPosition.value.length() - 1) < 1e-6, "the sky is fed a unit direction")
    seen.push({ h, darkness, sun: world.sun.intensity, elev: dn.scatter.material.uniforms.sunPosition.value.y })
  }
  const noon = seen.find((s) => s.h === 13)
  const night = seen.find((s) => s.h === 1)
  const dusk = seen.reduce((a, b) => (Math.abs(b.elev) < Math.abs(a.elev) && b.h > 12 ? b : a))
  assert.ok(noon.darkness < 0.02, "noon is fully lit")
  assert.ok(night.darkness > 0.98, "the small hours are fully dark")
  assert.ok(noon.sun > dusk.sun * 4, "noon casts a far stronger sun than dusk")
  assert.ok(night.sun < 0.2, "only moonlight at night")
  assert.ok(noon.elev > 0.8, "the scattering model gets the true elevation, not the flattened arc")
})

test("the mist and the shafts follow the true elevation, so nothing pops at sunset", () => {
  const world = stubWorld()
  const dn = new DayNight(world)
  const air = new Atmosphere(world)
  world.camera.position.set(0, 40, 0)
  world.camera.updateMatrixWorld()
  let last = null, worst = 0
  for (let h = 4; h < 23; h += 0.01) {
    dn.fixedHours = h
    dn.update()
    // the arc the light and the scattering ride is the honest one; the sprite rides a flattened copy of it
    assert.ok(Math.abs(dn.env.sunElev - dn.scatter.material.uniforms.sunPosition.value.y) < 1e-9)
    assert.ok(dn.env.discDir.y < 0.32, "the disc never climbs out of the strip of sky the chase camera sees")
    if (dn.sunSprite.material.opacity > 0.01) assert.ok(dn.env.discDir.y > 0, "…and it is above the horizon whenever it shows")
    air.update(1 / 60, world.camera, dn.env, 40)
    const mist = air.mistMat.uniforms.uStrength.value
    assert.ok(Number.isFinite(mist) && mist >= 0)
    if (last !== null) worst = Math.max(worst, Math.abs(mist - last))
    last = mist
  }
  // the old code read the light direction, which flips to the moon the instant the sun sets: that showed up
  // here as a step of about half the range. A smooth curve over this step of the clock cannot exceed a per cent or two.
  assert.ok(worst < 0.02, `the mist should ease through sunset, worst step was ${worst}`)
})
