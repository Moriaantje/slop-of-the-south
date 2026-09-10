# 3D BAG LoD2.2 surfaces per building: the actual roof planes and walls, as a MultiPolygon Z plus one
# semantic label per face (0 ground, 1 roof, 2 wall). Rendered instead of the extruded LoD1.3 parts.
class CreateBuildingMeshes < ActiveRecord::Migration[8.1]
  def change
    create_table :building_meshes do |t|
      t.string  :bag_id, null: false                        # BAG pand identificatie
      t.string  :roof_type                                  # 3D BAG b3_dak_type
      t.float   :ground_height                              # m NAP (b3_h_maaiveld)
      t.integer :labels, array: true, null: false, default: []
      t.st_point :center, srid: 28992, null: false          # for tile assignment
      t.multi_polygon :geom, srid: 28992, has_z: true, null: false
      t.timestamps
    end
    add_index :building_meshes, :bag_id, unique: true
    add_index :building_meshes, :center, using: :gist
  end
end
