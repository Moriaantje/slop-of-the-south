import * as THREE from "three"
import { World } from "game/World"
import { ChunkManager } from "game/ChunkManager"
import { Vehicle } from "game/Vehicle"
import { Input } from "game/Input"
import { Network } from "game/Network"
import { RemoteCars } from "game/RemoteCars"

async function main() {
  const config = await (await fetch("/api/world")).json()
  const container = document.getElementById("game")
  const playerId = container.dataset.playerId

  const world   = new World(container)
  const chunks  = new ChunkManager(world.scene, config)
  const input   = new Input()
  const car     = new Vehicle(config.spawn)
  const remotes = new RemoteCars(world.scene)
  const net     = new Network({ room: "main", playerId, onMessage: (m) => remotes.receive(m) })

  world.scene.add(car.mesh)

  const kmh = document.getElementById("kmh")
  const playersEl = document.getElementById("players")
  const timer = new THREE.Timer()
  let netTimer = 0

  function frame(now) {
    timer.update(now)
    const dt = Math.min(timer.getDelta(), 1 / 20)

    chunks.update(car.x, car.z)
    if (chunks.ready(car.x, car.z)) {
      if (input.reset) car.reset(config.spawn)
      car.update(dt, input, (x, z) => chunks.heightAt(x, z))
    }
    world.followCamera(car, dt)
    remotes.update()

    netTimer += dt
    if (netTimer > 0.1) { netTimer = 0; net.sendMove(car.state()) }

    kmh.textContent = Math.round(Math.abs(car.speed) * 3.6)
    playersEl.textContent = remotes.count ? `${remotes.count} andere ${remotes.count === 1 ? "chauffeur" : "chauffeurs"} online` : ""

    world.render()
    requestAnimationFrame(frame)
  }
  frame(performance.now())
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML("beforeend", `<pre style="color:#900;padding:1em">${e.message}</pre>`) })
