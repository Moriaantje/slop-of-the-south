# Reads an ESRI ASCII grid (gdal_translate -of AAIGrid) in EPSG:28992 and samples it bilinearly.
# Falls back to a flat world at 40 m NAP (≈ Geleen) when no DEM file exists.
module Geo
  class HeightGrid
    FLAT_HEIGHT = 40.0

    def self.load(path = Rails.root.join("data", "dem.asc"))
      File.exist?(path) ? new(path) : Flat.new
    end

    # Parsed once per process: the DEM is tens of MB of ASCII, too slow to reload for every on-demand tile.
    def self.current
      @current ||= load
    end

    class Flat
      def sample(_x, _y) = FLAT_HEIGHT
    end

    attr_reader :ncols, :nrows, :xll, :yll, :cell

    def initialize(path)
      header = {}
      rows = []
      File.foreach(path) do |line|
        key, val = line.split(" ", 2)
        if %w[ncols nrows xllcorner yllcorner cellsize NODATA_value xllcenter yllcenter].include?(key)
          header[key] = val.to_f
        else
          rows << line.split.map!(&:to_f)
        end
      end
      @ncols  = header["ncols"].to_i
      @nrows  = header["nrows"].to_i
      @cell   = header["cellsize"]
      @nodata = header["NODATA_value"] || -9999.0
      @xll    = header["xllcorner"] || (header["xllcenter"] - @cell / 2)
      @yll    = header["yllcorner"] || (header["yllcenter"] - @cell / 2)
      @rows   = rows # rows[0] is the NORTHERNMOST row
    end

    # x, y in RD metres
    def sample(x, y)
      fx = (x - @xll) / @cell - 0.5
      fy = (@yll + @nrows * @cell - y) / @cell - 0.5
      c0 = fx.floor.clamp(0, @ncols - 2)
      r0 = fy.floor.clamp(0, @nrows - 2)
      tx = (fx - c0).clamp(0.0, 1.0)
      ty = (fy - r0).clamp(0.0, 1.0)

      h00 = at(r0, c0);     h10 = at(r0, c0 + 1)
      h01 = at(r0 + 1, c0); h11 = at(r0 + 1, c0 + 1)
      top = h00 + (h10 - h00) * tx
      bot = h01 + (h11 - h01) * tx
      top + (bot - top) * ty
    end

    private

    def at(r, c)
      v = @rows[r][c]
      v == @nodata || v.abs > 1e30 ? FLAT_HEIGHT : v   # GDAL writes float-max for no-data
    end
  end
end
