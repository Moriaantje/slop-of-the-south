# Persistent players, keyed by the signed player_id cookie (a uuid) the game already hands out.
class CreatePlayers < ActiveRecord::Migration[8.1]
  def change
    create_table :players, id: :string do |t|
      t.string :name
      t.string :vehicle, null: false, default: "auto"
      t.integer :hp, null: false, default: 100
      t.integer :gold, null: false, default: 0
      t.integer :xp, null: false, default: 0
      t.string :last_hub_key
      t.string :discovered, array: true, null: false, default: []
      t.datetime :last_seen_at
      t.timestamps
    end
  end
end
