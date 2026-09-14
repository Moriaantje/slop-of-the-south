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
    FIELD_REGEN_DELAY_MS = 5_000        # the regeneration rates themselves are per player now: Game::Progression
    DISCOVER_XP   = 15

    @managers = {}
    @lock = Mutex.new

    class << self
      def for(room) = @lock.synchronize { @managers[room] ||= new(room) }
      def reset!(room, **options) = @lock.synchronize { @managers[room]&.stop; @managers[room] = new(room, **options) }
      def shutdown = @lock.synchronize { @managers.each_value(&:stop); @managers.clear }
    end

    attr_reader :room, :sessions, :world

    # actors: :default builds the dragons from the lair hubs, quests: :default the quest board; pass nil for none
    def initialize(room, hubs: nil, store: nil, actors: :default, quests: :default, publish: nil, publish_to: nil, threaded: true)
      @room, @threaded = room, threaded
      @hubs_given = hubs
      @store = store || PlayerStore.new
      @actors_arg, @quests_arg = actors, quests
      @publish    = publish    || ->(payload)     { ActionCable.server.broadcast("game:#{room}", payload) }
      @publish_to = publish_to || ->(id, payload) { ActionCable.server.broadcast("game:#{room}:p:#{id}", payload) }
      @mutex, @sessions, @world, @dirty = Mutex.new, {}, Destructibles.new, {}
      @you_dirty = Set.new
      @empty_since = nil
      @last_save = Game.now_ms
    end

    # hub key → Hub::Ref, loaded once (the hubs table changes only when hubs:build runs)
    def hubs = @hubs ||= (@hubs_given || Hub.refs).to_h { [ _1.key, _1 ] }

    def actors
      return @actors if defined?(@actors)
      @actors = @actors_arg == :default ? Actors::Dragons.new(hubs) : @actors_arg
    end

    def quests
      return @quests if defined?(@quests)
      @quests = @quests_arg == :default ? Quests::Board.new(hubs) : @quests_arg
      @quests.on_change = ->(s) { @you_dirty << s.id } if @quests.respond_to?(:on_change=)
      # the people at a lair talk about what lives there; the board duck-types on name / awake? / alive?
      @quests.dragons = ->(lair_key) { actors.respond_to?(:dragons) ? actors.dragons.find { _1.lair.key == lair_key } : nil } if @quests.respond_to?(:dragons=)
      @quests
    end

    # A skill point spent. Progression owns every rule here — the level you need, the prerequisites, whether you can
    # afford it — and answers with the whole block, so the client never has to work out what it now has.
    def skill(player_id, key, now = Game.now_ms)
      msg = @mutex.synchronize do
        s = @sessions[player_id] or next({ type: "skill", ok: false, reason: "player" })
        Progression.unlock(s, key.to_s)
      end
      @publish_to.call(player_id, msg.merge(now:))
      msg
    end

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
          objects: @world.damaged.map { @world.obj_h(_1) }, actors: actors&.snapshot(now) || [], quests: quests&.for_player(s) || [] }
      end
    end

    def leave(player_id, now = Game.now_ms)
      gone = @mutex.synchronize do
        s = @sessions[player_id] or next
        next if (s.tabs -= 1).positive?
        @sessions.delete(player_id)
        quests&.forget(player_id)
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
        hits.each { |key, damage, max| (obj = @world.hit(key, damage, max, Game.now_ms)) && @dirty[obj.key] = obj }
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

    # a spell hit a dragon: the actors validate (alive, kind, damage cap, within 300 m) and the room hears the new hp
    def strike(player_id, dragon_id, damage, kind, now = Game.now_ms)
      result = @mutex.synchronize do
        s = @sessions[player_id] or next "player"
        actors.respond_to?(:strike) ? actors.strike(s, dragon_id, damage, kind, now) : "actors"
      end
      return [ false, { type: "strike", ok: false, reason: result } ] if result.is_a?(String)
      @publish.call(result.merge(now:))
      [ true, result ]
    end

    # talk / accept / abandon / heal at a hub: the board answers on the player's personal stream
    def quest(player_id, action, now = Game.now_ms, **args)
      msgs = @mutex.synchronize do
        s = @sessions[player_id] or next [ { type: "quest", ok: false, reason: "player" } ]
        quests ? quests.handle(action, s, now, **args) : [ { type: "quest", ok: false, reason: "quests" } ]
      end
      msgs.each { @publish_to.call(player_id, _1.merge(now:)) }
      msgs
    end

    # Dragon fire (or anything else that hurts): takes hp unless the player holds a shield, tells the room so every
    # screen shows it, and kills at zero. Call under the mutex from a tick, or on its own otherwise.
    # A shield used to be all or nothing. It now blocks the share the player's own stats say it blocks, and a
    # reflecting shield sends part of what it stopped back at whatever is nearest — which is the only way an ability
    # that costs a skill point can be felt in the one situation it is for.
    def burn(session, damage, x, z, now, room_msgs, personal_msgs)
      st = session.stats
      blocked = session.shield ? damage * st[:shield_block] : 0.0
      taken = damage - blocked
      if taken.positive?
        session.hp = [ session.hp - taken, 0 ].max
        session.hurt_at = now
        session.changed = true
        @you_dirty << session.id
      end
      room_msgs << { type: "burn", id: session.id, x: x.round(1), z: z.round(1), damage: taken.round(1), shielded: session.shield }
      quests.on_hurt(session, taken, now, personal_msgs) if quests.respond_to?(:on_hurt)   # a fragile load does not survive a scorching
      if blocked.positive? && st[:shield_reflect].positive? && actors.respond_to?(:strike) && session.x
        back = (blocked * st[:shield_reflect]).round(1)
        near = actors.snapshot(now).min_by { Math.hypot(_1[:x] - session.x, _1[:z] - session.z) }
        hit = near && actors.strike(session, near[:id], back, Progression::REFLECT_KIND, now)
        room_msgs << hit.merge(reflect: true) if hit.is_a?(Hash)
      end
      die(session, now, room_msgs, personal_msgs) unless session.alive?
    end

    def tick(now = Game.now_ms)
      room_msgs, personal_msgs, saves = [], [], []
      @mutex.synchronize do
        if actors
          result = actors.tick(now, @sessions.values) || {}
          room_msgs.concat(result[:messages] || [])
          (result[:burns] || []).each { |id, damage, x, z| (s = @sessions[id]) && burn(s, damage, x, z, now, room_msgs, personal_msgs) }
          (result[:hits] || []).each { |key, damage, max| (obj = @world.hit(key, damage, max, now)) && @dirty[obj.key] = obj }
          (result[:kills] || []).each { |lair_key, ids| quests&.on_kill(lair_key, ids, now, @sessions, personal_msgs) }
        end
        @world.rebuild(now).each { @dirty[_1.key] = _1 }                  # what nobody hit for a while stands again
        @sessions.each_value { |s| regen(s, now); discover(s, now, personal_msgs); (up = s.level_up) && personal_msgs << [ s.id, up ] }
        quests&.tick(now, @sessions, personal_msgs)
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
      status(s).merge(s.progress).merge(id: s.id, name: s.name, vehicle: s.vehicle, discovered: s.discovered.to_a, skills: Progression.catalogue,
                      spawn: respawn_for(s), next_action_at: s.next_action_at)
    end

    private

    # rides every tick, so it carries only what changes: s.brief is level, max_hp and the points still to spend
    def status(s) = { hp: s.hp.round(1), gold: s.gold, xp: s.xp }.merge(s.brief)

    def respawn_for(s)
      hub = s.last_hub_key && hubs[s.last_hub_key]
      hub ? hub.spawn.merge(hub_key: hub.key) : Game::WORLD_SPAWN.merge(hub_key: nil)
    end

    def regen(s, now)
      return unless s.alive? && s.hp < s.max_hp && s.x
      near = near_hub(s, HUB_R)
      rate = near ? s.stats[:hub_regen] : (s.hurt_at.nil? || now - s.hurt_at >= FIELD_REGEN_DELAY_MS ? s.stats[:field_regen] : 0)
      return if rate.zero?
      s.hp = [ s.hp + rate * TICK_S, s.max_hp ].min
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
      quests&.on_discover(hub.key, s, now, personal_msgs)
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
      s.hp = s.max_hp
      s.hurt_at = nil
      s.changed = true
      @you_dirty << s.id
      quests&.on_death(s, now, personal_msgs)
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
