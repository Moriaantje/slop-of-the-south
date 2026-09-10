module ApplicationCable
  class Connection < ActionCable::Connection::Base
    identified_by :player_id

    def connect
      self.player_id = cookies.signed[:player_id] || reject_unauthorized_connection
    end
  end
end
