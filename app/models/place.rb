# Named places (towns, villages, neighbourhoods) from OSM place=* nodes; used for the HUD sign.
class Place < ApplicationRecord
  SETTLEMENTS = %w[city town village hamlet].freeze
  DISTRICTS   = %w[suburb neighbourhood quarter].freeze

  validates :osm_id, :name, :kind, :geom, presence: true

  # Compact list in game units for the client: [{ name:, kind:, x:, z: }, ...]
  def self.for_client
    connection.select_all("SELECT name, kind, ST_X(geom) AS x, ST_Y(geom) AS y FROM places ORDER BY name").map do |r|
      x, z = World.to_game(r["x"].to_f, r["y"].to_f)
      { name: r["name"], kind: r["kind"], x: x.round(1), z: z.round(1) }
    end
  end
end
