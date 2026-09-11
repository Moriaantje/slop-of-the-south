# NDW traffic signs (Nationaal Dataportaal Wegverkeer, current state) inside the world bbox.
class CreateTrafficSigns < ActiveRecord::Migration[8.1]
  def change
    create_table :traffic_signs do |t|
      t.string :ndw_id, null: false
      t.string :rvv_code, null: false          # A1, B6, G11 …
      t.string :black_code                     # the value on the sign (speed, height …)
      t.string :zone_code                      # ZB zone begin, ZE zone end
      t.string :text                           # text of the sign / onderbord
      t.integer :bearing                       # compass direction of the traffic the sign applies to
      t.string :side                           # N/O/Z/W: side of the road
      t.string :placement
      t.string :driving_direction
      t.string :road_name
      t.string :town
      t.string :county_code
      t.string :image_url
      t.string :status, null: false
      t.boolean :validated, null: false, default: false
      t.date :first_seen_on
      t.st_point :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :traffic_signs, :ndw_id, unique: true
    add_index :traffic_signs, :geom, using: :gist
    add_index :traffic_signs, :rvv_code
  end
end
