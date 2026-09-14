module Game
  # Loads and saves sessions through the players table (id = the signed cookie uuid). A first join creates the row.
  # Unlocked skills are filtered against the tree on the way in, so a key that was renamed or dropped between
  # deploys quietly disappears from an old row instead of poisoning every stat lookup that player makes.
  class PlayerStore
    COLUMNS = %i[id name vehicle hp gold xp discovered unlocked last_hub_key].freeze

    def load(id, name)
      player = Player.find_or_create_by!(id:) { _1.name = name }
      player.update_columns(name:, last_seen_at: Time.current) if player.name != name
      attrs = player.attributes.symbolize_keys.slice(*COLUMNS)
      attrs[:vehicle] = "auto" unless Game::VEHICLES.include?(attrs[:vehicle])
      attrs[:unlocked] = Progression.known(attrs[:unlocked])
      attrs
    end

    def save(session)
      Player.where(id: session.id).update_all(session.attrs.except(:id).merge(last_seen_at: Time.current, updated_at: Time.current))
    end
  end
end
