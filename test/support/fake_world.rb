# A fixed world for the manager tests: two towns, a lair and a shrine, and a player store in memory.
module FakeWorld
  HUBS = [
    Hub::Ref.new(key: "p:1", name: "Testdorp", role: "town", kind: "village", x: 0.0, z: 0.0,
                 spawn: { x: 10.0, z: 0.0, yaw: 0.0 }, npcs: [ { id: "p:1/0", name: "Sjeng Meertens", role: "burgemeester", x: 12.0, z: 5.0, yaw: 0.0 } ]),
    Hub::Ref.new(key: "p:2", name: "Verweg", role: "town", kind: "town", x: 5000.0, z: 0.0,
                 spawn: { x: 5010.0, z: 0.0, yaw: 1.0 }, npcs: []),
    Hub::Ref.new(key: "o:w3", name: "Kasteel Test", role: "lair", kind: "castle", x: 0.0, z: 2000.0,
                 spawn: { x: 0.0, z: 2020.0, yaw: 0.0 }, npcs: []),
    Hub::Ref.new(key: "o:n4", name: "Sint-Testkerk", role: "shrine", kind: "church", x: 2000.0, z: 2000.0,
                 spawn: { x: 2000.0, z: 2010.0, yaw: 0.0 }, npcs: [])
  ].freeze

  # actors that burn a given player every tick, for the hp/death tests
  class Burner
    def initialize(id, damage) = (@id, @damage = id, damage)
    def snapshot(_now) = []
    def tick(_now, _sessions) = { burns: [ [ @id, @damage, 1.0, 2.0 ] ] }
  end

  class NullActors
    def snapshot(_now) = []
    def tick(_now, _sessions) = {}
  end
end
