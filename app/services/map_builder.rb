# Vector data for the minimap, from our own PostGIS tables, in game units (x east, z south) rounded to metres.
# Two levels: one overview for the whole play area (coarse land cover, water, main roads) and 1 km detail cells
# (all roads with names, building footprints, land cover, water, tree dots) that the client fetches as it zooms in.
class MapBuilder
  CELL = 1000                                     # metres; cell (mx, my) covers RD [mx*1000, (mx+1)*1000) × [my*1000, (my+1)*1000)
  MAIN_ROADS = %w[motorway motorway_link trunk trunk_link primary primary_link secondary secondary_link tertiary].freeze
  MAP_TREES  = %w[boom fruitteelt].freeze         # registered trees and orchards; woodland is already a cover polygon

  def overview
    x0, y0, x1, y1 = World.bounds_rd
    env = "ST_MakeEnvelope(#{x0}, #{y0}, #{x1}, #{y1}, 28992)"
    big = (x1 - x0) * (y1 - y0) > 500e6                                             # a province rather than a town
    {
      bounds: [ *World.to_game(x0, y1), *World.to_game(x1, y0) ].map(&:round),   # [x_west, z_north, x_east, z_south]
      cover: cover(env, simplify: big ? 30 : 8, min_area: big ? 30_000 : 2500),
      roads: roads(env, big ? %w[motorway trunk primary secondary] : MAIN_ROADS, simplify: big ? 30 : 10, names: false),
      cells: [ x0.fdiv(CELL).floor, y0.fdiv(CELL).floor, x1.fdiv(CELL).ceil, y1.fdiv(CELL).ceil ]   # exclusive upper bounds
    }
  end

  def cell(mx, my)
    env = "ST_MakeEnvelope(#{mx * CELL}, #{my * CELL}, #{(mx + 1) * CELL}, #{(my + 1) * CELL}, 28992)"
    {
      mx: mx, my: my,
      cover: cover(env, simplify: 1.5, min_area: 40),
      roads: roads(env, nil, simplify: 1, names: true),
      buildings: buildings(env),
      trees: trees(env)
    }
  end

  private

  def conn = ActiveRecord::Base.connection

  # [[code, ring, hole…], …]; rings are flat game coords [x, z, x, z, …]
  def cover(env, simplify:, min_area:)
    rows = conn.select_rows(<<~SQL)
      SELECT layer, kind, ST_AsGeoJSON(ST_Multi(ST_CollectionExtract(ST_SimplifyPreserveTopology(ST_Intersection(geom, #{env}), #{simplify}), 3)), 0)
      FROM land_covers
      WHERE geom && #{env} AND ST_Intersects(geom, #{env}) AND ST_Area(geom) >= #{min_area}
    SQL
    rows.flat_map do |layer, kind, geojson|
      code = LandCover::CODES[layer == "water" ? "water" : kind]
      next [] unless code && geojson
      JSON.parse(geojson)["coordinates"].filter_map do |rings|
        rings = rings.map { |r| ring(r) }.reject { _1.size < 6 }
        [ code, *rings ] unless rings.empty?
      end
    end.sort_by { |code, _| [ LandCover::ORDER.call(code), code ] }
  end

  # [[kind, width, name, pts…], …] with pts flat game coords
  def roads(env, kinds, simplify:, names:)
    kind_sql = kinds ? "AND highway IN (#{kinds.map { conn.quote(_1) }.join(',')})" : ""
    rows = conn.select_rows(<<~SQL)
      SELECT highway, width, name, ST_AsGeoJSON(ST_Simplify(ST_Intersection(geom, #{env}), #{simplify}), 0)
      FROM roads WHERE geom && #{env} #{kind_sql}
    SQL
    rows.flat_map do |kind, width, name, geojson|
      g = JSON.parse(geojson)
      lines = case g["type"]
      when "LineString" then [ g["coordinates"] ]
      when "MultiLineString" then g["coordinates"]
      when "GeometryCollection" then g["geometries"].select { _1["type"] == "LineString" }.map { _1["coordinates"] }
      else []
      end
      lines.filter_map { |pts| pts.size >= 2 ? [ kind, width.to_f.round(1), names ? name : nil, *ring(pts) ] : nil }
    end
  end

  # building footprints (3D BAG parts, OSM elsewhere) whose centroid lies in the cell: flat rings
  def buildings(env)
    conn.select_values(<<~SQL).filter_map { |geojson| r = JSON.parse(geojson)["coordinates"].first; r && ring(r[0...-1]) }
      SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.5), 0) FROM buildings
      WHERE geom && #{env} AND ST_Intersects(ST_Centroid(geom), #{env})
        AND (source <> 'osm' OR NOT EXISTS (SELECT 1 FROM buildings o WHERE o.source = 'bag3d' AND o.geom && buildings.geom AND ST_Intersects(o.geom, buildings.geom)))
    SQL
  end

  # flat [x, z, x, z, …] of registered trees and orchard trees
  def trees(env)
    conn.select_rows(<<~SQL).flat_map { |x, y| World.to_game(x.to_f, y.to_f).map(&:round) }
      SELECT ST_X(geom), ST_Y(geom) FROM trees WHERE kind IN (#{MAP_TREES.map { conn.quote(_1) }.join(',')}) AND geom && #{env}
    SQL
  end

  def ring(coords)
    coords.flat_map { |x, y| World.to_game(x, y).map(&:round) }
  end
end
