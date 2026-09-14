# A persistent player: the row behind a Game::Session, keyed by the signed player_id cookie. The level, the skill
# points and the stat block are derived from xp and the unlocked column rather than stored, so a row can never
# disagree with itself — the only thing spending a point writes is one more string in `unlocked`.
class Player < ApplicationRecord
  self.primary_key = "id"

  def level = Game::Progression.level(xp)
  def skills = Game::Progression.known(unlocked)
  def skill_points = Game::Progression.points_left(level, skills)
  def stats = Game::Progression.stats(level, skills)
end
