module Game
  # Everything a level is worth. The xp curve, the skill points a level hands out, the tree of skills those points
  # buy, and the stat block that falls out of the two — all in one module, because the server is the only place
  # allowed to have an opinion about how strong a player is. The client is handed the finished numbers and draws
  # them; it never adds anything up itself.
  #
  # The curve is deliberately the one the game already had, xp = 50 * (level - 1)², so nobody who has been playing
  # loses a level the day this lands. What is new is that it stops: past MAX_LEVEL the numbers keep climbing but the
  # level does not, which keeps the stat block bounded and means the top of the tree is a real destination rather
  # than an asymptote. Points are derived from the level and spending is derived from what has been unlocked, so
  # there is no stored balance anywhere that a replayed message or a double tick could credit twice — the worst a
  # bug can do is fail to spend a point, never mint one.
  #
  # Stats are a flat hash of plain numbers because they cross the wire to a browser and get read inside frame loops.
  # Anything that is a rate or a size is a multiplier on the value already in Tuning.js, so the untouched base block
  # reproduces today's game exactly: every multiplier is 1.0 and every ability count is 0. That is what lets the
  # client modules adopt them one at a time without a flag day.
  module Progression
    XP_PER_LEVEL   = 50          # xp needed for level L is XP_PER_LEVEL * (L - 1)²
    MAX_LEVEL      = 30          # the curve stops here: 42_050 xp
    POINT_EVERY    = 5           # levels: every fifth one pays a second skill point
    HP_PER_LEVEL   = 2           # hit points added to the base for each level above the first
    REFLECT_SHARE  = 0.5         # share of blocked damage a reflecting shield sends back
    # Which spell a reflected hit counts as when it reaches Actors::Dragons#strike, whose STRIKE_CAP only knows the
    # kinds the mech casts. Flip this to "reflect" the moment that table has a cap of its own.
    REFLECT_KIND   = "lightning".freeze

    # The stat block at level 1 with nothing unlocked. Multipliers are against the matching constant in Tuning.js;
    # hp and the regeneration rates are absolute, in hit points and hit points per second.
    BASE = {
      max_hp:          100.0,    # hit points
      mana_max:          1.0,    # × the mech's mana meter: every mana cost is divided by this
      mana_regen:        1.0,    # × T.mech.manaRegen, the seconds from empty to full (lower is faster)
      spell_damage:      1.0,    # × the fireball's and the bolt's damage
      walk_speed:        1.0,    # × T.mech.walk
      drive_speed:       1.0,    # × the vehicle's top speed
      boost_capacity:    1.0,    # × T.boost.drainTime, the seconds of nitro in a full meter
      shield_drain:      1.0,    # × T.mech.shieldDrain, the shield's mana cost per second
      shield_block:      1.0,    # share of incoming damage the shield stops (1 = all of it, today's behaviour)
      shield_reflect:    0.0,    # share of the blocked damage thrown back at the attacker
      hub_regen:        10.0,    # hit points per second standing inside a hub
      field_regen:       1.0,    # hit points per second out in the field, once unhurt long enough
      hover_drain:       1.0,    # × T.mech.hoverDrain
      hover_sink:        1.0,    # × T.mech.hoverSink, how fast a hover falls (lower hangs longer)
      transform_time:    1.0,    # × T.transform.time
      action_cooldown:   1.0,    # × Session::ACTION_MS, the teleport cooldown
      jumps:             1.0,    # jumps before the feet have to touch the ground again
      fireball_split:    0.0,    # extra shards a fireball breaks into
      lightning_chain:   0.0,    # extra dragons a bolt jumps to
    }.freeze

    # The tree. Three branches that answer three different fears — dying, running out of mana, being too slow —
    # and cost 43 points in total against the 35 a maxed player owns, so the last few levels are a choice and not a
    # formality. `level` is the earliest level the skill may be bought at, `needs` the keys that must already be
    # unlocked. `add` lands before `mul` so a flat bonus is never quietly scaled by a later multiplier.
    SKILLS = [
      # lichaam: staying alive
      { key: "taai_1",               branch: "lichaam",  name: "Taai I",              cost: 1, level: 2,  needs: [],
        text: "Een dikkere romp: 25 levenspunten erbij.",                                   add: { max_hp: 25.0 } },
      { key: "taai_2",               branch: "lichaam",  name: "Taai II",             cost: 2, level: 8,  needs: %w[taai_1],
        text: "Nog eens 40 levenspunten.",                                                  add: { max_hp: 40.0 } },
      { key: "taai_3",               branch: "lichaam",  name: "Taai III",            cost: 3, level: 16, needs: %w[taai_2],
        text: "En nog eens 60. Drakenvuur wordt een schrammetje.",                          add: { max_hp: 60.0 } },
      { key: "herstel",              branch: "lichaam",  name: "Snel herstel",        cost: 2, level: 5,  needs: %w[taai_1],
        text: "Je knapt sneller op in een dorp, en ook onderweg.",                          add: { hub_regen: 8.0, field_regen: 1.0 } },
      { key: "rustplaats",           branch: "lichaam",  name: "Rustplaats",          cost: 2, level: 12, needs: %w[herstel],
        text: "Een dorp lapt je in een paar tellen weer op.",                               add: { hub_regen: 10.0, field_regen: 1.5 } },
      { key: "sterk_schild",         branch: "lichaam",  name: "Sterk schild",        cost: 2, level: 6,  needs: %w[taai_1],
        text: "Het schild kost minder mana en houdt alles tegen.",                          mul: { shield_drain: 0.7 } },
      { key: "kaatsschild",          branch: "lichaam",  name: "Kaatsschild",         cost: 3, level: 14, needs: %w[sterk_schild],
        text: "Wat je tegenhoudt kaatst terug naar de draak die het stuurde.",              add: { shield_reflect: REFLECT_SHARE } },

      # magie: the mech's mana and spells
      { key: "manavat_1",            branch: "magie",    name: "Manavat I",           cost: 1, level: 2,  needs: [],
        text: "Een kwart meer mana in het vat.",                                            add: { mana_max: 0.25 } },
      { key: "manavat_2",            branch: "magie",    name: "Manavat II",          cost: 2, level: 10, needs: %w[manavat_1],
        text: "Nog eens veertig procent erbij.",                                            add: { mana_max: 0.4 } },
      { key: "manastroom",           branch: "magie",    name: "Manastroom",          cost: 2, level: 5,  needs: %w[manavat_1],
        text: "Het vat loopt een kwart sneller vol.",                                       mul: { mana_regen: 0.75 } },
      { key: "vuurkracht_1",         branch: "magie",    name: "Vuurkracht I",        cost: 1, level: 3,  needs: [],
        text: "Vuurbal en bliksem slaan een vijfde harder in.",                             add: { spell_damage: 0.2 } },
      { key: "vuurkracht_2",         branch: "magie",    name: "Vuurkracht II",       cost: 2, level: 11, needs: %w[vuurkracht_1],
        text: "En nog eens dertig procent harder.",                                         add: { spell_damage: 0.3 } },
      { key: "splijtende_vuurbal",   branch: "magie",    name: "Splijtende vuurbal",  cost: 3, level: 13, needs: %w[vuurkracht_2],
        text: "De vuurbal splijt onderweg in drie.",                                        add: { fireball_split: 2.0 } },
      { key: "kettingbliksem",       branch: "magie",    name: "Kettingbliksem",      cost: 3, level: 15, needs: %w[manastroom vuurkracht_1],
        text: "De bliksem springt door naar twee draken erachter.",                         add: { lightning_chain: 2.0 } },

      # beweging: getting there
      { key: "snelle_tred",          branch: "beweging", name: "Snelle tred",         cost: 1, level: 2,  needs: [],
        text: "De mech loopt vijftien procent harder.",                                     add: { walk_speed: 0.15 } },
      { key: "stormloop",            branch: "beweging", name: "Stormloop",           cost: 2, level: 9,  needs: %w[snelle_tred],
        text: "Nog eens twintig procent erbij.",                                            add: { walk_speed: 0.2 } },
      { key: "dubbele_sprong",       branch: "beweging", name: "Dubbele sprong",      cost: 2, level: 7,  needs: %w[snelle_tred],
        text: "Een tweede sprong in de lucht, over het dak heen.",                          add: { jumps: 1.0 } },
      { key: "lange_zweef",          branch: "beweging", name: "Lange zweef",         cost: 2, level: 10, needs: %w[dubbele_sprong],
        text: "Zweven zakt langzamer en kost bijna geen mana.",                             mul: { hover_sink: 0.7, hover_drain: 0.55 } },
      { key: "turbovat",             branch: "beweging", name: "Groot turbovat",      cost: 1, level: 4,  needs: [],
        text: "De boostmeter houdt het veertig procent langer vol.",                        add: { boost_capacity: 0.4 } },
      { key: "raceziel",             branch: "beweging", name: "Raceziel",            cost: 2, level: 12, needs: %w[turbovat],
        text: "Elk voertuig rijdt harder, en de meter houdt het nog langer vol.",           add: { boost_capacity: 0.4, drive_speed: 0.08 } },
      { key: "snelle_transformatie", branch: "beweging", name: "Snelle transformatie", cost: 2, level: 6, needs: [],
        text: "Auto en mech wisselen bijna twee keer zo snel.",                             mul: { transform_time: 0.6 } },
      { key: "poortmeester",         branch: "beweging", name: "Poortmeester",        cost: 2, level: 8,  needs: [],
        text: "Teleporteren mag veel vaker: nog maar 36 tellen wachten.",                   mul: { action_cooldown: 0.6 } },
    ].map(&:freeze).freeze

    BY_KEY   = SKILLS.to_h { [ _1[:key], _1 ] }.freeze
    KEYS     = SKILLS.map { _1[:key] }.freeze
    BRANCHES = { "lichaam" => "Lichaam", "magie" => "Magie", "beweging" => "Beweging" }.freeze

    class << self
      # xp 0 → 1, 50 → 2, 200 → 3, 450 → 4 …, and never past MAX_LEVEL
      def level(xp) = [ Math.sqrt([ xp, 0 ].max / XP_PER_LEVEL.to_f).floor + 1, MAX_LEVEL ].min

      # the xp at which `level` starts
      def xp_for(level) = XP_PER_LEVEL * ([ level, 1 ].max - 1)**2

      # xp still to earn before the next level, or nil at the cap
      def xp_to_next(xp)
        level = level(xp)
        level >= MAX_LEVEL ? nil : xp_for(level + 1) - xp
      end

      # one point a level, a second one every fifth level
      def points_for(level)
        level = level.clamp(1, MAX_LEVEL)
        (level - 1) + level / POINT_EVERY
      end

      def cost_of(keys) = keys.sum { BY_KEY[_1]&.fetch(:cost).to_i }
      def known(keys) = Array(keys).map(&:to_s) & KEYS

      # points earned minus points spent; never negative even if the tree is re-costed under a saved player
      def points_left(level, unlocked) = [ points_for(level) - cost_of(unlocked), 0 ].max

      # nil when the skill may be bought, otherwise the reason the client shows
      def refusal(level, unlocked, key)
        skill = BY_KEY[key] or return "unknown"
        return "known" if unlocked.include?(key)
        return "level" if level < skill[:level]
        return "needs" unless skill[:needs].all? { unlocked.include?(_1) }
        return "points" if points_left(level, unlocked) < skill[:cost]
        nil
      end

      # The stat block for a level and a set of unlocked keys: the base, plus the flat bonuses, then the multipliers.
      # Additive first so a skill that says "+25 hit points" means the same whatever else is unlocked.
      def stats(level, unlocked)
        out = BASE.dup
        out[:max_hp] += HP_PER_LEVEL * (level.clamp(1, MAX_LEVEL) - 1)
        skills = unlocked.filter_map { BY_KEY[_1] }
        skills.each { |s| s[:add]&.each { |k, v| out[k] += v } }
        skills.each { |s| s[:mul]&.each { |k, v| out[k] *= v } }
        out[:max_hp] = out[:max_hp].round(1)
        out
      end

      # Spends a point on a session, in place. Returns the message the player's personal stream carries: either the
      # unlock with the fresh progress block, or a refusal with a reason the client has Dutch words for.
      def unlock(session, key)
        key = key.to_s
        reason = refusal(session.level, session.unlocked, key)
        return { type: "skill", ok: false, reason:, key: } if reason
        session.unlock!(key)
        { type: "skill", ok: true, key:, name: BY_KEY[key][:name] }.merge(session.progress)
      end

      # the tree as the client draws it, sent once with the sync
      def catalogue
        { max_level: MAX_LEVEL, branches: BRANCHES,
          skills: SKILLS.map { _1.slice(:key, :branch, :name, :cost, :level, :needs, :text) } }
      end
    end
  end
end
