require "zlib"
require "date"

module Game
  # The weather, which the world does not have. Nothing in the renderer rains or blows, so this is honest fiction and
  # nothing but: a deterministic sky for the day, seeded on the calendar date so that every player in every room is
  # standing under the same one and two people talking about it agree. It exists because the people at the hubs are
  # Limburgers and the first thing a Limburger says to a stranger is something about the weather, and a greeting that
  # is the same line every morning stops being a greeting after the second town.
  #
  # The pick is biased by the month, because a Limburg February and a Limburg July are not the same gamble: mist and
  # grey belong to the dark half of the year, thunder over the hills to the summer, and the clear cold morning is
  # something you only get when it has frozen. If a real sky ever lands in the renderer this module becomes its
  # mouthpiece instead of its author, and only `for` has to change.
  module Weather
    # key => [the noun a line can use, the remark the people make about it]
    KINDS = {
      helder:   [ "strakblauw", "Gèt 'n lucht, hè? Geen wolkje te bekennen." ],
      bewolkt:  [ "bewolkt", "Grijs. Zoals het hoort, anders weten we niet dat we thuis zijn." ],
      mist:     [ "mistig", "Die mist hangt in het dal tot de zon erdoor is. Rij voorzichtig." ],
      motregen: [ "miezerig", "'t Miezert. Dat is geen regen, zeggen ze hier, dat is vochtige lucht." ],
      regen:    [ "regenachtig", "Het giet. De weg is spekglad bij de bocht." ],
      onweer:   [ "onweerachtig", "Er hangt onweer boven de heuvels. Ruik je het?" ],
      wind:     [ "winderig", "Wind uit het westen, recht over de akker. De wieken draaien zich scheel." ],
      vorst:    [ "vriezend", "Het heeft gevroren vannacht. Kijk uit op de bruggen." ]
    }.freeze

    # the draw per month, a bag of keys: the same key several times is simply more likely
    BAGS = {
      1  => %i[vorst mist bewolkt bewolkt motregen regen], 2 => %i[vorst mist bewolkt motregen regen wind],
      3  => %i[bewolkt wind motregen helder regen mist],   4 => %i[helder bewolkt wind regen motregen helder],
      5  => %i[helder helder bewolkt onweer wind regen],   6 => %i[helder helder onweer bewolkt regen wind],
      7  => %i[helder helder onweer onweer bewolkt regen], 8 => %i[helder onweer bewolkt regen mist helder],
      9  => %i[helder mist bewolkt regen wind motregen],   10 => %i[mist mist bewolkt regen wind motregen],
      11 => %i[mist bewolkt motregen regen wind vorst],    12 => %i[vorst mist bewolkt regen motregen bewolkt]
    }.freeze

    Sky = Struct.new(:key, :noun, :remark, keyword_init: true)

    # the sky over the whole province on a date
    def self.for(date = Date.today)
      bag = BAGS.fetch(date.month)
      key = bag[Zlib.crc32("weer:#{date}") % bag.size]
      noun, remark = KINDS.fetch(key)
      Sky.new(key:, noun:, remark:)
    end

    # dragons fly badly in thick air, which the hunters at the lairs have opinions about
    def self.grounded?(sky) = %i[mist onweer regen].include?(sky.key)
  end
end
