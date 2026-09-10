namespace :tiles do
  desc "Pre-build every tile that has roads or buildings into public/tiles/*.json"
  task build: :environment do
    out = Rails.root.join("public", "tiles")
    FileUtils.mkdir_p(out)
    s = World::TILE_SIZE

    # Tile indices touched by any imported geometry
    rows = ActiveRecord::Base.connection.select_rows(<<~SQL)
      SELECT DISTINCT tx, ty FROM (
        SELECT geom FROM roads UNION ALL SELECT geom FROM buildings
      ) g,
      generate_series(floor(ST_XMin(geom) / #{s})::int, floor(ST_XMax(geom) / #{s})::int) AS tx,
      generate_series(floor(ST_YMin(geom) / #{s})::int, floor(ST_YMax(geom) / #{s})::int) AS ty
      ORDER BY tx, ty
    SQL

    builder = TileBuilder.new
    rows.each_with_index do |(tx, ty), i|
      out.join("#{tx}_#{ty}.json").write(JSON.generate(builder.build(tx, ty)))
      print "\r#{i + 1}/#{rows.size} tiles" if (i % 10).zero?
    end
    puts "\nWrote #{rows.size} tiles to #{out}"
  end

  desc "Delete built tiles"
  task clean: :environment do
    FileUtils.rm_rf(Rails.root.join("public", "tiles"))
  end
end
