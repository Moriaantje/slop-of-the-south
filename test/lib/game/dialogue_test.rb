require "test_helper"

module Game
  class DialogueTest < ActiveSupport::TestCase
    HUB = FakeWorld::HUBS.first
    NPC = { id: "p:1/0", name: "Sjeng Meertens", role: "burgemeester" }.freeze
    T = 1_700_000_000_000

    def scene(**over)
      Dialogue::Scene.new({ npc: NPC, hub: HUB, rank: 0, standing: 0, phase: :middag, sky: Weather.for(Date.new(2026, 9, 13)),
                            trait: :droog, blurb: nil, landmark: nil, dragon: nil, now: T }.merge(over))
    end

    test "a greeting is three lines, in Dutch, and names the person and the town" do
      lines = Dialogue.greeting(scene, offers: [ 1, 2 ])
      assert_equal 3, lines.size
      assert lines.all? { _1.is_a?(String) && _1.length > 3 }
      assert_includes lines.first, "Sjeng Meertens"
      assert_includes lines.first, "Testdorp"
      assert_includes lines.first, "Goeiemiddag"
    end

    test "standing changes what a person says first, and every rank has its own words" do
      firsts = (0..4).map { Dialogue.greeting(scene(rank: _1)).first }
      assert_equal firsts.size, firsts.uniq.size
      assert_includes firsts.last, "ereburger"
      assert_equal %w[vremdje bekende vertrouwd vrundj ereburger], (0..4).map { Dialogue.rank_name(_1) }
      assert_equal [ 0, 0, 1, 2, 3, 4 ], [ 0, 3, 4, 10, 20, 99 ].map { Dialogue.rank_for(_1) }
    end

    test "the middle line is drawn from what this scene actually has" do
      bare = Dialogue.greeting(scene)[1]
      with_dragon = Dialogue.greeting(scene(landmark: "Kasteel Test", dragon: { name: "Vuurtong", awake: true, alive: true }))[1]
      refute_equal bare, with_dragon
      refute_includes bare.to_s, "%"                                  # no placeholder ever reaches the player
      refute_includes with_dragon.to_s, "%"
    end

    test "the same person says the same thing for as long as you stand there, and something else later" do
      a = Dialogue.greeting(scene)
      assert_equal a, Dialogue.greeting(scene(now: T + 1_000))
      refute_equal a, Dialogue.greeting(scene(now: T + 10 * Dialogue::BUCKET_MS))
    end

    test "topics are only offered when the scene can answer them" do
      assert_empty Dialogue.topics(scene(sky: nil)).map { _1[:key] } & %w[plaats streek draak]
      full = Dialogue.topics(scene(blurb: "Testdorp is een dorp in Limburg.", landmark: "Kasteel Test",
                                   dragon: { name: "Vuurtong", awake: false, alive: true }))
      assert_equal %w[plaats streek weer draak], full.map { _1[:key] }
      assert full.all? { _1[:lines].size >= 2 && _1[:label].present? }
      assert_includes full.first[:lines].first, "Testdorp is een dorp"
    end

    test "a person has their own words for yes, for well done and for sorry" do
      %w[jager smid kapelaan herbergier].each do |role|
        s = scene(npc: NPC.merge(role:))
        assert_equal 3, [ Dialogue.accepted(s), Dialogue.done(s), Dialogue.failed(s) ].uniq.size
      end
      refute_equal Dialogue.done(scene(npc: NPC.merge(role: "jager"))), Dialogue.done(scene(npc: NPC.merge(role: "smid")))
    end

    test "a Wikipedia sentence is trimmed to something a person could say" do
      assert_equal "Testdorp is een dorp in Limburg.", TownInfo.trim("Testdorp is een dorp in Limburg. Het heeft 400 inwoners.")
      assert_nil TownInfo.trim("   ")
      long = TownInfo.trim("#{'woord ' * 80}einde.")
      assert_operator long.length, :<=, TownInfo::MAX_SENTENCE + 1
      assert long.end_with?("…")
    end
  end
end
