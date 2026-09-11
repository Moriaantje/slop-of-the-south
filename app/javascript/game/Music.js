// The parade's music: a YouTube playlist of vastelaovend songs in a hidden player, louder the closer the float is.
// Browsers only allow sound after a click or a key press, so the player waits for the first gesture. N mutes.
const PLAYLIST = "PLsZ8foBBsNxCAUIgof60CC_2bKBhqXOcf"          // "VASTELAOVEND 2023 - Beste Vastelaovesmeziek van Limburg!"
const NEAR = 60, FAR = 700                                      // metres: full volume within NEAR, the floor from FAR on
const FLOOR = 6

export class Music {
  constructor(host) {
    this.player = null
    this.ready = false
    this.gestured = false
    this.wanted = false
    this.volume = FLOOR
    this.muted = localStorage.getItem("muziek") === "uit"
    window.onYouTubeIframeAPIReady = () => {
      this.player = new YT.Player(host, {
        width: 1, height: 1,
        playerVars: { listType: "playlist", list: PLAYLIST, controls: 0, disablekb: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => { this.ready = true; this.player.setLoop(true); this.player.setShuffle(true); this.apply() },
          onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) this.player.nextVideo() },
        },
      })
    }
    const script = document.createElement("script")
    script.src = "https://www.youtube.com/iframe_api"
    document.head.appendChild(script)
    const gesture = () => { this.gestured = true; this.apply() }
    addEventListener("keydown", gesture, { once: true })
    addEventListener("pointerdown", gesture, { once: true })
  }

  // wanted: there is a parade to hear; distance: from the car to the float
  update(wanted, distance) {
    this.wanted = wanted
    this.volume = Math.round(Math.min(100, Math.max(FLOOR, 100 - (distance - NEAR) / (FAR - NEAR) * (100 - FLOOR))))
    this.apply()
  }

  toggle() {
    this.muted = !this.muted
    localStorage.setItem("muziek", this.muted ? "uit" : "aan")
    this.apply()
    return this.muted
  }

  apply() {
    if (!this.ready || !this.gestured) return
    const play = this.wanted && !this.muted
    const state = this.player.getPlayerState()
    if (play && state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) this.player.playVideo()
    if (!play && state === YT.PlayerState.PLAYING) this.player.pauseVideo()
    if (play) this.player.setVolume(this.volume)
  }
}
