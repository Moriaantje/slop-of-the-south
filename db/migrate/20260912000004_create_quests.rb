# A player's quests: the offers they accepted at a hub, with the objective, the reward and how it ended.
class CreateQuests < ActiveRecord::Migration[8.1]
  def change
    create_table :quests do |t|
      t.string :player_id, null: false
      t.string :key, null: false
      t.string :kind, null: false
      t.string :status, null: false, default: "active"
      t.string :hub_key, null: false
      t.jsonb :objective, null: false, default: {}
      t.jsonb :reward, null: false, default: {}
      t.jsonb :progress, null: false, default: {}
      t.datetime :accepted_at
      t.datetime :deadline_at
      t.datetime :completed_at
      t.timestamps
    end
    add_index :quests, [ :player_id, :key ], unique: true
    add_index :quests, [ :player_id, :status ]
  end
end
