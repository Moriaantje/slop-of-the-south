// The progression tree on the client: the stat block the server derived for you, and the panel (B) that spends a
// point on it. Nothing here decides anything — the server owns the level, the points and the unlocks, and the only
// thing this module ever sends is "I would like to buy this key"; what comes back is the whole progress block,
// which it redraws from. The local catalogue is a presentation copy of Game::Progression::SKILLS so the panel can
// draw a tree before the first sync has landed, and a Ruby test keeps the two tables honest about each other; the
// moment the server does send its own catalogue, that one wins.
//
// The stat block lives in one module-level object rather than being threaded through half a dozen constructors,
// because there is exactly one player in a browser tab and the modules that read it — Mech, Spells, Vehicle, Avatar
// — read it inside frame loops where an extra object hop is noise in the profile and an extra constructor argument
// is a merge conflict. Every entry starts at the value that reproduces today's game (multipliers 1.0, ability
// counts 0), so a module can adopt `stat(...)` before any of the server wiring lands and behave exactly as before.
export const BASE_STATS = {
  max_hp: 100,          // hit points
  mana_max: 1,          // × the mech's mana meter: divide every mana cost by this
  mana_regen: 1,        // × T.mech.manaRegen, seconds from empty to full (lower is faster)
  spell_damage: 1,      // × the fireball's and the bolt's damage
  walk_speed: 1,        // × T.mech.walk
  drive_speed: 1,       // × the vehicle's top speed
  boost_capacity: 1,    // × T.boost.drainTime, the seconds of nitro in a full meter
  shield_drain: 1,      // × T.mech.shieldDrain
  shield_block: 1,      // share of incoming damage the shield stops
  shield_reflect: 0,    // share of the blocked damage thrown back
  hub_regen: 10,        // hit points per second inside a hub
  field_regen: 1,       // hit points per second out in the field
  hover_drain: 1,       // × T.mech.hoverDrain
  hover_sink: 1,        // × T.mech.hoverSink (lower hangs longer)
  transform_time: 1,    // × T.transform.time
  action_cooldown: 1,   // × the teleport cooldown
  jumps: 1,             // jumps before the feet must touch down again
  fireball_split: 0,    // extra shards a fireball breaks into
  lightning_chain: 0,   // extra dragons a bolt jumps to
}

export const STATS = { ...BASE_STATS }

// the one call the rest of the game makes: stat("walk_speed") is 1 until the server says otherwise
export function stat(name) {
  const v = STATS[name]
  return typeof v === "number" && Number.isFinite(v) ? v : (BASE_STATS[name] ?? 0)
}

// the server's block, taken whole; unknown keys are ignored so an older client never chokes on a newer server
export function setStats(next) {
  if (!next) return
  for (const k in BASE_STATS) if (typeof next[k] === "number" && Number.isFinite(next[k])) STATS[k] = next[k]
}

export const BRANCHES = { lichaam: "Lichaam", magie: "Magie", beweging: "Beweging" }

// Mirror of Game::Progression::SKILLS. Keep the one-line-per-skill shape: test/lib/game/session_test.rb parses it.
export const CATALOGUE = [
  { key: "taai_1", branch: "lichaam", name: "Taai I", cost: 1, level: 2, needs: [], text: "Een dikkere romp: 25 levenspunten erbij." },
  { key: "taai_2", branch: "lichaam", name: "Taai II", cost: 2, level: 8, needs: ["taai_1"], text: "Nog eens 40 levenspunten." },
  { key: "taai_3", branch: "lichaam", name: "Taai III", cost: 3, level: 16, needs: ["taai_2"], text: "En nog eens 60. Drakenvuur wordt een schrammetje." },
  { key: "herstel", branch: "lichaam", name: "Snel herstel", cost: 2, level: 5, needs: ["taai_1"], text: "Je knapt sneller op in een dorp, en ook onderweg." },
  { key: "rustplaats", branch: "lichaam", name: "Rustplaats", cost: 2, level: 12, needs: ["herstel"], text: "Een dorp lapt je in een paar tellen weer op." },
  { key: "sterk_schild", branch: "lichaam", name: "Sterk schild", cost: 2, level: 6, needs: ["taai_1"], text: "Het schild kost minder mana en houdt alles tegen." },
  { key: "kaatsschild", branch: "lichaam", name: "Kaatsschild", cost: 3, level: 14, needs: ["sterk_schild"], text: "Wat je tegenhoudt kaatst terug naar de draak die het stuurde." },
  { key: "manavat_1", branch: "magie", name: "Manavat I", cost: 1, level: 2, needs: [], text: "Een kwart meer mana in het vat." },
  { key: "manavat_2", branch: "magie", name: "Manavat II", cost: 2, level: 10, needs: ["manavat_1"], text: "Nog eens veertig procent erbij." },
  { key: "manastroom", branch: "magie", name: "Manastroom", cost: 2, level: 5, needs: ["manavat_1"], text: "Het vat loopt een kwart sneller vol." },
  { key: "vuurkracht_1", branch: "magie", name: "Vuurkracht I", cost: 1, level: 3, needs: [], text: "Vuurbal en bliksem slaan een vijfde harder in." },
  { key: "vuurkracht_2", branch: "magie", name: "Vuurkracht II", cost: 2, level: 11, needs: ["vuurkracht_1"], text: "En nog eens dertig procent harder." },
  { key: "splijtende_vuurbal", branch: "magie", name: "Splijtende vuurbal", cost: 3, level: 13, needs: ["vuurkracht_2"], text: "De vuurbal splijt onderweg in drie." },
  { key: "kettingbliksem", branch: "magie", name: "Kettingbliksem", cost: 3, level: 15, needs: ["manastroom", "vuurkracht_1"], text: "De bliksem springt door naar twee draken erachter." },
  { key: "snelle_tred", branch: "beweging", name: "Snelle tred", cost: 1, level: 2, needs: [], text: "De mech loopt vijftien procent harder." },
  { key: "stormloop", branch: "beweging", name: "Stormloop", cost: 2, level: 9, needs: ["snelle_tred"], text: "Nog eens twintig procent erbij." },
  { key: "dubbele_sprong", branch: "beweging", name: "Dubbele sprong", cost: 2, level: 7, needs: ["snelle_tred"], text: "Een tweede sprong in de lucht, over het dak heen." },
  { key: "lange_zweef", branch: "beweging", name: "Lange zweef", cost: 2, level: 10, needs: ["dubbele_sprong"], text: "Zweven zakt langzamer en kost bijna geen mana." },
  { key: "turbovat", branch: "beweging", name: "Groot turbovat", cost: 1, level: 4, needs: [], text: "De boostmeter houdt het veertig procent langer vol." },
  { key: "raceziel", branch: "beweging", name: "Raceziel", cost: 2, level: 12, needs: ["turbovat"], text: "Elk voertuig rijdt harder, en de meter houdt het nog langer vol." },
  { key: "snelle_transformatie", branch: "beweging", name: "Snelle transformatie", cost: 2, level: 6, needs: [], text: "Auto en mech wisselen bijna twee keer zo snel." },
  { key: "poortmeester", branch: "beweging", name: "Poortmeester", cost: 2, level: 8, needs: [], text: "Teleporteren mag veel vaker: nog maar 36 tellen wachten." },
]

const REASONS = {
  level: (s) => `Vanaf niveau ${s.level}`,
  needs: (s, cat) => `Eerst ${s.needs.map((k) => name(cat, k)).join(" en ")}`,
  points: (s) => `${s.cost} ${s.cost === 1 ? "punt" : "punten"} nodig`,
  known: () => "Al geleerd",
  unknown: () => "Die vaardigheid bestaat niet",
  player: () => "Even wachten, je bent nog niet aangemeld",
}
const name = (cat, key) => cat.find((s) => s.key === key)?.name ?? key

// The pure half of the panel: what each skill looks like for a given level, unlock set and point balance. Mirrors
// Game::Progression.refusal, which is the one that actually decides; this only picks the words and the colour.
export function skillStates(catalogue, { level = 1, unlocked = [], points = 0 } = {}) {
  const have = new Set(unlocked)
  return catalogue.map((s) => {
    if (have.has(s.key)) return { ...s, state: "geleerd", why: "" }
    if (level < s.level) return { ...s, state: "vast", why: REASONS.level(s) }
    if (!s.needs.every((k) => have.has(k))) return { ...s, state: "vast", why: REASONS.needs(s, catalogue) }
    if (points < s.cost) return { ...s, state: "duur", why: REASONS.points(s) }
    return { ...s, state: "kan", why: "" }
  })
}

const CSS = `
#vaardigheden { position: fixed; inset: 0; z-index: 7; display: flex; flex-direction: column; align-items: center; justify-content: center;
                background: rgba(8, 10, 16, .82); color: #fff; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
#vaardigheden .vk-kop { font-size: 13px; letter-spacing: .3em; text-transform: uppercase; opacity: .8; margin-bottom: 4px; }
#vaardigheden .vk-punten { font-size: 26px; font-weight: 700; margin-bottom: 16px; }
#vaardigheden .vk-punten b { color: #f2c14e; }
#vaardigheden .vk-takken { display: flex; gap: 14px; align-items: flex-start; max-width: 1100px; width: 92vw; }
#vaardigheden .vk-tak { flex: 1; min-width: 0; }
#vaardigheden .vk-taknaam { font-size: 12px; letter-spacing: .2em; text-transform: uppercase; opacity: .7; margin-bottom: 8px; }
#vaardigheden .vk { position: relative; background: rgba(255, 255, 255, .07); border: 2px solid rgba(255, 255, 255, .1); border-radius: 9px;
                    padding: 9px 12px 10px; margin-bottom: 7px; }
#vaardigheden .vk b { display: block; font-size: 15px; }
#vaardigheden .vk p { margin: 3px 0 0; font-size: 12.5px; line-height: 1.35; opacity: .8; }
#vaardigheden .vk .vk-prijs { position: absolute; right: 10px; top: 9px; font-size: 12px; font-weight: 700; color: #f2c14e; }
#vaardigheden .vk .vk-reden { display: block; font-size: 11.5px; margin-top: 4px; opacity: .7; font-style: italic; }
#vaardigheden .vk.kan { cursor: pointer; border-color: rgba(242, 193, 78, .8); background: rgba(242, 193, 78, .14); }
#vaardigheden .vk.kan:hover { background: rgba(242, 193, 78, .26); }
#vaardigheden .vk.geleerd { border-color: rgba(120, 220, 140, .6); background: rgba(120, 220, 140, .13); }
#vaardigheden .vk.geleerd .vk-prijs { color: #9ee6ae; }
#vaardigheden .vk.vast { opacity: .5; }
#vaardigheden .vk-voet { font-size: 12px; opacity: .6; margin-top: 14px; }
`

// The panel itself. It builds its own markup and its own stylesheet so it needs nothing from the view, and it
// listens for its own key so it needs nothing from Input; both can be moved into the page later without touching
// anything else here. B opens and closes it, Esc closes it, a click on a golden card spends a point.
export class Skills {
  constructor({ session, send, root = null, key = "KeyB" } = {}) {
    this.session = session
    this.send = send
    this.open = false
    this.key = key
    this.root = root ?? this.build()
    this.root.hidden = true
    this.root.addEventListener("click", (e) => this.click(e))
    addEventListener("keydown", (e) => {
      if (e.code === key && !e.repeat) { e.preventDefault(); this.toggle() }
      else if (e.code === "Escape" && this.open) this.toggle(false)
    })
    if (session) session.onProgress = () => { if (this.open) this.render() }
  }

  build() {
    if (!document.getElementById("vaardigheden-stijl")) {
      const style = document.createElement("style")
      style.id = "vaardigheden-stijl"
      style.textContent = CSS
      document.head.appendChild(style)
    }
    const root = document.createElement("div")
    root.id = "vaardigheden"
    document.body.appendChild(root)
    return root
  }

  toggle(force = null) {
    this.open = force === null ? !this.open : force
    this.root.hidden = !this.open
    if (this.open) this.render()
  }

  get catalogue() { return this.session?.you?.skills?.skills ?? CATALOGUE }

  click(e) {
    const card = e.target.closest?.(".vk.kan")
    if (!card) return
    this.send?.("skill", { key: card.dataset.key })
  }

  render() {
    const s = this.session
    const level = s?.you?.level ?? 1, points = s?.you?.skill_points ?? 0, unlocked = s?.you?.unlocked ?? []
    const cat = this.catalogue
    const rows = skillStates(cat, { level, unlocked, points })
    const branches = s?.you?.skills?.branches ?? BRANCHES
    const takken = Object.entries(branches).map(([id, naam]) => {
      const cards = rows.filter((r) => r.branch === id).map((r) => `
        <div class="vk ${r.state}" data-key="${esc(r.key)}">
          <span class="vk-prijs">${r.state === "geleerd" ? "✓" : `${r.cost}✦`}</span>
          <b>${esc(r.name)}</b>
          <p>${esc(r.text)}</p>
          ${r.why ? `<span class="vk-reden">${esc(r.why)}</span>` : ""}
        </div>`).join("")
      return `<div class="vk-tak"><div class="vk-taknaam">${esc(naam)}</div>${cards}</div>`
    }).join("")
    this.root.innerHTML = `
      <div class="vk-kop">Vaardigheden · niveau ${level}</div>
      <div class="vk-punten"><b>${points}</b> ${points === 1 ? "punt" : "punten"} te besteden</div>
      <div class="vk-takken">${takken}</div>
      <div class="vk-voet">Klik op een gouden kaart om een punt uit te geven · B of Esc sluit</div>`
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
