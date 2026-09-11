require "zlib"

module Game
  # One dragon, a pure state machine driven by `step(now, sessions)` with a fake-clock-friendly `now` in ms. It perches
  # on its lair, patrols a circle around it, hunts a player who comes within 600 m, breathes fire along a 40 × 12 m
  # strip in front of its mouth (captured once at the start of each breath), cools down, and after three breaths or
  # a lost target flies home. Spells `strike` it; at zero hp it is dead for three minutes and comes back on the
  # perch. Heights are absolute: `ground` gives the terrain under any (x, z) in game units.
  class Dragon
    MAX_HP       = 900.0
    STRIKE_CAP   = { "fireball" => 60.0, "lightning" => 45.0 }.freeze
    PERCH_H      = { "castle" => 22.0, "ruins" => 12.0, "stadium" => 30.0, "industrial" => 40.0 }.freeze
    PERCH_MS     = (30_000..90_000)     # a short rest between flights: they are meant to be seen
    PATROL_MS    = (120_000..300_000)
    HUNT_R       = 800.0
    LOSE_R       = 1_200.0
    RAID_R       = 2_500.0              # a town this close to the lair may get a visit
    RAID_CHANCE  = 0.5                  # per patrol
    BREATH_R     = 140.0                # this close and lined up: breathe
    PATROL_SPEED, HUNT_SPEED, BREATH_SPEED, RETURN_SPEED, COOL_SPEED = 28.0, 40.0, 16.0, 32.0, 24.0
    HUNT_ALT, COOL_ALT = 35.0, 70.0     # metres above ground
    BREATH_MS    = 3_000
    COOLDOWN_MS  = 6_000
    MAX_BREATHS  = 3
    STRIP_LEN    = 60.0
    STRIP_HALF_W = 8.0
    MOUTH        = 10.0                 # metres ahead of the body centre
    DEAD_MS      = 180_000
    TURN_RATE    = 0.9                  # rad/s
    CLIMB_RATE   = 14.0                 # m/s
    MAX_DT       = 0.5                  # seconds; a stalled thread never teleports a dragon
    NAMES = %w[Vuurtong Sjaromme Aske Grieze Bombelke Knoevel Draoker Plamuur Sjoelke Gloeiend Roetsjer Vlamke].freeze

    attr_reader :id, :lair, :name, :x, :y, :z, :yaw, :pitch, :speed, :hp, :state, :target, :until_at, :strip, :breaths, :damaged_by, :killed_by

    # towns: the Hub::Refs a patrolling dragon may raid (breathe over the centre once, then fly home)
    def initialize(id, lair, ground:, now: Game.now_ms, rng: Random.new(Zlib.crc32(lair.key)), towns: [])
      @id, @lair, @ground, @rng = id, lair, ground, rng
      @towns = towns.select { Math.hypot(_1.x - lair.x, _1.z - lair.z) <= RAID_R }
      @raid = nil
      @name = "#{NAMES[rng.rand(NAMES.size)]} van #{lair.name}"
      @perch_h = PERCH_H.fetch(lair.kind, 18.0)
      @x, @z = lair.x.to_f, lair.z.to_f
      @y = ground_at(@x, @z) + @perch_h
      @yaw, @pitch, @speed = 0.0, 0.0, 0.0
      @hp = MAX_HP
      @damaged_by, @killed_by = [], nil
      @breaths = 0
      @target, @strip = nil, nil
      @last = now
      perch!(now)
    end

    def alive? = @state != :dead
    def awake? = !%i[perch dead].include?(@state)
    def breathing? = @state == :breathe

    # advances the dragon; returns events: [:breath_start, strip], [:breath_end]
    def step(now, sessions)
      dt = ((now - @last) / 1000.0).clamp(0.0, MAX_DT)
      @last = now
      events = []
      case @state
      when :perch
        if (t = prey(sessions)) then hunt!(t, now)
        elsif now >= @until_at then patrol!(now)
        end
      when :patrol
        if (t = prey(sessions)) then hunt!(t, now)
        elsif @raid && now >= @raid_at then raid!(now)
        elsif now >= @until_at then return!(now)
        else
          @angle += @dir * (PATROL_SPEED / @radius) * dt
          tx, tz = @lair.x + Math.cos(@angle) * @radius, @lair.z + Math.sin(@angle) * @radius
          fly_towards(tx, tz, ground_at(tx, tz) + @alt, PATROL_SPEED, dt)
        end
      when :hunt
        t = session(sessions, @target)
        if !t || dist(t) > LOSE_R then return!(now)
        else
          px, pz = lead(t)
          fly_towards(px, pz, ground_at(px, pz) + HUNT_ALT, HUNT_SPEED, dt)
          if dist(t) < BREATH_R && heading_error(px, pz).abs < 0.3
            breathe!(now)
            events << [ :breath_start, @strip ]
          end
        end
      when :raid
        if (t = prey(sessions)) then hunt!(t, now)
        else
          tx, tz = @raid.x, @raid.z
          fly_towards(tx, tz, ground_at(tx, tz) + HUNT_ALT, HUNT_SPEED, dt)
          if Math.hypot(tx - @x, tz - @z) < BREATH_R && heading_error(tx, tz).abs < 0.3
            @breaths = MAX_BREATHS - 1                     # one breath over the town, then home
            breathe!(now)
            events << [ :breath_start, @strip ]
          elsif Math.hypot(tx - @x, tz - @z) < 30          # overshot without lining up: give up
            return!(now)
          end
        end
      when :breathe
        fly_straight(BREATH_SPEED, dt)
        if now >= @until_at
          events << [ :breath_end ]
          @strip = nil
          cooldown!(now)
        end
      when :cooldown
        fly_towards(@x - Math.sin(@yaw) * 100, @z - Math.cos(@yaw) * 100, ground_at(@x, @z) + COOL_ALT, COOL_SPEED, dt)
        if now >= @until_at
          t = session(sessions, @target)
          if @breaths < MAX_BREATHS && t && dist(t) < HUNT_R then hunt!(t, now) else return!(now) end
        end
      when :return
        fly_towards(@lair.x, @lair.z, ground_at(@lair.x, @lair.z) + @perch_h, RETURN_SPEED, dt)
        perch!(now) if Math.hypot(@x - @lair.x, @z - @lair.z) < 15
      when :dead
        respawn!(now) if now >= @until_at
      end
      events
    end

    # is (px, pz) on the ground under the current breath?
    def scorches?(px, pz)
      return false unless breathing? && @strip
      s = @strip
      dx, dz = px - s[:x0], pz - s[:z0]
      along = dx * s[:ux] + dz * s[:uz]
      perp = (dx * s[:uz] - dz * s[:ux]).abs
      along.between?(-4.0, STRIP_LEN) && perp <= STRIP_HALF_W
    end

    # a spell landed: damage is capped per kind; returns { hp:, killed: } or nil when the strike is invalid
    def strike(damage, by, kind, now)
      cap = STRIKE_CAP[kind] or return nil
      return nil unless alive?
      damage = [ damage.to_f, cap ].min
      return nil unless damage.positive?
      @hp = [ @hp - damage, 0.0 ].max
      @damaged_by << by unless @damaged_by.include?(by)
      killed = @hp <= 0
      die!(now) if killed
      { hp: @hp, killed: }
    end

    def snapshot
      { id: @id, kind: "dragon", name: @name, lair: @lair.key, state: @state.to_s, x: @x.round(1), y: @y.round(1), z: @z.round(1),
        yaw: @yaw.round(3), pitch: @pitch.round(3), speed: @speed.round(1), hp: @hp.round, max: MAX_HP.round, target: @target, until: @until_at,
        raid: @state == :raid ? @raid&.key : nil }
    end

    private

    def ground_at(x, z) = @ground.call(x, z).to_f

    def session(sessions, id) = sessions.find { _1.id == id && _1.x && _1.alive? }

    def dist(s) = Math.hypot(s.x - @x, s.z - @z)

    def prey(sessions)
      sessions.select { _1.x && _1.alive? && dist(_1) < HUNT_R }.min_by { dist(_1) }
    end

    # where the player will be in a second and a half
    def lead(s)
      yaw, speed = s.yaw.to_f, s.speed.to_f
      [ s.x - Math.sin(yaw) * speed * 1.5, s.z - Math.cos(yaw) * speed * 1.5 ]
    end

    def heading_error(tx, tz)
      want = Math.atan2(-(tx - @x), -(tz - @z))
      wrap(want - @yaw)
    end

    def fly_towards(tx, tz, ty, speed, dt)
      err = heading_error(tx, tz)
      @yaw = wrap(@yaw + err.clamp(-TURN_RATE * dt, TURN_RATE * dt))
      fly_straight(speed, dt, ty)
    end

    def fly_straight(speed, dt, ty = nil)
      @speed = speed
      @x -= Math.sin(@yaw) * speed * dt
      @z -= Math.cos(@yaw) * speed * dt
      if ty
        dy = (ty - @y).clamp(-CLIMB_RATE * dt, CLIMB_RATE * dt)
        @y += dy
        @pitch = dt.positive? ? Math.atan2(dy / dt, speed) : 0.0
      else
        @pitch = 0.0
      end
    end

    def wrap(a) = Math.atan2(Math.sin(a), Math.cos(a))

    # ---- transitions ---------------------------------------------------------------------------------------------

    def perch!(now)
      @state = :perch
      @x, @z = @lair.x.to_f, @lair.z.to_f
      @y = ground_at(@x, @z) + @perch_h
      @speed, @pitch = 0.0, 0.0
      @breaths = 0
      @target = nil
      @until_at = now + @rng.rand(PERCH_MS)
    end

    def patrol!(now)
      @state = :patrol
      @radius = 600.0 + @rng.rand * 900.0
      @alt = 80.0 + @rng.rand * 70.0
      @dir = @rng.rand < 0.5 ? -1.0 : 1.0
      @angle = Math.atan2(@z - @lair.z, @x - @lair.x)
      @until_at = now + @rng.rand(PATROL_MS)
      # maybe a raid on a town partway through the patrol
      @raid = @towns.any? && @rng.rand < RAID_CHANCE ? @towns[@rng.rand(@towns.size)] : nil
      @raid_at = now + (@until_at - now) / 2
    end

    def raid!(now)
      @state = :raid
      @target = nil
      @until_at = nil
    end

    def hunt!(t, now)
      @state = :hunt
      @target = t.id
      @until_at = nil
    end

    def breathe!(now)
      @state = :breathe
      @breaths += 1
      @until_at = now + BREATH_MS
      ux, uz = -Math.sin(@yaw), -Math.cos(@yaw)
      x0, z0 = @x + ux * MOUTH, @z + uz * MOUTH
      @strip = { x0: x0.round(1), z0: z0.round(1), x1: (x0 + ux * STRIP_LEN).round(1), z1: (z0 + uz * STRIP_LEN).round(1), ux:, uz:, half_w: STRIP_HALF_W }
    end

    def cooldown!(now)
      @state = :cooldown
      @until_at = now + COOLDOWN_MS
    end

    def return!(now)
      @state = :return
      @target = nil
      @raid = nil
      @until_at = nil
    end

    def die!(now)
      @state = :dead
      @killed_by = @damaged_by.dup
      @strip = nil
      @speed = 0.0
      @until_at = now + DEAD_MS
    end

    def respawn!(now)
      @hp = MAX_HP
      @damaged_by, @killed_by = [], nil
      perch!(now)
    end
  end
end
