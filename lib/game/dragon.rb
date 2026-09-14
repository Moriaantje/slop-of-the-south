require "zlib"

module Game
  # One dragon, a pure state machine driven by `step(now, sessions)` with a fake-clock-friendly `now` in ms. It perches
  # on its lair, patrols a circle around it, hunts a player who comes within 800 m, spits fireballs at them from a
  # distance, closes in to breathe fire along a 60 × 16 m strip captured once at the start of each breath, hangs
  # exhausted for a moment afterwards, cools down, and after three breaths or a lost target flies home. Spells
  # `strike` it; at zero hp it is dead for three minutes and comes back on the perch. Heights are absolute: `ground`
  # gives the terrain under any (x, z) in game units.
  #
  # Everything a player has to read before it happens gets its own state, because an attack with no warning is not a
  # fight, it is weather. A volley is preceded by `aim` (it rears and tracks you), a breath by `tell` (it hangs and
  # the mouth lights up), and both are followed by `vulnerable`, a slow low drift where it cannot attack and you can.
  # Heavy damage inside a short window throws it into `stagger`, which cancels whatever it was winding up. Those
  # states cost nothing: they are the same flying code with different speeds and deadlines.
  #
  # A spat fireball is solved completely at the moment it leaves the mouth — launch velocity, impact point, impact
  # time — by aiming at where the player will be and then walking the parabola down onto the terrain. That is what
  # makes the shot honest over a network: one message carries the whole flight, every client draws the same arc from
  # the same numbers, and the burst lands on the same spot on every screen even when a tick goes missing. The lead is
  # deliberately short of perfect, so a player who holds a straight line is hit and a player who turns is not.
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
    AIM_SPEED, TELL_SPEED, VULN_SPEED, STAGGER_SPEED = 18.0, 11.0, 9.0, 6.0
    HUNT_ALT, COOL_ALT, VULN_ALT = 35.0, 70.0, 24.0   # metres above ground
    COOLDOWN_MS  = 6_000
    MAX_BREATHS  = 3
    STRIP_LEN    = 60.0
    STRIP_HALF_W = 8.0
    MOUTH        = 10.0                 # metres ahead of the body centre
    DEAD_MS      = 180_000
    TURN_RATE    = 0.9                  # rad/s
    CLIMB_RATE   = 14.0                 # m/s
    MAX_DT       = 0.5                  # seconds; a stalled thread never teleports a dragon

    # The spat fireballs. Only the flat solution of the ballistic equation is ever used: the steep one hangs in the
    # air for ten seconds, which nobody can read and nobody would bother dodging.
    GRAVITY         = 14.0              # m/s²: heavy enough to see the arc, light enough to carry 300 m
    MAX_FLIGHT      = 7.0               # s before a shot that found no ground bursts where it is
    TRACE_STEP      = 0.1               # s between ground samples while walking the arc down onto the terrain
    SHOT_MIN_R      = 60.0              # m: closer than this it breathes rather than spits
    OVERSHOOT_R     = 90.0              # m: twice its turning circle, inside which a bad line means a fresh pass
    FIRST_SPIT_MS   = 1_200             # a beat after the hunt starts before the first volley
    EYE_HEIGHT      = 1.5               # m above the ground: what a fireball is aimed at
    ENRAGED_HP      = 0.4               # below this share of its hp the volleys come half again as fast
    ENRAGED_CADENCE = 0.6

    # Being hit. STAGGER_DMG inside STAGGER_WINDOW_MS makes it flinch, and STAGGER_REST_MS after that it cannot be
    # made to flinch again, or two players with fireballs would hold it in a permanent stun. Any strike at all keeps
    # it in the fight for ENGAGE_MS past the three breaths it would otherwise go home after.
    STAGGER_DMG       = 110.0
    STAGGER_WINDOW_MS = 2_500
    STAGGER_MS        = 900
    STAGGER_REST_MS   = 4_000
    ENGAGE_MS         = 14_000

    # How a lair fights, so that meeting the castle dragon and meeting the Chemelot dragon are not the same evening.
    # speed is the muzzle speed of a spat fireball in m/s and range the distance it will take the shot at (both well
    # inside speed²/GRAVITY, the furthest a throw can carry); spread is the metres of scatter around the aim point and
    # lead the share of the target's own velocity it bothers to allow for; blast is the burst radius in metres and dmg
    # the hit a player takes dead centre of it; fire is how long the ground it lands on keeps burning, in ms.
    #
    # The castle dragon is the measure everything else is read against: two fast flat shots, a long breath. The ruins
    # dragon is a scavenger — it peppers you from close range with small sloppy shots and almost never leads properly.
    # The stadium dragon throws a wide fan of four, so there is no single thing to dodge, only a gap to find. The
    # Chemelot dragon is artillery: one enormous shell from four hundred metres, a long wind-up you can see from the
    # ground, a crater you must leave, and a fire that burns for ten seconds afterwards.
    PROFILES = {
      "castle"     => { shots: 2, speed: 76.0, spread: 3.5,  lead: 0.95, blast: 13.0, dmg: 26.0, windup: 900,   cadence: 2_800, range: 240.0, tell: 800,   breath: 3_000, vuln: 1_800, fire: 7_000 },
      "ruins"      => { shots: 3, speed: 62.0, spread: 8.0,  lead: 0.70, blast: 9.0,  dmg: 16.0, windup: 600,   cadence: 1_500, range: 190.0, tell: 500,   breath: 2_200, vuln: 2_400, fire: 5_000 },
      "stadium"    => { shots: 4, speed: 58.0, spread: 12.0, lead: 0.80, blast: 10.0, dmg: 14.0, windup: 800,   cadence: 2_300, range: 170.0, tell: 700,   breath: 2_600, vuln: 2_000, fire: 6_000 },
      "industrial" => { shots: 1, speed: 84.0, spread: 2.5,  lead: 1.00, blast: 20.0, dmg: 36.0, windup: 1_400, cadence: 3_400, range: 320.0, tell: 1_100, breath: 3_600, vuln: 1_400, fire: 11_000 }
    }.freeze
    DEFAULT_PROFILE = PROFILES.fetch("castle")

    NAMES = %w[Vuurtong Sjaromme Aske Grieze Bombelke Knoevel Draoker Plamuur Sjoelke Gloeiend Roetsjer Vlamke].freeze

    attr_reader :id, :lair, :name, :x, :y, :z, :yaw, :pitch, :speed, :hp, :state, :target, :until_at, :strip, :breaths,
                :damaged_by, :killed_by, :profile, :shots

    # towns: the Hub::Refs a patrolling dragon may raid (breathe over the centre once, then fly home)
    def initialize(id, lair, ground:, now: Game.now_ms, rng: Random.new(Zlib.crc32(lair.key)), towns: [])
      @id, @lair, @ground, @rng = id, lair, ground, rng
      @towns = towns.select { Math.hypot(_1.x - lair.x, _1.z - lair.z) <= RAID_R }
      @raid = nil
      @name = "#{NAMES[rng.rand(NAMES.size)]} van #{lair.name}"
      @profile = PROFILES.fetch(lair.kind, DEFAULT_PROFILE)
      @perch_h = PERCH_H.fetch(lair.kind, 18.0)
      @x, @z = lair.x.to_f, lair.z.to_f
      @y = ground_at(@x, @z) + @perch_h
      @yaw, @pitch, @speed = 0.0, 0.0, 0.0
      @hp = MAX_HP
      @damaged_by, @killed_by = [], nil
      @breaths = 0
      @target, @strip = nil, nil
      @shots, @shot_seq = [], 0                     # fireballs in the air, and the counter that names them
      @pending, @recent = [], []                    # events a strike made outside step, and the damage window
      @next_spit_at, @engaged_until, @last_stagger = 0, nil, nil
      @last = now
      perch!(now)
    end

    def alive? = @state != :dead
    def awake? = !%i[perch dead].include?(@state)
    def breathing? = @state == :breathe
    def enraged? = @hp < MAX_HP * ENRAGED_HP
    # the states in which it is busy with a player rather than with its own routine: what a test wants to assert
    def fighting? = %i[hunt aim tell breathe vulnerable cooldown stagger].include?(@state)

    # advances the dragon; returns events: [:breath_start, strip], [:breath_end], [:shot, shot], [:burst, shot]
    def step(now, sessions)
      dt = ((now - @last) / 1000.0).clamp(0.0, MAX_DT)
      @last = now
      events = @pending
      @pending = []
      events.concat(land_shots(now))
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
          d = dist(t)
          # Inside its own turning circle — HUNT_SPEED over TURN_RATE is about forty-five metres — a dragon that
          # keeps steering at the player only orbits them, never lines up, and never breathes again. So once it is
          # close and badly out of line it flies through, comes round wide, and takes a proper run at them.
          if d < OVERSHOOT_R && heading_error(px, pz).abs > 0.9
            fly_straight(HUNT_SPEED, dt, ground_at(@x, @z) + HUNT_ALT)
          else
            fly_towards(px, pz, ground_at(px, pz) + HUNT_ALT, HUNT_SPEED, dt)
          end
          if d < BREATH_R && heading_error(px, pz).abs < 0.3 then tell!(now, :hunt)
          elsif d >= SHOT_MIN_R && d <= @profile[:range] && now >= @next_spit_at && heading_error(t.x, t.z).abs < 0.55
            aim!(now)
          end
        end
      when :aim
        t = session(sessions, @target)
        if !t || dist(t) > LOSE_R then return!(now)
        else
          fly_towards(t.x, t.z, ground_at(t.x, t.z) + HUNT_ALT, AIM_SPEED, dt)      # it slows and stares: the tell
          if now >= @until_at
            events.concat(spit!(t, now))
            @next_spit_at = now + cadence
            if @aim_from == :cooldown
              @state = :cooldown                                    # back to shelling from the stand-off
              @until_at = [ @resume_at, now + 1_000 ].max
            else
              hunt!(t, now)
            end
          end
        end
      when :tell
        t = @tell_from == :hunt ? session(sessions, @target) : nil
        if @tell_from == :hunt && (t.nil? || dist(t) > LOSE_R) then return!(now)
        else
          fly_straight(TELL_SPEED, dt, @y)                                          # it hangs, and the mouth lights up
          if now >= @until_at
            breathe!(now)
            events << [ :breath_start, @strip ]
          end
        end
      when :breathe
        fly_straight(BREATH_SPEED, dt)
        if now >= @until_at
          events << [ :breath_end ]
          @strip = nil
          vulnerable!(now)
        end
      when :vulnerable
        fly_towards(@x - Math.sin(@yaw) * 60, @z - Math.cos(@yaw) * 60, ground_at(@x, @z) + VULN_ALT, VULN_SPEED, dt)
        cooldown!(now) if now >= @until_at
      when :stagger
        fly_straight(STAGGER_SPEED, dt, @y - 6)                                     # it drops and loses the line
        if now >= @until_at
          t = session(sessions, @target) || prey(sessions)
          if t && dist(t) < LOSE_R then hunt!(t, now) else return!(now) end
        end
      when :cooldown
        # The first half is the retreat — it pulls up and away, high and slow. The second half is the stand-off: it
        # turns back and shells you from a distance, which is the half of the fight the fireballs are for. Without it
        # a dragon only ever spits on the run-in and the whole engagement is breath, breath, breath.
        t = session(sessions, @target)
        if t && now >= @until_at - COOLDOWN_MS / 2
          fly_towards(t.x, t.z, ground_at(@x, @z) + COOL_ALT, COOL_SPEED, dt)
          d = dist(t)
          aim!(now, :cooldown) if now >= @next_spit_at && d >= SHOT_MIN_R && d <= @profile[:range] && heading_error(t.x, t.z).abs < 0.6
        else
          fly_towards(@x - Math.sin(@yaw) * 100, @z - Math.cos(@yaw) * 100, ground_at(@x, @z) + COOL_ALT, COOL_SPEED, dt)
        end
        if @state == :cooldown && now >= @until_at
          if t && dist(t) < HUNT_R && (@breaths < MAX_BREATHS || engaged?(now))
            @breaths = MAX_BREATHS - 1 if @breaths >= MAX_BREATHS    # still being shot at: one more pass, not a fresh three
            hunt!(t, now)
          else
            return!(now)
          end
        end
      when :return
        fly_towards(@lair.x, @lair.z, ground_at(@lair.x, @lair.z) + @perch_h, RETURN_SPEED, dt)
        perch!(now) if Math.hypot(@x - @lair.x, @z - @lair.z) < 15
      when :raid
        if (t = prey(sessions)) then hunt!(t, now)
        else
          tx, tz = @raid.x, @raid.z
          fly_towards(tx, tz, ground_at(tx, tz) + HUNT_ALT, HUNT_SPEED, dt)
          if Math.hypot(tx - @x, tz - @z) < BREATH_R && heading_error(tx, tz).abs < 0.3
            @breaths = MAX_BREATHS - 1                     # one breath over the town, then home
            tell!(now, :raid)
          elsif Math.hypot(tx - @x, tz - @z) < 30          # overshot without lining up: give up
            return!(now)
          end
        end
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

    # a spell landed: damage is capped per kind; returns { hp:, killed:, staggered: } or nil when the strike is invalid
    def strike(damage, by, kind, now)
      cap = STRIKE_CAP[kind] or return nil
      return nil unless alive?
      damage = [ damage.to_f, cap ].min
      return nil unless damage.positive?
      @hp = [ @hp - damage, 0.0 ].max
      @damaged_by << by unless @damaged_by.include?(by)
      @engaged_until = now + ENGAGE_MS
      if @hp <= 0
        die!(now)
        return { hp: @hp, killed: true, staggered: false }
      end
      @recent << [ now, damage ]
      @recent.reject! { |at, _| now - at > STAGGER_WINDOW_MS }
      staggered = @recent.sum { _1[1] } >= STAGGER_DMG && (@last_stagger.nil? || now - @last_stagger >= STAGGER_REST_MS)
      @pending.concat(stagger!(now)) if staggered
      { hp: @hp, killed: false, staggered: }
    end

    def snapshot
      { id: @id, kind: "dragon", name: @name, lair: @lair.key, flavour: @lair.kind, state: @state.to_s,
        x: @x.round(1), y: @y.round(1), z: @z.round(1), yaw: @yaw.round(3), pitch: @pitch.round(3), speed: @speed.round(1),
        hp: @hp.round, max: MAX_HP.round, target: @target, until: @until_at, breaths: @breaths, enraged: enraged?,
        raid: @state == :raid ? @raid&.key : nil }
    end

    # The fireballs still in the air, as the client needs them: where and when they left the mouth, how fast, and
    # where and when the server has already decided they will burst. Repeated every tick on purpose — a player who
    # joins or misses a message mid-flight still sees the shot, and drawing it twice is impossible because the id
    # does not change.
    def shot_snapshots
      @shots.map do |s|
        { id: s[:id], kind: "shot", owner: @id, flavour: s[:flavour],
          x: s[:x].round(1), y: s[:y].round(1), z: s[:z].round(1),
          vx: s[:vx].round(2), vy: s[:vy].round(2), vz: s[:vz].round(2), g: s[:g],
          t0: s[:t0], t1: s[:t1], ix: s[:ix].round(1), iy: s[:iy].round(1), iz: s[:iz].round(1), r: s[:r] }
      end
    end

    private

    def ground_at(x, z) = @ground.call(x, z).to_f

    def session(sessions, id) = sessions.find { _1.id == id && _1.x && _1.alive? }

    def dist(s) = Math.hypot(s.x - @x, s.z - @z)

    def engaged?(now) = @engaged_until && now < @engaged_until

    def prey(sessions)
      sessions.select { _1.x && _1.alive? && dist(_1) < HUNT_R }.min_by { dist(_1) }
    end

    # where the player will be in a second and a half: what the body steers towards while hunting
    def lead(s)
      yaw, speed = s.yaw.to_f, s.speed.to_f
      [ s.x - Math.sin(yaw) * speed * 1.5, s.z - Math.cos(yaw) * speed * 1.5 ]
    end

    def heading_error(tx, tz)
      want = Math.atan2(-(tx - @x), -(tz - @z))
      wrap(want - @yaw)
    end

    def mouth
      ux, uz = -Math.sin(@yaw), -Math.cos(@yaw)
      [ @x + ux * MOUTH, @y - 0.6, @z + uz * MOUTH ]
    end

    def cadence = (@profile[:cadence] * (enraged? ? ENRAGED_CADENCE : 1.0)).round

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

    # ---- the fireballs -------------------------------------------------------------------------------------------

    # A volley leaves the mouth. Every shot in it is aimed at the same led point with its own scatter and a little
    # muzzle-speed variation, so they land spread out in space and a beat apart in time rather than as one lump.
    def spit!(target, now)
      p = @profile
      mx, my, mz = mouth
      ax, _ay, az = aim_point(target, p)
      p[:shots].times.filter_map do
        tx = ax + (@rng.rand - 0.5) * 2 * p[:spread]
        tz = az + (@rng.rand - 0.5) * 2 * p[:spread]
        ty = ground_at(tx, tz) + EYE_HEIGHT
        speed = p[:speed] * (1.0 + (@rng.rand - 0.5) * 0.08)
        v = launch(mx, my, mz, tx, ty, tz, speed) or next nil
        [ :shot, add_shot(mx, my, mz, v, now) ]
      end
    end

    def add_shot(mx, my, mz, (vx, vy, vz), now)
      ix, iy, iz, flight = trace(mx, my, mz, vx, vy, vz)
      shot = { id: "#{@id}s#{@shot_seq += 1}", owner: @id, flavour: @lair.kind,
               x: mx, y: my, z: mz, vx:, vy:, vz:, g: GRAVITY, t0: now, t1: now + (flight * 1000).round,
               ix:, iy:, iz:, r: @profile[:blast], dmg: @profile[:dmg], fire: @profile[:fire] }
      @shots << shot
      shot
    end

    def land_shots(now)
      return [] if @shots.empty?
      done, @shots = @shots.partition { now >= _1[:t1] }
      done.map { [ :burst, _1 ] }
    end

    # Where to throw so a player who keeps doing what they are doing walks into it. Two passes: guess the flight time
    # from the straight distance, move the target along its own velocity by that much, guess again. The straight
    # distance under-estimates the true flight time (the horizontal speed is less than the muzzle speed) and `lead`
    # under 1 under-estimates it again on purpose — between them that is the whole dodge, because a shot aimed
    # perfectly at a perfectly predicted position cannot be avoided by anything but luck.
    def aim_point(s, profile)
      vx = -Math.sin(s.yaw.to_f) * s.speed.to_f
      vz = -Math.cos(s.yaw.to_f) * s.speed.to_f
      tx, tz = s.x.to_f, s.z.to_f
      ty = ground_at(tx, tz) + EYE_HEIGHT
      2.times do
        flight = Math.sqrt((tx - @x)**2 + (ty - @y)**2 + (tz - @z)**2) / profile[:speed]
        tx = s.x + vx * flight * profile[:lead]
        tz = s.z + vz * flight * profile[:lead]
        ty = ground_at(tx, tz) + EYE_HEIGHT
      end
      [ tx, ty, tz ]
    end

    # The flat solution of the ballistic equation: the launch velocity that drops a shot travelling at `speed` onto
    # (tx, ty, tz). Beyond the throw's reach there is no solution at all, and the angle that carries furthest is 45°,
    # so that is what it uses — the shot falls short, which is the truthful outcome of firing past your range.
    def launch(x, y, z, tx, ty, tz, speed)
      dx, dz = tx - x, tz - z
      d = Math.hypot(dx, dz)
      return nil if d < 1e-3
      h, v2 = ty - y, speed * speed
      disc = v2 * v2 - GRAVITY * (GRAVITY * d * d + 2 * h * v2)
      angle = disc.negative? ? Math::PI / 4 : Math.atan((v2 - Math.sqrt(disc)) / (GRAVITY * d))
      horizontal = speed * Math.cos(angle)
      [ dx / d * horizontal, speed * Math.sin(angle), dz / d * horizontal ]
    end

    # Walk the parabola forward in tenths of a second until it is under the terrain, then bisect the last step: the
    # impact point and the flight time in seconds. Buildings are not traced — the burst radius picks up whatever
    # stands where it lands, which is close enough for a house and far cheaper than a spatial query per shot.
    def trace(x, y, z, vx, vy, vz)
      t = 0.0
      while t < MAX_FLIGHT
        nt = t + TRACE_STEP
        px, py, pz = flight_at(x, y, z, vx, vy, vz, nt)
        if py <= ground_at(px, pz)
          lo, hi = t, nt
          6.times do
            mid = (lo + hi) / 2
            mx, my, mz = flight_at(x, y, z, vx, vy, vz, mid)
            my <= ground_at(mx, mz) ? hi = mid : lo = mid
          end
          fx, fy, fz = flight_at(x, y, z, vx, vy, vz, hi)
          return [ fx, [ fy, ground_at(fx, fz) ].max, fz, hi ]
        end
        t = nt
      end
      fx, fy, fz = flight_at(x, y, z, vx, vy, vz, MAX_FLIGHT)
      [ fx, fy, fz, MAX_FLIGHT ]
    end

    def flight_at(x, y, z, vx, vy, vz, t) = [ x + vx * t, y + vy * t - 0.5 * GRAVITY * t * t, z + vz * t ]

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
      @next_spit_at = now + FIRST_SPIT_MS if @state != :aim && @target != t.id
      @state = :hunt
      @target = t.id
      @until_at = nil
    end

    # from: which state to drop back into once the volley is away — the hunt, or the stand-off it is shelling from
    def aim!(now, from = :hunt)
      @aim_from = from
      @resume_at = @until_at
      @state = :aim
      @until_at = now + @profile[:windup]
    end

    def tell!(now, from)
      @state = :tell
      @tell_from = from
      @until_at = now + @profile[:tell]
    end

    def breathe!(now)
      @state = :breathe
      @breaths += 1
      @until_at = now + @profile[:breath]
      ux, uz = -Math.sin(@yaw), -Math.cos(@yaw)
      x0, z0 = @x + ux * MOUTH, @z + uz * MOUTH
      @strip = { x0: x0.round(1), z0: z0.round(1), x1: (x0 + ux * STRIP_LEN).round(1), z1: (z0 + uz * STRIP_LEN).round(1), ux:, uz:, half_w: STRIP_HALF_W }
    end

    def vulnerable!(now)
      @state = :vulnerable
      @until_at = now + @profile[:vuln]
    end

    # a flinch; returns the events the interruption produced, because a breath that is cut short still has to tell
    # the room to drop its strip
    def stagger!(now)
      events = @state == :breathe ? [ [ :breath_end ] ] : []
      @strip = nil
      @state = :stagger
      @until_at = now + STAGGER_MS
      @last_stagger = now
      @next_spit_at = now + STAGGER_MS + @profile[:windup]
      @recent.clear
      events
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
      @recent.clear
      @last_stagger, @engaged_until = nil, nil
      perch!(now)
    end
  end
end
