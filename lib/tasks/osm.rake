require "net/http"
require "json"

namespace :osm do
  OVERPASS = "https://overpass-api.de/api/interpreter"
  OSM_DIR  = Rails.root.join("data", "osm")

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
          res = Net::HTTP.post(URI(OVERPASS), "data=#{URI.encode_www_form_component(query)}",
                               "Content-Type" => "application/x-www-form-urlencoded")
          raise "Overpass #{res.code}: #{res.body[0, 300]}" unless res.is_a?(Net::HTTPSuccess)
          file.write(res.body)
          sleep 2 # be a polite Overpass citizen
        end
        lon += step
      end
      lat += step
    end
    puts "Done → #{OSM_DIR}"
  end

  desc "Import data/osm/*.json into PostGIS (idempotent; reprojects to EPSG:28992)"
  task import: :environment do
    conn = ActiveRecord::Base.connection
    roads = buildings = 0

    Dir[OSM_DIR.join("*.json")].each do |file|
      JSON.parse(File.read(file))["elements"].each do |el|
        next unless el["type"] == "way" && el["geometry"]
        tags = el["tags"] || {}
        pts  = el["geometry"].map { |g| "#{g['lon']} #{g['lat']}" }

        if (hw = tags["highway"]) && World::HIGHWAY_TYPES.include?(hw) && pts.size >= 2
          wkt = "LINESTRING(#{pts.join(',')})"
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
          wkt = "POLYGON((#{pts.join(',')}))"
          conn.exec_query(<<~SQL, "building", [ el["id"], tags["building"], tags["name"], height, levels, wkt ])
            INSERT INTO buildings (osm_id, kind, name, height, levels, geom, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, ST_Transform(ST_MakeValid(ST_GeomFromText($6, 4326)), 28992), now(), now())
            ON CONFLICT (osm_id) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name,
              height = EXCLUDED.height, levels = EXCLUDED.levels, geom = EXCLUDED.geom, updated_at = now()
          SQL
          buildings += 1
        end
      rescue ActiveRecord::StatementInvalid => e
        warn "skip way #{el['id']}: #{e.message.lines.first}"
      end
    end
    puts "Imported #{roads} roads, #{buildings} buildings"
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
