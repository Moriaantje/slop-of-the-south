require "test_helper"

module Game
  class DragonTest < ActiveSupport::TestCase
    T = 1_700_000_000_000
    LAIR = FakeWorld::HUBS.find { _1.role == "lair" }
    FLAT = ->(_x, _z) { 50.0 }

    def dragon(now = T) = Dragon.new("d1", LAIR, ground: FLAT, now:, rng: Random.new(7))

    def player(id, x, z, hp: 100, yaw: 0.0, speed: 0.0)
      Session.from_attrs(id:, name: id).tap { _1.x = x; _1.z = z; _1.hp = hp; _1.yaw = yaw; _1.speed = speed }
    end

    # run the dragon at 4 Hz for `seconds`, collecting events; the block may change the sessions along the way
    def advance(d, sessions, seconds, from: T)
      events = []
      (seconds * 4).times { |i| events.concat(d.step(from + (i + 1) * 250, sessions)) }
      events
    end

    # put the dragon in the sky at a known spot and heading, so a shot can be checked against arithmetic
    def hover(d, x: 0.0, y: 85.0, z: 0.0, yaw: 0.0)
      d.instance_variable_set(:@x, x); d.instance_variable_set(:@y, y); d.instance_variable_set(:@z, z)
      d.instance_variable_set(:@yaw, yaw)
      d
    end

    test "starts perched on the lair at its perch height and wakes up to patrol" do
      d = dragon
      assert_equal :perch, d.state
      assert_in_delta LAIR.x, d.x, 0.01
      assert_in_delta 50.0 + Dragon::PERCH_H["castle"], d.y, 0.01
      assert_equal "dragon", d.snapshot[:kind]
      t = T
      until d.state == :patrol || t > T + 100_000 do t += 250; d.step(t, []) end
      assert_equal :patrol, d.state
      assert d.awake?
      4.times { t += 250; d.step(t, []) }
      assert_operator Math.hypot(d.x - LAIR.x, d.z - LAIR.z), :>, 0
    end

    test "hunts a player within 600 m, breathes when close and lined up, and the strip is captured once" do
      d = dragon
      prey = player("p1", LAIR.x, LAIR.z - 400)                # 400 m north of the lair
      events = advance(d, [ prey ], 30)
      starts = events.select { _1[0] == :breath_start }
      assert_operator starts.size, :>=, 1, "expected at least one breath"
      strip = starts.first[1]
      assert_in_delta Dragon::STRIP_LEN, Math.hypot(strip[:x1] - strip[:x0], strip[:z1] - strip[:z0]), 0.2
      assert_equal Dragon::STRIP_HALF_W, strip[:half_w]
      # the strip is a ground rectangle from the mouth forward
      mid_x, mid_z = (strip[:x0] + strip[:x1]) / 2, (strip[:z0] + strip[:z1]) / 2
      d2 = dragon
      d2.instance_variable_set(:@state, :breathe); d2.instance_variable_set(:@strip, strip)
      assert d2.scorches?(mid_x, mid_z)
      assert d2.scorches?(mid_x + strip[:uz] * 5, mid_z - strip[:ux] * 5)
      refute d2.scorches?(mid_x + strip[:uz] * (Dragon::STRIP_HALF_W + 2), mid_z - strip[:ux] * (Dragon::STRIP_HALF_W + 2))
      refute d2.scorches?(strip[:x1] + strip[:ux] * 10, strip[:z1] + strip[:uz] * 10)
    end

    test "flies home after three breaths or a lost target" do
      d = dragon
      prey = player("p1", LAIR.x, LAIR.z - 300)
      breaths, t = 0, T
      until d.state == :return || t > T + 400_000
        t += 250
        breaths += d.step(t, [ prey ]).count { _1[0] == :breath_start }
      end
      assert_equal :return, d.state, "after three breaths the dragon goes home"
      assert_equal Dragon::MAX_BREATHS, breaths
      d = dragon
      advance(d, [ prey ], 3)
      assert d.fighting?, "three seconds in it is busy with the player, whatever part of the attack it is on"
      prey.x = LAIR.x + 5000                                    # gone far away
      advance(d, [ prey ], 1)
      assert_equal :return, d.state
      t = T
      until d.state == :perch || t > T + 60_000 do t += 250; d.step(t, []) end
      assert_equal :perch, d.state, "home within a minute"
    end

    test "strikes are capped per kind, refused for unknown kinds, and kill at zero hp; the dead come back" do
      d = dragon
      assert_nil d.strike(50, "p1", "sneeze", T)
      r = d.strike(999, "p1", "fireball", T)
      assert_equal Dragon::MAX_HP - 60, r[:hp]
      refute r[:killed]
      14.times { |i| d.strike(60, "p2", "fireball", T + i) }
      assert_equal 0, d.hp
      refute d.alive?
      assert_equal %w[p1 p2], d.killed_by
      assert_nil d.strike(10, "p1", "fireball", T)
      advance(d, [], 181)
      assert_equal :perch, d.state
      assert_equal Dragon::MAX_HP, d.hp
    end

    test "a long stall never teleports the dragon" do
      d = dragon
      d.step(T + 240_001, [])                                   # wake
      d.step(T + 240_002, [])
      x0, z0 = d.x, d.z
      d.step(T + 240_002 + 60_000, [])                          # a minute later in one step
      assert_operator Math.hypot(d.x - x0, d.z - z0), :<=, Dragon::PATROL_SPEED * Dragon::MAX_DT + 0.01
    end

    # ---- the fireballs it spits ----------------------------------------------------------------------------------

    test "a spat fireball is solved all the way to the ground: it lands on a standing target" do
      d = hover(dragon)
      prey = player("p1", 0.0, -200.0)                          # 200 m north, on the flat
      shots = d.send(:spit!, prey, T).map { _1[1] }
      assert_equal Dragon::PROFILES["castle"][:shots], shots.size
      shot = shots.first
      assert_in_delta 50.0, shot[:iy], 0.6, "it bursts on the terrain, not above or below it"
      miss = Math.hypot(shot[:ix] - prey.x, shot[:iz] - prey.z)
      assert_operator miss, :<, Dragon::PROFILES["castle"][:spread] + 4, "within the profile's scatter of the target"
      flight = (shot[:t1] - shot[:t0]) / 1000.0
      assert_operator flight, :>, 1.5, "long enough to see coming"
      assert_operator flight, :<, 4.0
      # the published arc really passes through the published impact: x, y, z at t1 from the launch numbers
      t = flight
      assert_in_delta shot[:ix], shot[:x] + shot[:vx] * t, 0.5
      assert_in_delta shot[:iz], shot[:z] + shot[:vz] * t, 0.5
      assert_in_delta shot[:iy], shot[:y] + shot[:vy] * t - 0.5 * shot[:g] * t * t, 0.5
    end

    test "it leads a moving target, and a target that changes its mind is missed" do
      # driving due east at 30 m/s: yaw -π/2 is east, since vx = -sin(yaw) · speed
      running = player("p1", 0.0, -200.0, yaw: -Math::PI / 2, speed: 30.0)
      lead_shot = hover(dragon).send(:spit!, running, T).map { _1[1] }.first
      assert_operator lead_shot[:ix], :>, 40, "the shot is thrown well ahead of where the player stands"
      standing = player("p1", 0.0, -200.0)
      still_shot = hover(dragon).send(:spit!, standing, T).map { _1[1] }.first
      assert_operator still_shot[:ix].abs, :<, 8, "a standing target is thrown at, not ahead of"
      # the dodge: the same shot, and a player who brakes instead of holding the line
      flight = (lead_shot[:t1] - lead_shot[:t0]) / 1000.0
      stopped_at = [ 0.0, -200.0 ]                                     # they stopped the moment it was thrown
      assert_operator Math.hypot(lead_shot[:ix] - stopped_at[0], lead_shot[:iz] - stopped_at[1]), :>,
                      Dragon::PROFILES["castle"][:blast], "braking takes you clear of the blast"
      assert_operator flight, :>, 1.0, "and there is time to brake"
    end

    test "a volley leaves only at the end of a wind-up, and bursts when the server said it would" do
      d = dragon
      prey = player("p1", LAIR.x, LAIR.z - 300)
      shots, bursts, saw_aim = [], [], false
      t = T
      200.times do
        t += 250
        before = d.state
        d.step(t, [ prey ]).each do |event, arg|
          shots << [ before, arg ] if event == :shot
          bursts << [ t, arg ] if event == :burst
        end
        saw_aim ||= d.state == :aim
      end
      assert saw_aim, "the player gets a wind-up to read"
      assert_operator shots.size, :>=, 2, "expected several fireballs in fifty seconds"
      assert_equal [ :aim ], shots.map(&:first).uniq, "every shot leaves at the end of a wind-up"
      assert_operator bursts.size, :>=, 1
      at, shot = bursts.first
      assert_operator at - shot[:t1], :<, 250, "it bursts on the first tick at or after its impact time"
      assert_operator shot[:t1], :>, shot[:t0]
      assert_operator shot[:dmg], :>, 0
      assert_operator shot[:r], :>, 0
    end

    test "a fireball in the air is republished every tick and disappears once it has burst" do
      d = hover(dragon)
      prey = player("p1", 0.0, -200.0)
      shot = d.send(:spit!, prey, T).map { _1[1] }.first
      ids = d.shot_snapshots.map { _1[:id] }
      assert_includes ids, shot[:id]
      assert_equal ids, d.shot_snapshots.map { _1[:id] }, "the same ids come back, so the client can ignore them"
      assert_equal "shot", d.shot_snapshots.first[:kind]
      d.step(shot[:t1] + 1, [ prey ])
      refute_includes d.shot_snapshots.map { _1[:id] }, shot[:id]
    end

    # ---- reading the fight ---------------------------------------------------------------------------------------

    test "a breath is announced by a tell and followed by a moment of weakness" do
      d = dragon
      prey = player("p1", LAIR.x, LAIR.z - 300)
      before_breath, after_breath = nil, nil
      t = T
      400.times do
        t += 250
        before = d.state
        d.step(t, [ prey ]).each do |event, _arg|
          before_breath ||= before if event == :breath_start
          after_breath ||= d.state if event == :breath_end
        end
        break if before_breath && after_breath
      end
      assert_equal :tell, before_breath, "it hangs and lights up before it breathes"
      assert_equal :vulnerable, after_breath, "and is slow and low straight afterwards"
    end

    test "heavy damage staggers it, cuts a breath short, and it cannot be held in a stun" do
      d = dragon
      prey = player("p1", LAIR.x, LAIR.z - 300)
      t = T
      until d.breathing? || t > T + 200_000
        t += 250
        d.step(t, [ prey ])
      end
      assert d.breathing?, "expected to catch it mid-breath"
      refute d.strike(60, "p1", "fireball", t)[:staggered], "one spell is not enough"
      assert d.strike(60, "p1", "fireball", t + 100)[:staggered], "two inside the window is"
      events = d.step(t + 200, [ prey ])
      assert_includes events.map(&:first), :breath_end, "the interrupted breath tells the room to drop its strip"
      assert_equal :stagger, d.state
      refute d.breathing?
      assert_nil d.strip
      d.strike(60, "p1", "fireball", t + 300)
      refute d.strike(60, "p1", "fireball", t + 400)[:staggered], "no second flinch inside the rest window"
    end

    test "a dragon that is being shot at stays in the fight past its three breaths" do
      d = dragon
      prey = player("p1", LAIR.x, LAIR.z - 300)
      breaths, t = 0, T
      until t > T + 200_000
        t += 250
        breaths += d.step(t, [ prey ]).count { _1[0] == :breath_start }
        d.strike(20, "p1", "fireball", t) if d.alive? && (t / 250) % 8 == 0 && d.hp > 300
        break if breaths > Dragon::MAX_BREATHS
      end
      assert_operator breaths, :>, Dragon::MAX_BREATHS, "it does not fly home while it is being hurt"
    end

    test "each lair fights its own way, and every profile can actually throw as far as it shoots" do
      p = Dragon::PROFILES
      assert_operator p["industrial"][:blast], :>, p["ruins"][:blast] * 2, "the Chemelot dragon throws artillery"
      assert_operator p["ruins"][:cadence], :<, p["industrial"][:cadence], "the scavenger peppers, the artillery waits"
      assert_operator p["stadium"][:shots], :>, p["castle"][:shots], "the stadium dragon fans them out"
      assert_operator p["stadium"][:spread], :>, p["castle"][:spread]
      p.each do |kind, spec|
        reach = spec[:speed]**2 / Dragon::GRAVITY                    # the furthest a throw carries, from level ground
        assert_operator reach, :>, spec[:range], "#{kind} shoots further than it can throw"
      end
      # and it shows in what actually leaves the mouth
      counts = p.keys.to_h do |kind|
        lair = Hub::Ref.new(key: "o:w9", name: "Test", role: "lair", kind:, x: 0.0, z: 0.0, spawn: {}, npcs: [])
        d = hover(Dragon.new("d1", lair, ground: FLAT, now: T, rng: Random.new(3)))
        [ kind, d.send(:spit!, player("p1", 0.0, -150.0), T).size ]
      end
      assert_equal 1, counts["industrial"]
      assert_equal 4, counts["stadium"]
    end
  end

  module Actors
    class DragonsTest < ActiveSupport::TestCase
      T = 1_700_000_000_000
      FLAT = ->(_x, _z) { 50.0 }

      class FakeCorridor
        def self.objects(*) = [ [ "t:1,2", 30.0 ], [ "m:9", 120.0 ] ]
        def self.blast(*) = [ [ "b:5", 200.0 ] ]
      end

      def player(id, x, z)
        Session.from_attrs(id:, name: id).tap { _1.x = x; _1.z = z }
      end

      setup do
        @hubs = FakeWorld::HUBS.to_h { [ _1.key, _1 ] }
        @actors = Dragons.new(@hubs, ground: FLAT, corridor: FakeCorridor, now: T)
      end

      test "one dragon per lair, heartbeats while asleep, every tick while awake" do
        assert_equal 1, @actors.dragons.size
        assert_equal [ "d1" ], @actors.snapshot.map { _1[:id] }
        r1 = @actors.tick(T + 250, [])
        assert_equal [ "actors" ], r1[:messages].map { _1[:type] }
        r2 = @actors.tick(T + 500, [])
        assert_empty r2[:messages], "asleep: no message a quarter second later"
        lair = @hubs["o:w3"]
        prey = player("p1", lair.x, lair.z - 300)
        r3 = @actors.tick(T + 750, [ prey ])
        assert_equal "hunt", r3[:messages].last[:list].first[:state]
      end

      test "a breath burns the players on the strip and chips the objects under it" do
        lair = @hubs["o:w3"]
        prey = player("p1", lair.x, lair.z - 300)
        burns, hits = [], []
        (60 * 4).times do |i|
          r = @actors.tick(T + (i + 1) * 250, [ prey ])
          burns.concat(r[:burns]); hits.concat(r[:hits])
          d = @actors.dragons.first
          if d.breathing? && d.strip then prey.x, prey.z = (d.strip[:x0] + d.strip[:x1]) / 2, (d.strip[:z0] + d.strip[:z1]) / 2 end
        end
        assert_operator burns.size, :>=, 1
        assert(burns.any? { _1.first(2) == [ "p1", 6.0 ] }, "the breath itself burns for six a tick")
        assert_includes hits.map(&:first), "m:9"
        assert_in_delta 120.0 / 8, hits.find { _1[0] == "m:9" }[1], 1e-6
      end

      test "a fireball bursts on the ground, hurts who is standing there and leaves a fire that keeps eating" do
        lair = @hubs["o:w3"]
        prey = player("p1", lair.x, lair.z - 300)
        burns, hits, shot = [], [], nil
        t = T
        400.times do
          t += 250
          r = @actors.tick(t, [ prey ])
          burns.concat(r[:burns]); hits.concat(r[:hits])
          list = r[:messages].last&.fetch(:list, nil) || []
          if !shot && (s = list.find { _1[:kind] == "shot" })
            shot = s
            prey.x, prey.z = s[:ix], s[:iz]                          # stand exactly where it is going to land
          end
          break if shot && t > shot[:t1] + 4_000
        end
        assert shot, "expected a spat fireball in the actors list"
        assert_equal "d1", shot[:owner]
        assert_includes hits.map(&:first), "b:5", "the blast bites what stands under it"
        assert_operator hits.count { _1[0] == "b:5" }, :>, 4, "and the fire keeps biting for seconds afterwards"
        assert_operator burns.count { _1[0] == "p1" }, :>=, 2, "the burst and then the fire it left"
        assert(@actors.snapshot.any? { _1[:kind] == "fire" }, "the burning ground is published to the room")
      end

      test "a fire goes out and stops costing anything" do
        @actors.instance_variable_get(:@fires) << { id: "x", x: 0.0, z: 0.0, r: 10.0, until: T + 1_000, objects: [ [ "b:5", 200.0 ] ] }
        prey = player("p1", 0.0, 0.0)
        r = @actors.tick(T + 500, [ prey ])
        assert_includes r[:hits].map(&:first), "b:5"
        assert_equal [ "p1" ], r[:burns].map(&:first)
        r2 = @actors.tick(T + 1_500, [ prey ])
        assert_empty r2[:hits]
        assert_empty r2[:burns]
        assert_empty @actors.fires
      end

      test "strike validates the dragon, the range and the kind, and reports kills and flinches" do
        lair = @hubs["o:w3"]
        near = player("p1", lair.x + 100, lair.z)
        far = player("p2", lair.x + 1000, lair.z)
        assert_equal "dragon", @actors.strike(near, "d9", 10, "fireball", T)
        assert_equal "range", @actors.strike(far, "d1", 10, "fireball", T)
        assert_equal "kind", @actors.strike(near, "d1", 10, "poke", T)
        msg = @actors.strike(near, "d1", 500, "lightning", T)
        assert_equal [ "strike", "d1", 855, "p1", false ], msg.values_at(:type, :dragon_id, :hp, :by, :killed)
        assert_equal false, msg[:staggered]
        refute @actors.strike(near, "d1", 60, "fireball", T + 10)[:staggered], "45 + 60 is under the flinch threshold"
        hard = @actors.strike(near, "d1", 60, "fireball", T + 20)
        assert hard[:staggered], "three spells in a heartbeat make it flinch"
        assert_equal "stagger", hard[:state]
        20.times { |i| @actors.strike(near, "d1", 60, "fireball", T + 100 + i) }
        assert_equal "dead", @actors.strike(near, "d1", 60, "fireball", T + 200)
        r = @actors.tick(T + 250, [ near ])
        assert_equal [ [ "o:w3", [ "p1" ] ] ], r[:kills]
      end
    end
  end
end

module Game
  class DragonRaidTest < ActiveSupport::TestCase
    T = 1_700_000_000_000
    FLAT = ->(_x, _z) { 50.0 }

    test "a patrolling dragon may raid a town within reach: one breath over the centre, then home" do
      lair = FakeWorld::HUBS.find { _1.role == "lair" }
      town = FakeWorld::HUBS.find { _1.key == "p:1" }                                    # 2 km from the lair
      raided = false
      # try a few seeds: the raid is a coin toss per patrol
      (1..12).each do |seed|
        d = Dragon.new("d1", lair, ground: FLAT, now: T, rng: Random.new(seed), towns: [ town ])
        t, breaths = T, 0
        until t > T + 600_000
          t += 250
          events = d.step(t, [])
          breaths += events.count { _1[0] == :breath_start }
          if d.state == :raid then raided = true end
          break if raided && breaths.positive?
        end
        if raided && breaths.positive?
          assert_equal :breathe, d.state
          assert_operator Math.hypot(d.x - town.x, d.z - town.z), :<, 200, "breathes over the town"
          break
        end
      end
      assert raided, "no raid in twelve seeds"
    end
  end
end
