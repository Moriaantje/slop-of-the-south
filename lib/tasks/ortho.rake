# Prefetch the aerial photographs for the built tiles into public/ortho (gitignored), so the game can run without
# reaching PDOK — a LAN party, a demo, a flaky connection. One 1024 px JPEG (~240 KB) per tile under public/tiles;
# resumable (existing files are kept). ORTHO_SIZE=512 for smaller files, ORTHO_FORCE=1 to refetch.
#   bin/rails ortho:fetch
namespace :ortho do
  WMS = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?request=GetMap&service=WMS&version=1.3.0&layers=Actueel_ortho25&styles=&crs=EPSG:28992&format=image/jpeg"

  def ortho_url(tx, ty, size)
    "#{WMS}&bbox=#{tx * 500},#{ty * 500},#{(tx + 1) * 500},#{(ty + 1) * 500}&width=#{size}&height=#{size}"
  end

  desc "Download the PDOK aerial photo of every built tile into public/ortho"
  task fetch: :environment do
    require "net/http"
    size = (ENV["ORTHO_SIZE"] || 1024).to_i
    out = Rails.root.join("public", "ortho"); FileUtils.mkdir_p(out)
    tiles = Dir[Rails.root.join("public", "tiles", "*_*.json*").to_s].map { File.basename(_1).split(".").first }.uniq
    abort "no tiles under public/tiles — run tiles:build first" if tiles.empty?
    done = 0
    tiles.each do |name|
      tx, ty = name.split("_").map(&:to_i)
      path = out.join("#{tx}_#{ty}.jpg")
      next if path.exist? && ENV["ORTHO_FORCE"].blank?
      res = Net::HTTP.get_response(URI(ortho_url(tx, ty, size)))
      unless res.is_a?(Net::HTTPSuccess) && res["content-type"].to_s.start_with?("image/")
        warn "#{name}: #{res.code} #{res.body.to_s[0, 120]}"; next
      end
      File.binwrite(path, res.body); done += 1
      print "\r#{done}/#{tiles.size}"
    end
    FileUtils.touch(out)   # bumps ortho.version in /api/world
    puts "\n#{done} tiles fetched into public/ortho"
  end
end
