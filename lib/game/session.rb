module Game
  # One connected player as the world manager sees them: what the players table remembers (name, vehicle, hp, gold,
  # xp, the skills unlocked, the hubs they discovered, the last hub they stood in) plus what only matters while they
  # are here (position, heading, speed, the shield flag from the last move, tab count, the action cooldown).
  # `changed` marks sessions the store still has to write.
  #
  # Progression lives in Game::Progression; this class is where it is felt. The stat block is derived from the level
  # and the unlocked keys rather than stored, so nothing here can drift out of step with the tree, and it is cached
  # behind the two setters that can invalidate it because regen reads it four times a second for every player in the
  # room. `level_seen` is the level the player has already been congratulated on, which is what turns a silent
  # crossing of an xp threshold into a moment the game can announce exactly once.
  class Session < Struct.new(:id, :name, :vehicle, :hp, :gold, :xp, :discovered, :unlocked, :last_hub_key,
                             :x, :z, :yaw, :speed, :shield, :moved_at, :hurt_at,
                             :tabs, :last_action_at, :level_seen, :changed, keyword_init: true)
    ACTION_MS = 60_000                   # teleport, then this long a cooldown before the Poortmeester discount
    MAX_HP    = 100                      # the base pool; a levelled player's real ceiling is #max_hp

    def self.from_attrs(attrs)
      xp = attrs[:xp] || 0
      new(id: attrs[:id], name: attrs[:name], vehicle: attrs[:vehicle] || "auto", hp: attrs[:hp] || MAX_HP,
          gold: attrs[:gold] || 0, xp:, discovered: Set.new(attrs[:discovered] || []),
          unlocked: Set.new(Progression.known(attrs[:unlocked] || [])),
          last_hub_key: attrs[:last_hub_key], tabs: 0, changed: false, shield: false,
          level_seen: Progression.level(xp))
    end

    # xp 0 → 1, 50 → 2, 200 → 3, 450 → 4 …, capped at Progression::MAX_LEVEL
    def self.level(xp) = Progression.level(xp)

    def level = Progression.level(xp)
    def alive? = hp.positive?

    # the derived stat block, rebuilt only when the xp or the unlocked set moved
    def stats = @stats ||= Progression.stats(level, unlocked)

    def max_hp = stats[:max_hp]
    def skill_points = Progression.points_left(level, unlocked)
    def unlocked?(key) = unlocked.include?(key.to_s)

    # the teleport cooldown, shortened by the Poortmeester skill
    def action_ms = (ACTION_MS * stats[:action_cooldown]).round
    def action_allowed?(now) = last_action_at.nil? || now - last_action_at >= action_ms
    def next_action_at = last_action_at && last_action_at + action_ms

    # xp only ever climbs, so invalidating the cache here covers every award site in the game
    def xp=(value)
      @stats = nil
      super
    end

    # The name the quest board probes for. A quest that finishes with a skill is granting it, not selling it, so it
    # goes through the same door as a bought unlock — Progression credits the cost back, which is what makes it free.
    def grant_unlock!(key) = unlock!(key)

    def unlock!(key)
      unlocked << key.to_s
      @stats = nil
      self.changed = true
      key
    end

    # The level-up moment, claimed once. Returns the payload the player's personal stream carries, or nil when
    # nothing has been crossed since the last call; the caller decides whether to publish it.
    def level_up
      now_level = level
      return nil if level_seen && now_level <= level_seen
      self.level_seen = now_level
      self.changed = true
      { type: "level", level: now_level, gained: skill_points }.merge(progress)
    end

    # What a plain `you` carries. It rides every tick a player regenerates on, so it stays three numbers: the stat
    # block below cannot move without a level or an unlock, and both of those send the whole thing anyway.
    def brief = { level:, max_hp:, skill_points: }

    # The whole picture, for a sync, a level-up and a spent point. xp_next is nil at the cap, which is how the
    # client knows to draw a full bar and stop counting.
    def progress
      now_level = level
      brief.merge(xp_level: Progression.xp_for(now_level),
                  xp_next: (Progression.xp_for(now_level + 1) if now_level < Progression::MAX_LEVEL),
                  unlocked: unlocked.to_a, stats:)
    end

    def attrs
      { id:, name:, vehicle:, hp:, gold:, xp:, discovered: discovered.to_a, unlocked: unlocked.to_a, last_hub_key: }
    end
  end
end
