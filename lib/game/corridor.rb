module Game
  # Every destructible inside a piece of ground — the strip under a dragon's breath, or the disc a fireball bursts
  # over — with the hit points the client gives the same object (Destructibles.js), so the server's verdicts land on
  # things the browser knows. Both shapes go through the same pair of queries and differ only in the PostGIS geometry
  # the CTE hands them: a buffered line for the breath, a buffered point for the burst. That matters because the two
  # must agree about what counts as hit — a tree half under the flame and half under the blast is one tree with one
  # key, and a rule that lived in two places would eventually disagree with itself about which.
  module Corridor
    POINT_MAX = { "t" => 30.0, "l" => 12.0, "g" => 20.0, "s" => 6.0 }.freeze

    # (x0, z0) → (x1, z1) in game units, half_w metres to each side; returns [[key, max_hp], ...]
    def self.objects(x0, z0, x1, z1, half_w)
      ax, ay = World.to_rd(x0, z0)
      bx, by = World.to_rd(x1, z1)
      within(<<~SQL)
        WITH c AS (SELECT ST_Buffer(ST_SetSRID(ST_MakeLine(ST_MakePoint(#{ax.to_f}, #{ay.to_f}), ST_MakePoint(#{bx.to_f}, #{by.to_f})), 28992),
                                    #{half_w.to_f}, 'endcap=flat') AS corr)
      SQL
    end

    # everything within r metres of (x, z) in game units: what a burst sets alight
    def self.blast(x, z, r)
      cx, cy = World.to_rd(x, z)
      within(<<~SQL)
        WITH c AS (SELECT ST_Buffer(ST_SetSRID(ST_MakePoint(#{cx.to_f}, #{cy.to_f}), 28992), #{r.to_f}) AS corr)
      SQL
    end

    # `with` defines a single-row CTE `c` with a column `corr`: the RD polygon to collect inside
    def self.within(with)
      conn = ActiveRecord::Base.connection
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
    private_class_method :within

    # Destructibles.js buildingHp: clamp(round(60 + 1.2 · area), 80, 800)
    def self.building_hp(area) = (60 + 1.2 * area).round.clamp(80, 800).to_f
  end
end
