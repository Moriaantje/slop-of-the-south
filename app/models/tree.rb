class Tree < ApplicationRecord
  # tile kinds: 0 street/park tree (deciduous), 1 deciduous wood, 2 conifer
  TILE_KIND = { "boom" => 0, "loofbos" => 1, "gemengd bos" => 1, "houtwal" => 1, "naaldbos" => 2 }.freeze

  validates :source, :source_id, :kind, :height, :geom, presence: true

  # Trees inside the tile as [x, y(RD), kind, height]
  def self.in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    connection.select_rows(<<~SQL).map { |x, y, kind, h| [ x.to_f, y.to_f, TILE_KIND.fetch(kind, 1), h.to_f ] }
      SELECT ST_X(geom), ST_Y(geom), kind, height FROM trees WHERE geom && #{env} AND ST_Intersects(geom, #{env})
    SQL
  end
end
