# One room = one stream, plus a personal stream per player for what only they should hear (their hp, gold, quests).
# Clients send `move` ~10x/second, which the server relays; `hit` reports damage, `fire` shows a trick to the
# others, `strike` reports a spell hit on a dragon, `quest` talks to the people at a hub, `teleport` jumps to a
# discovered hub, `skill` spends a skill point, `switch` picks a vehicle. The room's Game::WorldManager owns the
# world; a new subscriber gets the whole state in a `sync`.
class GameChannel < ApplicationCable::Channel
  RATES = { "move" => 15, "hit" => 20, "fire" => 10, "strike" => 10, "teleport" => 2, "switch" => 2, "quest" => 8, "skill" => 4 }.freeze   # messages per second
  MAX_HITS = 32

  def subscribed
    @room = params[:room].to_s.presence || "main"
    @name = params[:name].to_s.strip.first(16).presence || "Chauffeur"
    @last = Hash.new(0.0)
    stream_from stream_name
    stream_from "#{stream_name}:p:#{player_id}"
    transmit manager.join(player_id, @name).merge(type: "sync")
    broadcast(type: "join", name: @name)
  end

  def unsubscribed
    manager.leave(player_id)
    broadcast(type: "leave")
  end

  # data: { x, y, z, yaw, speed, brake, drift, boost, vehicle, shield, air } — drift/boost drive the smoke and flames
  # on other screens, shield/air the mech's bubble and jump
  def move(data)
    return unless allowed?("move")
    vehicle = data["vehicle"].to_s.first(16)
    manager.moved(player_id, data["x"].to_f, data["z"].to_f, vehicle, yaw: data["yaw"].to_f, speed: data["speed"].to_f, shield: data["shield"] == true)
    broadcast(
      type: "move", name: @name, vehicle:,
      x: data["x"].to_f, y: data["y"].to_f, z: data["z"].to_f,
      yaw: data["yaw"].to_f, speed: data["speed"].to_f, brake: data["brake"] == true,
      drift: data["drift"] == true, boost: data["boost"] == true, shield: data["shield"] == true, air: data["air"] == true,
      t: Game.now_ms
    )
  end

  # data: { hits: [{ key, damage, max }, ...] }; the verdicts come back in the manager's `object` messages
  def hit(data)
    return unless allowed?("hit")
    hits = Array(data["hits"]).first(MAX_HITS).filter_map do |h|
      key, damage, max = h["key"].to_s, h["damage"].to_f, h["max"].to_f
      [ key, damage, max ] if key.match?(Game::KEY_RE) && damage.positive? && max.positive?
    end
    manager.hit(player_id, hits) if hits.any?
  end

  # data: { kind, x, y, z, yaw, pitch, target }: a shot the other players draw, nothing more
  def fire(data)
    return unless allowed?("fire")
    target = data["target"].to_s.first(16)
    broadcast(type: "fire", name: @name, kind: data["kind"].to_s.first(16),
              x: data["x"].to_f, y: data["y"].to_f, z: data["z"].to_f, yaw: data["yaw"].to_f, pitch: data["pitch"].to_f,
              target: target.presence, t: Game.now_ms)
  end

  # data: { dragon_id, damage, kind }: a spell hit a dragon; the manager validates and broadcasts the dragon's hp
  def strike(data)
    return unless allowed?("strike")
    answer manager.strike(player_id, data["dragon_id"].to_s.first(8), data["damage"].to_f, data["kind"].to_s.first(16))
  end

  # data: { verb: talk | accept | abandon | heal, hub_key, npc_id, key }; the answers come on the personal stream
  # (Action Cable puts the method name in data["action"] on both ends, hence "verb")
  def quest(data)
    return unless allowed?("quest")
    manager.quest(player_id, data["verb"].to_s.first(12), hub_key: data["hub_key"].to_s.first(24).presence,
                  npc_id: data["npc_id"].to_s.first(32).presence, key: data["key"].to_s.first(80).presence)
  end

  # data: { key }: spend a skill point on one of Game::Progression's keys; the answer comes on the personal stream
  def skill(data)
    return unless allowed?("skill")
    manager.skill(player_id, data["key"].to_s.first(32))
  end

  # data: { hub_key }: to a hub you have discovered
  def teleport(data)
    return unless allowed?("teleport")
    answer manager.teleport(player_id, data["hub_key"].to_s.first(24))
  end

  # data: { vehicle }
  def switch(data)
    return unless allowed?("switch")
    answer manager.switch(player_id, data["vehicle"].to_s.first(16))
  end

  private

  def manager = Game::WorldManager.for(@room)
  def stream_name = "game:#{@room}"

  def allowed?(action)
    now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    return false if now - @last[action] < 1.0 / RATES[action]
    @last[action] = now
  end

  # the manager has broadcast a success itself; a refusal only goes back to the asker
  def answer((ok, payload))
    transmit(payload) unless ok
  end

  def broadcast(payload)
    ActionCable.server.broadcast(stream_name, payload.merge(id: player_id))
  end
end
