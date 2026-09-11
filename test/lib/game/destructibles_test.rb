require "test_helper"

module Game
  class DestructiblesTest < ActiveSupport::TestCase
    test "buildings crumble to rubble and then vanish, other things vanish at once" do
      w = Destructibles.new
      assert_equal :intact, w.hit("m:1", 60, 100).state
      rubble = w.hit("m:1", 60, 999)                                  # the second max is ignored
      assert_equal [ :rubble, 50, 100 ], [ rubble.state, rubble.hp, rubble.max ]
      assert_equal :rubble, w.hit("m:1", 49, 100).state
      assert_equal :gone, w.hit("m:1", 1, 100).state
      assert_nil w.hit("m:1", 1, 100)
      assert_equal :gone, w.hit("t:5,5", 30, 30).state
      assert_nil w.hit("l:5,5", -3, 30)
      assert_equal %w[m:1 t:5,5], w.damaged.map(&:key)
      assert_equal({ key: "t:5,5", hp: 0, max: 30, state: :gone }, w.obj_h(w.objects["t:5,5"]))
    end

    test "sessions level up with the square root of xp and cool down for a minute" do
      s = Session.from_attrs(id: "p", name: "Piet", xp: 200)
      assert_equal 3, s.level
      assert_equal 1, Session.level(0)
      assert s.action_allowed?(1000)
      s.last_action_at = 1000
      assert_not s.action_allowed?(1000 + 59_999)
      assert_equal 61_000, s.next_action_at
      assert s.action_allowed?(61_000)
      assert_equal %i[id name vehicle hp gold xp discovered last_hub_key], s.attrs.keys
    end
  end
end

module Game
  class DestructiblesRebuildTest < ActiveSupport::TestCase
    T = 1_700_000_000_000

    test "what nobody hits for a while stands again, houses last" do
      w = Destructibles.new
      w.hit("t:1,2", 30, 30, T)                    # a tree: gone
      w.hit("m:9", 150, 100, T)                    # a house: rubble
      assert_equal %i[gone rubble], [ w.objects["t:1,2"].state, w.objects["m:9"].state ]
      assert_empty w.rebuild(T + 299_000)
      back = w.rebuild(T + 300_000)
      assert_equal [ [ "t:1,2", :intact, 30.0 ] ], back.map { [ _1.key, _1.state, _1.hp ] }
      assert_nil w.objects["t:1,2"]
      assert_equal [ "m:9" ], w.rebuild(T + 600_000).map(&:key)
      assert_empty w.objects
    end
  end
end
