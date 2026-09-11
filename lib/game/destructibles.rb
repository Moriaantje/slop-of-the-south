module Game
  # The server's verdicts on everything that can be flattened. A client reports damage with the object's size-based
  # maximum (`max` is pinned when the object is first seen: clients compute it from the object's size, the server does
  # not know sizes). Buildings crumble to rubble at zero and get RUBBLE_SHARE of their hit points back; everything
  # else is gone at once. The manager sends changed objects to the room in one coalesced `object` message per tick.
  class Destructibles
    RUBBLE_SHARE   = 0.5
    MAX_HP         = 100_000
    BUILDING_KINDS = %w[m b].freeze

    Obj = Struct.new(:key, :kind, :hp, :max, :state, keyword_init: true)

    attr_reader :objects

    def initialize
      @objects = {}
    end

    # Returns the object when it changed, nil otherwise.
    def hit(key, damage, max)
      return if damage <= 0
      obj = objects[key] ||= Obj.new(key:, kind: key[0], state: :intact)
      return if obj.state == :gone
      obj.max ||= max.clamp(1, MAX_HP)
      obj.hp ||= obj.max
      obj.hp -= damage
      if obj.hp <= 0 && BUILDING_KINDS.include?(obj.kind) && obj.state == :intact
        obj.state, obj.hp = :rubble, (obj.max * RUBBLE_SHARE).ceil
      elsif obj.hp <= 0
        obj.state, obj.hp = :gone, 0
      end
      obj
    end

    def damaged = objects.values.reject { _1.state == :intact && _1.hp == _1.max }
    def clear = objects.clear
    def obj_h(o) = { key: o.key, hp: o.hp&.round(1), max: o.max, state: o.state }
  end
end
