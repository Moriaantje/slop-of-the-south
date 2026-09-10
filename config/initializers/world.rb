# World constants shared by the import pipeline, tile builder and the client (via /api/world).
module World
  # RD New (EPSG:28992) origin subtracted from every coordinate. Roughly between Geleen and Sittard.
  ORIGIN_X = 185_000.0
  ORIGIN_Y = 330_000.0

  TILE_SIZE   = 500                          # metres
  HEIGHT_STEP = 10                           # metres between height samples
  HEIGHT_N    = TILE_SIZE / HEIGHT_STEP + 1  # 51 samples per side (edges shared with neighbours)

  # WGS84 bounding boxes [south, west, north, east]
  BBOX_FULL    = [ 50.90, 5.70, 51.05, 6.02 ].freeze   # Stein/Urmond ↔ Brunssum/Schinveld
  BBOX_PHASE_1 = [ 50.94, 5.78, 51.01, 5.90 ].freeze   # Sittard–Geleen–Beek–Neerbeek

  def self.bbox
    ENV["WORLD_BBOX"] == "full" ? BBOX_FULL : BBOX_PHASE_1
  end

  # RD metres → game units (x east, z south)
  def self.to_game(x, y) = [ x - ORIGIN_X, -(y - ORIGIN_Y) ]

  # Road widths (metres) by OSM highway tag
  ROAD_WIDTHS = {
    "motorway" => 11.0, "motorway_link" => 5.0,
    "trunk" => 9.0, "trunk_link" => 5.0,
    "primary" => 8.0, "primary_link" => 4.5,
    "secondary" => 7.0, "secondary_link" => 4.5,
    "tertiary" => 6.5, "tertiary_link" => 4.0,
    "unclassified" => 5.5, "residential" => 5.5,
    "living_street" => 4.5, "service" => 3.5
  }.freeze
  HIGHWAY_TYPES = ROAD_WIDTHS.keys.freeze
end
