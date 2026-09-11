// The player's standing in the world as the server tells it: the server clock offset, hp/gold/xp/level, the hubs
// discovered, the teleport cooldown, and every Dutch string on the status HUD. Messages handled: sync (on
// subscribe), you (hp/gold/xp), discover, teleport/switch (verdicts), death, burn, heal, object. Hooks: onSync(msg),
// onObjects(list), onTeleport(msg) and onSwitch(msg) for the player's own accepted actions, onDeath(msg) (everyone's),
// onBurn(msg), onDiscover(hub), onHeal(), onActors(list, now) for the dragons, onStrike(msg) for a spell landing on one,
// onDialogue(msg), onQuest(msg) and onQuests(list) for the quests.
const REASONS = {
  cooldown: (s) => `Teleporteren kan weer over ${s.countdown()}`,
  undiscovered: () => "Die plek heb je nog niet ontdekt",
  unknown: () => "Onbekende plek",
  vehicle: () => "Dat voertuig bestaat niet",
  player: () => "Even wachten, je bent nog niet aangemeld",
}

export class Session {
  constructor(playerId, els, hooks) {
    this.playerId = playerId
    this.els = els
    this.hooks = hooks
    this.offset = 0                 // server clock minus Date.now()
    this.you = null                 // { id, name, vehicle, hp, max_hp, gold, xp, level, discovered, spawn }
    this.discovered = new Set()
    this.nextActionAt = null        // server ms; null = the action is ready
    this.flashTimer = null
    this.bannerTimer = null
  }

  now() { return Date.now() + this.offset }
  get hp() { return this.you?.hp ?? 100 }
  get spawn() { return this.you?.spawn }

  receive(msg) {
    if (msg.now) this.offset = msg.now - Date.now()
    switch (msg.type) {
      case "sync":
        this.you = msg.you
        this.discovered = new Set(msg.you.discovered ?? [])
        this.nextActionAt = msg.you.next_action_at
        this.hooks.onSync?.(msg)
        this.hooks.onObjects?.(msg.objects ?? [])
        this.hooks.onActors?.(msg.actors ?? [], msg.now)
        this.hooks.onQuests?.(msg.quests ?? [])
        break
      case "you":
        if (this.you) Object.assign(this.you, { hp: msg.hp, gold: msg.gold, xp: msg.xp, level: msg.level })
        break
      case "discover":
        this.discovered.add(msg.hub.key)
        this.you?.discovered?.push(msg.hub.key)
        this.flash(`${msg.hub.name} ontdekt · +${msg.xp} xp`)
        this.hooks.onDiscover?.(msg.hub)
        break
      case "object": this.hooks.onObjects?.(msg.list); break
      case "teleport":
      case "switch":
        if (msg.ok === false) this.flash((REASONS[msg.reason] ?? (() => "Dat gaat niet"))(this))
        else if (msg.id === this.playerId) {
          this.nextActionAt = msg.next_action_at ?? this.nextActionAt
          if (msg.type === "teleport") { this.hooks.onTeleport?.(msg) } else this.hooks.onSwitch?.(msg)
        }
        break
      case "death":
        if (msg.id === this.playerId) this.showBanner("Verslagen", "Je komt weer bij bij je laatste rustplaats", 3500)
        this.hooks.onDeath?.(msg)
        break
      case "burn": this.hooks.onBurn?.(msg); break
      case "heal": this.hooks.onHeal?.(); break
      case "actors": this.hooks.onActors?.(msg.list, msg.now); break
      case "dialogue": this.hooks.onDialogue?.(msg); break
      case "quest": this.hooks.onQuest?.(msg); break
      case "strike":
        if (msg.ok === false) { if (msg.reason !== "range" && msg.reason !== "dead") this.flash("De spreuk miste") }
        else this.hooks.onStrike?.(msg)
        break
    }
    this.hud()
  }

  canAct() { return !this.nextActionAt || this.nextActionAt <= this.now() }

  countdown(at = this.nextActionAt) {
    const s = Math.max(0, Math.ceil((at - this.now()) / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
  }

  // every 0.25 s from game.js, and after every message
  hud() {
    const { actie, status } = this.els
    if (this.you) {
      const y = this.you
      status.textContent = `♥ ${Math.round(y.hp)} · ${y.gold} goud · niveau ${y.level}`
      status.classList.toggle("laag", y.hp < 30)
      status.hidden = false
    }
    actie.hidden = this.canAct()
    if (!actie.hidden) actie.textContent = `Teleport over ${this.countdown()}`
  }

  showBanner(title, sub, ms = 3000) {
    const { banner, bannerTitel, bannerSub } = this.els
    bannerTitel.textContent = title
    bannerSub.textContent = sub
    banner.hidden = false
    clearTimeout(this.bannerTimer)
    if (ms) this.bannerTimer = setTimeout(() => { banner.hidden = true }, ms)
  }

  // a short toast at the bottom of the screen
  flash(text) {
    const { flits } = this.els
    flits.textContent = text
    flits.hidden = false
    clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => { flits.hidden = true }, 2200)
  }
}

// the nearest hub to (x, z) within r metres, or null
export function nearestHub(x, z, hubs, r = Infinity) {
  let best = null, bestD = r * r
  for (const h of hubs) { const d = (h.x - x) ** 2 + (h.z - z) ** 2; if (d < bestD) { bestD = d; best = h } }
  return best
}
