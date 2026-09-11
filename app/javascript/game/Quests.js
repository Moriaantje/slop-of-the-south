import * as THREE from "three"
import { makeBeacon, placeBeacon, showBeacon } from "game/Beacon"

// the objective marker: a tall amber column of light on the target (seen from kilometres), the sky beacon with the
// name, and a line laid over the ground from the player towards it
const pillarGeo = new THREE.CylinderGeometry(3, 4.5, 360, 14, 1, true); pillarGeo.translate(0, 180, 0); pillarGeo.__shared = true
const pillarMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  uniforms: { time: { value: 0 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float time; varying vec2 vUv;
    void main() {
      float fade = pow(1.0 - vUv.y, 1.6);                                            // bright at the ground, gone at the top
      float bands = 0.75 + 0.25 * sin(vUv.y * 40.0 - time * 2.0);
      gl_FragColor = vec4(vec3(1.0, 0.68, 0.18) * fade * bands, fade * 0.55);
    }`,
})
const TRAIL_N = 48

// Quests on the client: the dialogue panel (the person's lines typed out, the offers on 1–3, H to heal, Esc to
// close), the quest log (J), the objective — an amber beacon and a minimap ring on the target of the current quest
// (K cycles) — and the banners when one completes or fails. Everything comes from the server's `dialogue` and
// `quest` messages; this only asks (`quest` verbs) and shows.
const KIND_NL = { deliver: "bezorging", race: "race", scout: "verkenning", hunt: "drakenjacht" }

export class Quests {
  constructor({ els, session, send, scene, heightAt, npcs }) {
    this.els = els; this.session = session; this.send = send; this.heightAt = heightAt; this.npcs = npcs
    this.active = []                 // quests from the server, in order
    this.dialogue = null             // { hub, npc, lines, offers, actions, shown, typed }
    this.typeT = 0
    this.logOpen = false
    this.objectiveIndex = 0
    this.beacon = makeBeacon(scene, 0xffb000)
    showBeacon(this.beacon, false)
    this.pillar = new THREE.Mesh(pillarGeo, pillarMat); this.pillar.visible = false; this.pillar.frustumCulled = false; this.pillar.renderOrder = 6
    scene.add(this.pillar)
    const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(TRAIL_N * 3), 3))
    this.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0.85, depthWrite: false }))
    this.trail.visible = false; this.trail.frustumCulled = false; this.trail.renderOrder = 6
    scene.add(this.trail)
    this.trailT = 0
    els.dialoog.hidden = true
    els.log.hidden = true
  }

  get open() { return !!this.dialogue }
  get current() { return this.active.length ? this.active[this.objectiveIndex % this.active.length] : null }
  get objective() { const q = this.current; return q?.target ? { x: q.target.x, z: q.target.z } : null }

  // ---- from the server -------------------------------------------------------------------------------------------
  setAll(list) { this.active = list ?? []; this.renderLog() }

  receiveDialogue(msg) {
    this.dialogue = { ...msg, shown: 0, typed: "" }
    this.typeT = 0
    const { dialoog, dialoogNaam, dialoogRol, dialoogTekst, dialoogOpties } = this.els
    dialoogNaam.textContent = msg.npc.name
    dialoogRol.textContent = `${msg.npc.role} · ${msg.hub.name}`
    dialoogTekst.textContent = ""
    dialoogOpties.innerHTML = ""
    dialoog.hidden = false
  }

  receiveQuest(msg) {
    if (msg.ok === false) { this.session.flash(REASONS[msg.reason] ?? "Dat gaat nu niet"); return }
    const q = msg.quest
    switch (msg.action) {
      case "accepted":
        this.active.push(q)
        this.session.flash(`Aangenomen: ${q.title}`)
        if (this.dialogue) { this.dialogue.offers = this.dialogue.offers.filter((o) => o.key !== q.key); this.renderOptions() }
        break
      case "completed":
        this.remove(q.key)
        this.session.showBanner("Volbracht", `${q.title} · +${q.reward?.gold ?? 0} goud · +${q.reward?.xp ?? 0} xp`, 4000)
        break
      case "failed":
        this.remove(q.key)
        this.session.showBanner("Mislukt", `${q.title}${q.reason ? ` · ${q.reason}` : ""}`, 3500)
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

  remove(key) { this.active = this.active.filter((q) => q.key !== key); this.objectiveIndex = 0 }

  // ---- input; returns true when it took the keys --------------------------------------------------------------------
  handleInput(input) {
    if (input.log) { this.logOpen = !this.logOpen; this.els.log.hidden = !this.logOpen; this.renderLog() }
    if (input.cycle && this.active.length > 1) { this.objectiveIndex = (this.objectiveIndex + 1) % this.active.length; this.renderLog(); this.session.flash(`Doel: ${this.current.title}`) }
    if (!this.dialogue) return false
    if (input.escape) { this.close(); return true }
    const digit = input.digit
    if (digit) {
      const offer = this.dialogue.offers[digit - 1]
      if (offer) this.send("quest", { verb: "accept", hub_key: this.dialogue.hub.key, key: offer.key })
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
      const n = Math.min(full.length, Math.floor(this.typeT * 55))
      if (n !== d.shown) { d.shown = n; this.els.dialoogTekst.textContent = full.slice(0, n); if (n === full.length) this.renderOptions() }
      // walked away: the conversation ends
      if (Math.hypot(player.x - d.hub.x, player.z - d.hub.z) > 80 && d.hub.x !== undefined) this.close()
    }
    const o = this.objective
    showBeacon(this.beacon, !!o)
    this.pillar.visible = this.trail.visible = !!o
    if (!o) return
    const gy = this.heightAt(o.x, o.z)
    placeBeacon(this.beacon, o.x, gy, o.z, this.current.target.name, player, camera)
    this.pillar.position.set(o.x, gy - 2, o.z)
    pillarMat.uniforms.time.value += dt
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
  }

  renderOptions() {
    const d = this.dialogue
    if (!d || d.shown < d.lines.join("\n").length) return
    const rows = d.offers.map((o, i) => `<div class="optie"><kbd>${i + 1}</kbd> <b>${esc(o.title)}</b><span class="beloning">+${o.reward?.gold ?? 0} goud · +${o.reward?.xp ?? 0} xp${o.deadline_s ? ` · ${fmt(o.deadline_s)}` : ""}${o.requires === "mech" ? " · alleen in de mech" : ""}</span><p>${esc(o.text)}</p></div>`)
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
      const left = q.deadline_at ? Math.max(0, Math.ceil((q.deadline_at - now) / 1000)) : null
      return `<div class="quest${i === this.objectiveIndex % this.active.length ? " doel" : ""}"><b>${esc(q.title)}</b><span class="soort">${KIND_NL[q.kind] ?? q.kind}${q.hub_name ? ` · ${esc(q.hub_name)}` : ""}${left !== null ? ` · nog ${fmt(left)}` : ""}</span></div>`
    }).join("") + `<div class="leeg">K wisselt het doel</div>`
  }
}

const REASONS = { far: "Ga dichter naar de plek toe", unknown: "Die opdracht bestaat niet (meer)", max: "Je hebt al drie opdrachten", active: "Die heb je al",
                  mech: "Alleen in de tovenaarsmech (T)", place: "Hier kun je niet genezen", player: "Even wachten, je bent nog niet aangemeld", action: "Dat gaat niet" }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
