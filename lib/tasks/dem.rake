require "net/http"

# Real terrain: the AHN digital terrain model (DTM, "maaiveld") from PDOK's WCS, resampled to the
# game's height grid spacing and converted to the ESRI ASCII grid that Geo::HeightGrid reads.
namespace :dem do
  AHN_WCS = ENV.fetch("AHN_WCS_URL", "https://service.pdok.nl/rws/ahn/wcs/v1_0")
  DEM_RAW = Rails.root.join("data", "dem_raw.tif")     # straight from PDOK; no-data under buildings and water
  DEM_ASC = Rails.root.join("data", "dem.asc")         # what Geo::HeightGrid loads

  # RD envelope of World::BBOX_FULL, padded by one tile and snapped to the tile grid so DEM cells line up with tiles.
  DEM_EXTENT = lambda do
    s, w, n, e = World::BBOX_FULL
    row = ActiveRecord::Base.connection.select_one(<<~SQL)
      SELECT ST_XMin(g) x0, ST_YMin(g) y0, ST_XMax(g) x1, ST_YMax(g) y1
      FROM (SELECT ST_Transform(ST_MakeEnvelope(#{w}, #{s}, #{e}, #{n}, 4326), 28992) AS g) t
    SQL
    t = World::TILE_SIZE
    [ (row["x0"].to_f / t).floor * t - t, (row["y0"].to_f / t).floor * t - t,
      (row["x1"].to_f / t).ceil * t + t,  (row["y1"].to_f / t).ceil * t + t ]
  end

  desc "Download the AHN terrain model for World::BBOX_FULL from PDOK as a 10 m GeoTIFF (data/dem_raw.tif)"
  task fetch: :environment do
    if DEM_RAW.exist?
      puts "#{DEM_RAW} exists, skipping (delete it to fetch again)"
      next
    end
    x0, y0, x1, y1 = DEM_EXTENT.call
    step = World::HEIGHT_STEP
    uri = URI(AHN_WCS)
    uri.query = URI.encode_www_form(SERVICE: "WCS", VERSION: "1.0.0", REQUEST: "GetCoverage", COVERAGE: "dtm_05m",
                                    FORMAT: "GEOTIFF", CRS: "EPSG:28992", RESPONSE_CRS: "EPSG:28992",
                                    BBOX: [ x0, y0, x1, y1 ].join(","), RESX: step, RESY: step)
    puts "AHN DTM #{((x1 - x0) / step).to_i}×#{((y1 - y0) / step).to_i} cells at #{step} m for RD #{[ x0, y0, x1, y1 ].join(',')}"
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 20, read_timeout: 600) { |http| http.get(uri.request_uri) }
    unless res.is_a?(Net::HTTPSuccess) && res["content-type"].to_s.include?("tiff")
      raise "AHN WCS #{res.code} #{res["content-type"]}: #{res.body.to_s[0, 500]}"
    end
    part = DEM_RAW.sub_ext(".part")
    part.binwrite(res.body)
    part.rename(DEM_RAW)
    puts "Wrote #{DEM_RAW} (#{(DEM_RAW.size / 1e6).round(1)} MB)"
  end

  desc "Fill no-data holes (buildings, water, past the border) and write data/dem.asc for Geo::HeightGrid"
  task build: :environment do
    raise "#{DEM_RAW} missing; run bin/rails dem:fetch first" unless DEM_RAW.exist?
    fill = %w[gdal_fillnodata.py gdal_fillnodata].find { |bin| system("which", bin, out: File::NULL) }
    raise "GDAL not found (need gdal_fillnodata and gdal_translate): brew install gdal" unless fill && system("which", "gdal_translate", out: File::NULL)

    filled = Rails.root.join("data", "dem_filled.tif")
    # -md 500 cells = 5 km: also extrapolates across the German border, where AHN has no data, instead of a cliff.
    sh fill, "-q", "-md", "500", DEM_RAW.to_s, filled.to_s
    sh "gdal_translate", "-q", "-of", "AAIGrid", "-co", "DECIMAL_PRECISION=1", filled.to_s, DEM_ASC.to_s
    puts "Wrote #{DEM_ASC} (#{(DEM_ASC.size / 1e6).round(1)} MB). Rebuild tiles: bin/rails tiles:build"
  end

  desc "Delete the downloaded and derived DEM files"
  task clean: :environment do
    FileUtils.rm_f(Dir[Rails.root.join("data", "dem*").to_s])
  end
end
