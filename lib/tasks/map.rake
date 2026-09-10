namespace :map do
  desc "Pre-build the minimap: public/map/overview.json and one detail cell per km² of the play area"
  task build: :environment do
    out = Rails.root.join("public", "map")
    FileUtils.mkdir_p(out)
    builder = MapBuilder.new
    overview = builder.overview
    out.join("overview.json").write(JSON.generate(overview))
    mx0, my0, mx1, my1 = overview[:cells]
    n = 0
    (my0...my1).each do |my|
      (mx0...mx1).each do |mx|
        out.join("#{mx}_#{my}.json").write(JSON.generate(builder.cell(mx, my)))
        n += 1
        print "\r#{n} cells" if (n % 5).zero?
      end
    end
    puts "\nWrote overview (#{(out.join('overview.json').size / 1000.0).round} KB) and #{n} cells to #{out} (#{`du -sh #{out}`.split.first})"
  end

  desc "Delete built minimap data"
  task clean: :environment do
    FileUtils.rm_rf(Rails.root.join("public", "map"))
  end
end
