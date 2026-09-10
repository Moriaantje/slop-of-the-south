# Trees: individual street/park trees from BGT (vegetatieobject "boom") plus procedurally scattered trees
# inside BGT woodland polygons (begroeidterreindeel loofbos/naaldbos/gemengd bos/houtwal).
class CreateTrees < ActiveRecord::Migration[8.1]
  def change
    create_table :trees do |t|
      t.string :source, null: false        # "bgt" (registered tree) or "bgt_bos" (scattered inside a wood)
      t.string :source_id, null: false     # BGT lokaal_id, with "/n" suffix for scattered trees
      t.string :kind, null: false          # boom, loofbos, naaldbos, gemengd bos, houtwal
      t.float  :height, null: false        # metres, estimated (BGT has no tree height)
      t.st_point :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :trees, [ :source, :source_id ], unique: true
    add_index :trees, :geom, using: :gist
  end
end
