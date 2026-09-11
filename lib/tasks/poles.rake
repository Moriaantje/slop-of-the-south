# Street furniture points: BGT Paal (lamp posts, traffic-signal poles, sign posts …) from the bulk extracts, plus OSM
# nodes for signalised intersections/crossings and street lamps where BGT has none. Paal is an optional IMGeo ("plus")
# object: bgt-type is always niet-bgt and plus-type carries the kind, and some municipalities (Parkstad) deliver none.
namespace :bgt do
  desc "Import data/bgt/bulk/*-paal.zip (BGT_BULK_TYPES=paal bin/rails bgt:bulk_fetch) into poles"
  task paal_import: :environment do
    conn = ActiveRecord::Base.connection
    c = ActiveRecord::Base.connection_db_config.configuration_hash
    pg = "PG:" + { dbname: c[:database], host: c[:host], port: c[:port], user: c[:username], password: c[:password] }.compact.map { |k, v| "#{k}=#{v}" }.join(" ")
    zips = Dir[BULK_DIR.join("*-paal.zip").to_s].sort
    raise "no paal extracts; run BGT_BULK_TYPES=paal bin/rails bgt:bulk_fetch" if zips.empty?
    sql = %(SELECT gml_id, "bgt-type" AS bgt_type, "plus-type" AS plus_type, "bgt-status" AS status, eindRegistratie, objectEindTijd FROM Paal)
    conn.execute("DROP TABLE IF EXISTS bulk_bgt_paal")
    zips.each_with_index do |zip, i|
      dir = Pathname(zip).sub_ext("")
      sh "unzip", "-oq", zip, "-d", dir.to_s, verbose: false unless dir.exist?
      gml = dir.join("bgt_paal.gml")
      next unless gml.exist?
      # an extract without poles has a GML file without the Paal layer; ogr2ogr then fails and the municipality is skipped
      mode = conn.table_exists?("bulk_bgt_paal") ? [ "-append" ] : %w[-overwrite -lco GEOMETRY_NAME=geom]
      ok = system("ogr2ogr", "-q", "-f", "PostgreSQL", pg, gml.to_s, *mode, "-nln", "bulk_bgt_paal", "-a_srs", "EPSG:28992",
                  "-sql", sql, "--config", "GML_SKIP_RESOLVE_ELEMS", "ALL", err: File::NULL)
      print "\r#{i + 1}/#{zips.size} #{File.basename(zip, '.zip')}#{ok ? '' : ' (no poles)'}   "
    end
    puts
    kinds = Pole::KINDS.map { |k, v| "WHEN #{conn.quote(k)} THEN #{conn.quote(v)}" }.join(" ")
    n = conn.exec_update(<<~SQL)
      INSERT INTO poles (source, source_id, kind, attrs, geom, created_at, updated_at)
      SELECT DISTINCT ON (gml_id) 'bgt', gml_id, CASE plus_type #{kinds} ELSE plus_type END, '{}'::jsonb, ST_Force2D(geom), now(), now()
      FROM bulk_bgt_paal
      WHERE eindregistratie IS NULL AND objecteindtijd IS NULL AND status = 'bestaand' AND plus_type IS NOT NULL AND plus_type <> 'waardeOnbekend'
        AND ST_GeometryType(geom) = 'ST_Point'
      ORDER BY gml_id
      ON CONFLICT (source, source_id) DO UPDATE SET kind = EXCLUDED.kind, attrs = EXCLUDED.attrs, geom = EXCLUDED.geom, updated_at = now()
    SQL
    conn.execute("DROP TABLE bulk_bgt_paal")
    conn.execute("ANALYZE poles")
    puts "poles: #{n} upserted; by kind: " + conn.select_rows("SELECT kind, count(*) FROM poles WHERE source = 'bgt' GROUP BY 1 ORDER BY 2 DESC").map { |k, m| "#{k}=#{m}" }.join(", ")
  end
end

namespace :osm do
  desc "Import traffic signals, signalised crossings and (fallback) street lamps from the .osm.pbf into poles"
  task pbf_points: :environment do
    raise "#{PBF_FILE} missing; run bin/rails osm:pbf_fetch" unless PBF_FILE.exist?
    conn = ActiveRecord::Base.connection
    c = ActiveRecord::Base.connection_db_config.configuration_hash
    pg = "PG:" + { dbname: c[:database], host: c[:host], port: c[:port], user: c[:username], password: c[:password] }.compact.map { |k, v| "#{k}=#{v}" }.join(" ")
    sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, PBF_FILE.to_s, "points", "-nln", "osm_pbf_furniture", "-overwrite", "-t_srs", "EPSG:28992",
       "-lco", "GEOMETRY_NAME=geom", "-where", "highway IN ('traffic_signals', 'crossing', 'street_lamp')", "--config", "OSM_USE_CUSTOM_INDEXING", "NO"
    conn.execute("DELETE FROM poles WHERE source = 'osm'")
    n = conn.exec_update(<<~SQL)
      INSERT INTO poles (source, source_id, kind, attrs, geom, created_at, updated_at)
      SELECT 'osm', osm_id, kind, '{}'::jsonb, geom, now(), now() FROM (
        SELECT p.osm_id, p.geom,
               CASE WHEN p.highway = 'traffic_signals' THEN 'signal_node'
                    WHEN p.highway = 'crossing' AND p.other_tags LIKE '%"crossing"=>"traffic_signals"%' THEN 'crossing_signal'
                    WHEN p.highway = 'street_lamp' AND NOT EXISTS (SELECT 1 FROM poles b WHERE b.source = 'bgt' AND b.kind = 'lamp' AND ST_DWithin(b.geom, p.geom, 15)) THEN 'lamp'
               END AS kind
        FROM osm_pbf_furniture p
      ) s WHERE kind IS NOT NULL
    SQL
    conn.execute("DROP TABLE osm_pbf_furniture")
    conn.execute("ANALYZE poles")
    puts "poles from OSM: #{n}; " + conn.select_rows("SELECT kind, count(*) FROM poles WHERE source = 'osm' GROUP BY 1 ORDER BY 2 DESC").map { |k, m| "#{k}=#{m}" }.join(", ")
  end
end
