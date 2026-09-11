module Api
  # One hub with what Wikipedia knows about it, for the dialogue panel and the loading screen. TownInfo memoises per
  # process, so the Dutch Wikipedia is asked once per hub.
  class HubsController < ApplicationController
    def show
      hub = Hub.refs.find { _1.key == params[:key] } or return head(:not_found)
      render json: hub.to_h.merge(lore: Game::TownInfo.fetch(hub.name, hub.kind))
    end
  end
end
