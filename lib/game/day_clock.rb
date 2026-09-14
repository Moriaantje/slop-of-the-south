module Game
  # The server's copy of the sky's clock. DayNight.js runs a whole game day in eight wall-clock minutes, warped so
  # that the daylight hours take seven of them and the short night the eighth, and it reads the wall clock directly
  # rather than a server value, which is what lets every browser agree on the hour without a message. The people at
  # the hubs have to greet you by the same hour the sky shows, so the warp is mirrored here instead of shipped down
  # from the client: a client that lies about its clock would otherwise put a "goodemorgen" under a midnight sky.
  # Anything in here that changes must change in DayNight.js as well; the numbers are deliberately the same names.
  module DayClock
    DAY_SECONDS   = 480.0               # wall seconds for a whole game day
    NIGHT_SECONDS = 60.0                # of those, the hours between NIGHT_FROM and NIGHT_TO
    NIGHT_FROM    = 22.25               # game hour the night starts
    NIGHT_TO      = 3.75                # game hour it ends

    # game hour 0..24 for a server time in milliseconds
    def self.hours(now_ms = Game.now_ms)
      s = (now_ms / 1000.0) % DAY_SECONDS
      day_hours = NIGHT_FROM - NIGHT_TO
      day_seconds = DAY_SECONDS - NIGHT_SECONDS
      return NIGHT_TO + day_hours * (s / day_seconds) if s < day_seconds
      (NIGHT_FROM + (24 - day_hours) * ((s - day_seconds) / NIGHT_SECONDS)) % 24
    end

    # "07:12", the same string the HUD clock shows
    def self.clock(now_ms = Game.now_ms)
      h = hours(now_ms)
      format("%02d:%02d", h.floor, ((h % 1) * 60).floor)
    end

    DARK_FROM = 21.0                    # game hour a vigil starts counting
    DARK_TO   = 4.5                     # and stops

    # the part of the day a greeting has to fit: dawn and dusk are their own thing because that is when the light is
    # worth a remark and when the dragons are usually out
    def self.phase(now_ms = Game.now_ms) = phase_of(hours(now_ms))

    def self.phase_of(h)
      case h
      when 0...5    then :nacht
      when 5...7    then :vroeg
      when 7...12   then :ochtend
      when 12...17  then :middag
      when 17...20  then :avond
      when 20...22.5 then :schemer
      else :nacht
      end
    end

    GREET = { nacht: "Goedenacht", vroeg: "Moarge", ochtend: "Goedemorgen", middag: "Goeiemiddag",
              avond: "Goedenavond", schemer: "Goedenavond" }.freeze
    NOUN  = { nacht: "midden in de nacht", vroeg: "zo vroeg", ochtend: "vanmorgen", middag: "vanmiddag",
              avond: "vanavond", schemer: "met dit laatste licht" }.freeze

    def self.greeting(now_ms = Game.now_ms) = GREET.fetch(phase(now_ms))
    def self.noun(now_ms = Game.now_ms) = NOUN.fetch(phase(now_ms))

    # dark enough for the things that only count at night
    def self.dark_hour?(h) = h >= DARK_FROM || h < DARK_TO
    def self.dark?(now_ms = Game.now_ms) = dark_hour?(hours(now_ms))
  end
end
