# Land cover from BGT: vegetated terrain (meadows, fields, orchards, woods, lawns), unvegetated terrain
# (yards, pavement) and water surfaces. Painted onto the terrain per tile and used to classify biomes.
class CreateLandCovers < ActiveRecord::Migration[8.1]
  def change
    create_table :land_covers do |t|
      t.string :source_id, null: false      # BGT lokaal_id
      t.string :layer, null: false          # begroeid, onbegroeid, water
      t.string :kind, null: false           # fysiek_voorkomen, or water plus_type/type
      t.multi_polygon :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :land_covers, :source_id, unique: true
    add_index :land_covers, :layer
    add_index :land_covers, :geom, using: :gist
  end
end
