# BGT wegdeel / ondersteunendwegdeel: the real road surfaces (carriageway, cycle path, sidewalk, parking, verge)
# with their function and material. Painted into the terrain texture and used for widths and parking lots.
class CreateRoadSurfaces < ActiveRecord::Migration[8.1]
  def change
    create_table :road_surfaces do |t|
      t.string :source_id, null: false     # BGT gml_id
      t.string :layer, null: false         # wegdeel, ondersteunend
      t.string :function                   # rijbaan lokale weg, fietspad, voetpad, parkeervlak, berm, …
      t.string :material                   # gesloten verharding, open verharding, half verhard, onverhard
      t.multi_polygon :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :road_surfaces, :source_id, unique: true
    add_index :road_surfaces, :function
    add_index :road_surfaces, :geom, using: :gist
  end
end
