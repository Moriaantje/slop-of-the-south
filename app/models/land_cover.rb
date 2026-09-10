# BGT land cover polygons. Kinds map to small codes shared with the client (game/Cover.js), grouped into biomes.
class LandCover < ApplicationRecord
  LAYERS = %w[begroeid onbegroeid water].freeze

  # kind → code painted by the client; unknown kinds are skipped
  CODES = {
    "grasland agrarisch" => 1, "grasland overig" => 2, "groenvoorziening" => 3, "bouwland" => 4, "fruitteelt" => 5,
    "boomteelt" => 6, "loofbos" => 7, "naaldbos" => 7, "gemengd bos" => 7, "houtwal" => 7, "heide" => 8,
    "struiken" => 9, "moeras" => 10, "rietland" => 10, "kwelder" => 10, "duin" => 11, "zand" => 11, "transitie" => 12,
    "erf" => 20, "gesloten verharding" => 21, "open verharding" => 22, "half verhard" => 23, "onverhard" => 24,
    "water" => 30
  }.freeze
  # paint order: base vegetation first, then hard surfaces, water on top
  ORDER = ->(code) { code >= 30 ? 2 : (code >= 20 ? 1 : 0) }

  validates :source_id, :kind, :geom, presence: true
  validates :layer, inclusion: { in: LAYERS }

  # Polygons clipped to the tile and simplified, as [code, GeoJSON MultiPolygon coordinates] in RD.
  def self.in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    rows = connection.select_rows(<<~SQL)
      SELECT layer, kind,
             ST_AsGeoJSON(ST_Multi(ST_CollectionExtract(ST_SimplifyPreserveTopology(ST_Intersection(geom, #{env}), 0.4), 3)), 1)
      FROM land_covers
      WHERE geom && #{env} AND ST_Intersects(geom, #{env})
    SQL
    rows.filter_map do |layer, kind, geojson|
      code = CODES[layer == "water" ? "water" : kind]
      next unless code && geojson
      polys = JSON.parse(geojson)["coordinates"]
      next if polys.blank?
      [ code, polys ]
    end.sort_by { |code, _| [ ORDER.call(code), code ] }
  end

  # Area shares per code inside the tile (0..1), plus the 3D BAG building footprint share.
  def self.shares_in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    area = World::TILE_SIZE.to_f**2
    shares = Hash.new(0.0)
    connection.select_rows(<<~SQL).each { |layer, kind, a| code = CODES[layer == "water" ? "water" : kind] and shares[code] += a.to_f / area }
      SELECT layer, kind, sum(ST_Area(ST_Intersection(geom, #{env}))) FROM land_covers
      WHERE geom && #{env} AND ST_Intersects(geom, #{env}) GROUP BY layer, kind
    SQL
    shares[:buildings] = connection.select_value(<<~SQL).to_f / area
      SELECT coalesce(sum(ST_Area(ST_Intersection(geom, #{env}))), 0) FROM buildings
      WHERE source = 'bag3d' AND geom && #{env} AND ST_Intersects(geom, #{env})
    SQL
    shares
  end

  # Biome label for a tile from its area shares (Dutch, shown in the HUD). Building footprint share is the urban
  # signal: dense cores and industry >= 25 %, residential 10-25 %, villages 4-10 %; yards (erf) surround every
  # house in town, so they are not counted. Below that the largest rural cover wins.
  def self.biome(shares)
    water   = shares[30]
    bld     = shares[:buildings]
    wood    = shares[7]
    field   = shares[4] + shares[6]
    orchard = shares[5]
    meadow  = shares[1] + shares[2]
    return "water"       if water >= 0.5
    return "stad"        if bld >= 0.25
    return "woonwijk"    if bld >= 0.10
    return "bos"         if wood >= 0.35
    return "boomgaarden" if orchard >= 0.12
    return "akkerland"   if field >= 0.40 && field >= meadow
    return "weiland"     if meadow >= 0.35
    return "dorp"        if bld >= 0.04
    return "akkerland"   if field >= 0.25 && field >= meadow
    return "weiland"     if meadow >= 0.2
    return "bos"         if wood >= 0.2
    "platteland"
  end
end
