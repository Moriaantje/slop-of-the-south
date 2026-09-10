# Assembles one 500 m tile (Geo::HeightGrid is autoloaded from lib/ by Rails 8)
# into the JSON the Three.js client consumes.
# All coordinates are converted to game units (x east, z south, y up).
class TileBuilder
  def initialize(heights: Geo::HeightGrid.current)
    @heights = heights
  end

  def build(tx, ty)
    s = World::TILE_SIZE
    x0, y0 = tx * s, ty * s
    meshes = meshes_for(tx, ty)
    {
      tx: tx, ty: ty,
      origin: World.to_game(x0, y0 + s),      # game-space corner (west, north)
      heights: heights_for(x0, y0),
      roads: roads_for(tx, ty),
      buildings: buildings_for(tx, ty, skip: meshes.map { _1[:id] }.to_set),
      meshes: meshes,
      trees: trees_for(tx, ty)
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

  # Extruded boxes: OSM footprints and any 3D BAG parts whose building has no LoD2.2 mesh.
  def buildings_for(tx, ty, skip: Set.new)
    Building.in_tile(tx, ty).filter_map do |b|
      next if b["source"] == "bag3d" && skip.include?(b["source_id"].split("/").first.split(".").last)   # mesh ids are the numeric BAG id
      ring = b["geojson"]["coordinates"]&.first
      next if ring.nil? || ring.size < 4
      ring = ring[0...-1] # drop closing vertex
      base = ring.map { |x, y| @heights.sample(x, y) }.min
      # 3D BAG gives the absolute roof level (m NAP): extrude from the terrain up to it, so roofs sit at their true
      # height even where the DEM and the building ground level disagree a little. OSM only has a relative height.
      height = b["roof_height"] ? b["roof_height"].to_f - base : b["height"].to_f
      {
        base: base.round(2),
        height: height.clamp(2.5, 200.0).round(2),
        kind: b["kind"],
        roof: b["roof_type"],
        footprint: ring.map { |x, y| World.to_game(x, y).map { _1.round(2) } }
      }.compact
    end
  end

  # 3D BAG LoD2.2 surfaces as faces the client triangulates: per building an origin (game units) and faces
  # [label, outer_ring, hole_ring, ...] with vertices as flat centimetre offsets [dx, dy, dz, ...] from the origin.
  # Ground faces are dropped (the terrain covers them). A building whose ground level lies above the DEM is
  # lowered onto the terrain so it never floats.
  def meshes_for(tx, ty)
    BuildingMesh.in_tile(tx, ty).filter_map do |m|
      polys = m["geojson"]["coordinates"]
      next if polys.blank?
      labels = m["labels"].is_a?(String) ? m["labels"].scan(/\d+/).map(&:to_i) : m["labels"]
      ground = polys.flat_map { |rings| rings.first.map { _1[2] } }.min
      footprint = polys.each_with_index.filter_map { |rings, i| rings.first if labels[i] == BuildingMesh::LABEL_GROUND }.flatten(1)
      footprint = polys.flat_map(&:first) if footprint.empty?
      base = footprint.map { |x, y, _| @heights.sample(x, y) }.min
      dz = [ base - ground, 0.0 ].min
      ox, oz = World.to_game(*polys.first.first.first[0, 2]).map { _1.round(2) }
      oy = (ground + dz).round(2)
      faces = polys.each_with_index.filter_map do |rings, i|
        next if labels[i] == BuildingMesh::LABEL_GROUND
        [ labels[i] || BuildingMesh::LABEL_WALL, *rings.map { |ring| ring_offsets(ring, ox, oy, oz, dz) } ]
      end
      next if faces.empty?
      { id: m["bag_id"].split(".").last, roof: m["roof_type"], o: [ ox, oy, oz ], f: faces }
    end
  end

  # ring of RD [x, y, z] → flat centimetre offsets from the origin (closing vertex dropped)
  def ring_offsets(ring, ox, oy, oz, dz)
    pts = ring.first == ring.last ? ring[0...-1] : ring
    pts.flat_map do |x, y, z|
      gx, gz = World.to_game(x, y)
      [ ((gx - ox) * 100).round, ((z + dz - oy) * 100).round, ((gz - oz) * 100).round ]
    end
  end

  # Trees as [x, z, kind, height] in game units (kind 0 street tree, 1 deciduous wood, 2 conifer); the client
  # samples the terrain for y.
  def trees_for(tx, ty)
    Tree.in_tile(tx, ty).map do |x, y, kind, h|
      gx, gz = World.to_game(x, y)
      [ gx.round(1), gz.round(1), kind, h.round(1) ]
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
