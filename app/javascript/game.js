import * as THREE from "three"
import { World } from "game/World"
import { ChunkManager } from "game/ChunkManager"
import { Vehicle } from "game/Vehicle"
import { Input } from "game/Input"
import { Network } from "game/Network"
import { RemoteCars } from "game/RemoteCars"
import { Locator } from "game/Locator"

async function main() {
  const config = await (await fetch("/api/world")).json()
  // ?spawn=x,z[,yaw] teleports to game coordinates (handy for exploring the countryside)
  const spawnParam = new URLSearchParams(location.search).get("spawn")
  if (spawnParam) {
    const [x, z, yaw = 0] = spawnParam.split(",").map(Number)
    if (Number.isFinite(x) && Number.isFinite(z)) config.spawn = { x, z, yaw }
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

  world.scene.add(car.mesh)

  const kmh = document.getElementById("kmh")
  const playersEl = document.getElementById("players")
  const signEl = document.getElementById("sign"), streetEl = document.getElementById("sign-street")
  const districtEl = document.getElementById("sign-district"), placeEl = document.getElementById("sign-place")
  const biomeEl = document.getElementById("biome")
  const timer = new THREE.Timer()
  let netTimer = 0, signTimer = 0
  let placed = false          // car and camera snapped onto the terrain once the spawn tile is in

  function frame(now) {
    timer.update(now)
    const dt = Math.min(timer.getDelta(), 1 / 20)

    chunks.update(car.x, car.z)
    if (chunks.ready(car.x, car.z)) {
      if (input.reset) { car.reset(config.spawn); placed = false }
      if (!placed) {
        car.y = chunks.heightAt(car.x, car.z)
        car.mesh.position.y = car.y
        world.followCamera(car, 1e3)   // huge dt → camera jumps straight behind the car instead of rising out of the ground
        placed = true
      }
      car.update(dt, input, (x, z) => chunks.heightAt(x, z))
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
    
    kmh.textContent = Math.round(Math.abs(car.speed) * 3.6)
    playersEl.textContent = remotes.count ? `${remotes.count} andere ${remotes.count === 1 ? "chauffeur" : "chauffeurs"} online` : ""

    world.render()
    requestAnimationFrame(frame)
  }
  frame(performance.now())
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML("beforeend", `<pre style="color:#900;padding:1em">${e.message}</pre>`) })
