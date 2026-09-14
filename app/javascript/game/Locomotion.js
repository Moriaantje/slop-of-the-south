import { TUNING as T, expDamp, smoothstep } from "game/Tuning"

// The walking model for a legged body, kept apart from the machine that wears it so it can be reasoned about and
// tested on its own. A mech is not a box on rails: it has mass, it has feet, and both of those are things the player
// reads long before they read the animation. Everything here exists to make that mass visible.
//
// Momentum comes first. The throttle does not become acceleration at once; a drive signal takes it up and lets it go
// over its own rise time, so the speed curve is an S rather than a corner, and lifting off coasts instead of
// stopping. Braking is a separate, stronger authority that only appears when it opposes the motion — that is the
// plant, the moment the machine puts a foot down and leans back against its own speed — and it becomes a reverse
// step only once the body has actually stopped. Heading and velocity are deliberately not the same thing: the body
// carries a sideways component in its own frame which the feet scrub off at a finite rate, so a turn at a walk
// arcs and skids for a fraction of a second instead of teleporting the velocity onto the new nose. Standing still
// the machine pivots crisply, because a body with no momentum has nothing to fight; the faster it is going the
// lazier and wider the turn, which is what makes running feel committed.
//
// The ground is sampled under the feet rather than under the navel. Four probes, fore and aft of a left and a right
// foot, give a height to stand at, a pitch along the stride and a roll across the stance, so the body banks across a
// hillside and pitches up a slope; each foot is published in world space so the rig above can put a foot on what is
// actually under it. A kerb is told apart from a slope by comparing a near probe with a far one — a step has all of
// its rise close in, a hill spreads it out — and crossing one costs a real beat of speed, because clambering is not
// free and a machine that glides up a 150 mm lip weighs nothing.
//
// Air is three beats, not one. A jump winds up first: the legs compress for a tenth of a second before the body
// leaves the ground, which is both what a jump looks like and what gives the eye warning. Gravity is heavier on the
// way down than on the way up, so the apex hangs and the fall commits without changing how high the jump goes.
// Landing drives a compression spring proportional to the impact and takes the legs a real fraction of a second to
// get back under the body, during which the walk is slowed — an instant snap back to full speed is the single
// clearest tell that nothing here has weight. A press is remembered for a moment (so a jump asked for just before
// touchdown still fires) and an edge just left is forgiven for a moment (so a jump asked for just after stepping off
// still fires); together they cost nothing and are most of the difference between responsive and late.
//
// Nothing in here touches a scene graph. The caller owns the body — x, z, y, yaw, speed, vx, vz, vy, airY, landed —
// and this reads and writes those fields, then publishes a pose (lean, bank, compression, plant, stride, feet) that
// the rig is free to use or ignore.
const ONSET = 5.5              // /s: how fast the legs build a push and let it go — the acceleration's own rise time
const RELEASE = 8.8            // /s: and how fast they let it go again, which is quicker than they build it
const APPROACH = 5.0           // /s: the speed closes on what the drive is asking for
const ACCEL_MAX = 11           // m/s²: the most the legs can add or shed under power
const BRAKE_DECEL = 17         // m/s²: the plant, when the brake opposes the motion
const BRAKE_ONSET = 13         // /s: a plant takes hold faster than a push builds
const STOP_SPEED = 0.7         // m/s: below this the brake stops being a plant and becomes a reverse step
const PLANT_RATE = 9           // /s: how fast the planted pose comes in and goes
const IDLE_SPEED = 0.05        // m/s: below this with no input the body is simply standing
const FOOT_GRIP = 9            // /s: sideways speed the feet scrub off (a skid dies in about half a second)
const MAX_SLIDE = 6            // m/s: cap on the sideways component, so a hit can never fling the walk sideways
const YAW_STAND = 200          // /s: a standing pivot is immediate — there is no momentum to fight
const YAW_MOVE = 7             // /s: under way the heading has weight and eases in and out of a turn
const PIVOT_SPEED = 2.5        // m/s over which the turn is fully the moving one rather than the standing pivot
const TURN_RUN = 1.35          // rad/s: turn authority at full walking speed (a run turns in a wider arc)
const AIR_TURN = 0.45          // share of the turn authority that survives leaving the ground
const COYOTE = 0.12            // s an edge just left still counts as ground
const JUMP_BUFFER = 0.16       // s a jump press is remembered for
const CROUCH_TIME = 0.10       // s of windup before the body actually leaves the ground
const CROUCH_SLOW = 0.7        // walking speed during the windup
const LAUNCH_KICK = 9          // /s of compression velocity at the push-off, so the legs snap through and extend
const FALL_GRAVITY = 1.28      // gravity past the apex: the rise is unchanged, the fall commits
const APEX_SPAN = 4.5          // m/s of vertical speed either side of zero that reads as hanging at the apex
const ABSORB_REF = 16          // m/s of impact that fully compresses the legs
const LAND_KICK = 14           // /s of compression velocity per unit of referenced impact
const LEG_HZ = 2.5             // Hz of the leg compression spring
const LEG_ZETA = 0.55          // its damping: under one, so the machine rebounds rather than oozing back
const LAND_RECOVER = 0.45      // s to get back under the body after a full-impact landing
const LAND_SLOW = 0.4          // walking speed at the moment of that landing
const STANCE = 1.05            // m: half the distance between the feet
const FOOT_FWD = 0.85          // m: how far fore and aft of the hips the ground is sampled
const MAX_FOOT_DROP = 1.2      // m: a probe further than this from the centre is an unloaded tile, not a cliff
const LEDGE_DROP = 1.2         // m the surface may fall away under the body before it is a fall rather than a step
const GROUND_PITCH = 0.85      // share of the slope along the stride the body takes
const GROUND_ROLL = 0.95       // share of the slope across the stance the body takes
const LEAN_PER_ACCEL = -0.022  // rad per m/s²: negative, because a body leans *into* its own acceleration
const BANK_PER_ACCEL = -0.013  // rad per m/s²: and *into* the turn, which is the opposite of how a car rolls
const MAX_LEAN = 0.32          // rad
const MAX_BANK = 0.20          // rad
const POSE_HZ = 2.3            // Hz of the lean and bank springs
const POSE_ZETA = 0.75
const ACC_SMOOTH = 10          // /s: the acceleration the lean is read from
const CLIMB_RATE = 11          // m/s the body may follow the ground up (walk speed × the steepest walkable slope)
const FALL_RATE = 16           // m/s it may follow the ground down
const SINK_MAX = 0.4           // m the body may ever be below the ground it stands on
const SNAP_GAP = 2             // m of ground error that means a teleport rather than a step
const STEP_NEAR = 0.30         // m ahead the near kerb probe sits
const STEP_FAR = 1.00          // m ahead the far one sits
const STEP_LIP = 0.10          // m of near rise before it is worth calling a step
const STEP_RATIO = 0.6         // a step has most of its rise close in; a hill spreads it out
const STEP_TIME = 0.22         // s a step costs
const STEP_SLOW = 0.45         // walking speed while paying for it
const CADENCE = 0.13           // strides per second per m/s walked (the same rate MechRig's own gait uses)
const PIVOT_STRIDE = 0.11      // strides per radian of standing pivot, so the feet shuffle round instead of sliding
const SUBSTEP = 1 / 120        // s: the slide model behaves the same at 30 and 144 fps

export class Locomotion {
  // heightAt is the terrain probe used for the slope gate and the kerb test; it may be left out (the ground pass
  // takes its own surface function, which is the one that knows about rooftops).
  constructor({ heightAt = null, walk = null, reverse = null } = {}) {
    this.heightAt = heightAt
    this.walkSpeed = walk
    this.reverseSpeed = reverse
    this.feet = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]
    this.probes = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 }))
    this.reset()
  }

  reset() {
    this.force = 0; this.lateral = 0; this.yawRate = 0
    this.accLong = 0; this.accLat = 0
    this.compress = 0; this.compressV = 0
    this.lean = 0; this.leanV = 0; this.bank = 0; this.bankV = 0
    this.planted = 0; this.stride = 0
    this.crouchT = 0; this.jumpV = 0; this.recover = 0; this.stepT = 0
    this.jumpBuf = 0; this.coyote = COYOTE
    this.blocked = false; this.hovering = false
    this.landImpact = 0; this.landT = 0
    this.groundY = null; this.groundPitch = 0; this.groundRoll = 0; this.seeded = false
    this.t = 0; this._speedOut = 0
  }

  get walk() { return this.walkSpeed ?? T.mech.walk }
  get reverse() { return this.reverseSpeed ?? T.mech.reverse }
  get stepping() { return this.stepT > 0 }
  get crouching() { return this.crouchT > 0 }
  // 1 at the top of the arc, 0 on the way up or well into the fall: what a rig hangs its apex pose on
  get apex() { return this.airborne ? Math.max(0, 1 - Math.abs(this._vy) / APEX_SPAN) : 0 }

  // every penalty the walk is currently paying, as one multiplier
  penalty() {
    let k = 1
    if (this.stepT > 0) k *= STEP_SLOW
    if (this.crouchT > 0) k *= CROUCH_SLOW
    if (this.recover > 0) k *= 1 - (1 - LAND_SLOW) * (this.recover / LAND_RECOVER)
    return k
  }

  // cmd: { throttle, brake, steer, jump, hover, speedScale, canJump, canHover, jumpV, hoverSink, kickX, kickZ }
  integrate(dt, body, cmd) {
    const M = T.mech
    this.t += dt
    this.airborne = body.vy !== null
    this._vy = body.vy ?? 0
    this.hovering = false
    const throttle = cmd.throttle ?? 0, brake = cmd.brake ?? 0, steer = cmd.steer ?? 0

    // a press is remembered for a moment; an edge just left is forgiven for a moment
    if (cmd.jump) this.jumpBuf = JUMP_BUFFER
    else this.jumpBuf = Math.max(0, this.jumpBuf - dt)
    this.coyote = this.airborne ? Math.max(0, this.coyote - dt) : COYOTE
    if (this.jumpBuf > 0 && this.crouchT === 0 && (cmd.canJump ?? true)) {
      if (!this.airborne) { this.jumpBuf = 0; this.crouchT = CROUCH_TIME; this.jumpV = cmd.jumpV ?? M.jumpV }
      else if (this.coyote > 0) { this.jumpBuf = 0; this.coyote = 0; this.launch(body, cmd.jumpV ?? M.jumpV) }
    }
    if (!this.airborne && this.crouchT > 0) {
      this.crouchT = Math.max(0, this.crouchT - dt)
      if (this.crouchT === 0) this.launch(body, this.jumpV)
    }
    this.stepT = Math.max(0, this.stepT - dt)
    this.recover = Math.max(0, this.recover - dt)

    // the slope gate, measured in the direction the machine is trying to go rather than the one it happens to be
    // drifting in, so a blocked mech stays blocked instead of chattering against the hill
    this.blocked = false
    const intent = Math.sign(body.speed) || Math.sign(throttle - brake)
    if (this.heightAt && body.vy === null && intent !== 0) {
      const f = forward(body.yaw)
      const h0 = this.heightAt(body.x, body.z)
      const h1 = this.heightAt(body.x + f.x * intent * M.probe, body.z + f.z * intent * M.probe)
      if ((h1 - h0) / M.probe > M.slopeMax) this.blocked = true
    }
    this.kerbProbe(body, intent)

    // Combat or the avatar reached in and changed the speed: most of the sideways carry goes with it
    if (body.speed !== this._speedOut) this.lateral *= 0.3

    const v0 = body.speed
    const scale = (cmd.speedScale ?? 1) * this.penalty()
    const n = Math.max(1, Math.ceil(dt / SUBSTEP)), h = dt / n
    for (let i = 0; i < n; i++) this.step(h, body, throttle, brake, steer, scale, cmd)

    body.x += (cmd.kickX ?? 0) * dt
    body.z += (cmd.kickZ ?? 0) * dt
    body.vx += cmd.kickX ?? 0
    body.vz += cmd.kickZ ?? 0
    this._speedOut = body.speed
    this._vy = body.vy ?? 0
    this.airborne = body.vy !== null
    this.accLong = expDamp(this.accLong, (body.speed - v0) / dt, ACC_SMOOTH, dt)
    this.accLat = expDamp(this.accLat, -body.speed * this.yawRate, ACC_SMOOTH, dt)
    const stopping = brake > 0 && body.speed > STOP_SPEED
    this.planted = expDamp(this.planted, stopping ? 1 : 0, PLANT_RATE, dt)
  }

  step(h, body, throttle, brake, steer, scale, cmd) {
    const M = T.mech
    const air = body.vy !== null
    let f = forward(body.yaw), rx = -f.z, rz = f.x
    const wx = f.x * body.speed + rx * this.lateral, wz = f.z * body.speed + rz * this.lateral

    // ---- heading: a standing pivot is immediate, a running turn has weight and a wider arc
    const v = Math.abs(body.speed)
    const moving = smoothstep(0, PIVOT_SPEED, v)
    const lock = M.turnRate + (TURN_RUN - M.turnRate) * Math.min(1, v / this.walk)
    const want = steer * lock * (air ? AIR_TURN : 1)
    const rate = YAW_STAND + (YAW_MOVE - YAW_STAND) * moving
    this.yawRate = expDamp(this.yawRate, want, rate, h)
    body.yaw += this.yawRate * h

    // ---- longitudinal: the force the legs put down is what has the rise time, not the speed, so the first frame
    // of a press is a shove building rather than a shove arriving; the brake is a separate, stronger authority that
    // only exists while it opposes the motion, and becomes a reverse step once the body has actually stopped
    let speed = body.speed
    const target = (throttle * this.walk - brake * this.reverse) * scale
    let demand = clamp((target - speed) * APPROACH, -ACCEL_MAX, ACCEL_MAX)
    const planting = brake > 0 && speed > STOP_SPEED
    if (planting) demand = -BRAKE_DECEL
    if (air) demand *= 0.35                                                     // no feet on the ground to push with
    const onset = planting ? BRAKE_ONSET : Math.abs(demand) > Math.abs(this.force) ? ONSET : RELEASE
    this.force = expDamp(this.force, demand, onset, h)
    speed += this.force * h
    if (Math.abs(speed) < IDLE_SPEED && throttle === 0 && brake === 0) speed = 0

    // ---- the feet scrub the sideways carry off: turning under way arcs before the velocity catches the nose up
    f = forward(body.yaw); rx = -f.z; rz = f.x
    let vLong = wx * f.x + wz * f.z, vLat = wx * rx + wz * rz
    vLat *= Math.max(0, 1 - FOOT_GRIP * (air ? 0.25 : 1) * h)
    if (Math.abs(vLat) < 0.02) vLat = 0
    vLat = clamp(vLat, -MAX_SLIDE, MAX_SLIDE)
    vLong += speed - body.speed
    if (this.blocked) { vLong = 0; vLat = 0; this.force = 0 }                    // a wall of hill: nothing moves
    body.speed = vLong
    this.lateral = vLat
    body.vx = f.x * vLong + rx * vLat
    body.vz = f.z * vLong + rz * vLat
    body.x += body.vx * h
    body.z += body.vz * h

    // ---- the stride: distance walked drives it, a standing pivot shuffles it round
    this.stride += (Math.abs(vLong) * CADENCE + Math.abs(this.yawRate) * PIVOT_STRIDE * (1 - moving)) * h

    // ---- air: heavier coming down than going up, so the apex hangs without the jump getting higher
    if (body.vy !== null) {
      const g = M.gravity * (body.vy < 0 ? FALL_GRAVITY : 1)
      body.vy -= g * h
      if (cmd.hover && body.vy < 0 && (cmd.canHover ?? true)) {
        body.vy = Math.max(body.vy, -(cmd.hoverSink ?? M.hoverSink))
        this.hovering = true
      }
      body.airY += body.vy * h
    }
  }

  // a step is a rise that is all close in; a hill spreads the same rise out over the far probe as well
  kerbProbe(body, intent) {
    if (!this.heightAt || body.vy !== null || intent === 0) return
    const f = forward(body.yaw)
    const h0 = this.heightAt(body.x, body.z)
    const near = this.heightAt(body.x + f.x * intent * STEP_NEAR, body.z + f.z * intent * STEP_NEAR) - h0
    if (near <= STEP_LIP) return
    const far = this.heightAt(body.x + f.x * intent * STEP_FAR, body.z + f.z * intent * STEP_FAR) - h0
    if (near > STEP_RATIO * far) this.stepT = STEP_TIME
  }

  launch(body, v) {
    if (body.vy === null) body.airY = body.y            // a coyote jump keeps the arc it already had
    body.vy = v
    this.crouchT = 0
    this.compressV -= LAUNCH_KICK          // the legs snap through the crouch and extend: that is the push-off
  }

  land(body, gY) {
    const impact = Math.max(0, -(body.vy ?? 0))
    body.vy = null
    body.y = gY
    body.landed = true
    this.landImpact = impact
    this.landT++
    const k = Math.min(1, impact / ABSORB_REF)
    this.compressV += LAND_KICK * k
    this.recover = Math.max(this.recover, LAND_RECOVER * k)
  }

  // Ground contact and attitude. Returns the height the mesh should be drawn at: the settled surface on the ground,
  // the arc height in the air. body.y stays the surface the body stands on, which is what Combat and the shadow read.
  settle(dt, body, heightAt) {
    const f = forward(body.yaw), rx = -f.z, rz = f.x
    const gC = heightAt(body.x, body.z)
    let sum = 0, front = 0, back = 0, left = 0, right = 0
    for (let i = 0; i < 4; i++) {
      const sx = (i & 1) ? 1 : -1, sz = (i & 2) ? 1 : -1                         // sz = +1 is ahead
      const px = body.x + rx * sx * STANCE + f.x * sz * FOOT_FWD
      const pz = body.z + rz * sx * STANCE + f.z * sz * FOOT_FWD
      let hi = heightAt(px, pz)
      if (Math.abs(hi - gC) > MAX_FOOT_DROP) hi = gC                             // unloaded tile or a seam spike
      const p = this.probes[i]; p.x = px; p.y = hi; p.z = pz
      sum += hi
      if (sz > 0) front += hi; else back += hi
      if (sx > 0) right += hi; else left += hi
    }
    const gY = sum / 4
    this.groundY = gY
    this.groundPitch = Math.atan2((front - back) / 2, 2 * FOOT_FWD)
    this.groundRoll = Math.atan2((right - left) / 2, 2 * STANCE)
    // a foot stands on the higher of its own two probes: it rests on the kerb, not half inside it
    for (const s of [0, 1]) {
      const a = this.probes[s], b = this.probes[s + 2]                            // 0/2 left, 1/3 right
      const foot = this.feet[s]
      foot.x = (a.x + b.x) / 2; foot.z = (a.z + b.z) / 2; foot.y = Math.max(a.y, b.y)
    }

    // walked off a roof or a ledge: the surface drops away and the body falls rather than snapping down. The very
    // first contact after a reset or a teleport never counts as a ledge — the body has not been put down yet.
    if (body.vy === null && this.seeded && gY < body.y - LEDGE_DROP) { body.vy = 0; body.airY = body.y }
    this.seeded = true
    let drawY = body.y
    if (body.vy !== null) {
      if (body.airY <= gY && body.vy < 0) { this.land(body, gY); drawY = body.y }
      else { body.y = gY; drawY = body.airY }
    } else {
      body.y = this.follow(body.y, gY, dt)
      drawY = body.y
    }
    this.pose(dt, body.vy === null)
    return drawY
  }

  // the body follows the ground it stands on, rate-limited so a seam cannot throw it, and never sinks into it
  follow(y, gY, dt) {
    if (Math.abs(y - gY) > SNAP_GAP) return gY                                   // a teleport, not a step
    const next = expDamp(y, gY, T.mech.ySmooth, dt)
    const capped = clamp(next, y - FALL_RATE * dt, y + CLIMB_RATE * dt)
    return Math.max(gY - SINK_MAX, capped)
  }

  // lean, bank and leg compression, all springs so nothing arrives at its pose and stops dead
  pose(dt, grounded) {
    const steps = dt > 1 / 60 ? 2 : 1, h = dt / steps
    const leanT = grounded
      ? clamp(this.groundPitch * GROUND_PITCH + LEAN_PER_ACCEL * this.accLong, -MAX_LEAN, MAX_LEAN)
      : clamp(LEAN_PER_ACCEL * this.accLong * 0.5, -MAX_LEAN, MAX_LEAN)
    const bankT = clamp((grounded ? this.groundRoll * GROUND_ROLL : 0) + BANK_PER_ACCEL * this.accLat, -MAX_BANK, MAX_BANK)
    const compT = this.crouchT > 0 ? 1 : 0
    const wP = 2 * Math.PI * POSE_HZ, kP = wP * wP, cP = 2 * POSE_ZETA * wP
    const wL = 2 * Math.PI * LEG_HZ, kL = wL * wL, cL = 2 * LEG_ZETA * wL
    for (let s = 0; s < steps; s++) {
      this.leanV += (kP * (leanT - this.lean) - cP * this.leanV) * h; this.lean += this.leanV * h
      this.bankV += (kP * (bankT - this.bank) - cP * this.bankV) * h; this.bank += this.bankV * h
      this.compressV += (kL * (compT - this.compress) - cL * this.compressV) * h; this.compress += this.compressV * h
    }
    this.compress = clamp(this.compress, -1, 1.4)
  }
}

export function forward(yaw) { return { x: -Math.sin(yaw), z: -Math.cos(yaw) } }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
