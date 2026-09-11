// Keyboard state. Held keys are read every frame by Vehicle; one-shot presses (R, M) are recorded on keydown and
// consumed by the first frame that asks, so a quick tap is never missed.
export class Input {
  constructor() {
    this.keys = new Set()
    this.pressed = new Set()
    addEventListener("keydown", (e) => {
      this.keys.add(e.code)
      if (!e.repeat) this.pressed.add(e.code)
      if (e.code === "Space") e.preventDefault()
    })
    addEventListener("keyup", (e) => this.keys.delete(e.code))
  }
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
  consume(code)   { const had = this.pressed.has(code); this.pressed.delete(code); return had }
  clearPressed()  { this.pressed.clear() }
}
