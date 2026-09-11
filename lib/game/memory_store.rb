module Game
  # For tests and for rooms that should not touch the database.
  class MemoryStore
    attr_reader :rows

    def initialize(rows = {})
      @rows = rows
    end

    def load(id, name) = (@rows[id] ||= { id:, name:, vehicle: "auto", hp: Session::MAX_HP, gold: 0, xp: 0, discovered: [], last_hub_key: nil }).merge(name:)
    def save(session) = @rows[session.id] = session.attrs
  end
end
