module Game
  # the same for tests and rooms without a database
  class MemoryQuestStore
    attr_reader :rows

    def initialize = @rows = {}
    def load_active(player_id) = @rows.values.select { _1[:player_id] == player_id && _1[:status] == "active" }.map(&:dup)
    def save(q) = @rows[[ q[:player_id], q[:key] ]] = q.dup
  end
end
