require "net/http"

# Real terrain: the AHN digital terrain model (DTM, "maaiveld") from PDOK's WCS, resampled to the
# game's height grid spacing and converted to the ESRI ASCII grid that Geo::HeightGrid reads.
namespace :dem do
  AHN_WCS = ENV.fetch("AHN_WCS_URL", "https://service.pdok.nl/rws/ahn/wcs/v1_0")
  DEM_RAW = Rails.root.join("data", "dem_raw.tif")     # straight from PDOK; no-data under buildings and water
  DEM_ASC = Rails.root.join("data", "dem.asc")         # what Geo::HeightGrid loads

  # RD envelope of World.bbox, padded by one tile and snapped to the tile grid so DEM cells line up with tiles.
  DEM_EXTENT = lambda do
    x0, y0, x1, y1 = World.bounds_rd
    t = World::TILE_SIZE
    [ (x0 / t.to_f).floor * t - t, (y0 / t.to_f).floor * t - t, (x1 / t.to_f).ceil * t + t, (y1 / t.to_f).ceil * t + t ]
  end

  desc "Download the AHN terrain model for World.bbox from PDOK as 10 m GeoTIFF chunks (the WCS caps requests at 4096 px)"
  task fetch: :environment do
    if DEM_RAW.exist?
      puts "#{DEM_RAW} exists, skipping (delete it to fetch again)"
      next
    end
    x0, y0, x1, y1 = DEM_EXTENT.call
    step = World::HEIGHT_STEP
    chunk = 4000 * step                                        # metres per request (4000 px)
    dir = Rails.root.join("data", "dem_chunks")
    FileUtils.mkdir_p(dir)
    (y0...y1).step(chunk).each do |cy|
      (x0...x1).step(chunk).each do |cx|
        ex, ey = [ cx + chunk, x1 ].min, [ cy + chunk, y1 ].min
        file = dir.join("#{cx}_#{cy}.tif")
        next if file.exist?
        uri = URI(AHN_WCS)
        uri.query = URI.encode_www_form(SERVICE: "WCS", VERSION: "1.0.0", REQUEST: "GetCoverage", COVERAGE: "dtm_05m",
                                        FORMAT: "GEOTIFF", CRS: "EPSG:28992", RESPONSE_CRS: "EPSG:28992",
                                        BBOX: [ cx, cy, ex, ey ].join(","), RESX: step, RESY: step)
        print "AHN chunk #{cx},#{cy} (#{((ex - cx) / step).to_i}×#{((ey - cy) / step).to_i} cells)... "
        res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 20, read_timeout: 600) { |http| http.get(uri.request_uri) }
        unless res.is_a?(Net::HTTPSuccess) && res["content-type"].to_s.include?("tiff")
          raise "AHN WCS #{res.code} #{res["content-type"]}: #{res.body.to_s[0, 300]}"
        end
        part = file.sub_ext(".part")
        part.binwrite(res.body)
        part.rename(file)
        puts "#{(file.size / 1e6).round(1)} MB"
      end
    end
    chunks = Dir[dir.join("*.tif").to_s].sort
    sh "gdalbuildvrt", "-q", dir.join("dem.vrt").to_s, *chunks
    sh "gdal_translate", "-q", "-co", "COMPRESS=DEFLATE", dir.join("dem.vrt").to_s, DEM_RAW.to_s
    puts "Wrote #{DEM_RAW} (#{(DEM_RAW.size / 1e6).round(1)} MB) from #{chunks.size} chunks"
  end

  desc "Fill no-data holes (buildings, water, past the border) and write data/dem.raw + dem.json for Geo::HeightGrid"
  task build: :environment do
    raise "#{DEM_RAW} missing; run bin/rails dem:fetch first" unless DEM_RAW.exist?
    fill = %w[gdal_fillnodata.py gdal_fillnodata].find { |bin| system("which", bin, out: File::NULL) }
    raise "GDAL not found (need gdal_fillnodata and gdal_translate): brew install gdal" unless fill && system("which", "gdal_translate", out: File::NULL)

    filled = Rails.root.join("data", "dem_filled.tif")
    raw = Rails.root.join("data", "dem.raw")
    # -md 500 cells = 5 km: also extrapolates across the border, where AHN has no data, instead of a cliff.
    sh fill, "-q", "-md", "500", DEM_RAW.to_s, filled.to_s
    # raw little-endian Float32, rows north→south (ENVI = headerless binary + .hdr); gdalinfo -json for the georeferencing
    sh "gdal_translate", "-q", "-of", "ENVI", "-ot", "Float32", filled.to_s, raw.to_s
    Rails.root.join("data", "dem.json").write(`gdalinfo -json #{raw}`)
    puts "Wrote #{raw} (#{(raw.size / 1e6).round} MB) + dem.json. Rebuild tiles: bin/rails tiles:build"
  end

  desc "Delete the downloaded and derived DEM files"
  task clean: :environment do
    FileUtils.rm_f(Dir[Rails.root.join("data", "dem*").to_s])
  end
end
