// Keyboard state. Held keys are read every frame by whichever body is driving; one-shot presses (R, M, T, Space) are
// recorded on keydown and consumed by the first frame that asks, so a quick tap between two frames is never missed.
//
// Two things beyond that, both about not being late. A press is stamped with the time it arrived and goes stale after
// a fraction of a second, which matters because the queue survives across frames: without it, a tab switch or a long
// stall would hand the game a jump that was asked for seconds ago and fire it at whatever the machine happened to be
// doing on the way back. The longer buffering — remembering a jump asked for just before landing, and forgiving one
// asked for just after stepping off an edge — belongs where the ground state is known, which is Locomotion, not here.
//
// And the window losing focus clears every held key. Alt-tabbing with the throttle down used to leave the car
// flooring it into the countryside, because a keyup that happens over another window never arrives.
const STALE = 0.35             // seconds after which an unconsumed press is no longer what the player meant
const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"])   // keys the page would otherwise scroll on

export class Input {
  constructor() {
    this.keys = new Set()
    this.pressed = new Set()
    this.times = new Map()
    addEventListener("keydown", (e) => {
      this.keys.add(e.code)
      if (!e.repeat) { this.pressed.add(e.code); this.times.set(e.code, this.now()) }
      if (ARROWS.has(e.code)) e.preventDefault()
    })
    addEventListener("keyup", (e) => this.keys.delete(e.code))
    addEventListener("blur", () => this.keys.clear())      // a keyup over another window never arrives
  }
  now() { return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000 }
  get throttle()  { return (this.keys.has("KeyW") || this.keys.has("ArrowUp")) ? 1 : 0 }
  get brake()     { return (this.keys.has("KeyS") || this.keys.has("ArrowDown")) ? 1 : 0 }
  get steer()     { return ((this.keys.has("KeyA") || this.keys.has("ArrowLeft")) ? 1 : 0) - ((this.keys.has("KeyD") || this.keys.has("ArrowRight")) ? 1 : 0) }
  get handbrake() { return this.keys.has("Space") }
  get boost()     { return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") }
  get reset()     { return this.consume("KeyR") }
  get toggleMap() { return this.consume("KeyM") }
  get mute()      { return this.consume("KeyN") }
  get ability()   { return this.consume("KeyE") }
  get pick()      { return this.consume("KeyV") }
  get digit()     { for (let i = 1; i <= 6; i++) if (this.consume(`Digit${i}`)) return i; return 0 }
  // the wizard mech: T transforms, Space jumps (tap) and hovers (hold), Shift raises the shield, Q and F cast
  get transform() { return this.consume("KeyT") }
  get jump()      { return this.consume("Space") }
  get hover()     { return this.keys.has("Space") }
  get shield()    { return this.boost }
  get fireball()  { return this.consume("KeyQ") }
  get lightning() { return this.consume("KeyF") }
  get talk()      { return this.consume("KeyE") }
  // quests: J the log, K the next objective, H heal in a dialogue, Esc closes it
  get log()       { return this.consume("KeyJ") }
  get cycle()     { return this.consume("KeyK") }
  get heal()      { return this.consume("KeyH") }
  get escape()    { return this.consume("Escape") }
  // a press waiting to be read, unless it has been waiting so long that it is no longer what the player meant
  consume(code)   {
    if (!this.pressed.has(code)) return false
    this.pressed.delete(code)
    const at = this.times.get(code)
    this.times.delete(code)
    return at === undefined || this.now() - at < STALE
  }
  clearPressed()  { this.pressed.clear(); this.times.clear() }
}
