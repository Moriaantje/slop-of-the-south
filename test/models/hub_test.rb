require "test_helper"

class HubTest < ActiveSupport::TestCase
  # a straight east–west road through the origin, a village on it, a church 300 m north and one 2 km away
  setup do
    conn = ActiveRecord::Base.connection
    ox, oy = World::ORIGIN_X, World::ORIGIN_Y
    conn.execute(<<~SQL)
      INSERT INTO roads (osm_id, highway, name, width, geom, created_at, updated_at)
      VALUES (1, 'residential', 'Dorpsstraat', 6.0, ST_SetSRID(ST_MakeLine(ST_MakePoint(#{ox - 500}, #{oy}), ST_MakePoint(#{ox + 500}, #{oy})), 28992), now(), now());
      INSERT INTO places (osm_id, name, kind, population, geom, created_at, updated_at)
      VALUES (11, 'Testdorp', 'village', 900, ST_SetSRID(ST_MakePoint(#{ox}, #{oy + 20}), 28992), now(), now());
      INSERT INTO pois (osm_type, osm_id, name, kind, tags, geom, created_at, updated_at)
      VALUES ('w', 21, 'Sint-Testkerk', 'church', '{}', ST_SetSRID(ST_MakePoint(#{ox}, #{oy + 300}), 28992), now(), now()),
             ('w', 22, 'Verre Kerk', 'church', '{}', ST_SetSRID(ST_MakePoint(#{ox + 2000}, #{oy + 2000}), 28992), now(), now()),
             ('w', 23, 'Kasteel Test', 'castle', '{}', ST_SetSRID(ST_MakePoint(#{ox - 300}, #{oy + 100}), 28992), now(), now());
    SQL
  end

  test "builds towns with their people on the sidewalk, folds the town church, keeps far churches as shrines" do
    counts = Hub.build!
    assert_equal({ "town" => 1, "shrine" => 1, "lair" => 1 }, counts)
    town = Hub.refs.find { _1.key == "p:11" }
    assert_equal [ "Testdorp", "village" ], [ town.name, town.kind ]
    assert_equal %w[burgemeester herbergier smid kapelaan], town.npcs.map { _1[:role] }
    assert_in_delta 0.0, town.spawn[:z], 0.5, "spawn snapped onto the road (z = 0 in game units)"
    town.npcs.each do |npc|
      assert npc[:z].abs >= 3.0 + Hub::NPC_OFF - 0.01, "#{npc[:name]} stands off the road: z = #{npc[:z]}"
      assert_match(/\A[A-Zè]\S+ \S+\z/, npc[:name])
    end
    assert_equal 1, town.npcs.map { _1[:z].positive? }.uniq.size, "all on the same sidewalk"
    assert_equal "o:w22", Hub.refs.find { _1.role == "shrine" }.key
    assert_equal "o:w23", Hub.refs.find { _1.role == "lair" }.key
  end

  test "is deterministic and forgets hubs that vanished" do
    Hub.build!
    first = Hub.refs.map(&:to_h)
    Hub.build!
    assert_equal first, Hub.refs.map(&:to_h)
    Poi.where(osm_id: 23).delete_all
    Hub.build!
    assert_nil Hub.refs.find { _1.key == "o:w23" }
  end
end
