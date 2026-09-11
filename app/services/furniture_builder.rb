# Street furniture for one tile, oriented from the road network.
#
#   lamps:   [x, z, dir, h]              BGT lichtmast (OSM street_lamp where BGT has none); dir = compass direction of the
#                                        arm (towards the nearest road), h = mast height class in metres
#   signals: [x, z, face, group]         traffic lights: BGT verkeersregelinstallatiepaal poles facing the traffic that
#                                        approaches them; where BGT has no poles an OSM traffic_signals node gets one pole
#                                        per approaching road. group = intersection id (shared signal cycle)
#   signs:   [x, z, face, code, black?, text?]  NDW traffic signs; face = compass direction the sign face points to
#
# Compass directions are degrees clockwise from north; the client turns them into yaw.
class FurnitureBuilder
  MARGIN = 40
  TALL_MASTS = %w[motorway motorway_link trunk trunk_link primary secondary].freeze

  def build(tx, ty)
    s = World::TILE_SIZE
    x0, y0, x1, y1 = tx * s, ty * s, (tx + 1) * s, (ty + 1) * s
    @env = "ST_MakeEnvelope(#{x0}, #{y0}, #{x1}, #{y1}, 28992)"
    { lamps: lamps, signals: signals + synthesized_signals, signs: signs }
  end

  private

  def conn = ActiveRecord::Base.connection

  # each lamp/signal pole with its nearest carriageway (within 20 m): closest point, local compass azimuth, side
  def poles_with_roads(kinds)
    kinds_sql = kinds.map { conn.quote(_1) }.join(",")
    conn.select_rows(<<~SQL)
      SELECT p.id, p.kind, ST_X(p.geom), ST_Y(p.geom), r.highway, r.width, r.oneway, ST_X(r.cp), ST_Y(r.cp),
             degrees(ST_Azimuth(ST_LineInterpolatePoint(r.geom, GREATEST(r.f - 0.002, 0)), ST_LineInterpolatePoint(r.geom, LEAST(r.f + 0.002, 1)))),
             n.id
      FROM poles p
      LEFT JOIN LATERAL (
        SELECT r.highway, r.width, r.oneway, r.geom, ST_ClosestPoint(r.geom, p.geom) AS cp, ST_LineLocatePoint(r.geom, p.geom) AS f
        FROM roads r WHERE r.highway NOT IN ('cycleway', 'track') AND ST_DWithin(r.geom, p.geom, 20) ORDER BY r.geom <-> p.geom LIMIT 1
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT n.id FROM poles n WHERE n.kind = 'signal_node' AND ST_DWithin(n.geom, p.geom, 40) ORDER BY n.geom <-> p.geom LIMIT 1
      ) n ON true
      WHERE p.kind IN (#{kinds_sql}) AND p.geom && #{@env} AND ST_Intersects(p.geom, #{@env})
    SQL
  end

  def lamps
    poles_with_roads(%w[lamp]).map do |_id, _kind, x, y, highway, width, _oneway, cx, cy, _az, _node|
      gx, gz = World.to_game(x.to_f, y.to_f)
      dir = cx ? compass(cx.to_f - x.to_f, cy.to_f - y.to_f) : 0
      h = highway && (TALL_MASTS.include?(highway) || width.to_f >= 6.5) ? 9 : 6
      [ gx.round(1), gz.round(1), dir, h ]
    end
  end

  # BGT signal poles: the pole stands on the right of the traffic it serves, so on a two-way road the side decides the
  # approach direction; the head faces against that direction
  def signals
    poles_with_roads(%w[signal]).filter_map do |id, _kind, x, y, _highway, _width, oneway, cx, cy, az, node|
      next unless az
      x, y, cx, cy, az = x.to_f, y.to_f, cx.to_f, cy.to_f, az.to_f
      dx, dy = Math.sin(az * Math::PI / 180), Math.cos(az * Math::PI / 180)           # road direction, RD
      left = dx * (y - cy) - dy * (x - cx) > 0
      approach = oneway || !left ? az : az + 180
      gx, gz = World.to_game(x, y)
      [ gx.round(1), gz.round(1), ((approach + 180) % 360).round, (node || id).to_i ]
    end
  end

  # OSM traffic_signals nodes without BGT poles nearby: one pole per approaching road, 6 m before the node on the right
  def synthesized_signals
    nodes = conn.select_rows(<<~SQL)
      SELECT n.id, ST_X(n.geom), ST_Y(n.geom), ST_AsGeoJSON(ST_Collect(r.geom)), array_agg(r.width), array_agg(r.oneway)
      FROM poles n
      JOIN roads r ON r.highway NOT IN ('cycleway', 'track', 'footway', 'path') AND ST_DWithin(r.geom, n.geom, 1.5)
      WHERE n.kind = 'signal_node' AND n.geom && #{@env} AND ST_Intersects(n.geom, #{@env})
        AND NOT EXISTS (SELECT 1 FROM poles b WHERE b.kind = 'signal' AND ST_DWithin(b.geom, n.geom, 30))
      GROUP BY n.id, n.geom
    SQL
    nodes.flat_map do |id, nx, ny, geojson, widths, oneways|
      nx, ny = nx.to_f, ny.to_f
      lines = JSON.parse(geojson)["coordinates"]
      lines = [ lines ] if lines.first&.first.is_a?(Numeric)
      widths = widths.tr("{}", "").split(",").map(&:to_f)
      oneways = oneways.tr("{}", "").split(",").map { _1 == "t" }
      lines.each_with_index.flat_map do |pts, li|
        i = pts.each_index.min_by { |k| Math.hypot(pts[k][0] - nx, pts[k][1] - ny) }
        next [] if Math.hypot(pts[i][0] - nx, pts[i][1] - ny) > 1.5
        approaches = []
        approaches << pts[i - 1] if i > 0                                # traffic arriving along the way's direction
        approaches << pts[i + 1] if i < pts.size - 1 && !oneways[li]     # …and against it, unless one-way
        approaches.map do |from|
          ax, ay = nx - from[0], ny - from[1]
          len = Math.hypot(ax, ay)
          next nil if len < 0.5
          ax, ay = ax / len, ay / len
          px = nx - ax * 6 + ay * (widths[li] / 2 + 1.2)                 # right of the approach direction
          py = ny - ay * 6 - ax * (widths[li] / 2 + 1.2)
          gx, gz = World.to_game(px, py)
          [ gx.round(1), gz.round(1), ((compass(ax, ay) + 180) % 360).round, id.to_i ]
        end.compact
      end
    end
  end

  def signs
    rows = conn.select_rows(<<~SQL)
      SELECT ST_X(geom), ST_Y(geom), bearing, rvv_code, black_code, text, town, zone_code
      FROM traffic_signs WHERE status = 'PLACED' AND rvv_code <> 'onbekend' AND geom && #{@env} AND ST_Intersects(geom, #{@env})
    SQL
    rows.map do |x, y, bearing, code, black, text, town, zone|
      gx, gz = World.to_game(x.to_f, y.to_f)
      face = ((bearing || 0).to_i + 180) % 360
      label = code.start_with?("H") ? town : text
      black = "#{black}#{zone == 'ZB' ? ' zone' : ''}".strip.presence
      [ gx.round(1), gz.round(1), face, code, black, label.presence ].reverse.drop_while(&:nil?).reverse
    end
  end

  # compass degrees (clockwise from north) of an RD vector
  def compass(dx, dy) = ((Math.atan2(dx, dy) * 180 / Math::PI) % 360).round
end
