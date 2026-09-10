class GameController < ApplicationController
  def index
    # Stable anonymous identity for multiplayer; swap for real accounts later.
    cookies.permanent.signed[:player_id] ||= SecureRandom.uuid
    @player_id = cookies.signed[:player_id]
  end
end
