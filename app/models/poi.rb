# A landmark from OpenStreetMap. `kind_for` is the one mapping from OSM tags to our kinds, shared by the Overpass and
# the PBF importers; `ROLE_OF` says what a kind becomes in the game.
class Poi < ApplicationRecord
  KINDS = %w[castle ruins abbey church chapel mill monument stadium industrial museum].freeze
  ROLE_OF = {
    "castle" => "lair", "ruins" => "lair", "stadium" => "lair", "industrial" => "lair",
    "abbey" => "shrine", "church" => "shrine", "chapel" => "shrine",
    "mill" => "shop", "monument" => "shop", "museum" => "shop"
  }.freeze
  INDUSTRIAL_MIN_AREA = 500_000.0        # m²: only sites the size of Chemelot count

  validates :osm_type, :osm_id, :kind, :geom, presence: true
  validates :kind, inclusion: { in: KINDS }

  # tags: string-keyed OSM tags; area: m² for polygons (nil for nodes)
  def self.kind_for(tags, area: nil)
    h, t, a, b = tags["historic"], tags["tourism"], tags["amenity"], tags["building"]
    m, l, lu, name = tags["man_made"], tags["leisure"], tags["landuse"], tags["name"].to_s
    return "castle" if %w[castle fort manor citywalls].include?(h) || b == "castle"
    return "ruins" if h == "ruins"
    return "mill" if %w[windmill watermill].include?(m) || h == "mill" || b == "windmill"
    if a == "place_of_worship" || %w[church chapel cathedral basilica].include?(b)
      return "abbey" if %w[cathedral basilica].include?(b) || name.match?(/abdij|klooster|basiliek|kathedraal/i)
      return "chapel" if b == "chapel" || name.match?(/kapel/i)
      return "church"
    end
    return "monument" if %w[monument memorial].include?(h)
    return "stadium" if l == "stadium"
    return "industrial" if lu == "industrial" && area && area > INDUSTRIAL_MIN_AREA
    return "museum" if t == "museum"
    nil
  end

  # `"k"=>"v","k2"=>"v2"` (the hstore text ogr2ogr writes into other_tags) → Hash
  def self.parse_other_tags(text)
    text.to_s.scan(/"((?:[^"\\]|\\.)*)"=>"((?:[^"\\]|\\.)*)"/).to_h { |k, v| [ k.gsub('\\"', '"'), v.gsub('\\"', '"') ] }
  end

  # upsert one landmark; x, y in RD (EPSG:28992)
  def self.upsert_rd(osm_type:, osm_id:, name:, kind:, area:, tags:, x:, y:)
    connection.exec_query(<<~SQL, "poi", [ osm_type, osm_id, name, kind, area, tags.to_json, x, y ])
      INSERT INTO pois (osm_type, osm_id, name, kind, area, tags, geom, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, ST_SetSRID(ST_MakePoint($7, $8), 28992), now(), now())
      ON CONFLICT (osm_type, osm_id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, area = EXCLUDED.area,
        tags = EXCLUDED.tags, geom = EXCLUDED.geom, updated_at = now()
    SQL
  end

  def self.upsert_lonlat(lon:, lat:, **rest)
    x, y = connection.select_rows("SELECT ST_X(g), ST_Y(g) FROM ST_Transform(ST_SetSRID(ST_MakePoint(#{lon.to_f}, #{lat.to_f}), 4326), 28992) AS g").first
    upsert_rd(x: x.to_f, y: y.to_f, **rest)
  end
end
