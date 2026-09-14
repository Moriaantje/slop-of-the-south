require "zlib"

module Game
  # What the people say. This is the only place in the game with a voice, so it gets the room: every line is Dutch
  # with as much Limburgish in it as a stranger can still follow, and nothing here is filler — a line that could be
  # said by anybody in any town on any day has no business being in a conversation that is meant to make you drive
  # back to that town.
  #
  # Variety comes from the world rather than from a random number. A conversation is assembled out of four things
  # the game already knows: who is talking (the role, and a temperament derived from their id, so the same Sjeng is
  # dry every time), how well they know you (the standing you have built at that hub, which is counted from the
  # quests you finished there), where they are standing (the town's name and kind, the first sentence of its Dutch
  # Wikipedia article, the landmark over the hill, whether the dragon at the nearest lair is awake) and when you
  # walked up (the game clock, and the day's weather). The seed that picks between equal candidates is the person's
  # id plus a coarse time bucket, so a conversation is stable while you are having it and different the next time.
  #
  # Everything degrades: no article cached yet, no lair in range, no dragon hook wired up — the line simply is not
  # offered and the next candidate is. The one rule is that the result is never empty and never generic.
  module Dialogue
    RANKS = [ 0, 4, 10, 20, 36 ].freeze                # standing points at which each rank starts
    RANK_NL = [ "vremdje", "bekende", "vertrouwd", "vrundj", "ereburger" ].freeze
    BUCKET_MS = 90_000                                 # a conversation keeps the same lines for this long

    # Everything one conversation needs. Built by Game::Quests::Board; nothing in here fetches anything.
    Scene = Struct.new(:npc, :hub, :rank, :standing, :phase, :sky, :trait, :blurb, :landmark, :dragon, :now, keyword_init: true) do
      def role = npc[:role].to_s
      def name = npc[:name].to_s
      def first_name = name.split(" ").first.to_s
      def town = hub.name.to_s
      def kind_nl = TownInfo::KIND_NL[hub.kind] || "plaats"
      def rank_nl = RANK_NL[rank.to_i.clamp(0, RANK_NL.size - 1)]
      def seed = Zlib.crc32("#{npc[:id]}:#{(now.to_i / BUCKET_MS)}")
    end

    # ---- how a person opens -------------------------------------------------------------------------------------

    # the introduction, for someone who has never done anything for this hub
    INTRO = {
      "burgemeester" => [ "%{name}, burgemeester van %{town}. En jij bent die met die machine.",
                          "Ik ben %{name}. Ik besta uit vergaderingen, en soms uit %{town}." ],
      "herbergier"   => [ "%{name}, van de herberg. Kom binnen, de deur staat toch open.",
                          "%{name}. Ik tap, ik luister, en ik onthoud alles. Dat laatste vergeet men altijd." ],
      "smid"         => [ "%{name}, smid. Handen vol werk, dus zeg het kort.",
                          "%{name}. Aan die machine van jou valt nog wel wat te verbeteren, maar dat kost tijd en tijd kost geld." ],
      "kapelaan"     => [ "Vrede zij met je. %{name}, kapelaan van %{town}.",
                          "%{name}, kapelaan. Kom binnen, hier geneest men sneller dan buiten." ],
      "abt"          => [ "De abdij heet je welkom. %{name}, abt.",
                          "%{name}. Wie hier komt mag op adem komen, en betaalt dat met een verhaal." ],
      "jager"        => [ "Sst. %{name}, drakenjager. Praat zacht en kijk omhoog.",
                          "%{name}. Ik jaag op wat hier zit, en ik doe dat al langer dan goed voor me is." ],
      "koopman"      => [ "%{name}, koopman. Alles te koop, alles te bezorgen, alles bespreekbaar.",
                          "%{name}. Handel is bewegen, en jij beweegt hard, hoor ik." ],
      "molenaar"     => [ "%{name}, molenaar van %{town}. Het meel moet de deur uit.",
                          "%{name}. De wieken draaien, de zakken staan klaar, en er is nooit iemand." ]
    }.freeze
    INTRO_FALLBACK = [ "%{name}, uit %{town}. Zeg het maar." ].freeze

    # what they say once you have done something for the town: one pool per rank, above the introduction
    RECOGNISE = [
      [],                                                                       # rank 0 has no history to recognise
      [ "Jij bent die van laatst, hè. Dat ging goed.", "Ah, de sjauffeur. Je hebt %{town} al een dienst bewezen." ],
      [ "Kiek ins aan, doe weer. Ga je gang.", "Jij weer. Ik begin eraan te wennen, en dat zeg ik niet snel." ],
      [ "Daar hebben we hem. In %{town} hoef jij niets meer uit te leggen.", "Vrundj. Wat ze hier over je zeggen is voor één keer waar." ],
      [ "De ereburger van %{town} zelf. Zeg het maar, het is al geregeld.", "Voor jou doe ik de deur open voor je geklopt hebt." ]
    ].freeze

    # a line in the temperament of the person, said somewhere in the middle
    TRAIT_LINE = {
      droog:          [ "Ja.", "Tja.", "Zo is het." ],
      breed:          [ "Maar goed, dat is een lang verhaal en daar heb jij geen tijd voor, dus ik hou het kort, al is kort nooit mijn sterkste kant geweest.",
                        "Enfin. Waar was ik. Ja." ],
      kort:           [ "Snel graag, ik heb het druk.", "Kort houden." ],
      joviaal:        [ "Maar eerst: alles goed met je? Mooi. Dan dat.", "Ach jong, ga zitten. Nee, blijf staan, het is maar kort." ],
      achterdochtig:  [ "Eerst dit: wat kom jij hier eigenlijk doen?", "Ik ken je nog niet goed genoeg om dat te vragen. Maar ik vraag het toch." ]
    }.freeze

    # ---- what they remark on ------------------------------------------------------------------------------------

    PHASE_LINE = {
      nacht:   [ "Om deze tijd is hier niemand wakker behalve ik en de honden.", "Middernacht. Alles wat nu rijdt heeft haast of heeft ongelijk." ],
      vroeg:   [ "Zo vroeg al. De bakker is nog niet eens open.", "De mist ligt nog in het dal om dit uur." ],
      ochtend: [ "'t Is nog vroeg genoeg om er iets van te maken.", "Vanmorgen was de weg nog leeg. Dat is nu wel anders." ],
      middag:  [ "Middag. De helft van de dag is al weg en er is niets gebeurd.", "Om deze tijd zit half %{town} aan de koffie." ],
      avond:   [ "De avond valt. Dan wordt het rustig op de weg, en onrustig in de lucht.", "Vanavond is het weer laat geworden." ],
      schemer: [ "Kijk, dat licht over de heuvel. Daar kom je nooit op uitgekeken.", "Zo tegen het donker wordt hier iedereen wat stiller." ]
    }.freeze

    DRAGON_AWAKE = [ "Hij is wakker. Je hoort hem niet, en dat is precies het probleem.",
                     "Er vliegt er een boven %{landmark}. Rijd om, of rijd hard." ].freeze
    DRAGON_ASLEEP = [ "Bij %{landmark} is het stil vandaag. Geniet ervan, het duurt nooit lang.",
                      "Hij slaapt. Zeg maar niets te hard." ].freeze
    DRAGON_DEAD = [ "Sinds jij bij %{landmark} bent geweest slapen we weer. Dat vergeten we hier niet.",
                    "Er ligt iets groots dood bij %{landmark}. De kinderen gaan er kijken." ].freeze
    LANDMARK = [ "Verderop ligt %{landmark}. Ga daar eens kijken als je tijd hebt.",
                 "Zolang je hier bent: %{landmark} is de moeite waard, ook als niemand je ervoor betaalt." ].freeze

    # ---- the offers ---------------------------------------------------------------------------------------------

    OFFER_INTRO = [ "Ik heb iets voor je.", "Er ligt werk.", "Er is wel wat te doen, ja." ].freeze
    OFFER_INTRO_MANY = [ "Ik heb een paar dingen voor je.", "Er ligt genoeg. Kies maar.", "Meer dan één, en geen ervan is leuk." ].freeze
    NO_OFFERS = [ "Vandaag heb ik niets. Kom morgen terug, dan is er weer van alles mis.",
                  "Niets voor je. Dat is goed nieuws, al klinkt het niet zo.",
                  "Op. Morgen weer." ].freeze
    NO_OFFERS_RANK = [ "Voor jou zou ik iets verzinnen als ik iets had. Maar ik heb niets. Morgen.",
                       "Niets vandaag, vrundj. Ga rusten, dat mag ook eens." ].freeze
    FULL_HANDS = [ "Je hebt je handen al vol. Maak eerst af wat je hebt.",
                   "Drie tegelijk is genoeg, ook voor jou." ].freeze

    ACCEPTED = { "jager" => "Goed. Hou je ogen open en je mond dicht.",
                 "smid"  => "Afgesproken. En breng mijn spullen heel terug.",
                 "kapelaan" => "Ga met God, en met gepaste snelheid.",
                 "abt" => "Ga. Wij bidden, jij rijdt.",
                 "herbergier" => "Mooi. Er staat er een koud voor je als je terug bent.",
                 "burgemeester" => "Uitstekend. Dan zet ik dat in de notulen.",
                 "molenaar" => "Goed zo. De zakken staan achter.",
                 "koopman" => "Deal. Zaken zijn zaken." }.freeze
    ACCEPTED_FALLBACK = "Afgesproken."

    DONE = { "jager" => "Dat is één. Er zijn er meer.",
             "smid" => "Netjes. Daar kan ik wat mee.",
             "kapelaan" => "Je hebt meer gedaan dan je denkt. Dank je.",
             "abt" => "De abdij is je dankbaar, en dat is meer waard dan het klinkt.",
             "herbergier" => "Daar drinken we er een op. Later, jij moet rijden.",
             "burgemeester" => "Dat is geregeld. %{town} weet het.",
             "molenaar" => "Goed gedaan. De wieken draaien weer.",
             "koopman" => "Betaald is betaald. Tot de volgende." }.freeze
    DONE_FALLBACK = "Goed gedaan."

    FAIL = { "jager" => "Dat had je niet moeten doen. Nu weet hij dat we hem zoeken.",
             "smid" => "Weg. Dat was materiaal, geen speelgoed.",
             "kapelaan" => "Jammer. Wij beginnen opnieuw, dat kunnen wij goed.",
             "abt" => "Het is zoals het is.",
             "herbergier" => "Ach. Het was maar bier. Het was wel mijn bier.",
             "burgemeester" => "Dat wordt een vervelend briefje.",
             "molenaar" => "Dan maalt er vandaag niemand.",
             "koopman" => "Verlies. Dat komt van jouw kant, niet van de mijne." }.freeze
    FAIL_FALLBACK = "Dat is misgegaan."

    # ---- assembling ---------------------------------------------------------------------------------------------

    class << self
      # The lines the panel types out when you walk up: a greeting, something only this person in this town on this
      # day would say, and what they have for you.
      def greeting(scene, offers: [], full: false)
        lines = [ opening(scene) ]
        lines << remark(scene)
        lines << (full ? pick(FULL_HANDS, scene, "full") : offer_intro(scene, offers))
        lines.compact.map { fill(_1, scene) }
      end

      # the topics behind "vertel eens" — each is a key, a Dutch label and the lines it answers with
      def topics(scene)
        out = []
        if scene.blurb
          out << { key: "plaats", label: "Vertel eens over #{scene.town}",
                   lines: [ scene.blurb, pick(PLACE_TAIL, scene, "plaats") ] }
        end
        if scene.landmark
          out << { key: "streek", label: "Wat ligt hier in de buurt?",
                   lines: [ fill(pick(LANDMARK, scene, "streek"), scene), pick(STREEK_TAIL, scene, "streek2") ] }
        end
        out << { key: "weer", label: "En het weer?", lines: [ scene.sky.remark, pick(WEER_TAIL, scene, "weer") ] } if scene.sky
        out << { key: "draak", label: "En die draak?", lines: dragon_lines(scene) } if scene.dragon
        out.map { |t| t.merge(lines: t[:lines].compact.map { fill(_1, scene) }) }
      end

      def accepted(scene) = fill(ACCEPTED.fetch(scene.role, ACCEPTED_FALLBACK), scene)
      def done(scene) = fill(DONE.fetch(scene.role, DONE_FALLBACK), scene)
      def failed(scene) = fill(FAIL.fetch(scene.role, FAIL_FALLBACK), scene)

      # the standing rank a number of points buys, and the Dutch word for it
      def rank_for(points) = RANKS.rindex { points >= _1 } || 0
      def rank_name(rank) = RANK_NL[rank.to_i.clamp(0, RANK_NL.size - 1)]

      # what the client puts under the person's name: "vertrouwd in Meerssen"
      def standing_line(scene) = "#{rank_name(scene.rank)} in #{scene.town}"

      private

      def opening(scene)
        greet = DayClock::GREET.fetch(scene.phase, "Hallo")
        pool = RECOGNISE[scene.rank.to_i.clamp(0, RECOGNISE.size - 1)]
        body = pool.any? ? pick(pool, scene, "herken") : pick(INTRO.fetch(scene.role, INTRO_FALLBACK), scene, "intro")
        "#{greet}. #{body}"
      end

      # The one line that has to earn its place. Anything the world can offer is a candidate — the dragon at the
      # lair over the hill, the weather, the hour, the landmark — and the person's temperament decides how often
      # they skip all of it and just say something in their own register.
      def remark(scene)
        cands = []
        cands << dragon_lines(scene).first if scene.dragon
        cands << scene.sky.remark if scene.sky
        cands << pick(PHASE_LINE.fetch(scene.phase, PHASE_LINE[:middag]), scene, "uur")
        cands << pick(LANDMARK, scene, "mark") if scene.landmark
        cands << pick(TRAIT_LINE.fetch(scene.trait, TRAIT_LINE[:droog]), scene, "aard")
        cands.compact!
        return nil if cands.empty?
        cands[scene.seed % cands.size]
      end

      def offer_intro(scene, offers)
        return pick(scene.rank.to_i >= 3 ? NO_OFFERS_RANK : NO_OFFERS, scene, "leeg") if offers.empty?
        pick(offers.size > 1 ? OFFER_INTRO_MANY : OFFER_INTRO, scene, "aanbod")
      end

      def dragon_lines(scene)
        d = scene.dragon or return []
        pool = if d[:alive] == false then DRAGON_DEAD
        elsif d[:awake] then DRAGON_AWAKE
        else DRAGON_ASLEEP
        end
        [ pick(pool, scene, "draak"), d[:name] ? "Ze noemen hem #{d[:name]}." : nil ]
      end

      def pick(pool, scene, salt)
        return nil if pool.nil? || pool.empty?
        pool[Zlib.crc32("#{salt}:#{scene.seed}") % pool.size]
      end

      def fill(text, scene)
        return nil if text.nil?
        format(text, name: scene.name, town: scene.town, kind: scene.kind_nl, voornaam: scene.first_name,
                     landmark: scene.landmark.to_s, rang: scene.rank_nl)
      rescue KeyError, ArgumentError
        text
      end
    end

    PLACE_TAIL = [ "Dat staat in het boekje. Wat er niet in staat is dat het hier 's winters trekt.",
                   "Zo staat het opgeschreven, ja. Wij wonen er.",
                   "En verder: veel heuvel, weinig geduld." ].freeze
    STREEK_TAIL = [ "Neem de binnenweg, die is mooier en even lang.",
                    "En kijk uit bij de bocht daar, die vreet auto's." ].freeze
    WEER_TAIL = [ "Maar morgen is het anders, zeggen ze. Dat zeggen ze hier altijd.",
                  "Zulk weer is goed voor de akker en slecht voor het humeur." ].freeze
  end
end
