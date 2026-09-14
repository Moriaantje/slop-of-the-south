module Game
  # The blueprints: what the people at the hubs actually ask of you, as data. A quest here is a title, a brief, a
  # reward and a list of stages, and a stage is one thing the world can check without asking anybody — be within so
  # many metres of a point, stay there a while, kill the dragon of a lair, get back alive before the clock runs out.
  # Game::Quests::Board owns the checking; this module owns the asking, and the split is deliberate, because the
  # stage machine is small and dull and wants tests, while the writing wants to be changed every week without anyone
  # having to think about the machine.
  #
  # There are two sorts. The daily jobs are the filler: four templates, drawn from a seed of the hub key and the
  # date, the same for everybody, gone at midnight. The lines are the reason to come back: a chain of two or three
  # quests owned by one person in one town, where step two is only offered once step one is done, the writing knows
  # which step you are on, and the last one pays properly. A chain is seeded on the hub and the line alone and never
  # on the date, so the crate you were sent for is still the same crate tomorrow.
  #
  # Distances are metres, deadlines seconds, radii metres. A stage with `dwell_s` wants you to stand still for that
  # long, which is how "search the ruin" differs from "drive past the ruin"; `fragile` loses the cargo when a dragon
  # catches you; `peril` tells the client to paint the marker red, and `when_dark` holds the stage open until the
  # game clock says night, which is how a vigil is a vigil and not another errand.
  module QuestLines
    DAILY_EXPIRES_S = 5_400            # seconds a daily job stays yours before it goes stale
    LINE_EXPIRES_S  = 10_800           # a chain step is patient, but not endlessly
    ARRIVE_R        = 25.0             # metres: arriving somewhere
    WIDE_R          = 120.0            # metres: near enough to have seen a landmark
    ITEMS = [ "een vlaai", "een pan zoervleisj", "nonnevotten", "knapkook", "een rommedoe", "een krat Gulpener",
              "Limburgse mosterd", "een zak sjtoemp", "een doos eierkoeken", "een fles jenever" ].freeze
    SPOOR = [ "de holle weg", "het bosrandje", "de oude groeve", "het weiland achter de hoeve", "de kapel langs de weg",
              "de spoordijk", "het beekdal" ].freeze

    # Everything a blueprint may ask the world for. The Board builds one of these and hands it over; nothing in here
    # touches the database or the clock, so a blueprint is a pure function of the hub, the world and its seed.
    class Ctx
      attr_reader :hub, :hubs, :rng

      def initialize(hub:, hubs:, rng:)
        @hub, @hubs, @rng = hub, hubs, rng
      end

      # a hub of one of those roles between min and max metres away, chosen from the seed; the nearest one otherwise
      def pick(roles, min = 800, max = 6_000)
        cands = @hubs.values.select { _1.key != @hub.key && roles.include?(_1.role) }
        return nil if cands.empty?
        inside = cands.select { dist(_1).between?(min, max) }
        return cands.min_by { dist(_1) } if inside.empty?
        inside.sort_by(&:key)[@rng.rand(inside.size)]
      end

      def nearest(roles, max = 20_000)
        cands = @hubs.values.select { _1.key != @hub.key && roles.include?(_1.role) && dist(_1) <= max }
        cands.min_by { dist(_1) }
      end

      # the farthest hub of those roles still inside a sane drive
      def far(roles, max = 14_000)
        cands = @hubs.values.select { _1.key != @hub.key && roles.include?(_1.role) && dist(_1) <= max }
        cands.max_by { dist(_1) }
      end

      # A spot out in the countryside on the way to somewhere, with a name a person would use. Nothing is placed
      # there — the point of a trail is that there is nothing there until you look.
      def spoor(to, t = 0.62)
        name = SPOOR[@rng.rand(SPOOR.size)]
        dx, dz = to.x - @hub.x, to.z - @hub.z
        side = @rng.rand < 0.5 ? -1 : 1
        len = Math.hypot(dx, dz)
        off = len.zero? ? [ 0.0, 0.0 ] : [ -dz / len * 90 * side, dx / len * 90 * side ]
        { x: (@hub.x + dx * t + off[0]).round(1), z: (@hub.z + dz * t + off[1]).round(1), name: }
      end

      def dist(other) = Math.hypot(other.x - @hub.x, other.z - @hub.z)
      def km(d) = d < 950 ? "#{(d / 50).round * 50} m" : "#{(d / 1000.0).round(1)} km"
      def item = ITEMS[@rng.rand(ITEMS.size)]
      def town_kind = TownInfo::KIND_NL[@hub.kind] || "plaats"
    end

    # ---- the daily jobs ---------------------------------------------------------------------------------------------

    DAILY_KINDS = { "town" => %w[deliver race scout], "lair" => %w[hunt scout], "shrine" => %w[scout deliver],
                    "shop" => %w[deliver race] }.freeze

    def self.daily_kinds(role) = DAILY_KINDS.fetch(role, %w[deliver race])

    # one daily job, or nil when the world has nowhere to send you
    def self.daily(ctx, kind)
      hub = ctx.hub
      case kind
      when "deliver"
        target = ctx.pick(%w[town shop], 1_200, 6_000) or return nil
        item, d = ctx.item, ctx.dist(target)
        { kind:, title: "Bezorg #{item} in #{target.name}", giver_role: %w[koopman herbergier molenaar burgemeester],
          brief: "Simpel werk: #{item} moet naar #{target.name}, #{ctx.km(d)} hiervandaan. Heel aankomen, hè.",
          expires_s: DAILY_EXPIRES_S, reward: { gold: 40 + (d / 50).round, xp: 40 + (d / 50).round },
          stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (70 + d / 8).round, fragile: true,
                      objective: "Breng #{item} naar #{target.name}" } ] }
      when "race"
        target = ctx.pick(%w[town shrine], 1_000, 5_000) or return nil
        d = ctx.dist(target)
        { kind:, title: "Race naar #{target.name}", giver_role: %w[herbergier smid koopman],
          brief: "Er staat geld op. Van hier naar #{target.name}, #{ctx.km(d)}, en de klok loopt zodra je ja zegt.",
          expires_s: DAILY_EXPIRES_S, reward: { gold: 60 + (d / 40).round, xp: 60 + (d / 40).round },
          stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (22 + d / 14).round,
                      objective: "Naar #{target.name}, zo snel als je kunt" } ] }
      when "scout"
        target = ctx.pick(%w[lair shrine shop], 500, 8_000) or return nil
        d = ctx.dist(target)
        { kind:, title: "Verken #{target.name}", giver_role: %w[burgemeester kapelaan abt jager],
          brief: "Ga kijken bij #{target.name}, #{ctx.km(d)} verderop, en kom het hier vertellen. Kijken is genoeg.",
          expires_s: DAILY_EXPIRES_S, reward: { gold: 55, xp: 55 },
          stages: [ { kind: "goto", target: { key: target.key }, radius: WIDE_R, objective: "Ga kijken bij #{target.name}",
                      note: "Je ziet #{target.name} liggen. Onthoud wat je ziet." },
                    { kind: "return", target: { key: hub.key }, radius: ARRIVE_R, objective: "Vertel het in #{hub.name}",
                      note: "Genoeg gezien. Terug naar #{hub.name}." } ] }
      when "hunt"
        { kind:, title: "Versla de draak van #{hub.name}", requires: "mech", giver_role: %w[jager],
          brief: "De draak van #{hub.name} moet dood. Alleen in die tovenaarsmech maak je een kans: vuurballen en bliksem, tot hij valt.",
          expires_s: DAILY_EXPIRES_S, reward: { gold: 300, xp: 300 },
          stages: [ { kind: "hunt", target: { key: hub.key }, objective: "Versla de draak van #{hub.name}", requires: "mech" } ] }
      end
    end

    # ---- the chains -------------------------------------------------------------------------------------------------

    # id: the line key stored on every quest of it. role: the person who owns it. rank: the standing the town must
    # already have for the line to be offered at all. steps: one lambda per step, taking the context.
    LINES = [
      { id: "gemeente", role: "burgemeester", rank: 0, name: "Gemeentezaken",
        steps: [
          ->(c) {
            target = c.pick(%w[town], 1_000, 7_000) or next nil
            d = c.dist(target)
            { kind: "deliver", title: "De stukken naar #{target.name}",
              brief: "Een map met stukken die gisteren al in #{target.name} had moeten liggen. Ik zeg niets over wiens schuld dat is.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 70 + (d / 50).round, xp: 70 },
              stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (90 + d / 8).round, fragile: true,
                          objective: "Breng de map naar #{target.name}" } ] }
          },
          ->(c) {
            mark = c.nearest(%w[shrine shop lair]) or next nil
            spot = c.spoor(mark, 0.8)
            { kind: "fetch", title: "De grenspaal",
              brief: "Er staat ergens bij #{mark.name} een grenspaal die volgens #{c.hub.name} één kant op wijst en volgens de buren de andere. Zoek hem, en kom het mij vertellen.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 120, xp: 110 },
              stages: [ { kind: "search", target: spot, radius: 45.0, dwell_s: 8,
                          objective: "Zoek de grenspaal bij #{spot[:name]}",
                          note: "Het staat in de kaart als #{spot[:name]}. Rij er rond tot je hem ziet staan." },
                        { kind: "return", target: { key: c.hub.key }, radius: ARRIVE_R, deadline_s: 900,
                          objective: "Meld je terug in #{c.hub.name}",
                          note: "Daar staat hij, scheef en vol mos. De inscriptie wijst onze kant op. Terug naar #{c.hub.name}." } ] }
          },
          ->(c) {
            lair = c.nearest(%w[lair]) || c.nearest(%w[shrine]) or next nil
            d = c.dist(lair)
            { kind: "scout", title: "De schaduw over #{c.hub.name}",
              brief: "Iets cirkelt 's avonds boven ons. Rij naar #{lair.name}, #{c.km(d)} hiervandaan, kijk wat daar zit en kom heelhuids terug. Heelhuids, zeg ik.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 260, xp: 240, skill_point: 1 },
              stages: [ { kind: "goto", target: { key: lair.key }, radius: WIDE_R, peril: true,
                          objective: "Kijk wat er bij #{lair.name} huist" },
                        { kind: "flee", target: { key: c.hub.key }, radius: ARRIVE_R, deadline_s: (120 + d / 10).round, peril: true,
                          objective: "Terug naar #{c.hub.name}, nu",
                          note: "Je hebt hem gezien. Hij jou ook. Wegwezen." } ] }
          } ] },

      { id: "vat", role: "herbergier", rank: 0, name: "Vat en vaat",
        steps: [
          ->(c) {
            source = c.pick(%w[shop town], 900, 6_000) or next nil
            d = c.dist(source)
            { kind: "fetch", title: "Een krat uit #{source.name}",
              brief: "De tap staat droog en de kaart zegt dat er in #{source.name} nog een krat staat. Haal hem, en rij als een mens: glas is glas.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 90 + (d / 60).round, xp: 80 },
              stages: [ { kind: "goto", target: { key: source.key }, radius: ARRIVE_R,
                          objective: "Haal het krat in #{source.name}" },
                        { kind: "return", target: { key: c.hub.key }, radius: ARRIVE_R, deadline_s: (100 + d / 9).round, fragile: true,
                          objective: "Breng het krat naar #{c.hub.name}",
                          note: "Het krat staat achterin, koud en zwaar. Nu heel terugkrijgen." } ] }
          },
          ->(c) {
            target = c.pick(%w[shrine town], 1_200, 7_000) or next nil
            d = c.dist(target)
            { kind: "race", title: "De laatste gast",
              brief: "Er zit hier een gast die de laatste bus naar #{target.name} gemist heeft, en die zeurt al een uur. Breng hem weg voor ik iets zeg waar ik spijt van krijg.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 140 + (d / 40).round, xp: 130 },
              stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (30 + d / 13).round,
                          objective: "Zet hem af in #{target.name}" } ] }
          },
          ->(c) {
            target = c.far(%w[town]) || c.pick(%w[town]) or next nil
            d = c.dist(target)
            spot = c.spoor(target, 0.55)
            { kind: "deliver", title: "Het geld van de brouwer",
              brief: "Dit is de laatste keer dat ik je iets vraag, en het is meteen de vervelende: een tas geld naar de brouwer in #{target.name}. Er weten er meer van dan mij lief is.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 320, xp: 300, skill_point: 1 },
              stages: [ { kind: "goto", target: spot, radius: 60.0,
                          objective: "Naar #{target.name}, langs #{spot[:name]}" },
                        { kind: "flee", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (110 + d / 12).round, peril: true, fragile: true,
                          objective: "Rijden. Naar #{target.name}, zonder te stoppen",
                          note: "Bij #{spot[:name]} staat de weg vol. Dat is geen pech, dat is een afspraak. Gas." } ] }
          } ] },

      { id: "smidse", role: "smid", rank: 1, name: "De smidse",
        steps: [
          ->(c) {
            mark = c.nearest(%w[lair shrine shop]) or next nil
            spot = c.spoor(mark, 0.9)
            { kind: "fetch", title: "Erts uit de oude groeve",
              brief: "Ik kan die machine van jou verzwaren, maar niet met het blik dat ze tegenwoordig verkopen. Bij #{mark.name} ligt het goede spul nog in de grond.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 130, xp: 130 },
              stages: [ { kind: "search", target: spot, radius: 45.0, dwell_s: 10,
                          objective: "Zoek het erts bij #{spot[:name]}",
                          note: "Zoek rond #{spot[:name]} tot je de bruine bank in de helling ziet." },
                        { kind: "return", target: { key: c.hub.key }, radius: ARRIVE_R, fragile: true, deadline_s: 900,
                          objective: "Breng het erts naar de smidse",
                          note: "Zwaar spul. Rij rustig, het ligt los achterin." } ] }
          },
          ->(c) {
            target = c.far(%w[town shrine]) || c.pick(%w[town]) or next nil
            d = c.dist(target)
            { kind: "race", title: "De proef op de plaat",
              brief: "Ik heb het op je pantser gezet. Nu wil ik weten of het houdt: naar #{target.name} en terug, en niet zachtjes.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 200, xp: 190 },
              stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (60 + d / 12).round,
                          objective: "Naar #{target.name}" },
                        { kind: "return", target: { key: c.hub.key }, radius: ARRIVE_R, deadline_s: (60 + d / 12).round,
                          objective: "En terug naar #{c.hub.name}",
                          note: "Keren. Dezelfde weg terug, en nu met een warme motor." } ] }
          },
          ->(c) {
            lair = c.nearest(%w[lair], 20_000) or next nil
            { kind: "hunt", title: "Waar het voor gemaakt is", requires: "mech",
              brief: "Die plaat is niet voor de sier. Ga naar #{lair.name} en laat zien waar hij voor gemaakt is. In de mech, anders maak je hem alleen maar boos.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 420, xp: 400, skill_point: 1, unlock: "sterk_schild" },
              stages: [ { kind: "goto", target: { key: lair.key }, radius: WIDE_R, requires: "mech", peril: true,
                          objective: "Ga in de mech naar #{lair.name}" },
                        { kind: "hunt", target: { key: lair.key }, requires: "mech", peril: true,
                          objective: "Versla de draak van #{lair.name}",
                          note: "Daar zit hij. Vuurbal en bliksem, en blijf bewegen." } ] }
          } ] },

      { id: "processie", role: "kapelaan", rank: 0, name: "De processie",
        steps: [
          ->(c) {
            target = c.nearest(%w[shrine]) || c.pick(%w[town]) or next nil
            { kind: "deliver", title: "Het beeld naar #{target.name}",
              brief: "Het beeld moet voor de processie naar #{target.name}. Het is oud, het is van hout, en het heeft al een oorlog overleefd. Jij bent nu het gevaar.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 90, xp: 90 },
              stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, fragile: true, deadline_s: 600,
                          objective: "Breng het beeld naar #{target.name}" } ] }
          },
          ->(c) {
            mark = c.nearest(%w[lair shop town]) or next nil
            spot = c.spoor(mark, 0.7)
            { kind: "fetch", title: "Wat de processie mist",
              brief: "Er hoort een reliek bij dat beeld, en dat is in de oorlog bij #{spot[:name]} in de grond gegaan. Zoek het. Bid desnoods.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 150, xp: 160 },
              stages: [ { kind: "search", target: spot, radius: 45.0, dwell_s: 12,
                          objective: "Zoek het reliek bij #{spot[:name]}",
                          note: "Rij langzaam rond #{spot[:name]}. Wie haast heeft vindt niets." },
                        { kind: "return", target: { key: c.hub.key }, radius: ARRIVE_R,
                          objective: "Breng het reliek terug",
                          note: "Een koperen doosje, groen uitgeslagen. Er zit iets in dat rammelt." } ] }
          },
          ->(c) {
            { kind: "wake", title: "De nachtwake",
              brief: "Dan rest de wake. Kom terug als het donker is, en blijf tot het gebeden is. Overdag heeft het geen zin, dan luistert er niemand.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 240, xp: 260, skill_point: 1 },
              stages: [ { kind: "search", target: { key: c.hub.key }, radius: 50.0, dwell_s: 25, when_dark: true,
                          objective: "Wacht bij #{c.hub.name} tot het donker is, en blijf" } ] }
          } ] },

      { id: "spoor", role: "jager", rank: 0, name: "Het spoor",
        steps: [
          ->(c) {
            town = c.nearest(%w[town]) || c.pick(%w[town shrine shop]) or next nil
            spot = c.spoor(town, 0.45)
            { kind: "fetch", title: "Het spoor bij #{spot[:name]}",
              brief: "Sst. Hij jaagt niet hier, hij jaagt daar. Bij #{spot[:name]} ligt zijn spoor: verbrand gras, botten, de geur. Ga kijken en blijf even staan, anders zie je het niet.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 110, xp: 120 },
              stages: [ { kind: "search", target: spot, radius: 50.0, dwell_s: 8,
                          objective: "Vind het spoor bij #{spot[:name]}" },
                        { kind: "return", target: { key: c.hub.key }, radius: ARRIVE_R,
                          objective: "Vertel het bij #{c.hub.name}",
                          note: "Zwartgeblakerd gras, en botten die niet van een koe zijn. Terug." } ] }
          },
          ->(c) {
            town = c.nearest(%w[town]) || c.pick(%w[town]) or next nil
            d = c.dist(town)
            { kind: "scout", title: "Waarschuw #{town.name}",
              brief: "Hij vliegt op #{town.name} af. Rij erheen en waarschuw ze, en kom terug voor het donker is.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 190, xp: 180 },
              stages: [ { kind: "goto", target: { key: town.key }, radius: ARRIVE_R, deadline_s: (80 + d / 10).round,
                          objective: "Waarschuw ze in #{town.name}" },
                        { kind: "flee", target: { key: c.hub.key }, radius: ARRIVE_R, deadline_s: (100 + d / 10).round, peril: true,
                          objective: "Terug naar #{c.hub.name}",
                          note: "Ze geloven je pas als het brandt. Terug, en hou de lucht in de gaten." } ] }
          },
          ->(c) {
            { kind: "hunt", title: "De jacht", requires: "mech",
              brief: "Nu weet je waar hij slaapt, hoe hij ruikt en hoe laat hij gaat. Meer krijg je niet van mij. Transformeer, en maak er een eind aan.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 500, xp: 460, skill_point: 1, unlock: "vuurkracht_1" },
              stages: [ { kind: "hunt", target: { key: c.hub.key }, requires: "mech", peril: true,
                          objective: "Versla de draak van #{c.hub.name}" } ] }
          } ] },

      { id: "handel", role: "koopman", rank: 0, name: "De handel",
        steps: [
          ->(c) {
            target = c.pick(%w[town shop], 900, 5_000) or next nil
            d = c.dist(target)
            { kind: "deliver", title: "Een order voor #{target.name}",
              brief: "Handel is bewegen, en jij beweegt. #{c.item.capitalize} naar #{target.name}, #{c.km(d)}. Betaalt netjes.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 80 + (d / 50).round, xp: 75 },
              stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (80 + d / 9).round, fragile: true,
                          objective: "Lever af in #{target.name}" } ] }
          },
          ->(c) {
            target = c.far(%w[town]) || c.pick(%w[town]) or next nil
            d = c.dist(target)
            { kind: "deliver", title: "De verre vracht",
              brief: "En nu de rit waar niemand zin in heeft: helemaal naar #{target.name}, #{c.km(d)}. Daarom betaalt hij ook zo goed.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 260 + (d / 40).round, xp: 240, skill_point: 1 },
              stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (150 + d / 9).round, fragile: true,
                          objective: "Breng de vracht naar #{target.name}" } ] }
          } ] },

      { id: "meel", role: "molenaar", rank: 0, name: "Het meel",
        steps: [
          ->(c) {
            target = c.pick(%w[town], 800, 5_000) or next nil
            d = c.dist(target)
            { kind: "deliver", title: "Meel voor #{target.name}",
              brief: "De wieken hebben gedraaid, de zakken staan klaar en de bakker in #{target.name} wacht sinds vanmorgen.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 70 + (d / 50).round, xp: 70 },
              stages: [ { kind: "goto", target: { key: target.key }, radius: ARRIVE_R, deadline_s: (80 + d / 9).round, fragile: true,
                          objective: "Breng het meel naar #{target.name}" } ] }
          },
          ->(c) {
            mark = c.nearest(%w[shop shrine lair]) or next nil
            spot = c.spoor(mark, 0.75)
            { kind: "fetch", title: "De steen",
              brief: "Mijn loopsteen is versleten en de nieuwe ligt sinds de oorlog bij #{spot[:name]}. Zoek hem, dan draai ik weer.",
              expires_s: LINE_EXPIRES_S, reward: { gold: 200, xp: 200, skill_point: 1 },
              stages: [ { kind: "search", target: spot, radius: 45.0, dwell_s: 10,
                          objective: "Zoek de molensteen bij #{spot[:name]}" },
                        { kind: "return", target: { key: c.hub.key }, radius: ARRIVE_R, fragile: true,
                          objective: "Rol de steen terug naar #{c.hub.name}",
                          note: "Een steen van een meter, half in de grond. Voorzichtig laden." } ] }
          } ] }
    ].freeze

    ABBOT_LINE = "processie"          # an abbot runs the chaplain's line; the writing knows the difference
    BY_ROLE = LINES.group_by { _1[:role] }.freeze

    # the lines one person may own, chaplain and abbot sharing theirs
    def self.for_role(role)
      role = "kapelaan" if role == "abt"
      BY_ROLE.fetch(role, [])
    end

    def self.find(id) = LINES.find { _1[:id] == id }
    def self.steps(id) = find(id)&.fetch(:steps)&.size || 0
    def self.name(id) = find(id)&.fetch(:name)

    # step is one-based; nil when the line is finished or the world had nowhere to send you
    def self.build(id, step, ctx)
      line = find(id) or return nil
      body = line[:steps][step - 1] or return nil
      blueprint = body.call(ctx)
      return nil unless blueprint
      blueprint.merge(line: id, step:, line_name: line[:name], last: step == line[:steps].size, giver_role: [ line[:role] ])
    end
  end
end
