module Api
  # Fallback for tiles not pre-built into public/tiles: build on demand, then cache to disk.
  class TilesController < ApplicationController
    def show
      tx, ty = params[:tx].to_i, params[:ty].to_i
      path = Rails.root.join("public", "tiles", "#{tx}_#{ty}.json")
      unless path.exist?
        FileUtils.mkdir_p(path.dirname)
        path.write(JSON.generate(TileBuilder.new.build(tx, ty)))
      end
      expires_in 1.day, public: true
      send_file path, type: "application/json", disposition: "inline"
    end
  end
end
