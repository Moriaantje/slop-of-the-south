namespace :hubs do
  desc "Build the hubs table from places (towns) and pois (landmarks); HUB_MIN_POP limits villages"
  task build: :environment do
    counts = Hub.build!
    puts "Hubs: #{counts.sort.map { "#{_1}=#{_2}" }.join(", ")} (#{counts.values.sum} total, #{Hub.refs.sum { _1.npcs.size }} people)"
  end
end
