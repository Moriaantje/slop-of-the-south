# Refresh the photo materials under public/textures from ambientCG (CC0). Needs curl, unzip and sips (macOS) or
# ImageMagick's `magick`. The sets are committed, so this only runs when you want a different set or a fresh copy.
#   bin/rails assets:textures
namespace :assets do
  SETS = { "asphalt" => "Asphalt012", "klinker" => "PavingStones085", "pavers" => "PavingStones070", "gravel" => "Gravel022",
           "concrete" => "Concrete034", "brick" => "Bricks059", "brick2" => "Bricks090", "plaster" => "Plaster001",
           "rooftile" => "RoofingTiles005" }.freeze

  desc "Download the ambientCG material sets into public/textures"
  task textures: :environment do
    require "tmpdir"
    Dir.mktmpdir do |tmp|
      SETS.each do |name, id|
        zip = File.join(tmp, "#{id}.zip")
        system("curl", "-sL", "-o", zip, "https://ambientcg.com/get?file=#{id}_1K-JPG.zip") or abort "download of #{id} failed"
        abort "#{id}: not a zip (does the set exist?)" if File.size(zip) < 1000
        dir = Rails.root.join("public", "textures", name); FileUtils.mkdir_p(dir)
        system("unzip", "-qo", zip, "#{id}_1K-JPG_Color.jpg", "#{id}_1K-JPG_NormalGL.jpg", "#{id}_1K-JPG_Roughness.jpg", "-d", tmp) or abort "unzip #{id} failed"
        FileUtils.cp(File.join(tmp, "#{id}_1K-JPG_Color.jpg"), dir.join("color.jpg"))
        FileUtils.cp(File.join(tmp, "#{id}_1K-JPG_NormalGL.jpg"), dir.join("normal.jpg"))
        rough = File.join(tmp, "#{id}_1K-JPG_Roughness.jpg")
        if system("which sips > /dev/null 2>&1")
          system("sips", "-Z", "512", rough, "--out", dir.join("rough.jpg").to_s, out: File::NULL)
          %w[color normal].each { |k| system("sips", "-s", "formatOptions", "80", dir.join("#{k}.jpg").to_s, "--out", dir.join("#{k}.jpg").to_s, out: File::NULL) }
        else
          system("magick", rough, "-resize", "512x512", dir.join("rough.jpg").to_s) or FileUtils.cp(rough, dir.join("rough.jpg"))
        end
        puts "#{name} ← #{id}"
      end
    end
  end
end
