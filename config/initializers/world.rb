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
  BBOX_LIMBURG = [ 50.74, 5.55, 51.79, 6.24 ].freeze   # the whole province (RD 167495–213448, 306846–421225)

  # WORLD_BBOX=phase1 | full | limburg (default): the area every fetch/import/build task works on
  def self.bbox
    case ENV.fetch("WORLD_BBOX", "limburg")
    when "phase1" then BBOX_PHASE_1
    when "full"   then BBOX_FULL
    else BBOX_LIMBURG
    end
  end

  # RD envelope [x0, y0, x1, y1] of the active bbox (memoised; needs PostGIS)
  def self.bounds_rd
    @bounds_rd ||= begin
      s, w, n, e = bbox
      r = ActiveRecord::Base.connection.select_one("SELECT ST_XMin(g) x0, ST_YMin(g) y0, ST_XMax(g) x1, ST_YMax(g) y1 FROM (SELECT ST_Transform(ST_MakeEnvelope(#{w}, #{s}, #{e}, #{n}, 4326), 28992) AS g) t")
      r.values_at("x0", "y0", "x1", "y1").map { _1.to_f.round }
    end
  end

  # RD metres → game units (x east, z south), and back
  def self.to_game(x, y) = [ x - ORIGIN_X, -(y - ORIGIN_Y) ]
  def self.to_rd(gx, gz)  = [ gx + ORIGIN_X, ORIGIN_Y - gz ]

  # Road widths (metres) by OSM highway tag
ROAD_WIDTHS = {
  "motorway" => 11.0, "motorway_link" => 5.0,
  "trunk" => 9.0, "trunk_link" => 5.0,
  "primary" => 8.0, "primary_link" => 4.5,
  "secondary" => 7.0, "secondary_link" => 4.5,
  "tertiary" => 6.5, "tertiary_link" => 4.0,
  "unclassified" => 5.5, "residential" => 5.5,
  "living_street" => 4.5, "service" => 3.5,
  "cycleway" => 2.5, "track" => 3.0
}.freeze
  HIGHWAY_TYPES = ROAD_WIDTHS.keys.freeze
end
