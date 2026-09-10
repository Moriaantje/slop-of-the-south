class CreateRoads < ActiveRecord::Migration[8.1]
  def change
    create_table :roads do |t|
      t.bigint  :osm_id, null: false
      t.string  :highway, null: false
      t.string  :name
      t.float   :width, null: false, default: 5.5
      t.boolean :oneway, null: false, default: false
      t.line_string :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :roads, :osm_id, unique: true
    add_index :roads, :geom, using: :gist
  end
end
