import * as THREE from "three"

// Exponential height fog, patched straight into three's own fog chunks so that every material in the scene picks it
// up without any of them knowing. Limburg is the one genuinely hilly province in the country and the terrain here
// runs from about 27 m NAP in the Maas valley to 114 m on the plateaus, but plain distance fog treats a hilltop two
// kilometres away exactly like the valley floor beneath it, so the landscape flattens into a single grey wash and
// all that height is thrown away. Real haze is a fluid: it pools in the low ground and thins out exponentially with
// altitude, which is why hills read as hills from a distance — the tops stay sharp and coloured while the bottoms
// dissolve. Reproducing that costs one extra varying, one exp() and two mixes per fragment, which is nothing next
// to what a volumetric pass would cost, and it is the single cheapest thing that makes distance read as distance.
//
// The world height of the fragment is recovered in the vertex stage from the view-space position that three's fog
// chunk already has to hand: the view matrix is a rigid transform, so its inverse rotation is its transpose and
// worldY = dot(viewMatrix[1].xyz, mvPosition.xyz) + cameraPosition.y. Both of those are declared in three's default
// vertex prefix, so nothing has to be plumbed through and skinned, morphed and instanced geometry all come out
// right because mvPosition is whatever the material actually drew.
//
// The constants below are baked into the chunk source as literals on purpose. Adding uniforms would mean teaching
// WebGLMaterials to upload them for every built-in material, which is not something a game module gets to do; a
// literal costs nothing at runtime and the values are a property of the landscape, not of the moment.

export const FOG_BASE = 32          // m NAP: the level the haze pools at; below this the fog is at full strength
export const FOG_HEIGHT = 42        // m: the e-folding height, so ~95 % of the haze sits in the first 126 m
export const FOG_THIN = 0.52        // share of the distance fog that still reaches a hilltop
export const FOG_VALLEY = 0.20      // extra haze the low ground picks up on top of the distance fade
export const FOG_HAZE_NEAR = 200    // m: nothing closer than this gets the valley term
export const FOG_HAZE_FAR = 1100    // m: …and it has fully built up by here

// GLSL wants a decimal point on every float literal, and an integer constant silently becomes an int
const g = (x) => (Number.isInteger(x) ? x.toFixed(1) : x.toFixed(6))

export const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying float vFogHeight;
#endif`

export const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogHeight = dot( viewMatrix[ 1 ].xyz, mvPosition.xyz ) + cameraPosition.y;
#endif`

export const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying float vFogHeight;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`

export const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	float fogDens = exp( - max( vFogHeight - ${g(FOG_BASE)}, 0.0 ) * ${g(1 / FOG_HEIGHT)} );
	fogFactor *= mix( ${g(FOG_THIN)}, 1.0, fogDens );
	fogFactor += ( 1.0 - fogFactor ) * fogDens * ${g(FOG_VALLEY)} * smoothstep( ${g(FOG_HAZE_NEAR)}, ${g(FOG_HAZE_FAR)}, vFogDepth );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( fogFactor, 0.0, 1.0 ) );
#endif`

let installed = false

// Called once, before anything renders. Chunks are resolved at program-compile time, so materials built earlier in
// the session (the shared water material, for one) still come out with the new fog in them.
export function installHeightFog() {
  if (installed) return false
  installed = true
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT
  return true
}

// The same curve in JavaScript, so the maths above can be checked without a GPU and so anything that needs to know
// how hazy a spot is (the minimap, a debug readout) can ask without guessing. depth and height are metres.
export function heightFogFactor(depth, height, near, far) {
  const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t) }
  const dens = Math.exp(-Math.max(height - FOG_BASE, 0) / FOG_HEIGHT)
  let f = smooth(near, far, depth) * (FOG_THIN + (1 - FOG_THIN) * dens)
  f += (1 - f) * dens * FOG_VALLEY * smooth(FOG_HAZE_NEAR, FOG_HAZE_FAR, depth)
  return Math.min(Math.max(f, 0), 1)
}
