# Buildings can now come from 3D BAG (preferred) or OSM (fallback outside the Netherlands).
class BuildingsFromMultipleSources < ActiveRecord::Migration[8.1]
  def up
    remove_index :buildings, :osm_id
    rename_column :buildings, :osm_id, :source_id
    execute "ALTER TABLE buildings ALTER COLUMN source_id TYPE varchar USING source_id::text"
    add_column :buildings, :source, :string, null: false, default: "osm"   # "bag3d" or "osm"
    add_column :buildings, :ground_height, :float  # m NAP at the building (3D BAG b3_h_maaiveld)
    add_column :buildings, :roof_height, :float    # m NAP, absolute roof level (3D BAG); relative height = roof - ground
    add_column :buildings, :roof_type, :string     # 3D BAG b3_dak_type
    add_column :buildings, :year, :integer         # BAG oorspronkelijkbouwjaar
    add_index :buildings, [ :source, :source_id ], unique: true
    add_index :buildings, :source
  end

  def down
    remove_index :buildings, :source
    remove_index :buildings, [ :source, :source_id ]
    remove_column :buildings, :year
    remove_column :buildings, :roof_type
    remove_column :buildings, :roof_height
    remove_column :buildings, :ground_height
    remove_column :buildings, :source
    execute "ALTER TABLE buildings ALTER COLUMN source_id TYPE bigint USING source_id::bigint"
    rename_column :buildings, :source_id, :osm_id
    add_index :buildings, :osm_id, unique: true
  end
end
