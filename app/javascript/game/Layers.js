// Which objects the ambient-occlusion pre-pass is allowed to see.
//
// GTAOPass draws the scene's depth and normals with an override material that knows nothing about alpha. Anything
// cut out of a quad — a leaf card, a grass tuft, a hedge, a sprite — therefore occludes as the whole quad, and the
// occlusion it writes shows up in the frame as a dark rectangle around it. Anything large and translucent, like the
// mech's shield bubble, is worse: it covers the screen at close range, and every pixel behind it comes back fully
// occluded, which reads as the picture going black.
//
// So everything cut out or translucent lives on ALPHA layer. The main camera and the sun's shadow camera both have
// that layer enabled, so it renders and casts as normal; the AO pre-pass turns it off for the duration of its own
// render. Objects claim the layer when they are built rather than waiting for Post's periodic sweep to find them,
// because the sweep cannot see an object that is not in the scene graph yet — the mech and its bubble exist long
// before the first transform puts them there.
export const ALPHA = 1

export function noAO(object) {
  object.layers.set(ALPHA)
  return object
}
