module Game
  # Owns the live world of one room and drives it from a thread that ticks four times a second: the players'
  # sessions (loaded from and saved to the players table), the destruction verdicts, the actors (dragons, plugged in
  # through the `actors:` slot) and the quests (`quests:` slot). State changes happen under @mutex; the messages they
  # produce are published after the lock is released, to the room stream or to one player's personal stream. The
  # first GameChannel subscription starts the thread, so it lives inside the Puma process, the only place the
  # development cable adapter reaches browsers from.
  class WorldManager
    TICK_S        = 0.25
    SAVE_MS       = 30_000              # write changed sessions this often
    HEAL_IDLE_MS  = 300_000             # an empty room heals its world after five minutes
    DISCOVER_R    = 150.0               # metres from a hub centre that count as having been there
    HUB_R         = 60.0                # inside a hub: fast regeneration, and the hub becomes your respawn
    HUB_REGEN     = 10.0                # hp per second inside a hub
    FIELD_REGEN   = 1.0                 # hp per second elsewhere, once unhurt for FIELD_REGEN_DELAY_MS
    FIELD_REGEN_DELAY_MS = 5_000
    DISCOVER_XP   = 15

    @managers = {}
    @lock = Mutex.new

    class << self
      def for(room) = @lock.synchronize { @managers[room] ||= new(room) }
      def reset!(room, **options) = @lock.synchronize { @managers[room]&.stop; @managers[room] = new(room, **options) }
      def shutdown = @lock.synchronize { @managers.each_value(&:stop); @managers.clear }
    end

    attr_reader :room, :sessions, :world, :actors, :quests

    def initialize(room, hubs: nil, store: nil, actors: nil, quests: nil, publish: nil, publish_to: nil, threaded: true)
      @room, @threaded = room, threaded
      @hubs_given = hubs
      @store = store || PlayerStore.new
      @actors, @quests = actors, quests
      @publish    = publish    || ->(payload)     { ActionCable.server.broadcast("game:#{room}", payload) }
      @publish_to = publish_to || ->(id, payload) { ActionCable.server.broadcast("game:#{room}:p:#{id}", payload) }
      @mutex, @sessions, @world, @dirty = Mutex.new, {}, Destructibles.new, {}
      @you_dirty = Set.new
      @empty_since = nil
      @last_save = Game.now_ms
    end

    # hub key → Hub::Ref, loaded once (the hubs table changes only when hubs:build runs)
    def hubs = @hubs ||= (@hubs_given || Hub.refs).to_h { [ _1.key, _1 ] }

    # returns the `sync` payload for the new subscriber; the same player in several tabs is counted once
    def join(player_id, name, now = Game.now_ms)
      attrs = @sessions.key?(player_id) ? nil : @store.load(player_id, name)     # the database call stays outside the lock
      @mutex.synchronize do
        ensure_thread
        s = @sessions[player_id] ||= Session.from_attrs(attrs || { id: player_id, name: })
        s.tabs += 1
        s.name = name
        s.changed = true
        @empty_since = nil
        { now:, you: you(s), players: @sessions.values.map { { id: _1.id, name: _1.name, vehicle: _1.vehicle } },
          objects: @world.damaged.map { @world.obj_h(_1) }, actors: @actors&.snapshot(now) || [], quests: @quests&.for_player(s) || [] }
      end
    end

    def leave(player_id, now = Game.now_ms)
      gone = @mutex.synchronize do
        s = @sessions[player_id] or next
        next if (s.tabs -= 1).positive?
        @sessions.delete(player_id)
        @empty_since = now if @sessions.empty?
        s
      end
      @store.save(gone) if gone
    end

    def moved(player_id, x, z, vehicle, yaw: nil, speed: nil, shield: false, now: Game.now_ms)
      @mutex.synchronize do
        s = @sessions[player_id] or return
        s.x, s.z, s.moved_at, s.shield = x, z, now, shield
        s.yaw = yaw if yaw
        s.speed = speed if speed
        if vehicle.present? && Game::VEHICLES.include?(vehicle) && s.vehicle != vehicle then s.vehicle = vehicle; s.changed = true end
      end
    end

    # hits: [[key, damage, max], ...]; the verdicts leave with the next tick's `object` message
    def hit(player_id, hits)
      @mutex.synchronize do
        return unless @sessions[player_id]
        hits.each { |key, damage, max| (obj = @world.hit(key, damage, max)) && @dirty[obj.key] = obj }
      end
    end

    # teleport to a hub you have discovered; one per minute
    def teleport(player_id, hub_key, now = Game.now_ms)
      act(player_id, now, "teleport") do |s|
        hub = hubs[hub_key] or next "unknown"
        next "undiscovered" unless s.discovered.include?(hub.key)
        s.last_hub_key = hub.key
        s.changed = true
        hub.spawn.merge(hub_key: hub.key)
      end
    end

    # any vehicle, any time: the roster and the mech are free
    def switch(player_id, vehicle, now = Game.now_ms)
      act(player_id, now, "switch", free: true) do |s|
        next "vehicle" unless Game::VEHICLES.include?(vehicle)
        s.vehicle = vehicle
        s.changed = true
        { vehicle: }
      end
    end

    # Dragon fire (or anything else that hurts): takes hp unless the player holds a shield, tells the room so every
    # screen shows it, and kills at zero. Call under the mutex from a tick, or on its own otherwise.
    def burn(session, damage, x, z, now, room_msgs, personal_msgs)
      shielded = session.shield
      unless shielded
        session.hp = [ session.hp - damage, 0 ].max
        session.hurt_at = now
        session.changed = true
        @you_dirty << session.id
      end
      room_msgs << { type: "burn", id: session.id, x: x.round(1), z: z.round(1), damage: shielded ? 0 : damage, shielded: }
      die(session, now, room_msgs, personal_msgs) unless session.alive?
    end

    def tick(now = Game.now_ms)
      room_msgs, personal_msgs, saves = [], [], []
      @mutex.synchronize do
        if @actors
          result = @actors.tick(now, @sessions.values) || {}
          room_msgs.concat(result[:messages] || [])
          (result[:burns] || []).each { |id, damage, x, z| (s = @sessions[id]) && burn(s, damage, x, z, now, room_msgs, personal_msgs) }
          (result[:hits] || []).each { |key, damage, max| (obj = @world.hit(key, damage, max)) && @dirty[obj.key] = obj }
          (result[:kills] || []).each { |lair_key, ids| @quests&.on_kill(lair_key, ids, now, @sessions, personal_msgs) }
        end
        @sessions.each_value { |s| regen(s, now); discover(s, now, personal_msgs) }
        @quests&.tick(now, @sessions, personal_msgs)
        @you_dirty.each { |id| (s = @sessions[id]) && personal_msgs << [ id, { type: "you" }.merge(status(s)) ] }
        @you_dirty.clear
        room_msgs << { type: "object", list: @dirty.values.map { @world.obj_h(_1) } } if @dirty.any?
        @dirty.clear
        if @sessions.empty? && @empty_since && now - @empty_since >= HEAL_IDLE_MS && @world.objects.any?
          @world.clear
          @empty_since = nil
          room_msgs << { type: "heal" }
        end
        if now - @last_save >= SAVE_MS
          @last_save = now
          saves = @sessions.values.select(&:changed).each { _1.changed = false }.map(&:dup)
        end
      end
      room_msgs.each { @publish.call(_1.merge(now:)) }
      personal_msgs.each { |id, payload| @publish_to.call(id, payload.merge(now:)) }
      saves.each { @store.save(_1) }
    end

    def stop = @thread&.kill

    def you(s)
      status(s).merge(id: s.id, name: s.name, vehicle: s.vehicle, max_hp: Session::MAX_HP, discovered: s.discovered.to_a,
                      spawn: respawn_for(s), next_action_at: s.next_action_at)
    end

    private

    def status(s) = { hp: s.hp.round(1), gold: s.gold, xp: s.xp, level: s.level }

    def respawn_for(s)
      hub = s.last_hub_key && hubs[s.last_hub_key]
      hub ? hub.spawn.merge(hub_key: hub.key) : Game::WORLD_SPAWN.merge(hub_key: nil)
    end

    def regen(s, now)
      return unless s.alive? && s.hp < Session::MAX_HP && s.x
      near = near_hub(s, HUB_R)
      rate = near ? HUB_REGEN : (s.hurt_at.nil? || now - s.hurt_at >= FIELD_REGEN_DELAY_MS ? FIELD_REGEN : 0)
      return if rate.zero?
      s.hp = [ s.hp + rate * TICK_S, Session::MAX_HP ].min
      s.changed = true
      @you_dirty << s.id
    end

    def discover(s, now, personal_msgs)
      return unless s.x
      if (hub = near_hub(s, HUB_R)) && s.last_hub_key != hub.key
        s.last_hub_key = hub.key
        s.changed = true
      end
      hub = near_hub(s, DISCOVER_R) or return
      return if s.discovered.include?(hub.key)
      s.discovered << hub.key
      s.xp += DISCOVER_XP
      s.changed = true
      @you_dirty << s.id
      personal_msgs << [ s.id, { type: "discover", hub: { key: hub.key, name: hub.name, role: hub.role }, xp: DISCOVER_XP } ]
      @quests&.on_discover(hub.key, s, now, personal_msgs)
    end

    def near_hub(s, r)
      best, best_d = nil, r * r
      hubs.each_value do |h|
        d = (h.x - s.x)**2 + (h.z - s.z)**2
        best, best_d = h, d if d < best_d
      end
      best
    end

    def die(s, now, room_msgs, personal_msgs)
      spawn = respawn_for(s)
      s.hp = Session::MAX_HP
      s.hurt_at = nil
      s.changed = true
      @you_dirty << s.id
      @quests&.on_death(s, now, personal_msgs)
      room_msgs << { type: "death", id: s.id, x: s.x&.round(1), z: s.z&.round(1), respawn: spawn }
    end

    def ensure_thread
      return unless @threaded
      @thread ||= Thread.new do
        loop do
          sleep TICK_S
          break if stale?
          Rails.application.executor.wrap { tick }
        rescue => e
          Rails.logger.error("[game #{@room}] #{e.class}: #{e.message}")
        end
      end
    end

    # a development reload replaces the class; the old one keeps its thread and must bow out
    def stale? = !::Game::WorldManager.equal?(self.class)

    # A verb with the shared cooldown. The block gets the session and returns a reason string to refuse or a hash of
    # fields to broadcast. Returns [ok, payload]: a success has been published already, a refusal goes back to the asker.
    def act(player_id, now, type, free: false)
      ok, payload = @mutex.synchronize do
        s = @sessions[player_id] or next [ false, { type:, ok: false, reason: "player" } ]
        reason = "cooldown" if !free && !s.action_allowed?(now)
        fields = reason ? nil : yield(s)
        reason = fields if fields.is_a?(String)
        if reason
          [ false, { type:, ok: false, reason:, next_action_at: s.next_action_at } ]
        else
          s.last_action_at = now unless free
          [ true, { type:, id: player_id, now:, next_action_at: s.next_action_at }.merge(fields) ]
        end
      end
      @publish.call(payload) if ok
      [ ok, payload ]
    end
  end
end
