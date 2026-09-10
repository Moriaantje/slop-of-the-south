class CreatePlaces < ActiveRecord::Migration[8.1]
  def change
    create_table :places do |t|
      t.bigint  :osm_id, null: false
      t.string  :name, null: false
      t.string  :kind, null: false      # OSM place=* value: city, town, village, hamlet, suburb, neighbourhood, quarter
      t.integer :population
      t.st_point :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :places, :osm_id, unique: true
    add_index :places, :kind
    add_index :places, :geom, using: :gist
  end
end
