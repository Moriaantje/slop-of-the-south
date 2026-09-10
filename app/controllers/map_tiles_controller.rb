require "net/http"

# Base map for the minimap: PDOK's BRT Achtergrondkaart (Kadaster, CC BY 4.0) as WMTS tiles in the RD tile matrix.
# Fetched on first use and cached under public/map/{z}/{x}/{y}.png, from where the static file server takes over.
class MapTilesController < ApplicationController
  WMTS = ENV.fetch("BRT_WMTS_URL", "https://service.pdok.nl/kadaster/brt-achtergrondkaart/wmts/v2_0/standaard/EPSG:28992")

  def show
    z, x, y = params.values_at(:z, :x, :y).map(&:to_i)
    return head :bad_request unless z.between?(0, 14)
    path = Rails.root.join("public", "map", z.to_s, x.to_s, "#{y}.png")
    unless path.exist?
      res = Net::HTTP.get_response(URI("#{WMTS}/#{format('%02d', z)}/#{x}/#{y}.png"))
      return head :not_found unless res.is_a?(Net::HTTPSuccess)
      path.dirname.mkpath
      path.binwrite(res.body)
    end
    expires_in 30.days, public: true
    send_file path, type: "image/png", disposition: "inline"
  end
end
