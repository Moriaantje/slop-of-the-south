# The only thing progression needs to remember. The level, the skill points and the whole stat block fall out of xp
# and this array (Game::Progression), so there is no stored balance that a replayed message could credit twice and
# nothing to migrate again when the tree is rebalanced.
class AddUnlockedToPlayers < ActiveRecord::Migration[8.1]
  def change
    add_column :players, :unlocked, :string, array: true, null: false, default: []
  end
end
