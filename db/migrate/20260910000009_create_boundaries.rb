# Named administrative boundaries (the province of Limburg): the play area edge, rendered as a wall of flames.
class CreateBoundaries < ActiveRecord::Migration[8.1]
  def change
    create_table :boundaries do |t|
      t.string :name, null: false
      t.multi_polygon :geom, srid: 28992, null: false
      t.timestamps
    end
    add_index :boundaries, :name, unique: true
    add_index :boundaries, :geom, using: :gist
  end
end
