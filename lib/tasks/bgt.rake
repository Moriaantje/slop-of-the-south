require "net/http"

# BGT (Basisregistratie Grootschalige Topografie) via PDOK's OGC API Features: paged GeoJSON per collection
# for World.bbox, cached under data/bgt/<collection>/. The API has no attribute filter, so filtering happens on import.
namespace :bgt do
  BGT_API = ENV.fetch("BGT_API_URL", "https://api.pdok.nl/lv/bgt/ogc/v1")
  BGT_DIR = Rails.root.join("data", "bgt")
  BGT_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992"
  BGT_COLLECTIONS = ENV.fetch("BGT_COLLECTIONS", "vegetatieobject_punt,begroeidterreindeel").split(",")

  # woodland types that get trees scattered into them, with tree spacing (m² per tree) and height range
  BGT_WOODS = {
    "loofbos"     => { area: 45, height: 12..20 },
    "gemengd bos" => { area: 45, height: 12..20 },
    "naaldbos"    => { area: 40, height: 14..22 },
    "houtwal"     => { area: 30, height: 8..14 }
  }.freeze

  BGT_EXTENT = lambda do
    s, w, n, e = World.bbox
    row = ActiveRecord::Base.connection.select_one(<<~SQL)
      SELECT ST_XMin(g) x0, ST_YMin(g) y0, ST_XMax(g) x1, ST_YMax(g) y1
      FROM (SELECT ST_Transform(ST_MakeEnvelope(#{w}, #{s}, #{e}, #{n}, 4326), 28992) AS g) t
    SQL
    row.values_at("x0", "y0", "x1", "y1").map { _1.to_f.round }
  end

  BGT_GET = lambda do |url|
    attempts = 0
    loop do
      attempts += 1
      uri = URI(url)
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 20, read_timeout: 180) { |http| http.get(uri.request_uri, "Accept" => "application/geo+json") }
      return res.body if res.is_a?(Net::HTTPSuccess)
      raise "BGT API #{res.code}: #{res.body.to_s[0, 300]}" if attempts >= 5 || !%w[429 500 502 503 504].include?(res.code)
      warn "  BGT API #{res.code}, retrying in #{10 * attempts}s"
      sleep 10 * attempts
    rescue Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNRESET => e
      raise if attempts >= 5
      warn "  #{e.class}, retrying"
      sleep 10
    end
  end

  desc "Download BGT collections (BGT_COLLECTIONS=vegetatieobject_punt,begroeidterreindeel) for World.bbox as paged GeoJSON"
  task fetch: :environment do
    x0, y0, x1, y1 = BGT_EXTENT.call
    BGT_COLLECTIONS.each do |collection|
      dir = BGT_DIR.join(collection)
      FileUtils.mkdir_p(dir)
      done = dir.join("COMPLETE")
      if done.exist?
        puts "#{collection}: already complete (#{Dir[dir.join('page-*.json')].size} pages); delete #{done} to refetch"
        next
      end
      # resume: continue from the last saved page's next link
      pages = Dir[dir.join("page-*.json").to_s].sort_by { |f| f[/page-(\d+)/, 1].to_i }
      url = if pages.any?
        JSON.parse(File.read(pages.last))["links"].find { _1["rel"] == "next" }&.dig("href")
      else
        "#{BGT_API}/collections/#{collection}/items?f=json&limit=1000&bbox=#{x0},#{y0},#{x1},#{y1}&bbox-crs=#{BGT_CRS}&crs=#{BGT_CRS}"
      end
      n = pages.size
      while url
        n += 1
        body = BGT_GET.call(url)
        part = dir.join("page-#{n}.part")
        part.binwrite(body)
        part.rename(dir.join("page-#{n}.json"))
        json = JSON.parse(body)
        print "\r#{collection}: page #{n} (#{json["numberReturned"]} features)   "
        url = json["links"].find { _1["rel"] == "next" }&.dig("href")
      end
      FileUtils.touch(done)
      puts "\n#{collection}: #{n} pages → #{dir}"
    end
  end

  desc "Import BGT trees: vegetatieobject_punt (boom) as-is, woodland polygons filled with scattered trees"
  task import: :environment do
    conn = ActiveRecord::Base.connection
    current = ->(f) { f["properties"]["eind_registratie"].nil? }   # skip historical versions
    trees = woods = scattered = 0

    conn.transaction do
      Dir[BGT_DIR.join("vegetatieobject_punt", "page-*.json").to_s].each do |file|
        JSON.parse(File.read(file))["features"].each do |f|
          next unless current.call(f) && f["properties"]["plus_type"] == "boom" && f["geometry"]["type"] == "Point"
          x, y = f["geometry"]["coordinates"]
          # deterministic pseudo-random height 6–13 m from the id (BGT has no tree height)
          h = 6 + (f["properties"]["lokaal_id"].sum % 700) / 100.0
          conn.transaction(requires_new: true) do
            conn.exec_query(<<~SQL, "tree", [ f["properties"]["lokaal_id"], h, x, y ])
              INSERT INTO trees (source, source_id, kind, height, geom, created_at, updated_at)
              VALUES ('bgt', $1, 'boom', $2, ST_SetSRID(ST_MakePoint($3, $4), 28992), now(), now())
              ON CONFLICT (source, source_id) DO UPDATE SET height = EXCLUDED.height, geom = EXCLUDED.geom, updated_at = now()
            SQL
          end
          trees += 1
        end
      end

      Dir[BGT_DIR.join("begroeidterreindeel", "page-*.json").to_s].each do |file|
        JSON.parse(File.read(file))["features"].each do |f|
          wood = BGT_WOODS[f["properties"]["fysiek_voorkomen"]]
          next unless wood && current.call(f) && %w[Polygon MultiPolygon].include?(f["geometry"]["type"])
          woods += 1
          id = f["properties"]["lokaal_id"]
          seed = id.hash.abs % 1_000_000
          conn.transaction(requires_new: true) do
            n = conn.exec_update(<<~SQL, "wood", [ f["geometry"].to_json, wood[:area], seed, id, f["properties"]["fysiek_voorkomen"], wood[:height].min, wood[:height].max ])
              WITH g AS (SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 28992)) AS geom),
                   pts AS (SELECT (ST_Dump(ST_GeneratePoints(geom, GREATEST(1, (ST_Area(geom) / $2::float)::int), $3::int))).* FROM g)
              INSERT INTO trees (source, source_id, kind, height, geom, created_at, updated_at)
              SELECT 'bgt_bos', $4::text || '/' || path[1], $5::text, $6::float + ($7::float - $6::float) * random(), pts.geom, now(), now()
              FROM pts
              ON CONFLICT (source, source_id) DO UPDATE SET geom = EXCLUDED.geom, updated_at = now()
            SQL
            scattered += n
          end
        rescue ActiveRecord::StatementInvalid => e
          warn "skip wood #{f.dig("properties", "lokaal_id")}: #{e.message.lines.first}"
        end
      end
    end
    puts "Imported #{trees} registered trees and #{scattered} scattered trees in #{woods} woods; trees now: #{Tree.count}"
  end

  desc "Delete downloaded BGT pages"
  task clean: :environment do
    FileUtils.rm_rf(BGT_DIR)
  end
end
