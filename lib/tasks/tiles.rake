namespace :tiles do
  desc "Pre-build every tile that has roads or buildings into public/tiles/*.json"
  task build: :environment do
    out = Rails.root.join("public", "tiles")
    FileUtils.mkdir_p(out)
    s = World::TILE_SIZE

    # Tile indices touched by any imported geometry
    rows = ActiveRecord::Base.connection.select_rows(<<~SQL)
WITH area AS (SELECT ST_Buffer(geom, 1000) AS geom FROM boundaries WHERE name = 'Limburg'),
cand AS (
  SELECT DISTINCT tx, ty FROM (
    SELECT geom FROM roads UNION ALL SELECT geom FROM buildings UNION ALL SELECT geom FROM trees
  ) g,
  generate_series(floor(ST_XMin(g.geom) / #{s})::int, floor(ST_XMax(g.geom) / #{s})::int) AS tx,
  generate_series(floor(ST_YMin(g.geom) / #{s})::int, floor(ST_YMax(g.geom) / #{s})::int) AS ty
)
-- only tiles inside (or within 1 km of) the province: beyond the border the world is on fire anyway
SELECT cand.tx, cand.ty FROM cand
WHERE NOT EXISTS (SELECT 1 FROM area) OR EXISTS (
  SELECT 1 FROM area WHERE ST_Intersects(area.geom, ST_MakeEnvelope(cand.tx * #{s}, cand.ty * #{s}, (cand.tx + 1) * #{s}, (cand.ty + 1) * #{s}, 28992)))
ORDER BY tx, ty
    SQL

# WORKERS=n (default 4) forks n processes, each building every n-th tile
workers = ENV.fetch("WORKERS", "4").to_i.clamp(1, 16)
# libpq's GSS/Kerberos negotiation goes through macOS frameworks that are not fork-safe: a forked child segfaults in
# connect_start. Skipping GSS encryption (we connect over a local socket anyway) avoids it; OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES
# in the shell covers the rest of the Objective-C runtime.
ENV["PGGSSENCMODE"] ||= "disable"
ActiveRecord::Base.connection_pool.disconnect!
pids = workers.times.map do |w|
  Process.fork do
    builder = TileBuilder.new
    rows.each_with_index do |(tx, ty), i|
      next unless i % workers == w
      out.join("#{tx}_#{ty}.json").write(JSON.generate(builder.build(tx, ty)))
      print "\r#{i + 1}/#{rows.size} tiles" if w.zero? && (i % 50).zero?
    end
  end
end
failed = pids.count { |pid| Process.wait(pid); !$?.success? }
written = Dir[out.join("*.json").to_s].size
puts "\nWrote #{written} of #{rows.size} tiles to #{out} with #{workers} workers"
abort "#{failed} worker(s) died — on macOS run with OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES (see README)" if failed.positive?
  end

  desc "Delete built tiles"
  task clean: :environment do
    FileUtils.rm_rf(Rails.root.join("public", "tiles"))
  end
end
