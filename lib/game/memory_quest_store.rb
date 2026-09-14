module Game
  # The same for tests and for rooms without a database. It keeps the whole quest, finished ones included, because
  # the board counts a player's standing at a hub out of exactly that history and a store that forgot the settled
  # rows would make every town greet you as a stranger for ever.
  class MemoryQuestStore
    attr_reader :rows

    def initialize = @rows = {}

    def load_active(player_id) = @rows.values.select { _1[:player_id] == player_id && _1[:status] == "active" }.map(&:dup)

    def history(player_id, hub_key)
      @rows.values.select { _1[:player_id] == player_id && _1[:hub_key] == hub_key }
           .map { { key: _1[:key], status: _1[:status], line: _1[:line], step: _1[:step] } }
    end

    def save(q) = @rows[[ q[:player_id], q[:key] ]] = q.dup
  end
end
