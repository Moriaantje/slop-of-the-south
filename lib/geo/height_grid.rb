# Samples the terrain model bilinearly. Reads the raw Float32 grid that `rake dem:build` writes (data/dem.raw +
# data/dem.json from gdalinfo) row by row on demand, so a province-sized DEM costs no memory to speak of.
# Falls back to a flat world at 40 m NAP (≈ Geleen) when no DEM exists.
module Geo
  class HeightGrid
    FLAT_HEIGHT = 40.0
    ROW_CACHE = 512          # rows kept in memory (a 500 m tile touches ~52)

    def self.load(dir = Rails.root.join("data"))
      raw, meta = dir.join("dem.raw"), dir.join("dem.json")
      raw.exist? && meta.exist? ? new(raw, meta) : Flat.new
    end

    # Loaded once per process.
    def self.current
      @current ||= load
    end

    class Flat
      def sample(_x, _y) = FLAT_HEIGHT
    end

    attr_reader :ncols, :nrows, :cell

    def initialize(raw, meta)
      info = JSON.parse(File.read(meta))
      @ncols, @nrows = info.fetch("size")
      x0, dx, _, y0, _, dy = info.fetch("geoTransform")
      @x0, @y0, @cell = x0.to_f, y0.to_f, dx.to_f          # top-left corner, square cells (dy is negative)
      raise "DEM cells are not square (#{dx}, #{dy})" unless (dx + dy).abs < 1e-6
      @nodata = info.dig("bands", 0, "noDataValue")&.to_f
      @file = File.open(raw, "rb")
      @rows = {}
      @lock = Mutex.new
    end

    # x, y in RD metres
    def sample(x, y)
      fx = (x - @x0) / @cell - 0.5
      fy = (@y0 - y) / @cell - 0.5
      c0 = fx.floor.clamp(0, @ncols - 2)
      r0 = fy.floor.clamp(0, @nrows - 2)
      tx = (fx - c0).clamp(0.0, 1.0)
      ty = (fy - r0).clamp(0.0, 1.0)
      a, b = row(r0), row(r0 + 1)
      h00, h10 = at(a, c0), at(a, c0 + 1)
      h01, h11 = at(b, c0), at(b, c0 + 1)
      top = h00 + (h10 - h00) * tx
      bot = h01 + (h11 - h01) * tx
      top + (bot - top) * ty
    end

    private

    def row(r)
      @lock.synchronize do
        @rows.clear if @rows.size >= ROW_CACHE
        @rows[r] ||= @file.pread(@ncols * 4, r * @ncols * 4).unpack("e*")
      end
    end

    def at(row, c)
      v = row[c]
      v.nil? || v.nan? || v == @nodata || v.abs > 1e30 ? FLAT_HEIGHT : v
    end
  end
end
