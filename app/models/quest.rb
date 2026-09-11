# One accepted quest of one player (see Game::Quests for the rules; Game::QuestStore reads and writes these rows).
class Quest < ApplicationRecord
  STATUSES = %w[active done failed].freeze
  validates :player_id, :key, :kind, :hub_key, presence: true
  validates :status, inclusion: { in: STATUSES }
end
