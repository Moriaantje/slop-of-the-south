import { createConsumer } from "@rails/actioncable"

// Thin wrapper around the GameChannel subscription.
export class Network {
  constructor({ room, playerId, onMessage }) {
    this.playerId = playerId
    this.consumer = createConsumer()
    const name = localStorage.getItem("driverName") || `Chauffeur ${Math.floor(Math.random() * 900 + 100)}`
    this.ready = false
    this.sub = this.consumer.subscriptions.create({ channel: "GameChannel", room, name }, {
      connected: () => { this.ready = true },
      disconnected: () => { this.ready = false },
      received: (msg) => { if (msg.id !== playerId) onMessage(msg) },
    })
  }

  // Only send once the subscription is confirmed; earlier performs are dropped server-side with a warning.
  sendMove(state) { if (this.ready) this.sub.perform("move", state) }
}
