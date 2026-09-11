// The loading screen between rounds, GTA style: a photograph of the town, its name, what Wikipedia says about it and
// a bar for the tiles streaming in around the spawn. Shown when a new town is announced, gone once the round runs
// and the tiles are in. Pictures crossfade every few seconds.
const PHOTO_MS = 6000

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
  }

  get open() { return !this.el.hidden }

  show(arena, roundId) {
    const info = arena.info ?? {}
    this.kop.textContent = `Ronde ${roundId} · Vastelaovend in`
    this.titel.textContent = arena.name
    this.info.textContent = info.extract ?? ""
    this.images = info.images ?? []
    this.i = 0
    this.next()
    clearInterval(this.timer)
    if (this.images.length > 1) this.timer = setInterval(() => this.next(), PHOTO_MS)
    this.progress(0, null)
    this.el.hidden = false
  }

  // the next photo fades in on the layer that is off, over the one that is on
  next() {
    const on = this.fotos.findIndex((f) => f.classList.contains("on"))
    const layer = this.fotos[(on + 1) % this.fotos.length]
    layer.style.backgroundImage = this.images.length ? `url("${this.images[this.i++ % this.images.length]}")` : ""
    this.fotos.forEach((f) => f.classList.toggle("on", f === layer))
  }

  // fraction: tiles in around the car; secondsLeft: until the parade starts (null while it already runs)
  progress(fraction, secondsLeft) {
    this.balk.style.width = `${Math.round(fraction * 100)}%`
    this.status.textContent = fraction < 1 ? "Laden…" : secondsLeft === null ? "Daar geit 'r!" : `Optocht start over ${secondsLeft} s`
  }

  hide() {
    this.el.hidden = true
    clearInterval(this.timer)
  }
}
