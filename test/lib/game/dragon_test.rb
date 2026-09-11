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
      assert_equal :hunt, d.state
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
      14.times { d.strike(60, "p2", "fireball", T) }
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
  end

  module Actors
    class DragonsTest < ActiveSupport::TestCase
      T = 1_700_000_000_000
      FLAT = ->(_x, _z) { 50.0 }

      class FakeCorridor
        def self.objects(*) = [ [ "t:1,2", 30.0 ], [ "m:9", 120.0 ] ]
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
        (30 * 4).times do |i|
          r = @actors.tick(T + (i + 1) * 250, [ prey ])
          burns.concat(r[:burns]); hits.concat(r[:hits])
          d = @actors.dragons.first
          if d.breathing? && d.strip then prey.x, prey.z = (d.strip[:x0] + d.strip[:x1]) / 2, (d.strip[:z0] + d.strip[:z1]) / 2 end
        end
        assert_operator burns.size, :>=, 1
        assert_equal [ "p1", 6.0 ], burns.first.first(2)
        assert_includes hits.map(&:first), "m:9"
        assert_in_delta 120.0 / 8, hits.find { _1[0] == "m:9" }[1], 1e-6
      end

      test "strike validates the dragon, the range and the kind, and reports kills" do
        lair = @hubs["o:w3"]
        near = player("p1", lair.x + 100, lair.z)
        far = player("p2", lair.x + 1000, lair.z)
        assert_equal "dragon", @actors.strike(near, "d9", 10, "fireball", T)
        assert_equal "range", @actors.strike(far, "d1", 10, "fireball", T)
        assert_equal "kind", @actors.strike(near, "d1", 10, "poke", T)
        msg = @actors.strike(near, "d1", 500, "lightning", T)
        assert_equal [ "strike", "d1", 855, "p1", false ], msg.values_at(:type, :dragon_id, :hp, :by, :killed)
        20.times { @actors.strike(near, "d1", 60, "fireball", T) }
        assert_equal "dead", @actors.strike(near, "d1", 60, "fireball", T)
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
          strip = d.strip || d.instance_variable_get(:@strip)
          assert_equal :breathe, d.state
          assert_operator Math.hypot(d.x - town.x, d.z - town.z), :<, 200, "breathes over the town"
          break
        end
      end
      assert raided, "no raid in twelve seeds"
    end
  end
end
