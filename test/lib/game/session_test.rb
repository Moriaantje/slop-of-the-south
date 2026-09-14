require "test_helper"

module Game
  # The progression maths, the skill tree's gate and the session that carries both. Nothing here touches the world
  # manager: this is the arithmetic the rest of the game is allowed to trust.
  class SessionTest < ActiveSupport::TestCase
    def session(xp: 0, unlocked: [])
      Session.from_attrs(id: "p1", name: "Piet", xp:, unlocked:)
    end

    test "the xp curve is 50 (level - 1) squared and stops at the cap" do
      assert_equal 1, Progression.level(0)
      assert_equal 1, Progression.level(49)
      assert_equal 2, Progression.level(50)
      assert_equal 3, Progression.level(200)
      assert_equal 10, Progression.level(4_050)
      assert_equal 30, Progression.level(42_050)
      assert_equal 30, Progression.level(10_000_000)            # the cap holds, however much xp arrives
      assert_equal 42_050, Progression.xp_for(Progression::MAX_LEVEL)
      assert_equal 150, Progression.xp_to_next(50)              # level 2 starts at 50, level 3 at 200
      assert_nil Progression.xp_to_next(42_050)
    end

    test "a level pays one point, every fifth level a second" do
      assert_equal 0, Progression.points_for(1)
      assert_equal 1, Progression.points_for(2)
      assert_equal 5, Progression.points_for(5)                 # four levels gained plus the fifth-level bonus
      assert_equal 11, Progression.points_for(10)
      assert_equal 35, Progression.points_for(Progression::MAX_LEVEL)
      assert_equal 35, Progression.points_for(999)
    end

    test "the whole tree costs more than a maxed player owns, so it is a choice" do
      total = Progression::SKILLS.sum { _1[:cost] }
      assert_operator total, :>, Progression.points_for(Progression::MAX_LEVEL)
      assert_equal 43, total
      # and every skill is reachable: its prerequisites exist and sit at or below its own level gate
      Progression::SKILLS.each do |s|
        s[:needs].each do |key|
          need = Progression::BY_KEY[key]
          assert need, "#{s[:key]} needs unknown skill #{key}"
          assert_operator need[:level], :<=, s[:level], "#{s[:key]} unlocks before its prerequisite #{key}"
        end
        assert_operator s[:level], :<=, Progression::MAX_LEVEL
      end
    end

    test "stats are the base plus the flat bonuses and then the multipliers" do
      base = Progression.stats(1, [])
      assert_equal Progression::BASE[:max_hp], base[:max_hp]
      assert_equal 1.0, base[:walk_speed]
      assert_equal 1, base[:jumps]

      # 2 hit points a level: level 11 is ten levels of growth
      assert_equal 120.0, Progression.stats(11, [])[:max_hp]
      assert_equal 145.0, Progression.stats(11, %w[taai_1])[:max_hp]

      # additive first: two walk skills add, they do not compound
      assert_in_delta 1.35, Progression.stats(9, %w[snelle_tred stormloop])[:walk_speed], 1e-9
      # and a multiplier is a multiplier
      assert_in_delta 0.75, Progression.stats(5, %w[manavat_1 manastroom])[:mana_regen], 1e-9
      assert_in_delta 1.25, Progression.stats(5, %w[manavat_1 manastroom])[:mana_max], 1e-9
      assert_equal 2.0, Progression.stats(7, %w[snelle_tred dubbele_sprong])[:jumps]
      assert_equal 18.0, Progression.stats(5, %w[taai_1 herstel])[:hub_regen]
    end

    test "unlocking is refused without the level, the prerequisites or the points" do
      s = session(xp: 0)
      assert_equal "level", Progression.refusal(s.level, s.unlocked, "taai_1")
      assert_equal "unknown", Progression.refusal(s.level, s.unlocked, "vliegen")

      s = session(xp: Progression.xp_for(8))                      # level 8, 8 points
      assert_equal 8, s.level
      assert_equal 8, s.skill_points
      assert_equal "needs", Progression.refusal(s.level, s.unlocked, "taai_2")
      assert_nil Progression.refusal(s.level, s.unlocked, "taai_1")

      s.unlock!("taai_1")
      assert_equal "known", Progression.refusal(s.level, s.unlocked, "taai_1")
      assert_nil Progression.refusal(s.level, s.unlocked, "taai_2")

      # spend the rest, then the last one is simply unaffordable
      s.unlock!("taai_2")                                         # 2
      s.unlock!("herstel")                                        # 2
      s.unlock!("sterk_schild")                                   # 2
      assert_equal 1, s.skill_points
      assert_equal "points", Progression.refusal(s.level, s.unlocked, "snelle_transformatie")
    end

    test "unlock spends the point, marks the session dirty and answers with the whole block" do
      s = session(xp: Progression.xp_for(6))
      s.changed = false
      msg = Progression.unlock(s, "manavat_1")
      assert msg[:ok]
      assert_equal "Manavat I", msg[:name]
      assert s.changed
      assert s.unlocked?("manavat_1")
      assert_equal 5, msg[:skill_points]                          # six levels pay six points, one spent
      assert_in_delta 1.25, msg[:stats][:mana_max], 1e-9

      refused = Progression.unlock(s, "kettingbliksem")
      assert_equal false, refused[:ok]
      assert_equal "level", refused[:reason]
      assert_equal 5, s.skill_points                              # a refusal spends nothing
    end

    test "an unknown or stale skill key never reaches the stat block" do
      s = Session.from_attrs(id: "p1", name: "Piet", xp: 100_000, unlocked: %w[taai_1 uitgestorven_talent])
      assert_equal %w[taai_1], s.unlocked.to_a
      assert_equal Progression.stats(Progression::MAX_LEVEL, %w[taai_1]), s.stats
    end

    test "the stat cache is dropped when xp or the unlocked set moves" do
      s = session(xp: 0)
      assert_equal 100.0, s.max_hp
      s.xp = Progression.xp_for(11)
      assert_equal 120.0, s.max_hp
      s.unlock!("taai_1")
      assert_equal 145.0, s.max_hp
    end

    test "Poortmeester shortens the teleport cooldown" do
      s = session(xp: Progression.xp_for(8))
      s.last_action_at = 1_000_000
      assert_equal Session::ACTION_MS, s.action_ms
      assert_equal false, s.action_allowed?(1_000_000 + 59_000)
      s.unlock!("poortmeester")
      assert_equal 36_000, s.action_ms
      assert s.action_allowed?(1_000_000 + 40_000)
      assert_equal 1_036_000, s.next_action_at
    end

    test "the level-up moment is claimed once per level" do
      s = session(xp: 0)
      assert_nil s.level_up                                       # joining at level 1 is not a level-up
      s.xp = 200                                                  # straight past level 2 into level 3
      up = s.level_up
      assert_equal [ "level", 3 ], up.values_at(:type, :level)
      assert_equal 2, up[:gained]                                 # two levels' worth of points, none spent
      assert_nil s.level_up
      s.xp = 42_050
      assert_equal 30, s.level_up[:level]
      s.xp = 1_000_000
      assert_nil s.level_up                                       # the cap really is the end of it
    end

    test "unlocks survive a round trip through the store" do
      store = MemoryStore.new
      s = Session.from_attrs(store.load("p1", "Piet"))
      s.xp = Progression.xp_for(6)
      s.unlock!("snelle_transformatie")
      store.save(s)
      back = Session.from_attrs(store.load("p1", "Piet"))
      assert back.unlocked?("snelle_transformatie")
      assert_in_delta 0.6, back.stats[:transform_time], 1e-9
      assert_equal 4, back.skill_points
    end

    test "progress carries everything the client needs and nothing it has to work out" do
      s = session(xp: 250)
      p = s.progress
      assert_equal 3, p[:level]
      assert_equal 200, p[:xp_level]
      assert_equal 450, p[:xp_next]
      assert_equal 2, p[:skill_points]
      assert_equal [], p[:unlocked]
      assert_equal Progression::BASE.keys.sort, p[:stats].keys.sort
      s.xp = 42_050
      assert_nil s.progress[:xp_next]                             # at the cap there is no next

      # the per-tick message stays small: the block below it cannot move without a level or an unlock
      assert_equal %i[level max_hp skill_points], s.brief.keys
    end

    # The panel in game/Skills.js draws a copy of the tree so it has something to show before the first sync. The
    # server is the one that decides, so the copy has to agree with it; this is the only thing stopping them drifting.
    test "the browser's catalogue matches the Ruby tree" do
      js = File.read(Rails.root.join("app/javascript/game/Skills.js"))
      re = /\{ key: "(\w+)", branch: "(\w+)", name: "([^"]+)", cost: (\d+), level: (\d+), needs: \[([^\]]*)\], text: "([^"]*)" \}/
      rows = js.scan(re).map do |key, branch, name, cost, level, needs, text|
        { key:, branch:, name:, cost: cost.to_i, level: level.to_i, needs: needs.scan(/"(\w+)"/).flatten, text: }
      end
      assert_equal Progression::SKILLS.size, rows.size, "Skills.js has #{rows.size} skills, the tree has #{Progression::SKILLS.size}"
      assert_equal Progression::SKILLS.map { _1.slice(:key, :branch, :name, :cost, :level, :needs, :text) }, rows
      assert_equal Progression::BRANCHES.keys.sort, js[/export const BRANCHES = \{([^}]*)\}/, 1].scan(/(\w+):/).flatten.sort
      assert_equal Progression::BASE.keys.sort, js[/export const BASE_STATS = \{(.*?)\n\}/m, 1].scan(/^\s+(\w+):/).flatten.map(&:to_sym).sort
    end
  end
end
