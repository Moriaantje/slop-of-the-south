import * as THREE from "three"

// One wind for the whole landscape. Nothing gives a scene away as assembled out of unrelated parts faster than
// foliage that sways out of step, so the trees, the hedgerows and the grass underneath them all read their bend from
// this single function instead of each inventing its own wobble. The gust is a travelling wave: its phase is the dot
// product of the plant's world position with the wind direction, so a ripple crosses a meadow rather than every blade
// pulsing at once, and two sine terms of incommensurable frequency beat against each other so the loop never becomes
// audible to the eye. Amplitude comes in per vertex as a "flex" value baked into the geometry — zero where the plant
// meets the ground, one at the outermost twig — which is the only thing a caller has to prepare; that keeps leaf
// cards welded to the branch they hang from, because both read the same flex at the same point. The bend also drags
// the vertex down a little, since a branch that leans keeps its length and therefore loses height, and that small
// vertical component is what stops the sway from looking like a sideways slide.
//
// Trees and grass each advance their own uTime uniform at the same rate, so they share a clock without sharing an
// object; uWindGust here is the one dial that changes the weather, and it is deliberately not animated per frame.
export const WIND = {
  uWindDir: { value: new THREE.Vector2(0.83, 0.56) },   // unit vector in world xz
  uWindGust: { value: 1 },                              // 0 still, 1 a fresh breeze, 2 a gale
}

// GLSL declarations plus the offset function, pasted into any vertex shader that wants to move in this wind.
// `anchor` is the world position the gust phase is read at (use the plant's root so the whole plant moves as one),
// `flex` the per-vertex flexibility, `amp` the metres of travel at flex 1 and `flutter` the fast per-leaf tremble.
export const WIND_PARS = `
uniform vec2 uWindDir;
uniform float uWindGust;
vec3 windOffset(vec3 anchor, float flex, float amp, float flutter, float t) {
\tfloat phase = dot(anchor.xz, uWindDir) * 0.055;
\tfloat gust = sin(t * 0.61 - phase) * 0.62 + sin(t * 1.27 - phase * 1.63 + 1.7) * 0.38;
\tgust *= uWindGust;
\tfloat flap = sin(t * 4.3 + anchor.x * 1.7 + anchor.z * 2.3 + flex * 9.0) * flutter * uWindGust;
\tfloat bend = flex * amp;
\tvec2 d = uWindDir * (gust * bend + flap);
\treturn vec3(d.x, -abs(gust) * bend * 0.22, d.y);
}
`
