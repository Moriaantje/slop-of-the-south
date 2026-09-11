# Point street furniture: BGT Paal objects (lamp posts, traffic-signal poles, sign posts …) and OSM fallback nodes
# (traffic_signals, signalised crossings, street lamps where BGT has none).
class CreatePoles < ActiveRecord::Migration[8.1]
  def change
    create_table :poles do |t|
      t.string :source, null: false            # bgt | osm
      t.string :source_id, null: false
      t.string :kind, null: false              # lamp | signal | signal_node | crossing_signal | sign_post | <bgt type>
      t.jsonb :attrs, null: false, default: {}
      t.st_point :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :poles, [ :source, :source_id ], unique: true
    add_index :poles, :geom, using: :gist
    add_index :poles, :kind
  end
end
