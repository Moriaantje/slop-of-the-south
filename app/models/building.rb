class Building < ApplicationRecord
  validates :osm_id, :geom, presence: true

  # Buildings whose centroid falls inside the tile, so each building is emitted exactly once.
  def self.in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    connection.select_all(<<~SQL).map { |r| r.merge("geojson" => JSON.parse(r["geojson"])) }
      SELECT height, kind, ST_AsGeoJSON(geom, 2) AS geojson
      FROM buildings
      WHERE ST_Intersects(ST_Centroid(geom), #{env})
    SQL
  end
end
