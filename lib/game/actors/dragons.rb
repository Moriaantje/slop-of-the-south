module Game
  module Actors
    # The dragons of a room, one per lair hub, plugged into WorldManager's actors slot. `tick` steps them and turns
    # what they did into the four things that slot understands: burns (hp off a player), hits (damage on a
    # destructible), kills (for the quests) and messages (what the room is told). It publishes an `actors` message
    # every tick while any dragon is awake or any ground is still burning, and a heartbeat every two seconds
    # otherwise. `strike` validates a player's spell hit.
    #
    # The `actors` list is deliberately more than a list of dragons: a fireball in the air and a patch of burning
    # ground are actors too, and putting them in the same message is what lets the whole fight reach the client
    # without a new message type on a channel this file is not allowed to touch. Each entry carries a stable id, so a
    # client can tell a thing it already knows from a thing that is new however many times it is sent the same list.
    #
    # The expensive part of a burst is asking the database what stands where it landed, so that question is asked
    # once, at the moment of impact, and the answer is what the fire it leaves behind keeps chewing on for its whole
    # life. A patch that burns for eleven seconds is forty-four ticks of damage off one query.
    class Dragons
      HEARTBEAT_MS  = 2_000
      BURN_PER_TICK = 6.0            # hp per 4 Hz tick on the strip: 72 for a full breath
      HIT_SHARE     = 1.0 / 8        # of an object's hp per tick: gone after two seconds under the flame
      BLAST_SHARE   = 0.45           # of an object's hp, all at once, when a fireball bursts on it
      FIRE_PER_TICK = 1.5            # hp a player standing in a burning patch loses per tick: 6 a second, so move
      FIRE_SHARE    = 1.0 / 40       # of an object's hp per tick in the fire: ten seconds of it takes anything down
      MAX_FIRES     = 24             # burning patches at once, room-wide; the oldest is trodden out first
      STRIKE_RANGE  = 400.0
      MAX           = 12

      attr_reader :dragons, :fires

      def initialize(hubs, ground: nil, corridor: Corridor, now: Game.now_ms)
        ground ||= ->(x, z) { rx, ry = World.to_rd(x, z); ::Geo::HeightGrid.current.sample(rx, ry) }
        lairs = hubs.values.select { _1.role == "lair" }.sort_by(&:key).first(MAX)
        towns = hubs.values.select { _1.role == "town" }
        @dragons = lairs.each_with_index.map { |lair, i| Dragon.new("d#{i + 1}", lair, ground:, now:, towns:) }
        @corridor = corridor
        @strips = {}                 # dragon id → [[key, max], ...] under the current breath
        @fires = []                  # { id, x, z, r, until, objects } left by the fireballs that have landed
        @kills = []                  # [[lair_key, [player ids]], ...] since the last tick
        @last_publish = 0
      end

      def snapshot(_now = nil)
        @dragons.map(&:snapshot) + @dragons.flat_map(&:shot_snapshots) + @fires.map { fire_snapshot(_1) }
      end

      def find(id) = @dragons.find { _1.id == id }

      def tick(now, sessions)
        burns, hits, messages = [], [], []
        @dragons.each do |d|
          d.step(now, sessions).each do |event, arg|
            case event
            when :breath_start then @strips[d.id] = safe_objects(arg)
            when :breath_end   then @strips.delete(d.id)
            when :burst        then burst(arg, now, sessions, burns, hits)
            end
          end
          next unless d.breathing?
          sessions.each { |s| burns << [ s.id, BURN_PER_TICK, s.x, s.z ] if s.x && s.alive? && d.scorches?(s.x, s.z) }
          (@strips[d.id] || []).each { |key, max| hits << [ key, max * HIT_SHARE, max ] }
        end
        smoulder(now, sessions, burns, hits)
        kills = @kills.dup
        @kills.clear
        if @dragons.any?(&:awake?) || @fires.any? || now - @last_publish >= HEARTBEAT_MS
          @last_publish = now
          messages << { type: "actors", list: snapshot(now) }
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
        { type: "strike", dragon_id: d.id, hp: d.hp.round, by: session.id, kind:, killed: r[:killed],
          staggered: r[:staggered], state: d.state.to_s }
      end

      private

      # A spat fireball reached the ground. Players inside the blast lose hp falling off to two fifths at the rim,
      # everything standing there takes a bite out of its hit points, and unless the profile says otherwise the
      # ground keeps burning over the same set of objects.
      def burst(shot, now, sessions, burns, hits)
        r, ix, iz = shot[:r].to_f, shot[:ix], shot[:iz]
        sessions.each do |s|
          next unless s.x && s.alive?
          d = Math.hypot(s.x - ix, s.z - iz)
          burns << [ s.id, (shot[:dmg] * (1.0 - 0.6 * d / r)).round(1), ix, iz ] if d <= r
        end
        objects = safe_blast(ix, iz, r)
        objects.each { |key, max| hits << [ key, (max * BLAST_SHARE).round(1), max ] }
        return unless shot[:fire].to_i.positive?
        @fires.shift while @fires.size >= MAX_FIRES
        @fires << { id: shot[:id], flavour: shot[:flavour], x: ix.round(1), z: iz.round(1), r: (r * 0.7).round(1),
                    until: now + shot[:fire], objects: }
      end

      # the patches still alight: they keep hurting whoever stands in them and keep eating what they caught
      def smoulder(now, sessions, burns, hits)
        @fires.reject! { now >= _1[:until] }
        @fires.each do |f|
          sessions.each do |s|
            next unless s.x && s.alive?
            burns << [ s.id, FIRE_PER_TICK, s.x, s.z ] if Math.hypot(s.x - f[:x], s.z - f[:z]) <= f[:r]
          end
          f[:objects].each { |key, max| hits << [ key, (max * FIRE_SHARE).round(1), max ] }
        end
      end

      def fire_snapshot(f) = { id: f[:id], kind: "fire", flavour: f[:flavour], x: f[:x], z: f[:z], r: f[:r], until: f[:until] }

      def safe_objects(strip)
        @corridor.objects(strip[:x0], strip[:z0], strip[:x1], strip[:z1], strip[:half_w])
      rescue => e
        Rails.logger.error("[dragons] corridor: #{e.class}: #{e.message}") if defined?(Rails)
        []
      end

      def safe_blast(x, z, r)
        @corridor.blast(x, z, r)
      rescue => e
        Rails.logger.error("[dragons] blast: #{e.class}: #{e.message}") if defined?(Rails)
        []
      end
    end
  end
end
