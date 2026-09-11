require "net/http"

# NDW traffic signs: the current-state endpoint answers with the whole country as one GeoJSON FeatureCollection
# (~1.2 GB, ~3 million signs; the documented filters are ignored), so it is downloaded once and streamed through jq,
# keeping the signs inside the world bbox.
namespace :ndw do
  NDW_URL  = ENV.fetch("NDW_SIGNS_URL", "https://data.ndw.nu/api/rest/static-road-data/traffic-signs/v4/current-state")
  NDW_FILE = Rails.root.join("data", "ndw", "current-state.json")

  desc "Download the NDW traffic-sign register (all of NL, ~1.2 GB) to data/ndw/current-state.json"
  task fetch: :environment do
    next puts("#{NDW_FILE} exists (#{(NDW_FILE.size / 1e6).round} MB); delete it to refresh") if NDW_FILE.exist?
    FileUtils.mkdir_p(NDW_FILE.dirname)
    part = NDW_FILE.sub_ext(".part")
    uri = URI(NDW_URL)
    Net::HTTP.start(uri.host, uri.port, use_ssl: true, read_timeout: 1800) do |http|
      http.request_get(uri.request_uri, "Accept" => "application/json") do |res|
        raise "NDW #{res.code}" unless res.is_a?(Net::HTTPSuccess)
        File.open(part, "wb") { |f| res.read_body { |chunk| f.write(chunk) } }
      end
    end
    part.rename(NDW_FILE)
    puts "Downloaded #{(NDW_FILE.size / 1e6).round} MB"
  end

  desc "Import the signs inside World.bbox from data/ndw/current-state.json into traffic_signs"
  task import: :environment do
    raise "#{NDW_FILE} missing; run bin/rails ndw:fetch" unless NDW_FILE.exist?
    lat0, lon0, lat1, lon1 = World.bbox
    # jq --stream keeps memory flat: lib/tasks/ndw_signs.jq rebuilds each feature from its stream events, keeps the ones in
    # the bbox and emits TSV
    tsv = NDW_FILE.sub_ext(".limburg.tsv")
    unless tsv.exist?
      puts "streaming #{NDW_FILE.basename} through jq …"
      system("jq", "-rn", "--stream", "--argjson", "lon0", lon0.to_s, "--argjson", "lat0", lat0.to_s, "--argjson", "lon1", lon1.to_s, "--argjson", "lat1", lat1.to_s,
             "-f", Rails.root.join("lib", "tasks", "ndw_signs.jq").to_s, NDW_FILE.to_s, out: tsv.sub_ext(".part").to_s) or raise "jq failed"
      tsv.sub_ext(".part").rename(tsv)
    end
    puts "#{tsv.each_line.count} signs in the bbox"

    conn = ActiveRecord::Base.connection
    conn.execute("DROP TABLE IF EXISTS ndw_stage")
    conn.execute(<<~SQL)
      CREATE TEMP TABLE ndw_stage (ndw_id text, rvv_code text, black_code text, zone_code text, text text, bearing text, side text, placement text,
        driving_direction text, road_name text, town text, county_code text, image_url text, status text, validated boolean, first_seen_on text, lon float, lat float)
    SQL
    raw = conn.raw_connection
    raw.copy_data("COPY ndw_stage FROM STDIN WITH (FORMAT text, NULL '')") { File.foreach(tsv) { |line| raw.put_copy_data(line) } }
    n = conn.exec_update(<<~SQL)
      INSERT INTO traffic_signs (ndw_id, rvv_code, black_code, zone_code, text, bearing, side, placement, driving_direction, road_name, town, county_code,
                                 image_url, status, validated, first_seen_on, geom, created_at, updated_at)
      SELECT ndw_id, rvv_code, black_code, zone_code, text, NULLIF(bearing, '')::float::int % 360, side, placement, driving_direction, road_name, town, county_code,
             image_url, status, validated, NULLIF(first_seen_on, '')::date, ST_Transform(ST_SetSRID(ST_MakePoint(lon, lat), 4326), 28992), now(), now()
      FROM ndw_stage WHERE rvv_code IS NOT NULL AND rvv_code <> ''
      ON CONFLICT (ndw_id) DO UPDATE SET rvv_code = EXCLUDED.rvv_code, black_code = EXCLUDED.black_code, zone_code = EXCLUDED.zone_code, text = EXCLUDED.text,
        bearing = EXCLUDED.bearing, side = EXCLUDED.side, placement = EXCLUDED.placement, driving_direction = EXCLUDED.driving_direction, road_name = EXCLUDED.road_name,
        town = EXCLUDED.town, county_code = EXCLUDED.county_code, image_url = EXCLUDED.image_url, status = EXCLUDED.status, validated = EXCLUDED.validated,
        first_seen_on = EXCLUDED.first_seen_on, geom = EXCLUDED.geom, updated_at = now()
    SQL
    conn.execute("ANALYZE traffic_signs")
    puts "traffic_signs: #{n} upserted, #{TrafficSign.count} total; top codes: " +
         conn.select_rows("SELECT rvv_code, count(*) FROM traffic_signs GROUP BY 1 ORDER BY 2 DESC LIMIT 15").map { |c, k| "#{c}=#{k}" }.join(", ")
  end
end
