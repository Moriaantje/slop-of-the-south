require "test_helper"

module Game
  class DayClockTest < ActiveSupport::TestCase
    # the same warp DayNight.js does, written out independently: seven eighths of the cycle covers 03:45 → 22:15
    def js_warp(seconds)
      day_hours = 22.25 - 3.75
      day_seconds = 480.0 - 60.0
      return 3.75 + day_hours * (seconds / day_seconds) if seconds < day_seconds
      (22.25 + (24 - day_hours) * ((seconds - day_seconds) / 60.0)) % 24
    end

    test "the server clock walks the same warped day the sky does" do
      (0..479).step(7) do |s|
        assert_in_delta js_warp(s), DayClock.hours(s * 1000), 1e-9, "at #{s} s into the cycle"
      end
    end

    test "the day starts and ends where the sky says it does" do
      assert_in_delta 3.75, DayClock.hours(0), 1e-9
      assert_in_delta 22.25, DayClock.hours(420_000), 1e-9
      assert_equal "03:45", DayClock.clock(0)
    end

    test "phases and the dark hours line up with the greetings" do
      assert_equal %i[nacht vroeg ochtend middag avond schemer nacht],
                   [ 2.0, 6.0, 9.0, 13.0, 18.0, 21.0, 23.0 ].map { DayClock.phase_of(_1) }
      assert_equal "Goeiemiddag", DayClock::GREET.fetch(DayClock.phase_of(13.0))
      assert DayClock.dark_hour?(23.0)
      assert DayClock.dark_hour?(3.0)
      refute DayClock.dark_hour?(13.0)
    end

    test "the weather is one sky for the whole province, the same all day and different tomorrow" do
      day = Date.new(2026, 9, 13)
      sky = Weather.for(day)
      assert_equal sky, Weather.for(day)
      assert_includes Weather::KINDS.keys, sky.key
      refute_empty sky.remark
      seen = (0..30).map { Weather.for(day + _1).key }.uniq
      assert_operator seen.size, :>=, 3, "a month of the same weather is not weather"
      # July never freezes and January is never thundery
      assert_empty (0..30).map { Weather.for(Date.new(2026, 7, 1) + _1).key } & [ :vorst ]
      assert_empty (0..30).map { Weather.for(Date.new(2026, 1, 1) + _1).key } & [ :onweer ]
    end
  end
end
