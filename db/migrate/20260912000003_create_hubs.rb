# The hubs of the world, materialised by `hubs:build` from places (towns) and pois (landmarks): a stable key, a
# role, a spawn on the nearest street and the people standing there.
class CreateHubs < ActiveRecord::Migration[8.1]
  def change
    create_table :hubs do |t|
      t.string :key, null: false                 # p:<osm_id> | o:<n|w|r><osm_id>
      t.string :name, null: false
      t.string :role, null: false                # town | lair | shrine | shop
      t.string :kind, null: false                # place kind or poi kind
      t.string :source, null: false              # place | poi
      t.integer :population
      t.st_point :geom, srid: 28992, null: false
      t.jsonb :spawn, null: false                # { x, z, yaw } game units, on the nearest drivable road
      t.jsonb :npcs, null: false, default: []    # [{ id, name, role, x, z, yaw }]
      t.timestamps
    end
    add_index :hubs, :key, unique: true
    add_index :hubs, :role
    add_index :hubs, :geom, using: :gist
  end
end
