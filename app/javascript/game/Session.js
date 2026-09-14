import { setStats, stat, BASE_STATS } from "game/Skills"

// The player's standing in the world as the server tells it: the server clock offset, hp/gold/xp/level, the stat
// block and the skills unlocked, the hubs discovered, the teleport cooldown, and every Dutch string on the status
// HUD. Messages handled: sync (on subscribe), you (hp/gold/xp/progress), discover, teleport/switch (verdicts),
// death, burn, heal, object, level, skill. Hooks: onSync(msg), onObjects(list), onTeleport(msg) and onSwitch(msg)
// for the player's own accepted actions, onDeath(msg) (everyone's), onBurn(msg), onDiscover(hub), onHeal(),
// onActors(list, now) for the dragons, onStrike(msg) for a spell landing on one, onDialogue(msg), onQuest(msg) and
// onQuests(list) for the quests, onLevelUp({ level, points }) for the sound cue, onSkill(msg) when a point lands.
//
// Every message that carries progression carries the whole block — level, max hp, points left, unlocked keys, the
// derived stats — rather than a delta, because the server is the only thing allowed to do the arithmetic and a
// resend must not be able to apply twice. The level-up moment is noticed here rather than announced by the server,
// so it fires on whichever message arrives first and exactly once per level; `level` messages are welcome and go
// through the same gate. The stat block is pushed straight into game/Skills, where Mech, Spells, Vehicle and Avatar
// read it without anyone having to hand it to them.
const REASONS = {
  cooldown: (s) => `Teleporteren kan weer over ${s.countdown()}`,
  undiscovered: () => "Die plek heb je nog niet ontdekt",
  unknown: () => "Onbekende plek",
  vehicle: () => "Dat voertuig bestaat niet",
  player: () => "Even wachten, je bent nog niet aangemeld",
}

const SKILL_REASONS = {
  level: () => "Daar ben je nog niet hoog genoeg voor",
  needs: () => "Je mist een eerdere vaardigheid",
  points: () => "Te weinig vaardigheidspunten",
  known: () => "Die ken je al",
  unknown: () => "Die vaardigheid bestaat niet",
  player: () => "Even wachten, je bent nog niet aangemeld",
}

export class Session {
  constructor(playerId, els, hooks) {
    this.playerId = playerId
    this.els = els
    this.hooks = hooks
    this.offset = 0                 // server clock minus Date.now()
    this.you = null                 // { id, name, vehicle, hp, max_hp, gold, xp, level, skill_points, unlocked, stats, discovered, spawn }
    this.discovered = new Set()
    this.nextActionAt = null        // server ms; null = the action is ready
    this.level = 0                  // the level already announced: 0 until the first sync, so the join is never a level-up
    this.onProgress = null          // the skills panel hangs itself here
    this.flashTimer = null
    this.bannerTimer = null
  }

  now() { return Date.now() + this.offset }
  get hp() { return this.you?.hp ?? 100 }
  get maxHp() { return this.you?.max_hp ?? BASE_STATS.max_hp }
  get spawn() { return this.you?.spawn }
  get points() { return this.you?.skill_points ?? 0 }
  stat(name) { return stat(name) }
  has(key) { return (this.you?.unlocked ?? []).includes(key) }

  receive(msg) {
    if (msg.now) this.offset = msg.now - Date.now()
    switch (msg.type) {
      case "sync":
        this.you = msg.you
        this.discovered = new Set(msg.you.discovered ?? [])
        this.nextActionAt = msg.you.next_action_at
        this.level = msg.you.level ?? 1               // the level you arrive with is not a level-up
        this.progress(msg.you, false)
        this.hooks.onSync?.(msg)
        this.hooks.onObjects?.(msg.objects ?? [])
        this.hooks.onActors?.(msg.actors ?? [], msg.now)
        this.hooks.onQuests?.(msg.quests ?? [])
        break
      case "you":
        if (this.you) {
          Object.assign(this.you, { hp: msg.hp, gold: msg.gold, xp: msg.xp, level: msg.level })
          this.progress(msg)
        }
        break
      case "level":
        this.progress(msg)
        break
      case "skill":
        if (msg.ok === false) { this.flash((SKILL_REASONS[msg.reason] ?? (() => "Dat kan niet"))()); break }
        this.progress(msg)
        this.flash(`${msg.name} geleerd`)
        this.hooks.onSkill?.(msg)
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

  // Takes whatever progression fields a message carries and, when the level has moved, announces it once. Fields
  // that are absent are left alone, so a server that has not been taught to send stats yet simply never changes
  // them and the client keeps the base block.
  progress(msg, announce = true) {
    if (!msg) return
    if (!this.you) this.you = {}
    for (const k of ["level", "max_hp", "skill_points", "unlocked", "xp_level", "xp_next", "skills"]) {
      if (msg[k] !== undefined) this.you[k] = msg[k]
    }
    if (msg.stats) { this.you.stats = msg.stats; setStats(msg.stats) }
    const level = this.you.level ?? this.level
    if (announce && level > this.level) {
      const gained = level - this.level
      this.level = level
      const points = this.points
      this.showBanner(`Niveau ${level}`, points
        ? `${points} vaardigheidspunt${points === 1 ? "" : "en"} te besteden · druk op B`
        : "Je bent sterker geworden", 4200)
      this.hooks.onLevelUp?.({ level, gained, points })
    } else if (level > this.level) {
      this.level = level
    }
    this.onProgress?.()
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
      const punten = this.points ? ` · ✦${this.points}` : ""
      status.textContent = `♥ ${Math.round(y.hp)}/${Math.round(this.maxHp)} · ${y.gold} goud · niveau ${y.level}${punten}`
      status.classList.toggle("laag", y.hp < this.maxHp * 0.3)
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
