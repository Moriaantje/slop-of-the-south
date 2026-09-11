# Landmarks from OpenStreetMap (castles, churches, abbeys, mills, monuments, the stadium, big industrial sites,
# museums): the real-world hotspots that become lairs, shrines and shops. One row per OSM object.
class CreatePois < ActiveRecord::Migration[8.1]
  def change
    create_table :pois do |t|
      t.string :osm_type, null: false            # n | w | r
      t.bigint :osm_id, null: false
      t.string :name
      t.string :kind, null: false                # Poi::KINDS
      t.float :area                              # m², polygons only
      t.jsonb :tags, null: false, default: {}
      t.st_point :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :pois, [ :osm_type, :osm_id ], unique: true
    add_index :pois, :kind
    add_index :pois, :geom, using: :gist
  end
end
