require "net/http"

# Province boundary from PDOK Bestuurlijke Gebieden (Kadaster, CC0): the edge of the world.
namespace :border do
  BESTUURLIJK = ENV.fetch("BESTUURLIJKE_GEBIEDEN_URL", "https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1")

  desc "Fetch the province boundary (PROVINCE=Limburg) into the boundaries table"
  task fetch: :environment do
    province = ENV.fetch("PROVINCE", "Limburg")
    uri = URI("#{BESTUURLIJK}/collections/provinciegebied/items?f=json&limit=20&crs=http://www.opengis.net/def/crs/EPSG/0/28992")
    res = Net::HTTP.get_response(uri)
    raise "PDOK #{res.code}: #{res.body[0, 200]}" unless res.is_a?(Net::HTTPSuccess)
    feature = JSON.parse(res.body)["features"].find { |f| f["properties"]["naam"] == province }
    raise "province #{province} not found" unless feature
    conn = ActiveRecord::Base.connection
    conn.exec_query(<<~SQL, "boundary", [ province, feature["geometry"].to_json ])
      INSERT INTO boundaries (name, geom, created_at, updated_at)
      VALUES ($1, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2), 28992)), 3)), now(), now())
      ON CONFLICT (name) DO UPDATE SET geom = EXCLUDED.geom, updated_at = now()
    SQL
    b = Boundary.find_by!(name: province)
    area, pts = conn.select_rows("SELECT round(ST_Area(geom) / 1e6), ST_NPoints(geom) FROM boundaries WHERE name = #{conn.quote(province)}").first
    puts "#{province}: #{area} km², #{pts} vertices, #{Boundary.rings_for_client(province).size} ring(s) for the client"
  end
end
