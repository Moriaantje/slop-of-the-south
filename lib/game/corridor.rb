module Game
  # Every destructible inside a buffered line — the ground under a dragon's breath — with the hit points the client
  # gives the same object (Destructibles.js), so the server's verdicts land on things the browser knows.
  module Corridor
    POINT_MAX = { "t" => 30.0, "l" => 12.0, "g" => 20.0, "s" => 6.0 }.freeze

    # (x0, z0) → (x1, z1) in game units, half_w metres to each side; returns [[key, max_hp], ...]
    def self.objects(x0, z0, x1, z1, half_w)
      conn = ActiveRecord::Base.connection
      ax, ay = World.to_rd(x0, z0)
      bx, by = World.to_rd(x1, z1)
      with = <<~SQL
        WITH c AS (SELECT line, ST_Buffer(line, #{half_w.to_f}, 'endcap=flat') AS corr
                   FROM (SELECT ST_SetSRID(ST_MakeLine(ST_MakePoint(#{ax.to_f}, #{ay.to_f}), ST_MakePoint(#{bx.to_f}, #{by.to_f})), 28992) AS line) l)
      SQL
      # buildings, with the bag3d-wins rule of Building.in_tile; parts with a LoD2.2 mesh take the mesh key
      buildings = conn.select_rows(<<~SQL).map do |id, has_mesh, bag, area|
        #{with}
        SELECT b.id, EXISTS (SELECT 1 FROM building_meshes m WHERE m.bag_id = split_part(b.source_id, '/', 1)),
               split_part(b.source_id, '/', 1), ST_Area(b.geom)
        FROM buildings b, c
        WHERE b.geom && c.corr AND ST_Intersects(b.geom, c.corr)
          AND (b.source <> 'osm' OR NOT EXISTS (
                SELECT 1 FROM buildings o WHERE o.source = 'bag3d' AND o.geom && b.geom AND ST_Intersects(o.geom, b.geom)))
      SQL
        [ has_mesh ? "m:#{bag.to_s.split(".").last}" : "b:#{id}", building_hp(area.to_f) ]
      end
      # trees, lamp posts, traffic lights and signs, filtered like the tile builders emit them
      points = conn.select_rows(<<~SQL).map do |prefix, x, y|
        #{with}
        SELECT 't', ST_X(t.geom), ST_Y(t.geom) FROM trees t, c WHERE t.geom && c.corr AND ST_Intersects(t.geom, c.corr)
        UNION ALL
        SELECT CASE p.kind WHEN 'lamp' THEN 'l' ELSE 'g' END, ST_X(p.geom), ST_Y(p.geom)
        FROM poles p, c WHERE p.kind IN ('lamp', 'signal') AND p.geom && c.corr AND ST_Intersects(p.geom, c.corr)
          AND (p.kind = 'lamp' OR EXISTS (SELECT 1 FROM roads r WHERE r.highway NOT IN ('cycleway', 'track') AND ST_DWithin(r.geom, p.geom, 20)))
        UNION ALL
        SELECT 's', ST_X(s.geom), ST_Y(s.geom) FROM traffic_signs s, c
        WHERE s.status = 'PLACED' AND s.rvv_code <> 'onbekend' AND s.geom && c.corr AND ST_Intersects(s.geom, c.corr)
      SQL
        gx, gz = World.to_game(x.to_f, y.to_f)
        [ Game.point_key(prefix, gx, gz), POINT_MAX[prefix] ]
      end
      buildings + points
    end

    # Destructibles.js buildingHp: clamp(round(60 + 1.2 · area), 80, 800)
    def self.building_hp(area) = (60 + 1.2 * area).round.clamp(80, 800).to_f
  end
end
