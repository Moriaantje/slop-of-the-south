module Game
  # One connected player as the world manager sees them: what the players table remembers (name, vehicle, hp, gold,
  # xp, the hubs they discovered, the last hub they stood in) plus what only matters while they are here (position,
  # heading, speed, the shield flag from the last move, tab count, the action cooldown). `changed` marks sessions
  # the store still has to write.
  class Session < Struct.new(:id, :name, :vehicle, :hp, :gold, :xp, :discovered, :last_hub_key,
                             :x, :z, :yaw, :speed, :shield, :moved_at, :hurt_at,
                             :tabs, :last_action_at, :changed, keyword_init: true)
    ACTION_MS = 60_000                   # teleport, then this long a cooldown
    MAX_HP    = 100

    def self.from_attrs(attrs)
      new(id: attrs[:id], name: attrs[:name], vehicle: attrs[:vehicle] || "auto", hp: attrs[:hp] || MAX_HP,
          gold: attrs[:gold] || 0, xp: attrs[:xp] || 0, discovered: Set.new(attrs[:discovered] || []),
          last_hub_key: attrs[:last_hub_key], tabs: 0, changed: false, shield: false)
    end

    # xp 0 → 1, 50 → 2, 200 → 3, 450 → 4 …
    def self.level(xp) = Math.sqrt(xp / 50.0).floor + 1

    def level = Session.level(xp)
    def alive? = hp.positive?
    def action_allowed?(now) = last_action_at.nil? || now - last_action_at >= ACTION_MS
    def next_action_at = last_action_at && last_action_at + ACTION_MS

    def attrs
      { id:, name:, vehicle:, hp:, gold:, xp:, discovered: discovered.to_a, last_hub_key: }
    end
  end
end
