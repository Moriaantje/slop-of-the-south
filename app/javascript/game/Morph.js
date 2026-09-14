import * as THREE from "three"

// The machinery that turns one set of parts into two machines. A transforming vehicle in this game is not two models
// swapped behind a flash: it is a single mesh whose every moving piece carries two transforms, the driving pose and
// the walking pose, and the transformation is those pieces travelling between them. That is the only construction
// that survives a slow-motion look, because at no point is there anything to substitute — the bonnet you were
// looking at is the chest plate you end up looking at, and you watched it get there.
//
// A part is always a dedicated mount group that nothing else in the game writes to. Everything that is animated for
// other reasons — the suspension writing a wheel's ride height, the walk cycle swinging a thigh, Combat slewing the
// tank's turret — lives on a pivot *inside* the mount, so the morph and the animation never touch the same channel
// and neither has to know the other exists. That one rule is what makes this cost nothing to reason about.
//
// Each part also owns a window of the transformation, which is where the character comes from. Run every part on the
// same clock and the machine inflates like a balloon; give the legs 0 to 0.6, the torso 0.2 to 0.7 and the head 0.7
// to 1 and it deploys, limb by limb, the way a machine with hydraulics in it would. Going the other way the windows
// are mirrored in time, so the head stows first and the legs fold last.
//
// Inside its window a part follows a back-out curve driven through a squared clock. The back-out is what makes a
// panel lock into place rather than slide into it: it arrives a few per cent past its destination and settles back.
// Squaring the clock first is what stops it leaving like a gunshot — the curve's own derivative at zero is c + 3,
// which on a mount whose origin travels four metres works out at forty metres a second in the first frame, and the
// eye reads that as a teleport however smooth the maths says it is. Squared, both ends leave and arrive at rest and
// the peak speed lands in the middle of the window, where it belongs.
const BACK = 1.5                // the back-out curve's tension: ≈ 9 % overshoot three quarters of the way through
const HIDE_EPS = 1e-4           // below this much morph the parts that only exist in the walking pose are switched off

// A transform triple. Kept as three objects rather than a Matrix4 because the blend is a lerp, a slerp and a lerp,
// and decomposing a matrix every frame to do that would be the long way round.
export function transform({ position = null, rotation = null, quaternion = null, scale = 1 } = {}) {
  return {
    position: position ? position.clone() : new THREE.Vector3(),
    quaternion: quaternion ? quaternion.clone() : (rotation ? new THREE.Quaternion().setFromEuler(rotation) : new THREE.Quaternion()),
    scale: typeof scale === "number" ? new THREE.Vector3(scale, scale, scale) : scale.clone(),
  }
}

// The transform a node is sitting at right now, which is how a part's resting pose is captured without writing the
// same numbers twice.
export function currentTransform(node) {
  return { position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() }
}

const _box = new THREE.Box3()
const _axis = new THREE.Vector3()

// Pose a node so that everything hanging under it ends up rotated as asked, sized to `size` and centred on `centre`.
// The vehicles are all different lengths and every one of them has to become the same four-metre machine, so the
// destinations are written as "the chest is this big and sits here" and the scale that gets a particular bonnet
// there is solved from that bonnet's own bounding box. Hand-written scales would have to be retuned for all six
// every time a panel moved. `uniform` keeps wheels round; `max` caps how far a sparsely filled mount may grow.
export function fitTo(node, { rotation = null, quaternion = null, size, centre, uniform = false, max = Infinity }) {
  const q = quaternion ? quaternion.clone() : (rotation ? new THREE.Quaternion().setFromEuler(rotation) : new THREE.Quaternion())
  _box.makeEmpty()
  _box.setFromObject(node)
  if (_box.isEmpty()) return { position: centre.clone(), quaternion: q, scale: new THREE.Vector3(1, 1, 1) }
  const c = _box.getCenter(new THREE.Vector3()), e = _box.getSize(new THREE.Vector3())
  const ext = [e.x, e.y, e.z], want = [size.x, size.y, size.z], sc = [1, 1, 1]
  for (let i = 0; i < 3; i++) {
    _axis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyQuaternion(q)
    const ax = Math.abs(_axis.x), ay = Math.abs(_axis.y), az = Math.abs(_axis.z)
    const j = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2          // which world axis this local axis lands on
    sc[i] = want[j] / Math.max(1e-4, ext[i])
  }
  // `max` is what stops a mount that happens to hold two headlamps being blown up into a chest-sized pair of them
  const scale = uniform ? new THREE.Vector3().setScalar(Math.min(sc[0], sc[1], sc[2], max))
                        : new THREE.Vector3(Math.min(sc[0], max), Math.min(sc[1], max), Math.min(sc[2], max))
  const position = centre.clone().sub(c.multiply(scale).applyQuaternion(q))
  return { position, quaternion: q, scale }
}

// zero at zero, one at one, at rest at both, with one overshoot in between
function ease(s) {
  const x = s * s - 1
  return 1 + (BACK + 1) * x * x * x + BACK * x * x
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }

export class MorphRig {
  constructor() { this.parts = []; this.u = 0; this.dir = 1 }

  // `node` is a mount group the morph owns outright. `drive` and `walk` are its transforms in the two poses; pass
  // null for either to capture whatever the node is sitting at, which is how a part built in one of its two poses
  // declares that pose. `hidden` marks a part that has no business existing while driving: it is scaled down inside
  // the bodywork in the driving pose anyway, and switching it off at rest gives the draw calls back.
  add(node, { drive = null, walk = null, t0 = 0, t1 = 1, hidden = false } = {}) {
    const here = currentTransform(node)
    this.parts.push({ node, drive: drive ?? here, walk: walk ?? here, t0, t1: Math.max(t1, t0 + 1e-3), hidden })
    return node
  }

  // u = 0 is the vehicle, u = 1 is the mech. `dir` is which way the machine is travelling, and it mirrors every
  // part's window in time so the deployment order reverses on the way back rather than replaying forwards.
  pose(u, dir = this.dir) {
    this.u = u = clamp01(u)
    this.dir = dir
    for (const p of this.parts) {
      const span = p.t1 - p.t0
      const s = dir >= 0 ? clamp01((u - p.t0) / span) : clamp01((p.t1 - u) / span)
      const k = dir >= 0 ? ease(s) : 1 - ease(s)
      p.node.position.lerpVectors(p.drive.position, p.walk.position, k)
      p.node.quaternion.slerpQuaternions(p.drive.quaternion, p.walk.quaternion, k)
      p.node.scale.lerpVectors(p.drive.scale, p.walk.scale, k)
      if (p.hidden) p.node.visible = u > HIDE_EPS
    }
  }
}
