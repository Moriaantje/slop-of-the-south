require "net/http"
require "json"

namespace :osm do
  OVERPASS = ENV.fetch("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
  OSM_DIR  = Rails.root.join("data", "osm")

  # POST one query; the public server answers 429/504 when busy, so back off and retry a few times.
  OVERPASS_FETCH = lambda do |query|
    uri = URI(OVERPASS)
    attempts = 0
    loop do
      attempts += 1
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 20, read_timeout: 240) do |http|
        http.post(uri.request_uri, "data=#{URI.encode_www_form_component(query)}",
                  "Content-Type" => "application/x-www-form-urlencoded")
      end
      return res.body if res.is_a?(Net::HTTPSuccess)
      raise "Overpass #{res.code}: #{res.body[0, 300]}" if attempts >= 4 || !%w[429 502 503 504].include?(res.code)
      wait = 15 * 2**(attempts - 1)
      warn "  Overpass #{res.code}, retrying in #{wait}s (#{attempts}/4)"
      sleep wait
    rescue Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNRESET => e
      raise if attempts >= 4
      warn "  #{e.class}, retrying in 15s (#{attempts}/4)"
      sleep 15
    end
  end

  desc "Download roads and buildings from Overpass for World.bbox (WORLD_BBOX=full for the whole area)"
  task fetch: :environment do
    FileUtils.mkdir_p(OSM_DIR)
    south, west, north, east = World.bbox
    step = 0.04 # degrees; keeps each Overpass request small enough to succeed

    lat = south
    while lat < north
      lon = west
      while lon < east
        bbox = [ lat, lon, [ lat + step, north ].min, [ lon + step, east ].min ].map { _1.round(4) }.join(",")
        file = OSM_DIR.join("#{bbox.tr(',', '_')}.json")
        unless file.exist?
          highway = World::HIGHWAY_TYPES.join("|")
          query = <<~QL
            [out:json][timeout:180];
            (
              way["highway"~"^(#{highway})$"](#{bbox});
              way["building"](#{bbox});
            );
            out tags geom;
          QL
          puts "Overpass #{bbox}"
          part = file.sub_ext(".part")              # never leave a truncated .json behind
          part.binwrite(OVERPASS_FETCH.call(query))
          part.rename(file)
          sleep 2 # be a polite Overpass citizen
        end
        lon += step
      end
      lat += step
    end
    places = OSM_DIR.join("places.json")
    unless places.exist?
      puts "Overpass places"
      kinds = (Place::SETTLEMENTS + Place::DISTRICTS).join("|")
      part = places.sub_ext(".part")
      part.binwrite(OVERPASS_FETCH.call(<<~QL))
        [out:json][timeout:60];
        node["place"~"^(#{kinds})$"]["name"](#{World.bbox.map { _1.round(4) }.join(",")});
        out;
      QL
      part.rename(places)
    end
    puts "Done → #{OSM_DIR}"
  end

  desc "Import data/osm/*.json into PostGIS (idempotent; reprojects to EPSG:28992)"
  task import: :environment do
    conn = ActiveRecord::Base.connection
    roads = buildings = places = 0

    Dir[OSM_DIR.join("*.json")].sort.each do |file|
      elements = JSON.parse(File.read(file))["elements"]
      skipped = 0
      # One transaction per file (a commit per row is fsync-bound); a savepoint per element lets one bad
      # geometry be skipped without aborting the rest of the file.
      conn.transaction do
        elements.each do |el|
          tags = el["tags"] || {}
          conn.transaction(requires_new: true) do
            if el["type"] == "node" && tags["place"] && tags["name"]
              conn.exec_query(<<~SQL, "place", [ el["id"], tags["name"], tags["place"], tags["population"]&.to_i, el["lon"], el["lat"] ])
                INSERT INTO places (osm_id, name, kind, population, geom, created_at, updated_at)
                VALUES ($1, $2, $3, $4, ST_Transform(ST_SetSRID(ST_MakePoint($5, $6), 4326), 28992), now(), now())
                ON CONFLICT (osm_id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind,
                  population = EXCLUDED.population, geom = EXCLUDED.geom, updated_at = now()
              SQL
              places += 1
            elsif el["type"] == "way" && el["geometry"]
              pts = el["geometry"].map { |g| "#{g["lon"]} #{g["lat"]}" }
              if (hw = tags["highway"]) && World::HIGHWAY_TYPES.include?(hw) && pts.size >= 2
                wkt = "LINESTRING(#{pts.join(",")})"
                conn.exec_query(<<~SQL, "road", [ el["id"], hw, tags["name"], World::ROAD_WIDTHS[hw], tags["oneway"] == "yes", wkt ])
                  INSERT INTO roads (osm_id, highway, name, width, oneway, geom, created_at, updated_at)
                  VALUES ($1, $2, $3, $4, $5, ST_Transform(ST_GeomFromText($6, 4326), 28992), now(), now())
                  ON CONFLICT (osm_id) DO UPDATE SET highway = EXCLUDED.highway, name = EXCLUDED.name,
                    width = EXCLUDED.width, oneway = EXCLUDED.oneway, geom = EXCLUDED.geom, updated_at = now()
                SQL
                roads += 1
              elsif tags["building"] && pts.size >= 4 && pts.first == pts.last
                levels = tags["building:levels"]&.to_i
                height = tags["height"].to_s[/[\d.]+/]&.to_f || (levels ? levels * 3.2 + 1.5 : nil) || DEFAULT_HEIGHT.call(tags["building"])
                wkt = "POLYGON((#{pts.join(",")}))"
                conn.exec_query(<<~SQL, "building", [ el["id"], tags["building"], tags["name"], height, levels, wkt ])
                  INSERT INTO buildings (osm_id, kind, name, height, levels, geom, created_at, updated_at)
                  VALUES ($1, $2, $3, $4, $5, ST_Transform(ST_MakeValid(ST_GeomFromText($6, 4326)), 28992), now(), now())
                  ON CONFLICT (osm_id) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name,
                    height = EXCLUDED.height, levels = EXCLUDED.levels, geom = EXCLUDED.geom, updated_at = now()
                SQL
                buildings += 1
              end
            end
          end
        rescue ActiveRecord::StatementInvalid => e
          skipped += 1
          warn "skip #{el["type"]} #{el["id"]}: #{e.message.lines.first}"
        end
      end
      puts "#{File.basename(file)}: #{elements.size} elements, #{skipped} skipped"
    end
    puts "Imported #{roads} roads, #{buildings} buildings, #{places} places"
  end

  DEFAULT_HEIGHT = lambda do |kind|
    case kind
    when "church", "cathedral" then 25.0
    when "apartments", "office", "commercial", "hospital", "school" then 12.0
    when "industrial", "warehouse", "retail", "supermarket" then 8.0
    when "garage", "garages", "shed", "hut" then 2.8
    else 6.5
    end
  end
end
