# Administrative boundary polygons from PDOK Bestuurlijke Gebieden (Kadaster), in RD.
class Boundary < ApplicationRecord
  validates :name, :geom, presence: true

  # Outer rings of the named boundary in game units, simplified to `tolerance` metres: [[x, z, x, z, …], …]
  def self.rings_for_client(name = "Limburg", tolerance: 25)
    row = connection.select_value(<<~SQL)
      SELECT ST_AsGeoJSON(ST_Multi(ST_SimplifyPreserveTopology(geom, #{tolerance.to_f})), 0) FROM boundaries WHERE name = #{connection.quote(name)}
    SQL
    return [] unless row
    JSON.parse(row)["coordinates"].map { |rings| rings.first[0...-1].flat_map { |x, y| World.to_game(x, y).map(&:round) } }
  end
end
