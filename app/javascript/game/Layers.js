// Which objects a screen-space pre-pass is allowed to see.
//
// This layer was invented for three's GTAOPass, which drew the scene's depth and normals through an override
// material that knew nothing about alpha: anything cut out of a quad — a leaf card, a grass tuft, a hedge, a sprite
// — occluded as the whole quad and wore a dark rectangle, and anything large and translucent, like the mech's
// shield bubble, blacked out everything behind it. So everything cut out or translucent was moved here, out of the
// pre-pass's sight.
//
// The occlusion now comes from the depth buffer the main render already wrote (game/Ao), and that buffer is written
// by the real materials, alpha test and all, so a leaf occludes as a leaf and a bubble that writes no depth cannot
// occlude at all. The layer survives because it is still the cheapest way to say "this thing is cut out or
// see-through" to any pass that wants to know, and because half the world is already built onto it.
//
// The one rule that matters: the camera and the sun's shadow camera enable this layer in game/World, unconditionally
// and for the life of the session. Nothing may make that conditional again — the last time it depended on the post
// chain, turning the post chain off made every leaf in the province vanish.
export const ALPHA = 1

export function noAO(object) {
  object.layers.set(ALPHA)
  return object
}
