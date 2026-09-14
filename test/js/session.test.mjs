import { test } from "node:test"
import assert from "node:assert/strict"
import { Session, nearestHub } from "game/Session"
import { BASE_STATS, STATS, CATALOGUE, setStats, stat, skillStates } from "game/Skills"

// A Session needs the six HUD nodes; these are the smallest things that behave like them.
function stub() {
  const node = () => ({ textContent: "", hidden: true, classList: { toggle() {} } })
  const els = { actie: node(), status: node(), banner: node(), bannerTitel: node(), bannerSub: node(), flits: node() }
  const seen = { levelUps: [], skills: [] }
  const s = new Session("me", els, { onLevelUp: (e) => seen.levelUps.push(e), onSkill: (m) => seen.skills.push(m) })
  return { s, els, seen }
}

const sync = (you = {}) => ({ type: "sync", now: Date.now(), you: { id: "me", name: "Piet", hp: 100, gold: 0, xp: 0, level: 1, max_hp: 100, skill_points: 0, unlocked: [], discovered: [], ...you } })

// reset the shared block between tests: it is module state on purpose (one player per tab)
const clearStats = () => { for (const k in BASE_STATS) STATS[k] = BASE_STATS[k] }

test("nearestHub finds the closest hub within reach", () => {
  const hubs = [{ key: "a", x: 0, z: 0 }, { key: "b", x: 100, z: 0 }]
  assert.equal(nearestHub(90, 0, hubs).key, "b")
  assert.equal(nearestHub(90, 0, hubs, 5), null)
  assert.equal(nearestHub(2, 2, hubs, 5).key, "a")
})

test("the base stat block is today's game: every multiplier 1, every ability 0", () => {
  clearStats()
  assert.equal(stat("walk_speed"), 1)
  assert.equal(stat("mana_regen"), 1)
  assert.equal(stat("jumps"), 1)
  assert.equal(stat("fireball_split"), 0)
  assert.equal(stat("shield_reflect"), 0)
  assert.equal(stat("er_is_geen_stat"), 0)          // an unknown name reads as nothing, never as undefined
})

test("the server's stat block is taken whole, and only the keys it knows about", () => {
  clearStats()
  setStats({ walk_speed: 1.35, jumps: 2, onzin: 99, spell_damage: "veel", mana_regen: NaN })
  assert.equal(stat("walk_speed"), 1.35)
  assert.equal(stat("jumps"), 2)
  assert.equal(stat("spell_damage"), 1)             // a string is not a stat
  assert.equal(stat("mana_regen"), 1)               // and neither is NaN
  assert.equal(STATS.onzin, undefined)
  setStats(null)
  assert.equal(stat("walk_speed"), 1.35)            // nothing to apply leaves the block alone
  clearStats()
})

test("a sync is not a level-up, but the next level is, exactly once", () => {
  clearStats()
  const { s, els, seen } = stub()
  s.receive(sync({ level: 4, skill_points: 4 }))
  assert.equal(seen.levelUps.length, 0)
  assert.equal(s.level, 4)

  s.receive({ type: "you", hp: 100, gold: 0, xp: 500, level: 5, skill_points: 5, max_hp: 108, stats: { max_hp: 108, walk_speed: 1.15 } })
  assert.deepEqual(seen.levelUps, [{ level: 5, gained: 1, points: 5 }])
  assert.equal(els.bannerTitel.textContent, "Niveau 5")
  assert.match(els.bannerSub.textContent, /5 vaardigheidspunten/)
  assert.equal(els.banner.hidden, false)
  assert.equal(stat("walk_speed"), 1.15)
  assert.equal(s.maxHp, 108)

  // the same message again (a resend, or the tick's own `level`) announces nothing more
  s.receive({ type: "you", hp: 100, gold: 0, xp: 500, level: 5, skill_points: 5 })
  s.receive({ type: "level", level: 5, skill_points: 5 })
  assert.equal(seen.levelUps.length, 1)
  clearStats()
})

test("two levels at once are one banner that names the level reached", () => {
  const { s, seen } = stub()
  s.receive(sync({ level: 1 }))
  s.receive({ type: "you", hp: 100, gold: 0, xp: 200, level: 3, skill_points: 2 })
  assert.deepEqual(seen.levelUps, [{ level: 3, gained: 2, points: 2 }])
})

test("a spent point arrives as the whole block; a refusal is a Dutch excuse", () => {
  clearStats()
  const { s, els, seen } = stub()
  s.receive(sync({ level: 6, skill_points: 6 }))
  s.receive({ type: "skill", ok: true, key: "manavat_1", name: "Manavat I", level: 6, skill_points: 5,
              unlocked: ["manavat_1"], stats: { mana_max: 1.25 } })
  assert.equal(s.points, 5)
  assert.equal(s.has("manavat_1"), true)
  assert.equal(s.has("kettingbliksem"), false)
  assert.equal(stat("mana_max"), 1.25)
  assert.equal(seen.skills.length, 1)
  assert.equal(els.flits.textContent, "Manavat I geleerd")

  s.receive({ type: "skill", ok: false, reason: "level", key: "kettingbliksem" })
  assert.equal(els.flits.textContent, "Daar ben je nog niet hoog genoeg voor")
  assert.equal(s.points, 5)                          // a refusal changes nothing
  clearStats()
})

test("the status line carries hit points out of the pool and the points waiting to be spent", () => {
  const { s, els } = stub()
  s.receive(sync({ level: 9, hp: 143, max_hp: 216, gold: 240, skill_points: 3 }))
  assert.equal(els.status.textContent, "♥ 143/216 · 240 goud · niveau 9 · ✦3")
  s.receive({ type: "you", hp: 143, gold: 240, xp: 3200, level: 9, skill_points: 0 })
  assert.equal(els.status.textContent, "♥ 143/216 · 240 goud · niveau 9")
})

test("skillStates says why each skill is out of reach", () => {
  const at = (o) => Object.fromEntries(skillStates(CATALOGUE, o).map((r) => [r.key, r]))

  let rows = at({ level: 1, unlocked: [], points: 0 })
  assert.equal(rows.taai_1.state, "vast")
  assert.equal(rows.taai_1.why, "Vanaf niveau 2")

  rows = at({ level: 20, unlocked: [], points: 0 })
  assert.equal(rows.taai_1.state, "duur")
  assert.equal(rows.taai_1.why, "1 punt nodig")
  assert.equal(rows.taai_2.state, "vast")
  assert.equal(rows.taai_2.why, "Eerst Taai I")
  assert.equal(rows.kettingbliksem.why, "Eerst Manastroom en Vuurkracht I")

  rows = at({ level: 20, unlocked: ["taai_1"], points: 3 })
  assert.equal(rows.taai_1.state, "geleerd")
  assert.equal(rows.taai_2.state, "kan")
  assert.equal(rows.taai_3.why, "Eerst Taai II")
  assert.equal(rows.splijtende_vuurbal.state, "vast")   // affordable, but the prerequisites are checked first
  assert.equal(rows.splijtende_vuurbal.why, "Eerst Vuurkracht II")
})

test("the catalogue is a tree: every prerequisite exists and comes earlier", () => {
  const byKey = new Map(CATALOGUE.map((s) => [s.key, s]))
  assert.equal(byKey.size, CATALOGUE.length)                       // no duplicate keys
  for (const s of CATALOGUE) {
    assert.ok(["lichaam", "magie", "beweging"].includes(s.branch), `${s.key} has no branch`)
    assert.ok(s.cost >= 1 && s.level >= 2, `${s.key} is free or available at level 1`)
    for (const need of s.needs) {
      assert.ok(byKey.has(need), `${s.key} needs unknown ${need}`)
      assert.ok(byKey.get(need).level <= s.level, `${s.key} opens before ${need}`)
    }
  }
})
