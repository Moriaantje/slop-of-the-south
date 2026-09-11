require "test_helper"

module Game
  class WorldManagerTest < ActiveSupport::TestCase
    T = 1_700_000_000_000

    setup do
      @room, @personal = [], []
      @store = MemoryStore.new
      @m = WorldManager.new("test", hubs: FakeWorld::HUBS, store: @store, actors: FakeWorld::NullActors.new,
                            publish: ->(p) { @room << p }, publish_to: ->(id, p) { @personal << [ id, p ] }, threaded: false)
    end

    def join(id = "p1", name = "Piet") = @m.join(id, name, T)

    test "sync carries the player's state, the world's verdicts and the fallback spawn" do
      sync = join
      assert_equal [ "p1", "Piet", 100, 0, 1, [] ], sync[:you].values_at(:id, :name, :hp, :gold, :level, :discovered)
      assert_equal Game::WORLD_SPAWN.merge(hub_key: nil), sync[:you][:spawn]
      assert_equal [], sync[:objects]
      assert_equal [ [ "p1", "Piet", "auto" ] ], sync[:players].map(&:values)
      assert_equal "Piet", @store.rows["p1"][:name]
    end

    test "hits are coalesced per tick into one object message" do
      join
      @m.hit("p1", [ [ "m:1", 50, 100 ], [ "m:1", 60, 100 ] ])
      @m.tick(T + 250)
      objects = @room.select { _1[:type] == "object" }
      assert_equal [ { key: "m:1", hp: 50, max: 100, state: :rubble } ], objects.last[:list]
      assert_equal [ "m:1" ], join("p2", "Truus")[:objects].map { _1[:key] }
    end

    test "counts a player once across tabs and saves on the last leave" do
      2.times { join }
      @m.leave("p1")
      assert_equal 1, @m.sessions.size
      @m.moved("p1", 1.0, 2.0, "tank", now: T)
      @m.leave("p1")
      assert_empty @m.sessions
      assert_equal "tank", @store.rows["p1"][:vehicle]
    end

    test "standing near a hub discovers it, gives xp and makes it the respawn" do
      join
      @m.moved("p1", 100.0, 0.0, "auto", now: T)
      @m.tick(T + 250)
      discover = @personal.find { _2[:type] == "discover" }
      assert_equal [ "p1", "p:1", 15 ], [ discover[0], discover[1][:hub][:key], discover[1][:xp] ]
      assert_equal 15, @m.sessions["p1"].xp
      you = @personal.select { _2[:type] == "you" }.last[1]
      assert_equal 15, you[:xp]
      assert_equal 100.0, @m.sessions["p1"].x
      assert_nil @m.sessions["p1"].last_hub_key                    # 100 m out: discovered, but not inside the hub
      @m.moved("p1", 20.0, 0.0, "auto", now: T)
      @m.tick(T + 500)
      assert_equal "p:1", @m.sessions["p1"].last_hub_key
      assert_equal({ x: 10.0, z: 0.0, yaw: 0.0, hub_key: "p:1" }, @m.you(@m.sessions["p1"])[:spawn])
    end

    test "teleport needs a discovered hub and a minute between jumps; switching is free" do
      join
      assert_equal "undiscovered", @m.teleport("p1", "p:2", T)[1][:reason]
      assert_equal "unknown", @m.teleport("p1", "p:9", T)[1][:reason]
      @m.sessions["p1"].discovered << "p:2"
      ok, payload = @m.teleport("p1", "p:2", T)
      assert ok
      assert_equal [ 5010.0, 0.0, "p:2", T + Session::ACTION_MS ], payload.values_at(:x, :z, :hub_key, :next_action_at)
      assert_equal "cooldown", @m.teleport("p1", "p:2", T + 1000)[1][:reason]
      assert @m.switch("p1", "mech", T + 1000).first
      assert_equal "vehicle", @m.switch("p1", "spaceship", T + 1000)[1][:reason]
      assert_equal "mech", @m.sessions["p1"].vehicle
    end

    test "dragon fire takes hp, a shield takes it instead, and death respawns at the last hub" do
      m = WorldManager.new("burn", hubs: FakeWorld::HUBS, store: @store, actors: FakeWorld::Burner.new("p1", 40),
                           publish: ->(p) { @room << p }, publish_to: ->(id, p) { @personal << [ id, p ] }, threaded: false)
      m.join("p1", "Piet", T)
      m.moved("p1", 20.0, 0.0, "auto", now: T)
      m.tick(T + 250)                                               # inside the hub: discovered + regen after the burn
      assert_in_delta 62.5, m.sessions["p1"].hp, 0.01               # 100 − 40 + 2.5 regen
      burn = @room.find { _1[:type] == "burn" }
      assert_equal [ "p1", 40, false ], burn.values_at(:id, :damage, :shielded)
      m.moved("p1", 3000.0, 0.0, "auto", shield: true, now: T + 500)
      m.tick(T + 500)
      assert_in_delta 62.5, m.sessions["p1"].hp, 0.01
      assert @room.last(3).any? { _1[:type] == "burn" && _1[:shielded] }
      m.moved("p1", 3000.0, 0.0, "auto", shield: false, now: T + 750)
      m.tick(T + 750)
      assert_in_delta 22.5, m.sessions["p1"].hp, 0.01
      m.tick(T + 1000)
      death = @room.find { _1[:type] == "death" }
      assert_equal [ "p1", "p:1" ], [ death[:id], death[:respawn][:hub_key] ]
      assert_equal 100, m.sessions["p1"].hp
    end

    test "an empty room heals its world after five minutes" do
      join
      @m.hit("p1", [ [ "t:1,1", 30, 30 ] ])
      @m.tick(T)
      @m.leave("p1", T)
      @m.tick(T + WorldManager::HEAL_IDLE_MS - 1)
      assert_equal [ "t:1,1" ], @m.world.damaged.map(&:key)
      @m.tick(T + WorldManager::HEAL_IDLE_MS + 1)
      assert_empty @m.world.objects
      assert_equal "heal", @room.last[:type]
    end
  

    test "strike goes through the actors and the room hears the dragon's hp; refusals return to the asker" do
      striker = Object.new
      def striker.snapshot(_now) = []
      def striker.tick(_now, _sessions) = {}
      def striker.strike(session, dragon_id, damage, kind, _now) = dragon_id == "d1" ? { type: "strike", dragon_id:, hp: 540, by: session.id, kind:, killed: false } : "dragon"
      m = WorldManager.new("strike", hubs: FakeWorld::HUBS, store: @store, actors: striker, publish: ->(p) { @room << p }, publish_to: ->(_, _) {}, threaded: false)
      m.join("p1", "Piet", T)
      ok, payload = m.strike("p1", "d1", 60, "fireball", T)
      assert ok
      assert_equal [ "strike", "d1", 540, "p1" ], payload.values_at(:type, :dragon_id, :hp, :by)
      assert_equal "strike", @room.last[:type]
      ok, payload = m.strike("p1", "d2", 60, "fireball", T)
      refute ok
      assert_equal "dragon", payload[:reason]
      ok, payload = m.strike("nobody", "d1", 60, "fireball", T)
      refute ok
      assert_equal "player", payload[:reason]
    end

    test "the default actors are the dragons of the lair hubs" do
      m = WorldManager.new("dragons", hubs: FakeWorld::HUBS, store: @store, publish: ->(_) {}, publish_to: ->(_, _) {}, threaded: false)
      sync = m.join("p1", "Piet", T)
      assert_equal [ "dragon" ], sync[:actors].map { _1[:kind] }
      assert_equal "o:w3", sync[:actors].first[:lair]
    end
  end
end
