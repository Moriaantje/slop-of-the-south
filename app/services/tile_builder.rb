# Assembles one 500 m tile (Geo::HeightGrid is autoloaded from lib/ by Rails 8)
# into the JSON the Three.js client consumes.
# All coordinates are converted to game units (x east, z south, y up).
class TileBuilder
  def initialize(heights: Geo::HeightGrid.load)
    @heights = heights
  end

  def build(tx, ty)
    s = World::TILE_SIZE
    x0, y0 = tx * s, ty * s
    {
      tx: tx, ty: ty,
      origin: World.to_game(x0, y0 + s),      # game-space corner (west, north)
      heights: heights_for(x0, y0),
      roads: roads_for(tx, ty),
      buildings: buildings_for(tx, ty)
    }
  end

  private

  # Flat array, HEIGHT_N × HEIGHT_N, rows north→south, columns west→east.
  def heights_for(x0, y0)
    n, step, s = World::HEIGHT_N, World::HEIGHT_STEP, World::TILE_SIZE
    out = Array.new(n * n)
    n.times do |row|
      y = y0 + s - row * step
      n.times do |col|
        out[row * n + col] = @heights.sample(x0 + col * step, y).round(1)
      end
    end
    out
  end

  def roads_for(tx, ty)
    Road.in_tile(tx, ty).flat_map do |r|
      lines_from(r["geojson"]).filter_map do |coords|
        next if coords.size < 2
        { kind: r["highway"], name: r["name"], width: r["width"], pts: coords.map { |x, y| World.to_game(x, y).map { _1.round(2) } } }
      end
    end
  end

  def buildings_for(tx, ty)
    Building.in_tile(tx, ty).filter_map do |b|
      ring = b["geojson"]["coordinates"]&.first
      next if ring.nil? || ring.size < 4
      ring = ring[0...-1] # drop closing vertex
      base = ring.map { |x, y| @heights.sample(x, y) }.min
      {
        base: base.round(2),
        height: b["height"].to_f.clamp(2.5, 200.0),
        kind: b["kind"],
        footprint: ring.map { |x, y| World.to_game(x, y).map { _1.round(2) } }
      }
    end
  end

  def lines_from(geojson)
    case geojson["type"]
    when "LineString"      then [ geojson["coordinates"] ]
    when "MultiLineString" then geojson["coordinates"]
    when "GeometryCollection" then geojson["geometries"].flat_map { lines_from(_1) }
    else []
    end
  end
end
