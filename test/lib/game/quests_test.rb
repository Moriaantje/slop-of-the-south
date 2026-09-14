require "test_helper"

module Game
  module Quests
    class BoardTest < ActiveSupport::TestCase
      T = 1_700_000_000_000
      HUBS = FakeWorld::HUBS.to_h { [ _1.key, _1 ] }
      TOWN = HUBS["p:1"]
      LAIR = HUBS["o:w3"]

      setup do
        @store = MemoryQuestStore.new
        @day = Date.new(2026, 9, 12)
        @hour = 13.0                                      # a fixed midday, so the greetings never wander
        @board = Board.new(HUBS, store: @store, today: -> { @day }, clock: ->(_now) { @hour })
        @changed = []
        @board.on_change = ->(s) { @changed << s.id }
      end

      def player(id = "p1", x: TOWN.x + 10, z: TOWN.z, vehicle: "auto")
        Session.from_attrs(id:, name: id, vehicle:).tap { _1.x = x; _1.z = z }
      end

      # drive to a point and let the board look at it for one tick
      def go(s, point, msgs = [], now = T + 1000, r = 5)
        s.x, s.z = point[:x] + r, point[:z]
        @board.tick(now, { s.id => s }, msgs)
        msgs
      end

      def offer_of(hub_key, kind_or_line, s = nil)
        @board.offers_for(HUBS[hub_key], s, T).find { _1[:kind] == kind_or_line || _1[:line] == kind_or_line }
      end

      # ---- the daily board -------------------------------------------------------------------------------------

      test "the daily offers are the same for everyone on a day and change with the date" do
        a = @board.offers_for(TOWN)
        b = Board.new(HUBS, store: MemoryQuestStore.new, today: -> { @day }).offers_for(TOWN)
        assert_equal a.map { _1[:key] }, b.map { _1[:key] }
        assert_equal %w[deliver race scout], a.map { _1[:kind] }
        assert_equal "p:2", a[0][:target_key]                                  # the only other town, 5 km east
        assert_includes a[0][:title], "Verweg"
        assert a.all? { _1[:stages].any? }, "every offer carries its stages"
        @day += 1
        refute_equal a.map { _1[:key] }, @board.offers_for(TOWN).map { _1[:key] }
      end

      test "talking needs you at the hub and gives lines, standing and the chain's first step" do
        assert_equal [ "quest", false, "far" ], @board.talk(player(x: 500), "p:1", nil, T).first.values_at(:type, :ok, :reason)
        s = player
        dlg = @board.talk(s, "p:1", "p:1/0", T).first
        assert_equal [ "dialogue", "Sjeng Meertens", "burgemeester" ], [ dlg[:type], dlg[:npc][:name], dlg[:npc][:role] ]
        assert_equal 3, dlg[:lines].size
        assert dlg[:lines].all? { _1.is_a?(String) && !_1.strip.empty? }
        assert_includes dlg[:lines].first, "Goeiemiddag"                        # the clock is fixed at 13:00
        assert_equal [ 0, "vremdje" ], dlg[:standing].values_at(:rank, :name)
        assert_equal [ "heal" ], dlg[:actions]
        assert_equal %w[deliver race scout gemeente], dlg[:offers].map { _1[:line] || _1[:kind] }
        gemeente = dlg[:offers].find { _1[:line] == "gemeente" }
        assert_equal [ 1, 3 ], gemeente.values_at(:step, :steps)
      end

      test "a person you have helped greets you differently and pays better" do
        s = player
        deliver = offer_of("p:1", "deliver", s)
        @board.accept(s, "p:1", deliver[:key], T)
        go(s, { x: HUBS["p:2"].x, z: HUBS["p:2"].z }, [], T + 1000, 10)
        assert_equal 2, @board.standing("p1", "p:1")                            # one finished job is worth two points
        s.x, s.z = TOWN.x, TOWN.z
        3.times { |i| @store.save({ player_id: "p1", key: "los#{i}", hub_key: "p:1", status: "done" }) }
        again = Board.new(HUBS, store: @store, today: -> { @day }, clock: ->(_n) { @hour })
        assert_equal 1, again.rank("p1", "p:1")                                 # eight points: a bekende
        vremd = @board.talk(player("p2"), "p:1", nil, T).first                  # someone this town has never seen
        bekend = again.talk(s, "p:1", nil, T).first
        refute_equal vremd[:lines].first, bekend[:lines].first
        assert_equal "bekende", bekend[:standing][:name]
        base = @board.offers_for(TOWN).find { _1[:kind] == "race" }[:reward][:gold]
        paid = again.offers_for(TOWN, s, T).find { _1[:kind] == "race" }[:reward][:gold]
        assert_equal (base * 1.15).round, paid
      end

      # ---- accepting -------------------------------------------------------------------------------------------

      test "accepting starts the quest at stage nought with the first stage's clock" do
        s = player
        offer = offer_of("p:1", "deliver", s)
        msg = @board.accept(s, "p:1", offer[:key], T).first
        assert_equal [ "quest", "accepted", "active" ], [ msg[:type], msg[:action], msg[:quest][:status] ]
        assert_equal T + offer[:deadline_s] * 1000, msg[:quest][:deadline_at]
        assert_equal T + QuestLines::DAILY_EXPIRES_S * 1000, msg[:quest][:expires_at]
        assert_equal "Verweg", msg[:quest][:target][:name]
        assert_equal [ 0, 1 ], msg[:quest].values_at(:stage, :stage_count)
        refute_nil msg[:said]
        assert_equal 1, @board.for_player(s).size
        assert_equal "active", @store.rows.values.first[:status]
        refute_includes @board.talk(s, "p:1", nil, T).first[:offers].map { _1[:key] }, offer[:key]
        assert_equal "active", @board.accept(s, "p:1", offer[:key], T).first[:reason]
      end

      test "at most three quests; the hunt needs the mech" do
        s = player
        offers = @board.offers_for(TOWN, s, T).first(3)
        offers.each { @board.accept(s, "p:1", _1[:key], T) }
        assert_equal 3, @board.for_player(s).size
        s.x, s.z = LAIR.x, LAIR.z
        hunt = @board.offers_for(LAIR).first
        assert_equal "hunt", hunt[:kind]
        assert_equal "max", @board.accept(s, "o:w3", hunt[:key], T).first[:reason]
        @board.abandon(s, offers[0][:key], T)
        assert_equal "mech", @board.accept(s, "o:w3", hunt[:key], T).first[:reason]
        s.vehicle = "mech"
        assert_equal "accepted", @board.accept(s, "o:w3", hunt[:key], T).first[:action]
      end

      # ---- the stage machine -----------------------------------------------------------------------------------

      test "a scout runs in two stages: the marker follows you there and then home again" do
        s = player
        scout = offer_of("p:1", "scout", s)
        @board.accept(s, "p:1", scout[:key], T)
        target = HUBS[scout[:target_key]]
        msgs = go(s, { x: target.x, z: target.z }, [], T + 1000, 300)             # 300 m out: not there yet
        assert_empty msgs
        msgs = go(s, { x: target.x, z: target.z }, [], T + 2000, 100)             # inside the wide look-at radius
        assert_equal [ "p1", "stage" ], [ msgs.last[0], msgs.last[1][:action] ]
        quest = msgs.last[1][:quest]
        assert_equal [ 1, 2, "Testdorp" ], [ quest[:stage], quest[:stage_count], quest[:target][:name] ]
        assert_includes quest[:objective], "Testdorp"
        refute_nil msgs.last[1][:note]
        msgs = go(s, { x: TOWN.x, z: TOWN.z }, [], T + 3000, 10)
        assert_equal "completed", msgs.last[1][:action]
        assert_equal scout[:reward][:gold], s.gold
      end

      test "a search stage wants you to stand still, and only then hands over the next stage" do
        s = player
        step1 = offer_of("p:1", "gemeente", s)
        @board.accept(s, "p:1", step1[:key], T)
        go(s, { x: HUBS["p:2"].x, z: HUBS["p:2"].z }, [], T + 1000, 10)            # step one: a delivery
        assert_equal "done", @store.rows[[ "p1", step1[:key] ]][:status]
        step2 = offer_of("p:1", "gemeente", s)
        assert_equal 2, step2[:step]
        s.x, s.z = TOWN.x, TOWN.z
        @board.accept(s, "p:1", step2[:key], T)
        spot = @board.for_player(s).first[:target]
        assert_nil spot[:key], "a trail points at a spot in the fields, not at a hub"
        msgs = go(s, spot, [], T + 1_000, 10)
        assert_equal [ "dwell", T + 1_000 ], msgs.last[1].values_at(:action, :since), "the client is told the clock started"
        msgs.clear
        msgs = go(s, spot, [], T + 5_000, 10)
        assert_empty msgs, "eight seconds of looking, not one tick"
        msgs = go(s, spot, [], T + 10_000, 10)
        assert_equal "stage", msgs.last[1][:action]
        s.x, s.z = TOWN.x + 1000, TOWN.z                                          # leaving resets the dwell
        @board.tick(T + 11_000, { "p1" => s }, [])
        msgs = go(s, { x: TOWN.x, z: TOWN.z }, [], T + 12_000, 10)
        assert_equal "completed", msgs.last[1][:action]
        assert_empty @board.for_player(s), "nothing left on the list"
      end

      test "a vigil only counts after dark" do
        shrine = HUBS["o:n4"]                                                      # the chaplain's line lives here
        s = player(x: shrine.x, z: shrine.z)
        assert_equal 1, @board.offers_for(shrine, s, T).find { _1[:line] == "processie" }[:step]
        # the first two steps are a delivery and a search; write them off so the third one is on offer
        (1..2).each { @store.save({ player_id: "p1", key: "o:n4|processie|#{_1}", hub_key: "o:n4", line: "processie", step: _1, status: "done" }) }
        board = Board.new(HUBS, store: @store, today: -> { @day }, clock: ->(_n) { @hour })
        wake = board.offers_for(shrine, s, T).find { _1[:line] == "processie" }
        assert_equal [ 3, "wake" ], wake.values_at(:step, :kind)
        board.accept(s, "o:n4", wake[:key], T)
        @hour = 13.0
        msgs = []
        board.tick(T + 60_000, { "p1" => s }, msgs)
        assert_empty msgs, "in broad daylight nobody is listening"
        @hour = 22.5
        board.tick(T + 61_000, { "p1" => s }, msgs)
        board.tick(T + 90_000, { "p1" => s }, msgs)
        assert_equal "completed", msgs.last[1][:action]
      end

      # ---- failure ---------------------------------------------------------------------------------------------

      test "the deadline fails a quest, and the expiry date kills a forgotten one" do
        s = player
        race = offer_of("p:1", "race", s)
        @board.accept(s, "p:1", race[:key], T)
        msgs = []
        @board.tick(T + race[:deadline_s] * 1000 + 1, { "p1" => s }, msgs)
        assert_equal [ "failed", "de tijd is om" ], [ msgs.last[1][:action], msgs.last[1][:quest][:reason] ]
        assert_equal "failed", @store.rows[[ "p1", race[:key] ]][:status]
        refute_nil msgs.last[1][:said]
        assert_equal 0, @board.standing("p1", "p:1")                               # standing never goes below nothing
        scout = offer_of("p:1", "scout", s)
        @board.accept(s, "p:1", scout[:key], T)
        msgs.clear
        @board.tick(T + QuestLines::DAILY_EXPIRES_S * 1000 + 1, { "p1" => s }, msgs)
        assert_equal "expired", msgs.last[1][:action]
        assert_equal "expired", @store.rows[[ "p1", scout[:key] ]][:status]
      end

      test "a fragile load is lost when you are hit, and when you are killed" do
        s = player
        deliver = offer_of("p:1", "deliver", s)
        @board.accept(s, "p:1", deliver[:key], T)
        msgs = []
        @board.on_hurt(s, 12.0, T + 500, msgs)
        assert_equal [ "failed", "deliver" ], [ msgs.last[1][:action], msgs.last[1][:quest][:kind] ]
        assert_equal "de lading is eraan gegaan", msgs.last[1][:quest][:reason]
        scout = offer_of("p:1", "scout", s)
        @board.accept(s, "p:1", scout[:key], T)
        msgs.clear
        @board.on_hurt(s, 12.0, T + 600, msgs)
        assert_empty msgs, "a scout carries nothing to break"
        @board.on_death(s, T + 700, msgs)
        assert_empty msgs
      end

      test "a hunt ends on the kill and pays" do
        s = player(vehicle: "mech")
        s.x, s.z = LAIR.x, LAIR.z
        hunt = @board.offers_for(LAIR).first
        @board.accept(s, "o:w3", hunt[:key], T)
        msgs = []
        @board.on_kill("o:n4", [ "p1" ], T, { "p1" => s }, msgs)
        assert_empty msgs, "another lair's dragon is not yours"
        @board.on_kill("o:w3", [ "p1", "p9" ], T, { "p1" => s }, msgs)
        assert_equal [ "completed", "hunt" ], [ msgs.last[1][:action], msgs.last[1][:quest][:kind] ]
        assert_equal hunt[:reward][:gold], s.gold
        assert_equal [ "p1" ], @changed
      end

      # ---- chains, rewards and the rest --------------------------------------------------------------------------

      test "a chain offers one step at a time and the next one only once the last is done" do
        s = player
        line = @board.offers_for(TOWN, s, T).select { _1[:line] == "gemeente" }
        assert_equal 1, line.size
        step1 = line.first
        @board.accept(s, "p:1", step1[:key], T)
        assert_empty @board.offers_for(TOWN, s, T).select { _1[:line] == "gemeente" }, "not while it is in your hands"
        go(s, { x: HUBS["p:2"].x, z: HUBS["p:2"].z }, [], T + 1000, 10)
        assert_equal 2, @board.offers_for(TOWN, s, T).find { _1[:line] == "gemeente" }[:step]
      end

      test "a line behind a rank gate stays shut until the town knows you" do
        far_town = HUBS["p:2"]                                                    # no people in the table: it gets a
        s = player(x: far_town.x, z: far_town.z)                                  # mayor, an innkeeper and a smith
        refute @board.offers_for(far_town, s, T).any? { _1[:line] == "smidse" }, "the smith wants to know you first"
        2.times { |i| @store.save({ player_id: "p1", key: "los#{i}", hub_key: "p:2", status: "done" }) }
        board = Board.new(HUBS, store: @store, today: -> { @day }, clock: ->(_n) { @hour })
        assert_equal 1, board.rank("p1", "p:2")
        assert board.offers_for(far_town, s, T).any? { _1[:line] == "smidse" }
      end

      test "a promised skill point is paid in gold while nothing can grant one" do
        s = player
        blueprint = QuestLines.build("handel", 2, QuestLines::Ctx.new(hub: TOWN, hubs: HUBS, rng: Random.new(1)))
        assert_equal 1, blueprint[:reward][:skill_point]
        gold = blueprint[:reward][:gold]
        q = { player_id: "p1", key: "k", hub_key: "p:1", kind: "deliver", status: "active", stage: 1, stages: [],
              reward: blueprint[:reward] }
        msgs = []
        @board.send(:complete!, s, q, T, msgs)
        given = msgs.last[1][:given]
        assert_equal gold + SKILL_GOLD, given[:gold]
        assert_nil given[:skill_point]
        assert_equal given[:gold], s.gold
      end

      test "healing at a town or shrine fills the hit points" do
        s = player
        s.hp = 20
        assert_equal "healed", @board.heal(s, "p:1", T).first[:action]
        assert_equal s.max_hp, s.hp
        s.x, s.z = LAIR.x, LAIR.z
        assert_equal "place", @board.heal(s, "o:w3", T).first[:reason]
      end

      test "the board verb tells the client what a hub has without walking up to it" do
        s = player(x: 4000)
        msg = @board.handle("board", s, T, hub_key: "p:1").first
        assert_equal [ "quest", "board", "p:1" ], msg.values_at(:type, :action, :hub_key)
        assert_equal 4, msg[:offers]
        assert msg[:chain]
        assert_equal [ "p:1/0" ], msg[:npcs]
        assert_equal "unknown", @board.handle("board", s, T, hub_key: "nergens").first[:reason]
      end

      test "topics answer with more than one line, and only the ones this scene has" do
        s = player
        dlg = @board.talk(s, "p:1", nil, T).first
        assert_includes dlg[:topics].map { _1[:key] }, "weer"
        answer = @board.handle("topic", s, T, hub_key: "p:1", npc_id: "p:1/0", key: "weer").first
        assert_equal [ "dialogue", "topic" ], answer.values_at(:type, :action)
        assert_operator answer[:lines].size, :>=, 2
        assert_equal "unknown", @board.handle("topic", s, T, hub_key: "p:1", key: "onzin").first[:reason]
      end

      test "active quests survive a reload through the store, stage and all" do
        s = player
        scout = offer_of("p:1", "scout", s)
        @board.accept(s, "p:1", scout[:key], T)
        target = HUBS[scout[:target_key]]
        go(s, { x: target.x, z: target.z }, [], T + 1000, 100)
        again = Board.new(HUBS, store: @store, today: -> { @day }, clock: ->(_n) { @hour })
        back = again.for_player(s).first
        assert_equal [ 1, 2, "Testdorp" ], [ back[:stage], back[:stage_count], back[:target][:name] ]
        msgs = []
        s.x, s.z = TOWN.x, TOWN.z
        again.tick(T + 2000, { "p1" => s }, msgs)
        assert_equal "completed", msgs.last[1][:action]
      end
    end
  end
end
