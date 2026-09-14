# Quests grew stages, chains and an expiry date. The stage list itself stays in the objective blob — it is written
# once and never queried — but the step of a chain, the stage a player is on and the moment the whole thing goes
# stale are columns, because the board asks the table about them: which step of a line may be offered next, where a
# reconnecting player left off, and what to sweep. The index on (player_id, hub_key) is what makes a town's standing
# one cheap lookup rather than a scan, since that is now counted from the rows themselves.
class AddStagesToQuests < ActiveRecord::Migration[8.1]
  def change
    add_column :quests, :line, :string
    add_column :quests, :step, :integer, default: 0, null: false
    add_column :quests, :stage, :integer, default: 0, null: false
    add_column :quests, :expires_at, :datetime
    add_index :quests, [ :player_id, :hub_key ]
    add_index :quests, [ :player_id, :line, :status ]
  end
end
