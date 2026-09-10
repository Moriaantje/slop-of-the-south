// Keyboard state. Values are read every frame by Vehicle.
export class Input {
  constructor() {
    this.keys = new Set()
    addEventListener("keydown", (e) => { this.keys.add(e.code); if (e.code === "Space") e.preventDefault() })
    addEventListener("keyup",   (e) => this.keys.delete(e.code))
  }
  get throttle()  { return (this.keys.has("KeyW") || this.keys.has("ArrowUp")) ? 1 : 0 }
  get brake()     { return (this.keys.has("KeyS") || this.keys.has("ArrowDown")) ? 1 : 0 }
  get steer()     { return ((this.keys.has("KeyA") || this.keys.has("ArrowLeft")) ? 1 : 0) - ((this.keys.has("KeyD") || this.keys.has("ArrowRight")) ? 1 : 0) }
  get handbrake() { return this.keys.has("Space") }
  get reset()     { const r = this.keys.has("KeyR"); if (r) this.keys.delete("KeyR"); return r }
}
