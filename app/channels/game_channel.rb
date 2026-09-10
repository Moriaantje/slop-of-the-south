# One room = one stream. Clients send `move` ~10x/second; the server relays to everyone in the room.
class GameChannel < ApplicationCable::Channel
  MAX_RATE_HZ = 15

  def subscribed
    @room = params[:room].to_s.presence || "main"
    @name = params[:name].to_s.strip.first(16).presence || "Chauffeur"
    @last_move_at = 0.0
    stream_from stream_name
    broadcast(type: "join", name: @name)
  end

  def unsubscribed
    broadcast(type: "leave")
  end

  # data: { x, y, z, yaw, speed }
  def move(data)
    now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    return if now - @last_move_at < 1.0 / MAX_RATE_HZ
    @last_move_at = now

    broadcast(
      type: "move", name: @name,
      x: data["x"].to_f, y: data["y"].to_f, z: data["z"].to_f,
      yaw: data["yaw"].to_f, speed: data["speed"].to_f,
      t: (Time.now.to_f * 1000).to_i
    )
  end

  private

  def stream_name = "game:#{@room}"

  def broadcast(payload)
    ActionCable.server.broadcast(stream_name, payload.merge(id: player_id))
  end
end
