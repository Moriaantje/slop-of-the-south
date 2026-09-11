module Game
  # PostGIS helpers in game units (x east, z south, metres from the world origin).
  module Geo
    # The nearest drivable road to (gx, gz): the closest point on its centreline, its heading there (as a Vehicle.js
    # yaw, facing along `heading` when given), the road's compass azimuth and half-width. nil when no road is within
    # `within` metres. Used to drop players and NPCs on a street instead of in a field.
    def self.snap_to_road(gx, gz, heading: nil, within: 400)
      conn = ActiveRecord::Base.connection
      sx, sy = World.to_rd(gx, gz)
      row = conn.select_rows(<<~SQL).first
        SELECT ST_X(t.cp), ST_Y(t.cp),
               ST_Azimuth(ST_LineInterpolatePoint(t.geom, GREATEST(t.f - 0.01, 0)), ST_LineInterpolatePoint(t.geom, LEAST(t.f + 0.01, 1))),
               t.width
        FROM (SELECT r.geom, r.width, ST_ClosestPoint(r.geom, s.pt) AS cp, ST_LineLocatePoint(r.geom, s.pt) AS f
              FROM roads r, (SELECT ST_SetSRID(ST_MakePoint(#{sx.to_f}, #{sy.to_f}), 28992) AS pt) s
              WHERE r.highway NOT IN ('cycleway', 'track') AND ST_DWithin(r.geom, s.pt, #{within.to_f})
              ORDER BY r.geom <-> s.pt LIMIT 1) t
      SQL
      return unless row&.[](2)
      x, y, az, width = row
      az = az.to_f
      az += Math::PI if heading && Math.cos(az - heading) < 0                 # face along the wanted heading, not against it
      x, z = World.to_game(x.to_f, y.to_f)
      { x: x.round(1), z: z.round(1), yaw: Game.yaw(az), azimuth: az, half_width: (width.to_f / 2).round(2) }
    end
  end
end
