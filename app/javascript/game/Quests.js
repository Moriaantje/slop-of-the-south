import * as THREE from "three"
import { makeBeacon, placeBeacon, showBeacon } from "game/Beacon"
import { noAO } from "game/Layers"

// Quests on the client: the conversation, the log and the way to whatever the current stage wants.
//
// A quest from the server is a list of stages and the number of the one you are on, so everything here follows that
// one stage and never the quest as a whole: the objective line, the beacon, the pillar of light and the ground trail
// all point at the stage's target, and they change colour with what the stage is — amber to go somewhere, green to
// bring something back, red when the stage is marked perilous, which is how a delivery that turns into an ambush
// announces itself without a word. A stage that wants you to stand still and search shows how far along the standing
// still is, because a bar that fills is the only way to tell "keep looking" from "nothing here".
//
// The conversation is meant to read as an encounter rather than a menu. The lines type out, the person turns to you
// and gestures (Npcs.js), and the camera swings round to a two-shot for as long as the panel is open and eases back
// when it closes — the chase camera is left completely alone, this only blends the finished result towards the shot,
// so nothing here can ever fight the spring or leave the camera somewhere strange.
//
// The panel's markup lives in the view, but everything new about it is styled from the small sheet this file injects
// once, so no other agent's file has to change for this to land. Keys: 1–6 take an offer or ask about something, H
// heals where that is on offer, Esc leaves, J opens the log, K walks the tracked quest on.
const TRAIL_N = 48
const CAM_IN = 0.55, CAM_OUT = 0.4          // seconds to swing the camera into the two-shot and back out
const CAM_SIDE = 3.4, CAM_HEIGHT = 2.0      // metres beside and above the line between you and the person
const TYPE_CPS = 62                         // characters a second
const BOARD_EVERY = 0.5                     // seconds between two "what has this hub got" questions
const KIND_NL = { deliver: "bezorging", race: "race", scout: "verkenning", hunt: "drakenjacht", fetch: "opdracht", wake: "wake" }
const STAGE_NL = { goto: "ga erheen", search: "zoeken", return: "terugbrengen", hunt: "versla de draak", flee: "wegwezen" }
const COLOURS = { goto: 0xffb000, search: 0x8fd66a, return: 0x6ede8a, hunt: 0xff4d3d, flee: 0xff4d3d, peril: 0xff4d3d }

// the objective marker: a tall column of light on the target (seen from kilometres), the sky beacon with the name,
// and a line laid over the ground from the player towards it
const pillarGeo = new THREE.CylinderGeometry(3, 4.5, 360, 14, 1, true); pillarGeo.translate(0, 180, 0); pillarGeo.__shared = true
const pillarMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  uniforms: { time: { value: 0 }, kleur: { value: new THREE.Color(0xffb000) }, haast: { value: 0.0 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float time; uniform float haast; uniform vec3 kleur; varying vec2 vUv;
    void main() {
      float fade = pow(1.0 - vUv.y, 1.6);                                            // bright at the ground, gone at the top
      float speed = 2.0 + haast * 6.0;                                               // a perilous stage pulses faster
      float bands = 0.75 + 0.25 * sin(vUv.y * 40.0 - time * speed);
      gl_FragColor = vec4(kleur * fade * bands, fade * (0.55 + 0.2 * haast));
    }`,
})

export class Quests {
  constructor({ els, session, send, scene, heightAt, npcs }) {
    this.els = els; this.session = session; this.send = send; this.heightAt = heightAt; this.npcs = npcs
    this.active = []                 // quests from the server, in order
    this.dialogue = null             // { hub, npc, standing, lines, offers, topics, actions, shown, typed }
    this.typeT = 0
    this.logOpen = false
    this.objectiveIndex = 0
    this.camT = 0                    // 0 driving, 1 in the conversation shot
    this.boardT = 0
    this.beacon = makeBeacon(scene, 0xffb000)
    showBeacon(this.beacon, false)
    this.pillar = noAO(new THREE.Mesh(pillarGeo, pillarMat))    // additive and translucent: out of the AO pre-pass
    this.pillar.visible = false; this.pillar.frustumCulled = false; this.pillar.renderOrder = 6
    scene.add(this.pillar)
    const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(TRAIL_N * 3), 3))
    this.trail = noAO(new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0.85, depthWrite: false })))
    this.trail.visible = false; this.trail.frustumCulled = false; this.trail.renderOrder = 6
    scene.add(this.trail)
    this.trailT = 0
    els.dialoog.hidden = true
    els.log.hidden = true
    injectStyle()
  }

  get open() { return !!this.dialogue }
  get current() { return this.active.length ? this.active[this.objectiveIndex % this.active.length] : null }
  get objective() { const q = this.current; return q?.target ? { x: q.target.x, z: q.target.z } : null }

  // ---- from the server -------------------------------------------------------------------------------------------
  setAll(list) { this.active = list ?? []; this.renderLog() }

  receiveDialogue(msg) {
    const keep = msg.action === "topic" && this.dialogue ? this.dialogue : null
    this.dialogue = { ...msg, offers: msg.offers ?? keep?.offers ?? [], topics: msg.topics ?? keep?.topics ?? [], shown: 0 }
    this.typeT = 0
    const { dialoog, dialoogNaam, dialoogRol, dialoogTekst, dialoogOpties } = this.els
    dialoogNaam.textContent = msg.npc.name
    dialoogRol.innerHTML = `${esc(msg.npc.role)} · ${esc(msg.hub.name)}${msg.standing ? ` <span class="q-rang q-r${msg.standing.rank}">${esc(msg.standing.name)}</span>` : ""}`
    dialoogTekst.textContent = ""
    dialoogOpties.innerHTML = ""
    dialoog.hidden = false
  }

  receiveQuest(msg) {
    if (msg.ok === false) { this.session.flash(REASONS[msg.reason] ?? "Dat gaat nu niet"); return }
    const q = msg.quest
    switch (msg.action) {
      case "board":
        this.npcs?.setBoard(msg.hub_key, msg)
        return
      case "dwell": {                                        // the search clock started or was broken off
        const found = this.active.find((a) => a.key === msg.key)
        if (found) found.dwell_since = msg.since
        this.renderLog()
        return
      }
      case "accepted":
        this.active.push(q)
        this.session.flash(`Aangenomen: ${q.title}`)
        if (msg.said) this.say(msg.said)
        if (this.dialogue) { this.dialogue.offers = this.dialogue.offers.filter((o) => o.key !== q.key); this.renderOptions() }
        break
      case "stage": {
        const i = this.active.findIndex((a) => a.key === q.key)
        if (i >= 0) this.active[i] = q; else this.active.push(q)
        this.session.showBanner(q.peril ? "Het loopt anders" : "Volgende stap", msg.note ?? q.objective ?? q.title, q.peril ? 4200 : 3200)
        break
      }
      case "completed": {
        this.remove(q.key)
        const g = msg.given ?? q.reward ?? {}
        const bits = [`+${g.gold ?? 0} goud`, `+${g.xp ?? 0} xp`]
        if (g.skill_point) bits.push(`+${g.skill_point} vaardigheidspunt`)
        if (g.unlock) bits.push("nieuwe vaardigheid")
        this.session.showBanner(q.step && q.steps > 1 && q.step === q.steps ? `${q.line_name ?? "Volbracht"} · af` : "Volbracht",
                                `${q.title} · ${bits.join(" · ")}`, 4200)
        if (msg.said) this.say(msg.said)
        break
      }
      case "failed":
        this.remove(q.key)
        this.session.showBanner("Mislukt", `${q.title}${q.reason ? ` · ${q.reason}` : ""}`, 3800)
        if (msg.said) this.say(msg.said)
        break
      case "expired":
        this.remove(q.key)
        this.session.showBanner("Verlopen", `${q.title} · ${q.reason ?? "te lang laten liggen"}`, 3500)
        break
      case "abandoned":
        this.remove(q.key)
        this.session.flash(`Opgegeven: ${q.title}`)
        break
      case "healed":
        this.session.flash("Genezen")
        break
    }
    this.renderLog()
  }

  // one more line from the person you are standing in front of, appended to what they were saying
  say(line) {
    if (!this.dialogue || !line) { if (line) this.session.flash(line); return }
    this.dialogue.lines = [...this.dialogue.lines, line]
  }

  remove(key) { this.active = this.active.filter((q) => q.key !== key); this.objectiveIndex = 0 }

  // ---- input; returns true when it took the keys --------------------------------------------------------------------
  handleInput(input) {
    if (input.log) { this.logOpen = !this.logOpen; this.els.log.hidden = !this.logOpen; this.renderLog() }
    if (input.cycle && this.active.length > 1) { this.objectiveIndex = (this.objectiveIndex + 1) % this.active.length; this.renderLog(); this.session.flash(`Doel: ${this.current.objective ?? this.current.title}`) }
    if (!this.dialogue) return false
    if (input.escape) { this.close(); return true }
    const digit = input.digit
    if (digit) {
      const d = this.dialogue, offer = d.offers[digit - 1], topic = d.topics?.[digit - 1 - d.offers.length]
      if (offer) this.send("quest", { verb: "accept", hub_key: d.hub.key, key: offer.key })
      else if (topic) this.send("quest", { verb: "topic", hub_key: d.hub.key, npc_id: d.npc.id, key: topic.key })
      return true
    }
    if (input.heal && this.dialogue.actions?.includes("heal")) { this.send("quest", { verb: "heal", hub_key: this.dialogue.hub.key }); return true }
    return true
  }

  close() { this.dialogue = null; this.els.dialoog.hidden = true; this.npcs?.stopTalking() }

  abandon(key) { this.send("quest", { verb: "abandon", key }) }

  // ---- per frame -------------------------------------------------------------------------------------------------
  update(player, camera, dt) {
    if (this.dialogue) {
      // the lines type out; all shown after a few seconds
      const d = this.dialogue, full = d.lines.join("\n")
      this.typeT += dt
      const n = Math.min(full.length, Math.floor(this.typeT * TYPE_CPS))
      if (n !== d.shown) { d.shown = n; this.els.dialoogTekst.textContent = full.slice(0, n); if (n === full.length) this.renderOptions() }
      // walked away: the conversation ends
      if (d.hub.x !== undefined && Math.hypot(player.x - d.hub.x, player.z - d.hub.z) > 90) this.close()
    }
    this.frameCamera(player, camera, dt)
    this.askBoards(dt)

    const q = this.current, o = this.objective
    showBeacon(this.beacon, !!o)
    this.pillar.visible = this.trail.visible = !!o
    if (!o || !q) return
    const colour = q.peril ? COLOURS.peril : (COLOURS[q.stage_kind] ?? COLOURS.goto)
    pillarMat.uniforms.kleur.value.setHex(colour)
    pillarMat.uniforms.haast.value = q.peril ? 1 : 0
    pillarMat.uniforms.time.value += dt
    this.trail.material.color.setHex(colour)
    if (this.beacon.color !== colour) {                                         // the label draws its ring in this colour
      this.beacon.color = colour
      this.beacon.line.material.color.setHex(colour)
      this.beacon.text = ""                                                     // force one redraw of the label
    }
    const gy = this.heightAt(o.x, o.z)
    placeBeacon(this.beacon, o.x, gy, o.z, this.beaconName(q), player, camera)
    this.pillar.position.set(o.x, gy - 2, o.z)
    // the guide line follows the ground from the player to the target, refreshed a few times a second
    this.trailT += dt
    if (this.trailT > 0.2) {
      this.trailT = 0
      const pos = this.trail.geometry.attributes.position
      for (let i = 0; i < TRAIL_N; i++) {
        const k = i / (TRAIL_N - 1), x = player.x + (o.x - player.x) * k, z = player.z + (o.z - player.z) * k
        pos.setXYZ(i, x, this.heightAt(x, z) + 0.7 + k * 0.5, z)
      }
      pos.needsUpdate = true
    }
    if (this.logOpen && q.dwell_s) this.renderLog()          // the search bar has to move while you stand there
  }

  // The label is redrawn whenever its text changes, so the search progress is quantised to tenths: a percentage
  // that ticks every frame would upload a canvas texture every frame for the whole search.
  beaconName(q) {
    const name = q.target?.name ?? q.title
    const dwell = this.dwellFraction(q)
    return dwell === null ? name : `${name} · ${Math.round(dwell * 10) * 10}%`
  }

  // how far through a "stand here and look" stage you are, or null when this stage is not one
  dwellFraction(q) {
    if (!q?.dwell_s) return null
    if (!q.dwell_since) return 0
    return Math.max(0, Math.min(1, (this.session.now() - q.dwell_since) / (q.dwell_s * 1000)))
  }

  // The two-shot. The chase camera has already placed itself for this frame; this blends that result towards a spot
  // beside the two of you and never touches the spring, so letting go simply eases the blend back to nothing.
  frameCamera(player, camera, dt) {
    const focus = this.npcs?.focus
    const want = this.dialogue && focus ? 1 : 0
    const rate = want ? dt / CAM_IN : dt / CAM_OUT
    this.camT = want ? Math.min(1, this.camT + rate) : Math.max(0, this.camT - rate)
    if (this.camT <= 0.001 || !focus) return
    const t = this.camT * this.camT * (3 - 2 * this.camT)                       // smoothstep: no snap at either end
    const ax = focus.x - player.x, az = focus.z - player.z
    const len = Math.hypot(ax, az) || 1
    const ux = ax / len, uz = az / len
    _mid.set((player.x + focus.x) / 2, focus.y + 1.5, (player.z + focus.z) / 2)
    _pos.set(_mid.x - uz * CAM_SIDE - ux * 1.2, _mid.y + CAM_HEIGHT, _mid.z + ux * CAM_SIDE - uz * 1.2)
    const floor = this.heightAt(_pos.x, _pos.z) + 1.2
    if (_pos.y < floor) _pos.y = floor
    camera.getWorldDirection(_dir)
    _look.copy(camera.position).addScaledVector(_dir, Math.max(6, len + 4))     // where the chase camera was looking
    _look.lerp(_mid, t)
    camera.position.lerp(_pos, t)
    camera.lookAt(_look)
  }

  // ask the server what the hubs around you have on offer, one at a time, so the people wear the right marker
  askBoards(dt) {
    if (!this.npcs?.hubsNeedingBoard) return
    this.boardT += dt
    if (this.boardT < BOARD_EVERY) return
    this.boardT = 0
    const key = this.npcs.hubsNeedingBoard()[0]
    if (key) this.send("quest", { verb: "board", hub_key: key })
  }

  // ---- the panel ---------------------------------------------------------------------------------------------------

  renderOptions() {
    const d = this.dialogue
    if (!d || d.shown < d.lines.join("\n").length) return
    const rows = d.offers.map((o, i) => {
      const r = o.reward ?? {}
      const bits = [`+${r.gold ?? 0} goud`, `+${r.xp ?? 0} xp`]
      if (r.skill_point) bits.push("vaardigheidspunt")
      if (o.deadline_s) bits.push(fmt(o.deadline_s))
      if (o.requires === "mech") bits.push("alleen in de mech")
      if (o.stages > 1) bits.push(`${o.stages} stappen`)
      const chain = o.line ? `<span class="q-stap">${esc(o.line_name ?? "")} ${o.step}/${o.steps}</span>` : ""
      return `<div class="optie${o.line ? " q-lijn" : ""}"><kbd>${i + 1}</kbd> <b>${esc(o.title)}</b>${chain}<span class="beloning">${bits.join(" · ")}</span><p>${esc(o.text ?? o.brief ?? "")}</p></div>`
    })
    d.topics?.forEach((t, i) => rows.push(`<div class="optie klein"><kbd>${d.offers.length + i + 1}</kbd> ${esc(t.label)}</div>`))
    if (d.actions?.includes("heal")) rows.push(`<div class="optie klein"><kbd>H</kbd> genezen</div>`)
    rows.push(`<div class="optie klein"><kbd>Esc</kbd> tot ziens</div>`)
    this.els.dialoogOpties.innerHTML = rows.join("")
  }

  renderLog() {
    const { logLijst } = this.els
    if (!this.logOpen) return
    if (!this.active.length) { logLijst.innerHTML = `<div class="leeg">Geen opdrachten. Praat met de mensen in een dorp (E).</div>`; return }
    const now = this.session.now()
    logLijst.innerHTML = this.active.map((q, i) => {
      const tracked = i === this.objectiveIndex % this.active.length
      const left = q.deadline_at ? Math.max(0, Math.ceil((q.deadline_at - now) / 1000)) : null
      const stale = q.expires_at ? Math.max(0, Math.ceil((q.expires_at - now) / 1000)) : null
      const soort = [KIND_NL[q.kind] ?? q.kind, q.hub_name ? esc(q.hub_name) : null].filter(Boolean).join(" · ")
      const chain = q.steps > 1 ? `<span class="q-stap">${esc(q.line_name ?? "")} ${q.step}/${q.steps}</span>` : ""
      const steps = q.stage_count > 1 ? `<span class="q-fase">stap ${Math.min(q.stage + 1, q.stage_count)} van ${q.stage_count} · ${STAGE_NL[q.stage_kind] ?? ""}</span>` : ""
      const dwell = this.dwellFraction(q)
      const bar = dwell === null ? "" : `<span class="q-balk"><i style="width:${Math.round(dwell * 100)}%"></i></span>`
      const klok = left !== null ? `<span class="q-tijd${left < 30 ? " kort" : ""}">nog ${fmt(left)}</span>` : (stale !== null && stale < 600 ? `<span class="q-tijd">verloopt over ${fmt(stale)}</span>` : "")
      return `<div class="quest${tracked ? " doel" : ""}${q.peril ? " gevaar" : ""}"><b>${esc(q.title)}</b>${chain}
        <span class="soort">${soort}</span>
        <span class="q-doel">${esc(q.objective ?? "")}</span>${steps}${bar}${klok}</div>`
    }).join("") + `<div class="leeg">K wisselt het doel · J sluit dit</div>`
  }
}

const _pos = new THREE.Vector3(), _look = new THREE.Vector3(), _mid = new THREE.Vector3(), _dir = new THREE.Vector3()
const REASONS = { far: "Ga dichter naar de plek toe", unknown: "Die opdracht bestaat niet (meer)", max: "Je hebt al drie opdrachten", active: "Die heb je al",
                  mech: "Alleen in de tovenaarsmech (T)", place: "Hier kun je niet genezen", player: "Even wachten, je bent nog niet aangemeld", action: "Dat gaat niet" }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

// The panel's own styling. It lives here rather than in the view because everything it dresses — the standing badge,
// the chain counter, the stage line, the search bar — arrived with this file, and a rule that has no markup to hang
// on is worse than one that ships beside it.
let styled = false
function injectStyle() {
  if (styled || typeof document === "undefined" || !document.head) return
  styled = true
  const el = document.createElement("style")
  el.textContent = `
    .q-rang { margin-left: 8px; padding: 1px 7px; border-radius: 10px; font-size: 11px; letter-spacing: .06em;
              text-transform: uppercase; background: rgba(255,255,255,.14); }
    .q-rang.q-r1 { background: rgba(143, 214, 106, .26); } .q-rang.q-r2 { background: rgba(110, 222, 138, .32); }
    .q-rang.q-r3 { background: rgba(255, 176, 0, .34); } .q-rang.q-r4 { background: rgba(255, 176, 0, .55); color: #1a1406; }
    #dialoog-opties .optie.q-lijn { box-shadow: inset 3px 0 0 rgba(255, 176, 0, .8); }
    .q-stap { display: inline-block; margin-left: 8px; font-size: 11px; opacity: .8; letter-spacing: .06em; text-transform: uppercase; }
    #logboek .quest.gevaar { background: rgba(255, 77, 61, .22); }
    #logboek .q-doel { display: block; font-size: 13px; margin-top: 2px; }
    #logboek .q-fase, #logboek .q-tijd { display: inline-block; margin-top: 3px; margin-right: 8px; font-size: 11px; opacity: .7; }
    #logboek .q-tijd.kort { opacity: 1; color: #ff9c8f; }
    #logboek .q-balk { display: block; height: 4px; margin: 5px 0 2px; border-radius: 2px; background: rgba(255,255,255,.16); }
    #logboek .q-balk i { display: block; height: 100%; border-radius: 2px; background: #8fd66a; }
  `
  document.head.appendChild(el)
}
