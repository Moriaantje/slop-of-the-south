# Extra OSM road attributes that drive procedural road generation.
class AddRoadDetails < ActiveRecord::Migration[8.1]
  def change
    change_table :roads do |t|
      t.string  :surface            # OSM surface=*: asphalt, paving_stones, unpaved, …
      t.integer :lanes              # OSM lanes=*
      t.boolean :bridge, null: false, default: false
      t.boolean :tunnel, null: false, default: false
    end
  end
end
