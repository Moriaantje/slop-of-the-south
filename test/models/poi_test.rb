require "test_helper"

class PoiTest < ActiveSupport::TestCase
  test "maps OSM tags to landmark kinds" do
    assert_equal "castle", Poi.kind_for({ "historic" => "castle", "name" => "Kasteel Limbricht" })
    assert_equal "ruins", Poi.kind_for({ "historic" => "ruins" })
    assert_equal "abbey", Poi.kind_for({ "amenity" => "place_of_worship", "name" => "Abdij Lilbosch" })
    assert_equal "abbey", Poi.kind_for({ "amenity" => "place_of_worship", "building" => "basilica" })
    assert_equal "chapel", Poi.kind_for({ "amenity" => "place_of_worship", "name" => "Mariakapel" })
    assert_equal "church", Poi.kind_for({ "amenity" => "place_of_worship", "name" => "Sint-Petruskerk" })
    assert_equal "mill", Poi.kind_for({ "man_made" => "windmill" })
    assert_equal "monument", Poi.kind_for({ "historic" => "memorial" })
    assert_equal "stadium", Poi.kind_for({ "leisure" => "stadium" })
    assert_equal "industrial", Poi.kind_for({ "landuse" => "industrial" }, area: 8_000_000)
    assert_nil Poi.kind_for({ "landuse" => "industrial" }, area: 20_000)
    assert_nil Poi.kind_for({ "landuse" => "industrial" })
    assert_equal "museum", Poi.kind_for({ "tourism" => "museum" })
    assert_nil Poi.kind_for({ "shop" => "bakery" })
  end

  test "parses ogr2ogr's other_tags text" do
    assert_equal({ "historic" => "castle", "name:nl" => "Kasteel" }, Poi.parse_other_tags('"historic"=>"castle","name:nl"=>"Kasteel"'))
    assert_equal({}, Poi.parse_other_tags(nil))
  end

  test "roles per kind" do
    assert_equal Poi::KINDS.sort, Poi::ROLE_OF.keys.sort
    assert_equal %w[lair lair shrine shrine shrine shop shop lair lair shop], Poi::KINDS.map { Poi::ROLE_OF[_1] }
  end
end
