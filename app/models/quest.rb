# One quest of one player, taken from a hub (see Game::Quests for the rules; Game::QuestStore reads and writes these
# rows). The row outlives the quest on purpose: a finished or botched one is never deleted, because the rows of one
# player at one hub are what that town's standing is counted from, and `line`/`step` are what tells the board which
# step of a chain it may offer next.
class Quest < ApplicationRecord
  STATUSES = %w[active done failed expired].freeze
  SETTLED  = %w[done failed expired].freeze

  validates :player_id, :key, :kind, :hub_key, presence: true
  validates :status, inclusion: { in: STATUSES }

  scope :active, -> { where(status: "active") }
  scope :settled, -> { where(status: SETTLED) }
  scope :at_hub, ->(hub_key) { where(hub_key:) }
  scope :of_line, ->(line) { where(line:) }

  def settled? = SETTLED.include?(status)
  def stages = Array(objective["stages"])
end
