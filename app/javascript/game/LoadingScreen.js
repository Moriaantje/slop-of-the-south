// The loading screen, GTA style: a photograph of the place you arrive at, its name, what Wikipedia says about it and
// a bar for the tiles streaming in around the spawn. Shown at the first join (and after a teleport to a hub), gone
// once the tiles are in. Pictures crossfade every few seconds.
const PHOTO_MS = 6000
const KOP = { town: "Welkom in", lair: "Drakennest", shrine: "Bedevaart naar", shop: "Handelspost" }

export class LoadingScreen {
  constructor(el) {
    this.el = el
    this.fotos = [...el.querySelectorAll(".laden-foto")]
    this.kop = el.querySelector(".laden-kop")
    this.titel = el.querySelector(".laden-titel")
    this.info = el.querySelector(".laden-info")
    this.status = el.querySelector(".laden-status")
    this.balk = el.querySelector(".laden-balk i")
    this.images = []
    this.i = 0
    this.timer = null
    this.shown = false
  }

  get open() { return !this.el.hidden }

  // a hub from /api/world; its Wikipedia lore is fetched from /api/hubs/:key while the screen is up
  showHub(hub) {
    this.shown = true
    this.show({ name: hub.name, kop: KOP[hub.role] ?? "Welkom in", info: {} })
    fetch(`/api/hubs/${hub.key}`).then((r) => (r.ok ? r.json() : null)).then((h) => {
      if (h?.lore && this.open && this.titel.textContent === hub.name) this.show({ name: hub.name, kop: KOP[hub.role] ?? "Welkom in", info: h.lore })
    }).catch(() => {})
  }

  show({ name, kop, info = {} }) {
    this.kop.textContent = kop
    this.titel.textContent = name
    this.info.textContent = info.extract ?? ""
    this.images = info.images ?? []
    this.i = 0
    this.next()
    clearInterval(this.timer)
    if (this.images.length > 1) this.timer = setInterval(() => this.next(), PHOTO_MS)
    this.el.hidden = false
  }

  // the next photo fades in on the layer that is off, over the one that is on
  next() {
    const on = this.fotos.findIndex((f) => f.classList.contains("on"))
    const layer = this.fotos[(on + 1) % this.fotos.length]
    layer.style.backgroundImage = this.images.length ? `url("${this.images[this.i++ % this.images.length]}")` : ""
    this.fotos.forEach((f) => f.classList.toggle("on", f === layer))
  }

  // fraction: tiles in around the car
  progress(fraction) {
    this.balk.style.width = `${Math.round(fraction * 100)}%`
    this.status.textContent = fraction < 1 ? "Laden…" : "Daar geit 'r!"
  }

  hide() {
    this.el.hidden = true
    clearInterval(this.timer)
  }
}
