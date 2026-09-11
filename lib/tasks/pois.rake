require "json"

# Landmarks (castles, churches, abbeys, mills, monuments, the stadium, big industrial sites, museums) from
# OpenStreetMap into the pois table. Two paths like the roads: Overpass for a small WORLD_BBOX, the Geofabrik PBF
# for the province. Both go through Poi.kind_for, the one mapping from tags to our kinds.
namespace :pois do
  POIS_JSON = Rails.root.join("data", "osm", "pois.json")

  desc "Download landmarks from Overpass for World.bbox → data/osm/pois.json"
  task fetch: :environment do
    bbox = World.bbox.map { _1.round(4) }.join(",")
    POIS_JSON.dirname.mkpath
    part = POIS_JSON.sub_ext(".part")
    puts "Overpass landmarks #{bbox}"
    part.binwrite(OVERPASS_FETCH.call(<<~QL))
      [out:json][timeout:120];
      (
        nwr["historic"~"^(castle|fort|manor|citywalls|ruins|monument|memorial|mill)$"](#{bbox});
        nwr["amenity"="place_of_worship"]["name"](#{bbox});
        nwr["man_made"~"^(windmill|watermill)$"](#{bbox});
        nwr["leisure"="stadium"](#{bbox});
        nwr["tourism"="museum"]["name"](#{bbox});
      )->.a;
      .a out center tags;
      (way["landuse"="industrial"](#{bbox}); relation["landuse"="industrial"](#{bbox});)->.b;
      .b out geom tags;
    QL
    part.rename(POIS_JSON)
    puts "Done → #{POIS_JSON}"
  end

  desc "Import data/osm/pois.json into pois"
  task import_overpass: :environment do
    raise "#{POIS_JSON} missing; run pois:fetch" unless POIS_JSON.exist?
    conn = ActiveRecord::Base.connection
    n = 0
    JSON.parse(File.read(POIS_JSON))["elements"].each do |el|
      tags = el["tags"] || {}
      area = nil
      if el["type"] == "way" && el["geometry"] && tags["landuse"] == "industrial"
        pts = el["geometry"].map { "#{_1["lon"]} #{_1["lat"]}" }
        pts << pts.first unless pts.first == pts.last
        area = conn.select_value("SELECT ST_Area(ST_Transform(ST_GeomFromText(#{conn.quote("POLYGON((#{pts.join(",")}))")}, 4326), 28992))").to_f rescue nil
      elsif el["type"] == "relation" && el["bounds"] && tags["landuse"] == "industrial"
        b = el["bounds"]
        area = conn.select_value("SELECT ST_Area(ST_Transform(ST_MakeEnvelope(#{b["minlon"]}, #{b["minlat"]}, #{b["maxlon"]}, #{b["maxlat"]}, 4326), 28992))").to_f * 0.6
      end
      kind = Poi.kind_for(tags, area:) or next
      lon, lat = el["type"] == "node" ? [ el["lon"], el["lat"] ] : [ el.dig("center", "lon"), el.dig("center", "lat") ]
      next unless lon && lat
      Poi.upsert_lonlat(osm_type: el["type"][0], osm_id: el["id"], name: tags["name"], kind:, area:, tags: tags.slice("historic", "tourism", "amenity", "building", "man_made", "leisure", "landuse", "name"), lon:, lat:)
      n += 1
    end
    puts "Upserted #{n} landmarks; by kind: #{Poi.group(:kind).count.sort_by { -_2 }.map { "#{_1}=#{_2}" }.join(", ")}"
  end

  desc "Import landmarks from the .osm.pbf (ogr2ogr multipolygons + points → pois)"
  task import: :environment do
    raise "#{PBF_FILE} missing; run osm:pbf_fetch" unless PBF_FILE.exist?
    conn = ActiveRecord::Base.connection
    c = ActiveRecord::Base.connection_db_config.configuration_hash
    pg = "PG:" + { dbname: c[:database], host: c[:host], port: c[:port], user: c[:username], password: c[:password] }.compact.map { |k, v| "#{k}=#{v}" }.join(" ")
    sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, PBF_FILE.to_s, "multipolygons", "-nln", "osm_pbf_poi_polys", "-overwrite", "-t_srs", "EPSG:28992",
       "-lco", "GEOMETRY_NAME=geom", "--config", "OSM_USE_CUSTOM_INDEXING", "NO",
       "-where", "historic IS NOT NULL OR tourism = 'museum' OR amenity = 'place_of_worship' OR leisure = 'stadium' OR man_made IN ('windmill', 'watermill') OR landuse = 'industrial' OR building IN ('castle', 'church', 'chapel', 'cathedral', 'basilica', 'windmill')"
    sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, PBF_FILE.to_s, "points", "-nln", "osm_pbf_poi_points", "-overwrite", "-t_srs", "EPSG:28992",
       "-lco", "GEOMETRY_NAME=geom", "--config", "OSM_USE_CUSTOM_INDEXING", "NO",
       "-where", "man_made IN ('windmill', 'watermill') OR other_tags LIKE '%\"historic\"=>%' OR other_tags LIKE '%\"tourism\"=>\"museum\"%' OR other_tags LIKE '%\"amenity\"=>\"place_of_worship\"%'"
    n = 0
    conn.select_rows(<<~SQL).each do |osm_id, osm_way_id, name, historic, tourism, amenity, leisure, man_made, landuse, building, other, area, x, y|
      SELECT p.osm_id, p.osm_way_id, p.name, p.historic, p.tourism, p.amenity, p.leisure, p.man_made, p.landuse, p.building, p.other_tags,
             ST_Area(p.geom), ST_X(ST_PointOnSurface(p.geom)), ST_Y(ST_PointOnSurface(p.geom))
      FROM osm_pbf_poi_polys p JOIN boundaries b ON b.name = 'Limburg' AND ST_Intersects(p.geom, b.geom)
    SQL
      tags = Poi.parse_other_tags(other).merge({ "name" => name, "historic" => historic, "tourism" => tourism, "amenity" => amenity, "leisure" => leisure, "man_made" => man_made, "landuse" => landuse, "building" => building }.compact)
      kind = Poi.kind_for(tags, area: area.to_f) or next
      type, id = osm_id.present? ? [ "r", osm_id ] : [ "w", osm_way_id ]
      Poi.upsert_rd(osm_type: type, osm_id: id.to_i, name:, kind:, area: area.to_f, tags: tags.slice("historic", "tourism", "amenity", "building", "man_made", "leisure", "landuse", "name"), x: x.to_f, y: y.to_f)
      n += 1
    end
    conn.select_rows(<<~SQL).each do |osm_id, name, man_made, other, x, y|
      SELECT p.osm_id, p.name, p.man_made, p.other_tags, ST_X(p.geom), ST_Y(p.geom)
      FROM osm_pbf_poi_points p JOIN boundaries b ON b.name = 'Limburg' AND ST_Intersects(p.geom, b.geom)
    SQL
      tags = Poi.parse_other_tags(other).merge({ "name" => name, "man_made" => man_made }.compact)
      kind = Poi.kind_for(tags) or next
      Poi.upsert_rd(osm_type: "n", osm_id: osm_id.to_i, name:, kind:, area: nil, tags: tags.slice("historic", "tourism", "amenity", "building", "man_made", "leisure", "landuse", "name"), x: x.to_f, y: y.to_f)
      n += 1
    end
    conn.execute("DROP TABLE IF EXISTS osm_pbf_poi_polys, osm_pbf_poi_points")
    puts "Upserted #{n} landmarks; by kind: #{Poi.group(:kind).count.sort_by { -_2 }.map { "#{_1}=#{_2}" }.join(", ")}"
  end
end
