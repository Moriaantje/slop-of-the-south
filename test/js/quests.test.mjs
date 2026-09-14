import { test } from "node:test"
import assert from "node:assert/strict"
import * as THREE from "three"
import { Quests } from "game/Quests"
import { Npcs, faceYaw } from "game/Npcs"

// the six elements the view gives Quests, as plain objects
function els() {
  const el = () => ({ hidden: false, textContent: "", innerHTML: "" })
  return { dialoog: el(), dialoogNaam: el(), dialoogRol: el(), dialoogTekst: el(), dialoogOpties: el(), log: el(), logLijst: el() }
}

function build({ now = () => 1000, npcs = null } = {}) {
  const sent = [], banners = [], flashes = []
  const session = { now, flash: (t) => flashes.push(t), showBanner: (a, b) => banners.push([a, b]) }
  const q = new Quests({ els: els(), session, send: (a, d) => sent.push([a, d]), scene: new THREE.Scene(), heightAt: () => 0, npcs })
  return { q, sent, banners, flashes }
}

const quest = (over = {}) => ({
  key: "p:1|deliver|0", kind: "deliver", status: "active", title: "Bezorg een vlaai in Verweg", objective: "Breng de vlaai naar Verweg",
  hub_key: "p:1", hub_name: "Testdorp", stage: 0, stage_count: 2, stage_kind: "goto", steps: 1, step: null,
  target: { key: "p:2", name: "Verweg", x: 500, z: 0 }, reward: { gold: 40, xp: 40 }, ...over,
})

const dialogue = (over = {}) => ({
  type: "dialogue", npc: { id: "p:1/0", name: "Sjeng Meertens", role: "burgemeester" },
  hub: { key: "p:1", name: "Testdorp", x: 0, z: 0 }, standing: { rank: 2, name: "vertrouwd" },
  lines: ["Goeiemiddag.", "Er ligt werk."],
  offers: [{ key: "a", title: "Bezorg een vlaai", text: "Naar Verweg.", reward: { gold: 40, xp: 40 }, stages: 1 }],
  topics: [{ key: "weer", label: "En het weer?" }], actions: ["heal"], ...over,
})

const keys = (over = {}) => ({ log: false, cycle: false, escape: false, digit: 0, heal: false, ...over })

test("the objective follows the stage, and its colour follows what the stage is", () => {
  const { q } = build()
  q.setAll([quest()])
  assert.deepEqual(q.objective, { x: 500, z: 0 })
  const player = { x: 0, y: 0, z: 0 }
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 5, 10)
  q.update(player, camera, 0.016)
  assert.equal(q.pillar.visible, true)
  assert.equal(q.beacon.color, 0xffb000)
  // the second stage brings it home, and a perilous stage turns the whole marker red
  q.receiveQuest({ action: "stage", quest: quest({ stage: 1, stage_kind: "return", target: { key: "p:1", name: "Testdorp", x: 0, z: 0 } }), note: "Terug." })
  assert.deepEqual(q.objective, { x: 0, z: 0 })
  q.update(player, camera, 0.016)
  assert.equal(q.beacon.color, 0x6ede8a)
  q.receiveQuest({ action: "stage", quest: quest({ stage: 1, stage_kind: "flee", peril: true, target: { key: "p:1", name: "Testdorp", x: 0, z: 0 } }) })
  q.update(player, camera, 0.016)
  assert.equal(q.beacon.color, 0xff4d3d)
  assert.equal(q.pillar.material.uniforms.haast.value, 1)
})

test("a stage message replaces the quest in the log instead of adding a second one", () => {
  const { q, banners } = build()
  q.setAll([quest()])
  q.receiveQuest({ action: "stage", quest: quest({ stage: 1, stage_kind: "return" }), note: "Genoeg gezien." })
  assert.equal(q.active.length, 1)
  assert.equal(q.active[0].stage, 1)
  assert.deepEqual(banners.at(-1), ["Volgende stap", "Genoeg gezien."])
})

test("what a finished quest actually paid is what the banner says", () => {
  const { q, banners } = build()
  q.setAll([quest()])
  q.receiveQuest({ action: "completed", quest: quest({ status: "done", step: 3, steps: 3, line_name: "Gemeentezaken" }),
                   given: { gold: 320, xp: 300, skill_point: 1 } })
  assert.equal(q.active.length, 0)
  assert.equal(banners.at(-1)[0], "Gemeentezaken · af")
  assert.match(banners.at(-1)[1], /\+320 goud · \+300 xp · \+1 vaardigheidspunt/)
})

test("the search bar reads the server's dwell clock", () => {
  let now = 10_000
  const { q } = build({ now: () => now })
  const searching = quest({ stage_kind: "search", dwell_s: 8, dwell_since: 10_000 })
  assert.equal(q.dwellFraction(searching), 0)
  now = 14_000
  assert.equal(q.dwellFraction(searching), 0.5)
  now = 30_000
  assert.equal(q.dwellFraction(searching), 1)
  assert.equal(q.dwellFraction(quest()), null)
  assert.equal(q.beaconName(searching), "Verweg · 100%")
})

test("the dwell message moves the search bar", () => {
  let now = 20_000
  const { q } = build({ now: () => now })
  q.setAll([quest({ stage_kind: "search", dwell_s: 10 })])
  assert.equal(q.dwellFraction(q.active[0]), 0)
  q.receiveQuest({ action: "dwell", key: q.active[0].key, since: 20_000 })
  now = 25_000
  assert.equal(q.dwellFraction(q.active[0]), 0.5)
  q.receiveQuest({ action: "dwell", key: q.active[0].key, since: null })
  assert.equal(q.dwellFraction(q.active[0]), 0)
})

test("the digits take the offers first and the topics after them", () => {
  const { q, sent } = build()
  q.receiveDialogue(dialogue())
  assert.equal(q.open, true)
  assert.equal(q.handleInput(keys({ digit: 1 })), true)
  assert.deepEqual(sent.at(-1), ["quest", { verb: "accept", hub_key: "p:1", key: "a" }])
  q.handleInput(keys({ digit: 2 }))
  assert.deepEqual(sent.at(-1), ["quest", { verb: "topic", hub_key: "p:1", npc_id: "p:1/0", key: "weer" }])
  q.handleInput(keys({ heal: true }))
  assert.deepEqual(sent.at(-1), ["quest", { verb: "heal", hub_key: "p:1" }])
  q.handleInput(keys({ escape: true }))
  assert.equal(q.open, false)
  assert.equal(q.handleInput(keys({ digit: 1 })), false, "with no panel the digits belong to the vehicle picker")
})

test("a topic answer keeps the offers that came with the greeting", () => {
  const { q } = build()
  q.receiveDialogue(dialogue())
  q.receiveDialogue({ ...dialogue(), action: "topic", lines: ["Het miezert.", "Zoals altijd."], offers: undefined, topics: undefined })
  assert.equal(q.dialogue.offers.length, 1)
  assert.equal(q.dialogue.topics.length, 1)
  assert.equal(q.dialogue.lines.length, 2)
})

test("the camera swings to a two-shot while you talk and comes all the way back", () => {
  const focus = { x: 10, y: 0, z: 0 }
  const { q } = build({ npcs: { focus, stopTalking() {} } })
  const camera = new THREE.PerspectiveCamera()
  const player = { x: 0, y: 0, z: 0 }
  const drive = () => camera.position.set(0, 4, 12)
  drive(); q.update(player, camera, 0.016)
  assert.deepEqual(camera.position.toArray(), [0, 4, 12], "no dialogue, no camera")
  q.receiveDialogue(dialogue())
  for (let i = 0; i < 60; i++) { drive(); q.update(player, camera, 0.016) }
  assert.ok(q.camT > 0.99)
  assert.ok(camera.position.distanceTo(new THREE.Vector3(5, 2, 0)) < 4.5, `two-shot lands beside the pair: ${camera.position.toArray()}`)
  q.close()
  for (let i = 0; i < 60; i++) { drive(); q.update(player, camera, 0.016) }
  assert.equal(q.camT, 0)
  assert.deepEqual(camera.position.toArray(), [0, 4, 12])
})

test("the hubs around you are asked about one at a time, and the answer reaches the people", () => {
  const boards = []
  const npcs = { focus: null, setBoard: (k, m) => boards.push([k, m.offers]), hubsNeedingBoard: () => ["p:1", "p:2"] }
  const { q, sent } = build({ npcs })
  q.update({ x: 0, y: 0, z: 0 }, new THREE.PerspectiveCamera(), 0.2)
  assert.equal(sent.length, 0, "not every frame")
  q.update({ x: 0, y: 0, z: 0 }, new THREE.PerspectiveCamera(), 0.4)
  assert.deepEqual(sent.at(-1), ["quest", { verb: "board", hub_key: "p:1" }])
  q.receiveQuest({ action: "board", hub_key: "p:1", offers: 2, turn_in: false, npcs: ["p:1/0"] })
  assert.deepEqual(boards.at(-1), ["p:1", 2])
})

// ---- the people -------------------------------------------------------------------------------------------------

const inst = () => ({ root: new THREE.Group(), ready: true, current: null, played: [], clips: [],
  play(which) { this.played.push(String(which)); this.current = { getClip: () => ({ duration: 1 }) }; return this.current },
  update() {}, dispose() {} })

function town() {
  const scene = new THREE.Scene()
  const hubs = [{ key: "p:1", name: "Testdorp", x: 0, z: 0, npcs: [
    { id: "p:1/0", name: "Sjeng Meertens", role: "burgemeester", x: 0, z: 0, yaw: 0 },
    { id: "p:1/1", name: "Mia Wolfs", role: "herbergier", x: 3, z: 0, yaw: 0 }] }]
  const npcs = new Npcs({ scene, assets: { instantiate: () => inst() }, hubs, heightAt: () => 0 })
  return npcs
}

test("people stroll about their own spot and never wander off it", () => {
  const npcs = town()
  const player = { x: 0, y: 0, z: 8, vx: 0, vz: 0 }
  const camera = new THREE.PerspectiveCamera()
  for (let i = 0; i < 4000; i++) npcs.update(player, camera, 1 / 60, 0)
  assert.equal(npcs.people.size, 2)
  let moved = false
  for (const p of npcs.people.values()) {
    assert.ok(Math.hypot(p.x - p.home.x, p.z - p.home.z) <= 5.6, "stays within reach of home")
    if (Math.hypot(p.x - p.home.x, p.z - p.home.z) > 0.2) moved = true
    assert.ok(["staan", "lopen", "praten"].includes(p.state))
  }
  assert.ok(moved, "somebody went for a walk")
})

test("they notice you, face you while you talk, and let go afterwards", () => {
  const npcs = town()
  const camera = new THREE.PerspectiveCamera()
  const far = { x: 0, y: 0, z: 300, vx: 0, vz: 0 }
  npcs.update(far, camera, 0.016, 0)
  const sjeng = npcs.people.get("p:1/0")
  assert.equal(sjeng.greeted, false)
  const near = { x: 0, y: 0, z: 4, vx: 0, vz: 0 }
  npcs.update(near, camera, 0.016, 0)
  assert.equal(sjeng.greeted, true, "a wave when you walk up")
  assert.equal(npcs.near, sjeng)
  assert.match(npcs.prompt, /^E · praat met Sjeng Meertens \(burgemeester\)/)
  npcs.talkTo(sjeng)
  for (let i = 0; i < 120; i++) npcs.update(near, camera, 1 / 60, 0)
  assert.ok(Math.abs(sjeng.root.rotation.y - faceYaw(near.x - sjeng.x, near.z - sjeng.z)) < 0.05, "turned to face you")
  assert.equal(sjeng.x, sjeng.home.x, "nobody walks off mid-sentence")
  npcs.stopTalking()
  assert.equal(npcs.talking, null)
})

test("the marker over a head is only what the server told us", () => {
  const npcs = town()
  const camera = new THREE.PerspectiveCamera()
  const player = { x: 0, y: 0, z: 10, vx: 0, vz: 0 }
  npcs.update(player, camera, 0.016, 0)
  assert.equal(npcs.badgeFor(npcs.people.get("p:1/0")), null)
  assert.deepEqual(npcs.hubsNeedingBoard(), ["p:1"])
  assert.deepEqual(npcs.hubsNeedingBoard(), [], "and not again straight away")
  npcs.setBoard("p:1", { offers: 2, turn_in: false, npcs: ["p:1/0"] })
  assert.equal(npcs.badgeFor(npcs.people.get("p:1/0")), "!")
  assert.equal(npcs.badgeFor(npcs.people.get("p:1/1")), null, "the offers belong to the mayor")
  npcs.setBoard("p:1", { offers: 0, turn_in: true })
  assert.equal(npcs.badgeFor(npcs.people.get("p:1/0")), "?")
  npcs.update(player, camera, 0.016, 0)
  assert.ok(npcs.people.get("p:1/0").mark.visible)
  assert.match(npcs.prompt ?? "", /iets af te ronden|^$/)
})
