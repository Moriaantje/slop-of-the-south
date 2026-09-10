// Minimap on PDOK's BRT Achtergrondkaart (Kadaster, CC BY 4.0), served in the RD tile matrix, so map pixels
// convert to RD metres exactly. Small: follows the car, north-up. Expanded (M): the whole play area; a click
// teleports the car there.
const ORIGIN_X = -285401.92, ORIGIN_Y = 903401.92, RES0 = 3440.64, TILE = 256, MAX_ZOOM = 14
const SMALL_SCALE = 3.5          // m/px in the corner map

export class Minimap {
  constructor(canvas, config, { onTeleport }) {
    this.canvas = canvas
    this.ctx = canvas.getContext("2d")
    this.cfg = config
    this.onTeleport = onTeleport
    this.expanded = false
    this.images = new Map()        // "z/x/y" → HTMLImageElement
    this.dirty = true
    this.hover = null
    canvas.addEventListener("click", (e) => this.click(e))
    canvas.addEventListener("mousemove", (e) => { this.hover = this.expanded ? [e.offsetX, e.offsetY] : null; this.dirty = true })
    canvas.addEventListener("mouseleave", () => { this.hover = null; this.dirty = true })
    addEventListener("resize", () => this.resize())
    this.resize()
  }

  toggle() {
    this.expanded = !this.expanded
    this.canvas.classList.toggle("expanded", this.expanded)
    this.resize()
  }

  resize() {
    const r = this.canvas.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    this.w = Math.max(1, Math.round(r.width)); this.h = Math.max(1, Math.round(r.height))
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.dirty = true
  }

  // view: RD centre and metres per CSS pixel
  view(car) {
    if (this.expanded) {
      const [x0, y0, x1, y1] = this.cfg.bounds
      const scale = Math.max((x1 - x0) / this.w, (y1 - y0) / this.h) * 1.04
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale }
    }
    return { cx: car.x + this.cfg.origin.x, cy: this.cfg.origin.y - car.z, scale: SMALL_SCALE }
  }

  toPixel(v, rx, ry) { return [this.w / 2 + (rx - v.cx) / v.scale, this.h / 2 - (ry - v.cy) / v.scale] }
  toRD(v, px, py) { return [v.cx + (px - this.w / 2) * v.scale, v.cy - (py - this.h / 2) * v.scale] }

  update(car, remotes) {
    this.car = car; this.remotes = remotes
    if (!this.dirty && !this.expanded && this.lastX === car.x && this.lastZ === car.z && this.lastYaw === car.yaw) return
    this.lastX = car.x; this.lastZ = car.z; this.lastYaw = car.yaw
    this.dirty = false
    this.draw()
  }

  draw() {
    const { ctx, w, h } = this
    const v = this.view(this.car)
    ctx.fillStyle = "#e8e4d8"
    ctx.fillRect(0, 0, w, h)
    // pick the zoom whose resolution is just finer than the view scale
    const z = Math.min(MAX_ZOOM, Math.max(0, Math.ceil(Math.log2(RES0 / v.scale))))
    const res = RES0 / 2 ** z, span = TILE * res
    const [rx0, ry1] = this.toRD(v, 0, 0), [rx1, ry0] = this.toRD(v, w, h)
    const tx0 = Math.floor((rx0 - ORIGIN_X) / span), tx1 = Math.floor((rx1 - ORIGIN_X) / span)
    const ty0 = Math.floor((ORIGIN_Y - ry1) / span), ty1 = Math.floor((ORIGIN_Y - ry0) / span)
    const size = span / v.scale
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const img = this.tile(z, tx, ty)
        if (!img?.complete || !img.naturalWidth) continue
        const [px, py] = this.toPixel(v, ORIGIN_X + tx * span, ORIGIN_Y - ty * span)
        ctx.drawImage(img, px, py, size + 0.5, size + 0.5)
      }
    // other drivers
    if (this.remotes) for (const [, rc] of this.remotes.cars) {
      const p = rc.mesh.position
      const [px, py] = this.toPixel(v, p.x + this.cfg.origin.x, this.cfg.origin.y - p.z)
      ctx.fillStyle = "#" + rc.color.toString(16).padStart(6, "0")
      ctx.beginPath(); ctx.arc(px, py, this.expanded ? 5 : 4, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke()
    }
    // own car: arrow pointing along the heading (yaw 0 = north = up)
    const [cx, cy] = this.toPixel(v, this.car.x + this.cfg.origin.x, this.cfg.origin.y - this.car.z)
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(-this.car.yaw)
    const s = this.expanded ? 9 : 7
    ctx.beginPath(); ctx.moveTo(0, -s * 1.3); ctx.lineTo(s * 0.8, s); ctx.lineTo(0, s * 0.5); ctx.lineTo(-s * 0.8, s); ctx.closePath()
    ctx.fillStyle = "#d7412b"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke()
    ctx.restore()
    if (this.expanded) {
      if (this.hover) {                                       // crosshair under the mouse
        ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(this.hover[0] - 12, this.hover[1]); ctx.lineTo(this.hover[0] + 12, this.hover[1])
        ctx.moveTo(this.hover[0], this.hover[1] - 12); ctx.lineTo(this.hover[0], this.hover[1] + 12); ctx.stroke()
      }
      ctx.font = "12px system-ui, sans-serif"; ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.textAlign = "right"
      ctx.fillText("klik om te teleporteren · M sluit · © Kadaster / PDOK", w - 10, h - 8)
    }
  }

  tile(z, x, y) {
    const key = `${z}/${x}/${y}`
    let img = this.images.get(key)
    if (!img) {
      img = new Image()
      img.onload = () => { this.dirty = true }
      img.src = `/map/${key}.png`
      this.images.set(key, img)
    }
    return img
  }

  click(e) {
    if (!this.expanded) { this.toggle(); return }               // clicking the small map opens it
    const [rx, ry] = this.toRD(this.view(this.car), e.offsetX, e.offsetY)
    this.onTeleport(rx - this.cfg.origin.x, -(ry - this.cfg.origin.y))
    this.toggle()
  }
}
