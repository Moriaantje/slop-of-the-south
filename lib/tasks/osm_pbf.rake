# Roads and place names for a whole province from a Geofabrik OSM extract (.osm.pbf) via GDAL's OSM driver,
# instead of hundreds of Overpass requests. Objects are kept within 1 km of the province boundary.
namespace :osm do
  PBF_URL  = ENV.fetch("OSM_PBF_URL", "https://download.geofabrik.de/europe/netherlands/limburg-latest.osm.pbf")
  PBF_FILE = Rails.root.join("data", "osm", File.basename(URI(PBF_URL).path))

  desc "Download the Geofabrik extract (OSM_PBF_URL) to data/osm"
  task pbf_fetch: :environment do
    next puts("#{PBF_FILE} exists") if PBF_FILE.exist?
    FileUtils.mkdir_p(PBF_FILE.dirname)
    sh "curl", "-sSL", "-o", PBF_FILE.to_s, PBF_URL
    puts "Downloaded #{(PBF_FILE.size / 1e6).round} MB"
  end

  desc "Import roads and places from the .osm.pbf into PostGIS (ogr2ogr → staging → roads/places)"
  task pbf_import: :environment do
    raise "#{PBF_FILE} missing; run osm:pbf_fetch" unless PBF_FILE.exist?
    conn = ActiveRecord::Base.connection
    c = conn.instance_variable_get(:@config) || ActiveRecord::Base.connection_db_config.configuration_hash
    pg = "PG:" + { dbname: c[:database], host: c[:host], port: c[:port], user: c[:username], password: c[:password] }.compact.map { |k, v| "#{k}=#{v}" }.join(" ")
    highways = World::HIGHWAY_TYPES.map { conn.quote(_1) }.join(",")

    sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, PBF_FILE.to_s, "lines", "-nln", "osm_pbf_lines", "-overwrite", "-t_srs", "EPSG:28992",
       "-lco", "GEOMETRY_NAME=geom", "-where", "highway IN (#{highways.gsub("'", "'")})", "--config", "OSM_USE_CUSTOM_INDEXING", "NO"
    sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, PBF_FILE.to_s, "points", "-nln", "osm_pbf_points", "-overwrite", "-t_srs", "EPSG:28992",
       "-lco", "GEOMETRY_NAME=geom", "-where", "place IS NOT NULL", "--config", "OSM_USE_CUSTOM_INDEXING", "NO"

    widths = World::ROAD_WIDTHS.map { |k, w| "(#{conn.quote(k)}, #{w})" }.join(",")
    roads = conn.exec_update(<<~SQL)
      INSERT INTO roads (osm_id, highway, name, width, oneway, geom, created_at, updated_at)
      SELECT l.osm_id::bigint, l.highway, l.name, w.width, coalesce(l.other_tags LIKE '%"oneway"=>"yes"%', false), l.geom, now(), now()
      FROM osm_pbf_lines l
      JOIN (VALUES #{widths}) AS w(highway, width) ON w.highway = l.highway
      JOIN boundaries b ON b.name = 'Limburg' AND ST_DWithin(l.geom, b.geom, 1000)
      WHERE ST_GeometryType(l.geom) = 'ST_LineString' AND ST_NPoints(l.geom) >= 2
      ON CONFLICT (osm_id) DO UPDATE SET highway = EXCLUDED.highway, name = EXCLUDED.name, width = EXCLUDED.width,
        oneway = EXCLUDED.oneway, geom = EXCLUDED.geom, updated_at = now()
    SQL
    kinds = (Place::SETTLEMENTS + Place::DISTRICTS).map { conn.quote(_1) }.join(",")
    places = conn.exec_update(<<~SQL)
      INSERT INTO places (osm_id, name, kind, population, geom, created_at, updated_at)
      SELECT p.osm_id::bigint, p.name, p.place, NULLIF(substring(p.other_tags from '"population"=>"([0-9]+)"'), '')::int, p.geom, now(), now()
      FROM osm_pbf_points p
      JOIN boundaries b ON b.name = 'Limburg' AND ST_DWithin(p.geom, b.geom, 1000)
      WHERE p.place IN (#{kinds}) AND p.name IS NOT NULL
      ON CONFLICT (osm_id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, population = EXCLUDED.population, geom = EXCLUDED.geom, updated_at = now()
    SQL
    conn.execute("DROP TABLE osm_pbf_lines, osm_pbf_points")
    puts "Upserted #{roads} roads and #{places} places; totals: roads=#{Road.count} places=#{Place.count}"
  end
end
