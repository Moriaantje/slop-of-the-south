module Game
  module Actors
    # The dragons of a room, one per lair hub, plugged into WorldManager's actors slot. `tick` steps them and turns
    # their breath into burns (players on the strip), hits (the destructibles under it, a share of their hp per
    # tick) and kills (for the quests); it publishes an `actors` message every tick while any dragon is awake and a
    # heartbeat every two seconds otherwise. `strike` validates a player's spell hit.
    class Dragons
      HEARTBEAT_MS  = 2_000
      BURN_PER_TICK = 6.0            # hp per 4 Hz tick on the strip: 72 for a full breath
      HIT_SHARE     = 1.0 / 8        # of an object's hp per tick: gone after two seconds under the flame
      STRIKE_RANGE  = 400.0
      MAX           = 12

      attr_reader :dragons

      def initialize(hubs, ground: nil, corridor: Corridor, now: Game.now_ms)
        ground ||= ->(x, z) { rx, ry = World.to_rd(x, z); ::Geo::HeightGrid.current.sample(rx, ry) }
        lairs = hubs.values.select { _1.role == "lair" }.sort_by(&:key).first(MAX)
        towns = hubs.values.select { _1.role == "town" }
        @dragons = lairs.each_with_index.map { |lair, i| Dragon.new("d#{i + 1}", lair, ground:, now:, towns:) }
        @corridor = corridor
        @strips = {}                 # dragon id → [[key, max], ...] under the current breath
        @kills = []                  # [[lair_key, [player ids]], ...] since the last tick
        @last_publish = 0
      end

      def snapshot(_now = nil) = @dragons.map(&:snapshot)
      def find(id) = @dragons.find { _1.id == id }

      def tick(now, sessions)
        burns, hits, messages = [], [], []
        @dragons.each do |d|
          d.step(now, sessions).each do |event, arg|
            case event
            when :breath_start then @strips[d.id] = safe_objects(arg)
            when :breath_end   then @strips.delete(d.id)
            end
          end
          next unless d.breathing?
          sessions.each { |s| burns << [ s.id, BURN_PER_TICK, s.x, s.z ] if s.x && s.alive? && d.scorches?(s.x, s.z) }
          (@strips[d.id] || []).each { |key, max| hits << [ key, max * HIT_SHARE, max ] }
        end
        kills = @kills.dup
        @kills.clear
        if @dragons.any?(&:awake?) || now - @last_publish >= HEARTBEAT_MS
          @last_publish = now
          messages << { type: "actors", list: snapshot }
        end
        { messages:, burns:, hits:, kills: }
      end

      # a player's spell hit a dragon: returns the `strike` message to broadcast, or a reason string to refuse
      def strike(session, dragon_id, damage, kind, now)
        d = find(dragon_id) or return "dragon"
        return "dead" unless d.alive?
        return "range" unless session.x && Math.hypot(d.x - session.x, d.z - session.z) <= STRIKE_RANGE
        r = d.strike(damage, session.id, kind, now) or return "kind"
        @kills << [ d.lair.key, d.killed_by ] if r[:killed]
        { type: "strike", dragon_id: d.id, hp: d.hp.round, by: session.id, kind:, killed: r[:killed] }
      end

      private

      def safe_objects(strip)
        @corridor.objects(strip[:x0], strip[:z0], strip[:x1], strip[:z1], strip[:half_w])
      rescue => e
        Rails.logger.error("[dragons] corridor: #{e.class}: #{e.message}") if defined?(Rails)
        []
      end
    end
  end
end
