class Road < ApplicationRecord
  validates :osm_id, :highway, :geom, presence: true

  # Roads clipped to a tile envelope, geometry as parsed GeoJSON (RD metres).
  def self.in_tile(tx, ty)
    env = tile_envelope_sql(tx, ty)
    connection.select_all(<<~SQL).map { |r| r.merge("geojson" => JSON.parse(r["geojson"])) }
      SELECT highway, width, name,
             ST_AsGeoJSON(ST_Intersection(geom, #{env}), 2) AS geojson
      FROM roads
      WHERE geom && #{env}
    SQL
  end

  def self.tile_envelope_sql(tx, ty)
    s = World::TILE_SIZE
    "ST_MakeEnvelope(#{tx * s}, #{ty * s}, #{(tx + 1) * s}, #{(ty + 1) * s}, 28992)"
  end
end
