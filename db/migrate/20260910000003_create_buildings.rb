class CreateBuildings < ActiveRecord::Migration[8.1]
  def change
    create_table :buildings do |t|
      t.bigint  :osm_id, null: false
      t.string  :kind            # OSM building=* value (house, apartments, church, …)
      t.string  :name
      t.float   :height, null: false, default: 6.0   # metres above ground
      t.integer :levels
      t.st_polygon :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :buildings, :osm_id, unique: true
    add_index :buildings, :geom, using: :gist
  end
end
