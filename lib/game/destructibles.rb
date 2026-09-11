module Game
  # The server's verdicts on everything that can be flattened. A client reports damage with the object's size-based
  # maximum (`max` is pinned when the object is first seen: clients compute it from the object's size, the server does
  # not know sizes). Buildings crumble to rubble at zero and get RUBBLE_SHARE of their hit points back; everything
  # else is gone at once. The manager sends changed objects to the room in one coalesced `object` message per tick.
  # Nothing stays broken: `rebuild` restores whatever has not been hit for a while (houses take longer), so the
  # persisted world heals itself object by object instead of all at once when the room empties.
  class Destructibles
    RUBBLE_SHARE   = 0.5
    MAX_HP         = 100_000
    BUILDING_KINDS = %w[m b].freeze
    REBUILD_MS     = { building: 600_000, other: 300_000 }.freeze

    Obj = Struct.new(:key, :kind, :hp, :max, :state, :hit_at, keyword_init: true)

    attr_reader :objects

    def initialize
      @objects = {}
    end

    # Returns the object when it changed, nil otherwise.
    def hit(key, damage, max, now = Game.now_ms)
      return if damage <= 0
      obj = objects[key] ||= Obj.new(key:, kind: key[0], state: :intact)
      return if obj.state == :gone
      obj.max ||= max.clamp(1, MAX_HP)
      obj.hp ||= obj.max
      obj.hp -= damage
      obj.hit_at = now
      if obj.hp <= 0 && BUILDING_KINDS.include?(obj.kind) && obj.state == :intact
        obj.state, obj.hp = :rubble, (obj.max * RUBBLE_SHARE).ceil
      elsif obj.hp <= 0
        obj.state, obj.hp = :gone, 0
      end
      obj
    end

    # everything left alone long enough comes back whole: returns the restored objects (intact, full hp) and forgets them
    def rebuild(now)
      done = objects.values.select do |o|
        wait = BUILDING_KINDS.include?(o.kind) ? REBUILD_MS[:building] : REBUILD_MS[:other]
        o.hit_at && now - o.hit_at >= wait
      end
      done.each { |o| o.state, o.hp = :intact, o.max; objects.delete(o.key) }
    end

    def damaged = objects.values.reject { _1.state == :intact && _1.hp == _1.max }
    def clear = objects.clear
    def obj_h(o) = { key: o.key, hp: o.hp&.round(1), max: o.max, state: o.state }
  end
end
