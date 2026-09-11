import * as THREE from "three"
import { World } from "game/World"
import { ChunkManager } from "game/ChunkManager"
import { updateSignals, setNightLevel } from "game/Furniture"
import { setSignsNight } from "game/Signs"
import { DayNight } from "game/DayNight"
import { updateWater } from "game/Cover"
import { Avatar } from "game/Avatar"
import { Spells } from "game/Spells"
import { Dragons } from "game/Dragons"
import { Input } from "game/Input"
import { Network } from "game/Network"
import { RemoteCars } from "game/RemoteCars"
import { Locator, nearestPointOnRoads } from "game/Locator"
import { Minimap } from "game/Minimap"
import { FlameWall } from "game/FlameWall"
import { Session, nearestHub } from "game/Session"
import { LoadingScreen } from "game/LoadingScreen"
import { vehicleSpec } from "game/Vehicles"
import { Picker } from "game/Picker"
import { Destructibles } from "game/Destructibles"
import { Combat } from "game/Combat"
import { Effects } from "game/Effects"
import { VehicleFx } from "game/VehicleFx"
import { Pickups } from "game/Pickups"
import { TUNING } from "game/Tuning"
import { configure as configureTextures } from "game/Textures"
import { SkyEnv } from "game/EnvMap"
import { Blob } from "game/Shadows"
import { Assets } from "game/Assets"

async function main() {
  const config = await (await fetch("/api/world")).json()
  const homeSpawn = { ...config.spawn }      // the world spawn, kept as the fallback when a URL spawn is outside the border
  const hubs = config.hubs ?? []
  configureTextures({ version: config.assets_version })
  // ?spawn=x,z[,yaw] teleports to game coordinates (handy for exploring the countryside)
  let urlSpawn = false
  const spawnParam = new URLSearchParams(location.search).get("spawn")
  if (spawnParam) {
    const [x, z, yaw = 0] = spawnParam.split(",").map(Number)
    if (Number.isFinite(x) && Number.isFinite(z)) { config.spawn = { x, z, yaw }; urlSpawn = true }
  }
  const container = document.getElementById("game")
  const playerId = container.dataset.playerId
  const el = (id) => document.getElementById(id)

  const world   = new World(container)
  const effects = new Effects(world.scene)
  const index   = new Destructibles(effects)                // every object a player can flatten, in a grid
  const pickups = new Pickups()                             // boost pads, placed per tile from its roads
  const chunks  = new ChunkManager(world.scene, config, { onTile: (t) => { index.indexTile(t); pickups.addTile(t) }, onDrop: (t) => { index.dropTile(t); pickups.dropTile(t) } })
  index.heightAt = (x, z) => chunks.heightAt(x, z)
  world.setHeightAt((x, z) => chunks.heightAt(x, z))
  const input   = new Input()
  const assets  = new Assets()                               // glTF models for dragons, the mech and the townsfolk
  assets.warm(["mech", "dragon"])
  // the player: a car and a wizard mech, one of them active (T transforms); `car` is the same object, kept under the
  // old name because the camera, the HUD and the network only ever see the active body through it
  const player  = new Avatar({ spawn: config.spawn, spec: vehicleSpec(localStorage.getItem("voertuig") ?? "trike"), scene: world.scene, assets,
                               heightAt: (x, z) => chunks.heightAt(x, z), waterAt: (x, z) => chunks.waterLevelAt(x, z), onMode: (mode) => onMode(mode) })
  const car     = player
  let carFx     = new VehicleFx(player.car.mesh, effects.smoke)
  const combat  = new Combat({ scene: world.scene, index, effects, heightAt: (x, z) => chunks.heightAt(x, z), car: player, send: (action, data) => net.send(action, data) })
  const remotes = new RemoteCars(world.scene, effects.smoke, { heightAt: (x, z) => chunks.heightAt(x, z), assets })
  const dayNight = new DayNight(world)
  const skyEnv  = new SkyEnv(world, dayNight)               // the sky baked into an environment map for the materials
  const shadow  = new Blob(world.scene)                      // the contact shadow under the player
  const loading = new LoadingScreen(el("laden"))
  const burnEl = el("burn")
  const burn = (ms) => { burnEl.classList.add("on"); setTimeout(() => burnEl.classList.remove("on"), ms) }
  let placed = false          // car and camera snapped onto the terrain once the spawn tile is in
  let snapToRoad = urlSpawn   // after a teleport or a ?spawn= URL: move onto the nearest street once its tile is in
  const teleport = (x, z, yaw = car.yaw) => { car.reset({ x, z, yaw }); placed = false; snapToRoad = true; burn(400) }
  const voertuigEl = el("voertuig-naam"), hintEl = el("voertuig-hint")
  const applySpec = (spec) => {
    if (player.mode === "mech") player.setMode("car")
    player.setSpec(spec)
    carFx = new VehicleFx(player.car.mesh, effects.smoke)
    localStorage.setItem("voertuig", spec.id)
    voertuigEl.textContent = spec.naam; hintEl.textContent = spec.ability.hint
    placed = false
  }
  voertuigEl.textContent = car.spec.naam; hintEl.textContent = car.spec.ability.hint
  // the picker: any vehicle, any time; the server hears about it through `switch` so the others swap your mesh
  const picker = new Picker(el("kiezer"), { onPick: (spec) => { applySpec(spec); net.send("switch", { vehicle: spec.id }) } })
  // car ↔ mech: restyle the HUD (the boost bar is the mana bar), resize the shadow, tell the server
  const boostEl = el("boost")
  function onMode(mode) {
    const mech = mode === "mech"
    voertuigEl.textContent = player.spec.naam; hintEl.textContent = player.spec.ability.hint
    boostEl.classList.toggle("mana", mech)
    shadow.size(mech ? 2.2 : 1.2, mech ? 2.2 : 2.4)
    input.clearPressed()
    net.send("switch", { vehicle: mech ? "mech" : player.car.spec.id })
  }
  const spells = new Spells({ combat, effects, send: (a, d) => net.send(a, d), heightAt: (x, z) => chunks.heightAt(x, z),
    hud: { nope: () => { boostEl.classList.add("nope"); setTimeout(() => boostEl.classList.remove("nope"), 350); session.flash("Te weinig mana") } } })

  // the dragons: drawn from the server's `actors` messages; the spells aim at them and report hits
  let dragons = null
  // the session: who you are in the world, and what the server decides about you
  const session = new Session(playerId, { actie: el("actie"), banner: el("banner"), bannerTitel: el("banner-titel"), bannerSub: el("banner-sub"), flits: el("flits"), status: el("status") }, {
    onSync: (msg) => {
      // land at your last rest hub (unless the URL asked for a spot); the loading screen tells about the place meanwhile
      if (!urlSpawn && msg.you.spawn) { config.spawn = msg.you.spawn; teleport(msg.you.spawn.x, msg.you.spawn.z, msg.you.spawn.yaw) }
      const hub = hubs.find((h) => h.key === msg.you.spawn?.hub_key) ?? nearestHub(config.spawn.x, config.spawn.z, hubs)
      if (hub && !loading.shown) loading.showHub(hub)
      if (msg.you.vehicle === "mech") { if (player.mode !== "mech") player.setMode("mech") }
      else if (msg.you.vehicle && msg.you.vehicle !== player.car.spec.id && vehicleSpec(msg.you.vehicle).id === msg.you.vehicle) applySpec(vehicleSpec(msg.you.vehicle))
    },
    onObjects: (list) => index.applyAll(list),
    onTeleport: (msg) => teleport(msg.x, msg.z, msg.yaw),
    onSwitch: () => {},
    onDeath: (msg) => {
      if (msg.id === playerId) { burn(900); setTimeout(() => teleport(msg.respawn.x, msg.respawn.z, msg.respawn.yaw), 400) }
      else effects.explosion(msg.x, chunks.heightAt(msg.x, msg.z) + 1, msg.z, 5)
    },
    onBurn: (msg) => {
      if (msg.id !== playerId) return
      if (msg.shielded) { if (player.mode === "mech") player.mech.mana = Math.max(0, player.mech.mana - 0.06); return }
      burn(180); effects.shake(0.3)
      if (player.mode === "mech") { const f = player.forward(); player.kick(-f.x * 4, -f.z * 4) } else car.speed *= 0.7
    },
    onHeal: () => { chunks.reload(); index.resetState(); combat.reset() },
    onActors: (list, now) => dragons?.receive(list, now),
    onStrike: (msg) => dragons?.strike(msg),
  })
  const doelwitEl = el("doelwit"), doelwitNaam = el("doelwit-naam"), doelwitBar = el("doelwit-bar"), hitmarkEl = el("hitmark")
  dragons = new Dragons({ scene: world.scene, assets, effects, session, send: (a, d) => net.send(a, d), heightAt: (x, z) => chunks.heightAt(x, z),
    hud: { hit: () => { hitmarkEl.classList.remove("on"); void hitmarkEl.offsetWidth; hitmarkEl.classList.add("on") } } })
  spells.targets = (x, z, yaw) => dragons.nearest(x, z, yaw)
  spells.onStrike = (target, kind) => dragons.struck(target, kind)
  combat.onStrike = (target, kind) => dragons.struck(target, kind)
  window.slop = { world, dayNight, skyEnv, ortho: chunks.ortho, assets, player, spells, dragons, car, remotes, chunks, session, hubs, index, combat, effects, pickups, loading, picker, applySpec, tuning: TUNING }   // for poking at the scene from the console
  // ?name=Pietje sets the driver name other players see above your car (kept in localStorage)
  const nameParam = new URLSearchParams(location.search).get("name")
  if (nameParam) localStorage.setItem("driverName", nameParam.trim().slice(0, 16))
  const net = new Network({ room: "main", onMessage: (m) => {
    if (m.type === "move" || m.type === "join" || m.type === "leave") { if (m.id !== playerId) remotes.receive(m); return }
    if (m.type === "fire") {
      if (m.id === playerId) return
      const mesh = remotes.get(m.id)?.mesh
      if (m.kind === "fireball" || m.kind === "lightning") spells.remote(m, mesh); else combat.remoteFire(m, mesh)
      return
    }
    session.receive(m)
  } })
  const locator = new Locator(config.places)
  const overlay = { hubs, discovered: session.discovered, objective: null }
  const minimap = new Minimap(el("minimap"), config, {
    // a map click near a hub you have discovered asks the server for a teleport; the car moves when the answer comes back
    onTeleport: (x, z) => {
      const hub = nearestHub(x, z, hubs, Math.max(400, minimap.view.scale * 12))
      if (!hub) { session.flash("Klik op een plaats om erheen te reizen"); return false }
      if (!session.discovered.has(hub.key)) { session.flash(`${hub.name} heb je nog niet ontdekt`); return false }
      if (!session.canAct()) { session.flash(`Teleporteren kan weer over ${session.countdown()}`); return false }
      net.send("teleport", { hub_key: hub.key })
    }
  })

  const wall = config.border?.length ? new FlameWall(config.border) : null
  if (wall) world.scene.add(wall.mesh)
  let lastInside = null       // last position inside the border, to fall back to after burning

  const kmh = el("kmh"), playersEl = el("players"), clockEl = el("clock"), cooldownBar = el("cooldown-bar")
  const boostFill = el("boost-fill"), driftEl = el("drift"), pipsEl = el("drift-pips")
  let shownLevel = -1, shownDrift = null, lastKmh = -1, lastMeter = -1, lastBoostOn = null, lastCooldown = -1   // DOM writes only on change
  const onPickup = (p) => {
    car.addBoost(TUNING.boost.pickupFill, TUNING.boost.pickupBurst)
    effects.flash(p.x, p.y + 0.6, p.z, 1.6); effects.shake(0.04)
    boostEl.classList.add("pop"); setTimeout(() => boostEl.classList.remove("pop"), 200)
  }
  const signEl = el("sign"), streetEl = el("sign-street"), districtEl = el("sign-district"), placeEl = el("sign-place"), biomeEl = el("biome")
  const timer = new THREE.Timer()
  let netTimer = 0, signTimer = 0, borderTimer = 0
  const heightAt = (x, z) => chunks.heightAt(x, z), tileIndex = (x, z) => chunks.tileIndex(x, z)
  overlay.discovered = session.discovered

  function frame(now) {
    timer.update(now)
    const dt = Math.min(timer.getDelta(), 1 / 20)

    chunks.update(car.x, car.z)
    updateSignals()
    const darkness = dayNight.update()
    skyEnv.update(now)
    car.setNight(darkness); remotes.setNight(darkness); setNightLevel(darkness); setSignsNight(darkness)
    updateWater(dayNight.env, timer.getElapsed())
    if (input.toggleMap) minimap.toggle()
    if (input.pick) picker.show(car.spec.id, true)
    const digit = input.digit
    if (digit) picker.digit(digit)
    if (chunks.ready(car.x, car.z)) {
      if (input.reset) { car.reset(config.spawn); placed = false }
      if (!placed) {
        if (snapToRoad) {
          const p = nearestPointOnRoads(car.x, car.z, chunks.roadsAround(car.x, car.z))
          if (p) { car.x = p.x; car.z = p.z; car.yaw = p.yaw }
          snapToRoad = false
        }
        car.y = chunks.heightAt(car.x, car.z)
        car.mesh.position.y = car.y
        world.followCamera(car, 1e3)   // huge dt → camera jumps straight behind the car instead of rising out of the ground
        placed = true
      }
      player.integrate(dt, input)
      if (player.vy === null) combat.collide(player, dt)          // airborne bodies clear everything
      player.settle(heightAt)
      combat.abilities(player, input, dt)                         // the car's trick on E; a landing mech stomps
      spells.update(player, input, dt)                            // the mech's Q and F
      if (player.mode === "car") carFx.update(player.car, dt)
      pickups.collect(player, tileIndex, onPickup)
      if (player.mode === "mech" && player.mech.drowned) {        // too deep for too long: back to the hub
        player.mech.drowned = false; player.mech.drownT = 0
        session.showBanner("Verzopen", "de mech is gezonken", 1800); burn(700)
        player.reset(config.spawn); placed = false; snapToRoad = true
      }
    }
    pickups.update(dt)
    combat.projectiles(dt)
    // the edge of the world: cross the province border and you burn back to where you were
    if (wall) {
      wall.update(timer.getElapsed())
      borderTimer += dt
      if (borderTimer > 0.2) {
        borderTimer = 0
        if (wall.inside(car.x, car.z)) lastInside = { x: car.x, z: car.z, yaw: car.yaw }
        else {
          car.reset(lastInside ?? homeSpawn)
          car.yaw += Math.PI                                      // turn around
          placed = false
          burn(600)
        }
      }
    }
    world.followCamera(car, dt)
    if (placed) shadow.place(car.x, car.y, car.z, car.yaw, car.mesh.position.y - car.y, darkness)   // car.y is the driving surface; the mesh floats above it in the air
    effects.update(dt, world.camera)
    remotes.update(car, world.camera)
    dragons.update(car, world.camera, dt, darkness)
    if (loading.open && placed && chunks.readyFraction(car.x, car.z) >= 1) loading.hide()

    netTimer += dt
    if (netTimer > 0.1) { netTimer = 0; net.sendMove({ ...car.state(), vehicle: car.spec.id }); combat.flush() }

    signTimer += dt
    if (signTimer > 0.25) {
      signTimer = 0
      locator.update(car.x, car.z, chunks.roadsAround(car.x, car.z))
      streetEl.textContent = locator.street ?? ""
      districtEl.textContent = locator.district ?? ""
      signEl.hidden = !locator.street
      placeEl.textContent = locator.place ?? ""
      placeEl.hidden = !locator.place
      biomeEl.textContent = chunks.biomeAt(car.x, car.z) ?? ""
      clockEl.textContent = dayNight.clock()
      session.hud()
      if (loading.open) loading.progress(placed ? chunks.readyFraction(car.x, car.z) : 0)
      // the dragon in your sights (or the nearest awake one): name and hp
      const aimed = dragons.aimed(car)
      doelwitEl.hidden = !aimed
      if (aimed) { doelwitNaam.textContent = aimed.name; doelwitBar.style.transform = `scaleX(${Math.max(0, aimed.hp / aimed.max)})` }
    }
    minimap.update(car, remotes, overlay)

    const shownKmh = Math.round(Math.hypot(car.vx, car.vz) * 3.6)
    if (shownKmh !== lastKmh) { lastKmh = shownKmh; kmh.textContent = shownKmh }
    const cooldown = Math.round((1 - (player.mode === "mech" ? spells.cooldownFraction : combat.cooldownFraction)) * 100) / 100
    if (cooldown !== lastCooldown) { lastCooldown = cooldown; cooldownBar.style.transform = `scaleX(${cooldown})` }
    const meter = Math.round(car.boostMeter * 200) / 200
    if (meter !== lastMeter) { lastMeter = meter; boostFill.style.transform = `scaleX(${meter})` }
    const boostOn = car.boostPower > 0.3
    if (boostOn !== lastBoostOn) { lastBoostOn = boostOn; boostEl.classList.toggle("on", boostOn) }
    const driftShown = car.drifting && !car.driftMild
    if (driftShown !== shownDrift) { shownDrift = driftShown; driftEl.hidden = !driftShown }
    if (driftShown && car.chargeLevel !== shownLevel) {
      shownLevel = car.chargeLevel
      pipsEl.textContent = "●".repeat(shownLevel) + "○".repeat(3 - shownLevel)
      driftEl.classList.toggle("l3", shownLevel === 3)
    }
    playersEl.textContent = remotes.count ? `${remotes.count} andere ${remotes.count === 1 ? "chauffeur" : "chauffeurs"} online` : ""

    world.render()
    requestAnimationFrame(frame)
  }
  frame(performance.now())
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML("beforeend", `<pre style="color:#900;padding:1em">${e.message}</pre>`) })
