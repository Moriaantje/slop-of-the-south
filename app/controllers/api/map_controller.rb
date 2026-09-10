module Api
  # Minimap data, built on demand and cached to public/map so the static file server takes over afterwards.
  class MapController < ApplicationController
    def overview
      serve(Rails.root.join("public", "map", "overview.json")) { MapBuilder.new.overview }
    end

    def cell
      mx, my = params[:mx].to_i, params[:my].to_i
      serve(Rails.root.join("public", "map", "#{mx}_#{my}.json")) { MapBuilder.new.cell(mx, my) }
    end

    private

    def serve(path)
      unless path.exist?
        FileUtils.mkdir_p(path.dirname)
        path.write(JSON.generate(yield))
      end
      expires_in 1.day, public: true
      send_file path, type: "application/json", disposition: "inline"
    end
  end
end
