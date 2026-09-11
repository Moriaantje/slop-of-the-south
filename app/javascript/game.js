import * as THREE from "three"
import { World } from "game/World"
import { ChunkManager } from "game/ChunkManager"
import { updateSignals } from "game/Furniture"
import { Vehicle } from "game/Vehicle"
import { Input } from "game/Input"
import { Network } from "game/Network"
import { RemoteCars } from "game/RemoteCars"
import { Locator, nearestPointOnRoads } from "game/Locator"
import { Minimap } from "game/Minimap"
import { FlameWall } from "game/FlameWall"

async function main() {
  const config = await (await fetch("/api/world")).json()
  const homeSpawn = { ...config.spawn }      // the world spawn, kept as the fallback when a URL spawn is outside the border
  // ?spawn=x,z[,yaw] teleports to game coordinates (handy for exploring the countryside)
  let urlSpawn = false
  const spawnParam = new URLSearchParams(location.search).get("spawn")
  if (spawnParam) {
    const [x, z, yaw = 0] = spawnParam.split(",").map(Number)
    if (Number.isFinite(x) && Number.isFinite(z)) { config.spawn = { x, z, yaw }; urlSpawn = true }
  }
  const container = document.getElementById("game")
  const playerId = container.dataset.playerId

  const world   = new World(container)
  const chunks  = new ChunkManager(world.scene, config)
  const input   = new Input()
  const car     = new Vehicle(config.spawn)
  const remotes = new RemoteCars(world.scene)
  const net     = new Network({ room: "main", playerId, onMessage: (m) => remotes.receive(m) })
  const locator = new Locator(config.places)
  const minimap = new Minimap(document.getElementById("minimap"), config, {
    onTeleport: (x, z) => { car.reset({ x, z, yaw: car.yaw }); placed = false; snapToRoad = true }
  })

  world.scene.add(car.mesh)
  const wall = config.border?.length ? new FlameWall(config.border) : null
  if (wall) world.scene.add(wall.mesh)
  const burnEl = document.getElementById("burn")
  let lastInside = null       // last position inside the border, to fall back to after burning

  const kmh = document.getElementById("kmh")
  const playersEl = document.getElementById("players")
  const signEl = document.getElementById("sign"), streetEl = document.getElementById("sign-street")
  const districtEl = document.getElementById("sign-district"), placeEl = document.getElementById("sign-place")
  const biomeEl = document.getElementById("biome")
  const timer = new THREE.Timer()
  let netTimer = 0, signTimer = 0, borderTimer = 0
  let placed = false          // car and camera snapped onto the terrain once the spawn tile is in
  let snapToRoad = urlSpawn   // after a map teleport or a ?spawn= URL: move onto the nearest street once its tile is in

  function frame(now) {
    timer.update(now)
    const dt = Math.min(timer.getDelta(), 1 / 20)

    chunks.update(car.x, car.z)
    updateSignals()
    if (input.toggleMap) minimap.toggle()
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
      car.update(dt, input, (x, z) => chunks.heightAt(x, z))
    }
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
          burnEl.classList.add("on"); setTimeout(() => burnEl.classList.remove("on"), 600)
        }
      }
    }
    world.followCamera(car, dt)
    remotes.update()

    netTimer += dt
    if (netTimer > 0.1) { netTimer = 0; net.sendMove(car.state()) }

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
    }
    minimap.update(car, remotes)
    
    kmh.textContent = Math.round(Math.abs(car.speed) * 3.6)
    playersEl.textContent = remotes.count ? `${remotes.count} andere ${remotes.count === 1 ? "chauffeur" : "chauffeurs"} online` : ""

    world.render()
    requestAnimationFrame(frame)
  }
  frame(performance.now())
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML("beforeend", `<pre style="color:#900;padding:1em">${e.message}</pre>`) })
