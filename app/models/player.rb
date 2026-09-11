# A persistent player: the row behind a Game::Session, keyed by the signed player_id cookie.
class Player < ApplicationRecord
  self.primary_key = "id"

  def level = Game::Session.level(xp)
end
