require "zlib"

# A hub: a town or a landmark where the game happens. Towns (places of kind city/town/village) get quest givers,
# castles/ruins/the stadium/big industry become dragon lairs, churches and abbeys shrines, mills and monuments shops.
# `build!` derives them from the places and pois tables; the key survives re-imports because it comes from the OSM id.
class Hub < ApplicationRecord
  ROLES = %w[town lair shrine shop].freeze
  TOWN_KINDS = %w[city town village].freeze
  CHURCH_FOLD_R = 800.0                  # a church this close to a town is the town's church, not a hub of its own
  SHOP_DEDUPE_R = 400.0                  # one shop per neighbourhood
  NPC_GAP = 8.0                          # metres between the people along the road
  NPC_OFF = 2.3                          # metres outside the road's half-width: the sidewalk

  Ref = Struct.new(:key, :name, :role, :kind, :x, :z, :spawn, :npcs, keyword_init: true) do
    def to_h = { key:, name:, role:, kind:, x:, z:, spawn:, npcs: }
  end

  validates :key, :name, :role, :kind, :source, :geom, :spawn, presence: true
  validates :role, inclusion: { in: ROLES }

  # every hub as a light struct in game units, loaded once per process (hubs:build changes them, nothing else)
  def self.refs(reload: false)
    @refs = nil if reload
    @refs ||= connection.select_all("SELECT key, name, role, kind, spawn, npcs, ST_X(geom) AS x, ST_Y(geom) AS y FROM hubs ORDER BY key").map do |r|
      x, z = World.to_game(r["x"].to_f, r["y"].to_f)
      spawn = r["spawn"].is_a?(String) ? JSON.parse(r["spawn"]) : r["spawn"]
      npcs = r["npcs"].is_a?(String) ? JSON.parse(r["npcs"]) : r["npcs"]
      Ref.new(key: r["key"], name: r["name"], role: r["role"], kind: r["kind"], x: x.round(1), z: z.round(1),
              spawn: spawn.symbolize_keys, npcs: npcs.map(&:symbolize_keys))
    end
  end

  def self.all_for_client = refs.map(&:to_h)

  # Rebuild the table from places + pois. Deterministic: the same data gives the same hubs, spawns and people.
  def self.build!(min_pop: ENV["HUB_MIN_POP"]&.to_i)
    conn = connection
    inside = conn.select_value("SELECT count(*) FROM boundaries WHERE name = 'Limburg'").to_i.positive?
    join = ->(alias_) { inside ? "JOIN boundaries b ON b.name = 'Limburg' AND ST_Contains(b.geom, #{alias_}.geom)" : "" }
    pop = min_pop ? "AND (p.population >= #{min_pop.to_i} OR p.kind IN ('city', 'town'))" : ""
    specs = conn.select_rows(<<~SQL).map do |osm_id, name, kind, population, x, y|
      SELECT p.osm_id, p.name, p.kind, p.population, ST_X(p.geom), ST_Y(p.geom) FROM places p #{join.call("p")}
      WHERE p.kind IN (#{TOWN_KINDS.map { conn.quote(_1) }.join(",")}) #{pop} ORDER BY p.osm_id
    SQL
      gx, gz = World.to_game(x.to_f, y.to_f)
      { key: "p:#{osm_id}", name:, role: "town", kind:, source: "place", population: population&.to_i, x: gx, z: gz, rd: [ x.to_f, y.to_f ], has_church: false }
    end
    towns = specs.dup
    pois = conn.select_rows(<<~SQL).map do |osm_type, osm_id, name, kind, area, x, y|
      SELECT o.osm_type, o.osm_id, o.name, o.kind, o.area, ST_X(o.geom), ST_Y(o.geom) FROM pois o #{join.call("o")} ORDER BY o.kind, o.area DESC NULLS LAST, o.osm_id
    SQL
      gx, gz = World.to_game(x.to_f, y.to_f)
      { key: "o:#{osm_type}#{osm_id}", name: name.presence || Game::TownInfo::KIND_NL.fetch(kind, kind).capitalize, role: Poi::ROLE_OF[kind], kind:, source: "poi", area: area&.to_f, x: gx, z: gz, rd: [ x.to_f, y.to_f ] }
    end
    nearest = ->(list, s, r) { list.find { (_1[:x] - s[:x])**2 + (_1[:z] - s[:z])**2 < r * r } }
    shops = []
    pois.each do |s|
      next unless s[:role]
      if %w[church chapel].include?(s[:kind]) && (town = nearest.call(towns, s, CHURCH_FOLD_R))
        town[:has_church] = true
        next
      end
      if s[:role] == "shop"
        next if nearest.call(shops, s, SHOP_DEDUPE_R)
        shops << s
      end
      specs << s
    end
    rows = specs.map { |s| row_for(s) }
    transaction do
      where.not(key: rows.map { _1[:key] }).delete_all
      rows.each do |r|
        conn.exec_query(<<~SQL, "hub", [ r[:key], r[:name], r[:role], r[:kind], r[:source], r[:population], r[:rd][0], r[:rd][1], r[:spawn].to_json, r[:npcs].to_json ])
          INSERT INTO hubs (key, name, role, kind, source, population, geom, spawn, npcs, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 28992), $9::jsonb, $10::jsonb, now(), now())
          ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, kind = EXCLUDED.kind, source = EXCLUDED.source,
            population = EXCLUDED.population, geom = EXCLUDED.geom, spawn = EXCLUDED.spawn, npcs = EXCLUDED.npcs, updated_at = now()
        SQL
      end
    end
    refs(reload: true)
    rows.group_by { _1[:role] }.transform_values(&:size)
  end

  # spawn on the nearest street and the people along it, all from a seed so they never move between builds
  def self.row_for(s)
    rng = Random.new(Zlib.crc32(s[:key]))
    road = Game::Geo.snap_to_road(s[:x], s[:z], heading: rng.rand * 2 * Math::PI, within: 400)
    spawn = road ? { x: road[:x], z: road[:z], yaw: road[:yaw] } : { x: s[:x].round(1), z: s[:z].round(1), yaw: 0.0 }
    az = road ? road[:azimuth] : 0.0
    dir = [ Math.sin(az), -Math.cos(az) ]                     # along the road, game units (x east, z south)
    perp = [ Math.cos(az), Math.sin(az) ]                     # to its right
    side = rng.rand < 0.5 ? -1 : 1
    off = (road ? road[:half_width] : 3.0) + NPC_OFF
    roles = Game::Names.roles_for(s[:role], kind: s[:kind], has_church: s[:has_church])
    npcs = roles.each_with_index.map do |role, i|
      along = (i - (roles.size - 1) / 2.0) * NPC_GAP
      x = spawn[:x] + dir[0] * along + perp[0] * side * off
      z = spawn[:z] + dir[1] * along + perp[1] * side * off
      face = [ -perp[0] * side, -perp[1] * side ]           # look at the road
      { id: "#{s[:key]}/#{i}", name: Game::Names.person(rng), role:, x: x.round(1), z: z.round(1), yaw: Math.atan2(-face[0], -face[1]).round(3) }
    end
    s.slice(:key, :name, :role, :kind, :source, :population, :rd).merge(spawn:, npcs:)
  end
end
