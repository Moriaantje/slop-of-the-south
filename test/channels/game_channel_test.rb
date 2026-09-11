require "test_helper"

class GameChannelTest < ActionCable::Channel::TestCase
  setup do
    @manager = Game::WorldManager.reset!("test", hubs: FakeWorld::HUBS, store: Game::MemoryStore.new, actors: FakeWorld::NullActors.new, publish: ->(_) {}, threaded: false)
    stub_connection(player_id: "p1")
    subscribe room: "test", name: "Pietje"
  end

  teardown { Game::WorldManager.shutdown }

  test "hands the subscriber a sync on a room and a personal stream and announces the join" do
    assert_has_stream "game:test"
    assert_has_stream "game:test:p:p1"
    sync = transmissions.last
    assert_equal [ "sync", "p1", 100 ], [ sync["type"], sync["you"]["id"], sync["you"]["hp"] ]
    assert_equal [], sync["objects"]
    assert_equal "join", ActiveSupport::JSON.decode(broadcasts("game:test").last)["type"]
  end

  test "relays moves with the vehicle and the mech flags" do
    perform :move, x: 1, y: 2, z: 3, yaw: 0.5, speed: 10, brake: false, vehicle: "mech", shield: true, air: false
    move = ActiveSupport::JSON.decode(broadcasts("game:test").last)
    assert_equal [ "move", "mech", "p1", 1.0, true, false ], move.values_at("type", "vehicle", "id", "x", "shield", "air")
    assert_equal [ "mech", true ], [ @manager.sessions["p1"].vehicle, @manager.sessions["p1"].shield ]
  end

  test "applies valid hits and drops malformed ones" do
    hits = [ { "key" => "m:1", "damage" => 30, "max" => 100 }, { "key" => "x:1", "damage" => 30, "max" => 100 }, { "key" => "m:2", "damage" => -5, "max" => 100 } ]
    perform :hit, hits: hits
    assert_equal 70, @manager.world.objects["m:1"].hp
    assert_nil @manager.world.objects["x:1"]
    assert_nil @manager.world.objects["m:2"]
  end

  test "a refused teleport comes back to the asker only" do
    perform :teleport, hub_key: "p:2"
    assert_equal [ "teleport", false, "undiscovered" ], transmissions.last.values_at("type", "ok", "reason")
  end

  test "relays fire with pitch and target" do
    perform :fire, kind: "fireball", x: 1, y: 2, z: 3, yaw: 0.1, pitch: 0.2, target: "d1"
    fire = ActiveSupport::JSON.decode(broadcasts("game:test").last)
    assert_equal [ "fireball", 0.2, "d1" ], fire.values_at("kind", "pitch", "target")
  end
end
