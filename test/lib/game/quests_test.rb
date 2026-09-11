require "test_helper"

module Game
  module Quests
    class BoardTest < ActiveSupport::TestCase
      T = 1_700_000_000_000
      HUBS = FakeWorld::HUBS.to_h { [ _1.key, _1 ] }
      TOWN = HUBS["p:1"]

      setup do
        @store = MemoryQuestStore.new
        @day = Date.new(2026, 9, 12)
        @board = Board.new(HUBS, store: @store, today: -> { @day })
        @changed = []
        @board.on_change = ->(s) { @changed << s.id }
      end

      def player(id = "p1", x: TOWN.x + 10, z: TOWN.z, vehicle: "auto")
        Session.from_attrs(id:, name: id, vehicle:).tap { _1.x = x; _1.z = z }
      end

      test "offers are the same for everyone on a day and change with the date" do
        a = @board.offers_for(TOWN)
        b = Board.new(HUBS, store: MemoryQuestStore.new, today: -> { @day }).offers_for(TOWN)
        assert_equal a, b
        assert_equal %w[deliver race scout], a.map { _1[:kind] }
        assert_equal "p:2", a[0][:target_key]                                  # the only other town, 5 km east
        assert_includes a[0][:title], "Verweg"
        @day += 1
        refute_equal a.map { _1[:key] }, @board.offers_for(TOWN).map { _1[:key] }
      end

      test "talking needs you at the hub and lists the offers; accepting starts the quest with its deadline" do
        far = player(x: 500)
        assert_equal [ "quest", false, "far" ], @board.talk(far, "p:1", nil, T).first.values_at(:type, :ok, :reason)
        s = player
        dlg = @board.talk(s, "p:1", "p:1/0", T).first
        assert_equal [ "dialogue", "Sjeng Meertens", "burgemeester", 3 ], [ dlg[:type], dlg[:npc][:name], dlg[:npc][:role], dlg[:offers].size ]
        assert_includes dlg[:lines].first, "Testdorp"
        assert_equal [ "heal" ], dlg[:actions]
        offer = dlg[:offers].find { _1[:kind] == "deliver" }
        msg = @board.accept(s, "p:1", offer[:key], T).first
        assert_equal [ "quest", "accepted", "active" ], [ msg[:type], msg[:action], msg[:quest][:status] ]
        assert_equal T + offer[:deadline_s] * 1000, msg[:quest][:deadline_at]
        assert_equal "Verweg", msg[:quest][:target][:name]
        assert_equal 1, @board.for_player(s).size
        assert_equal "active", @store.rows.values.first[:status]
        # the offer is gone from the next dialogue, and cannot be taken twice
        refute_includes @board.talk(s, "p:1", nil, T).first[:offers].map { _1[:key] }, offer[:key]
        assert_equal "active", @board.accept(s, "p:1", offer[:key], T).first[:reason]
      end

      test "at most three quests; the hunt needs the mech" do
        s = player
        offers = @board.offers_for(TOWN)
        offers.each { @board.accept(s, "p:1", _1[:key], T) }
        assert_equal 3, @board.for_player(s).size
        lair = HUBS["o:w3"]
        s.x, s.z = lair.x, lair.z
        hunt = @board.offers_for(lair).first
        assert_equal "max", @board.accept(s, "o:w3", hunt[:key], T).first[:reason]
        @board.abandon(s, offers[0][:key], T)
        assert_equal "mech", @board.accept(s, "o:w3", hunt[:key], T).first[:reason]
        s.vehicle = "mech"
        assert_equal "accepted", @board.accept(s, "o:w3", hunt[:key], T).first[:action]
      end

      test "arriving within 25 m completes a delivery and pays; 26 m does not; the deadline fails it" do
        s = player
        deliver = @board.offers_for(TOWN).find { _1[:kind] == "deliver" }
        @board.accept(s, "p:1", deliver[:key], T)
        target = HUBS["p:2"]
        msgs = []
        s.x, s.z = target.x + 26, target.z
        @board.tick(T + 1000, { "p1" => s }, msgs)
        assert_empty msgs
        s.x = target.x + 24
        @board.tick(T + 2000, { "p1" => s }, msgs)
        assert_equal [ "p1", "completed" ], [ msgs.last[0], msgs.last[1][:action] ]
        assert_equal deliver[:reward][:gold], s.gold
        assert_equal deliver[:reward][:xp], s.xp
        assert_equal [ "p1" ], @changed
        assert_empty @board.for_player(s)
        # a race left to run out of time fails
        race = @board.offers_for(TOWN).find { _1[:kind] == "race" }
        s.x, s.z = TOWN.x, TOWN.z
        @board.accept(s, "p:1", race[:key], T)
        msgs.clear
        @board.tick(T + race[:deadline_s] * 1000 + 1, { "p1" => s }, msgs)
        assert_equal "failed", msgs.last[1][:action]
        assert_equal "failed", @store.rows[[ "p1", race[:key] ]][:status]
      end

      test "a scout completes on discovery, a hunt on the kill, a death loses the delivery" do
        s = player(vehicle: "mech")
        offers = @board.offers_for(TOWN)
        scout = offers.find { _1[:kind] == "scout" }
        deliver = offers.find { _1[:kind] == "deliver" }
        @board.accept(s, "p:1", scout[:key], T)
        @board.accept(s, "p:1", deliver[:key], T)
        msgs = []
        @board.on_discover("p:2", s, T, msgs)
        assert_empty msgs
        @board.on_discover(scout[:target_key], s, T, msgs)
        assert_equal "completed", msgs.last[1][:action]
        @board.on_death(s, T, msgs)
        assert_equal [ "failed", "deliver" ], [ msgs.last[1][:action], msgs.last[1][:quest][:kind] ]
        lair = HUBS["o:w3"]
        s.x, s.z = lair.x, lair.z
        @board.accept(s, "o:w3", @board.offers_for(lair).first[:key], T)
        @board.on_kill("o:w3", [ "p1", "p9" ], T, { "p1" => s }, msgs)
        assert_equal [ "completed", "hunt" ], [ msgs.last[1][:action], msgs.last[1][:quest][:kind] ]
        assert_equal 300 + 50, s.gold
      end

      test "healing at a town or shrine fills the hit points" do
        s = player
        s.hp = 20
        assert_equal "healed", @board.heal(s, "p:1", T).first[:action]
        assert_equal Session::MAX_HP, s.hp
        lair = HUBS["o:w3"]
        s.x, s.z = lair.x, lair.z
        assert_equal "place", @board.heal(s, "o:w3", T).first[:reason]
      end

      test "active quests survive a reload through the store" do
        s = player
        @board.accept(s, "p:1", @board.offers_for(TOWN).first[:key], T)
        again = Board.new(HUBS, store: @store, today: -> { @day })
        assert_equal 1, again.for_player(s).size
        assert_equal "Verweg", again.for_player(s).first[:target][:name]
      end
    end
  end
end
