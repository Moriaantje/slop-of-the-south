require "zlib"

module Game
  # Names, roles and temperaments for the people at the hubs, Limburgish where it counts. The names are drawn from an
  # rng at hub build time and live in the hubs table; the temperament is not stored anywhere, it is derived from the
  # person's id, so the same Sjeng is dry every time you meet him without a migration and without the hubs having to
  # be rebuilt. That matters because the temperament is what keeps two mayors in two villages from reading like the
  # same mayor: the lines they choose from are the same pool, the one they reach for first is not.
  module Names
    FIRST = %w[Sjeng Sjra Pie Harie Wiel Bèr Tiny Mia Truus Fien Lei Zef Nölke Mathieu Jo Toos Marij Hub Leo Riet
               Wim Netty Frans Gerda Jacques Lies Twan Ans Har Gonny Pierre Mientje Sjef Bertie Leon Annie].freeze
    LAST  = %w[Meertens Schreurs Cremers Dassen Ramaekers Ruijters Wolfs Beckers Kusters Hendrix Vranken Smeets Dirix
               Gelissen Coumans Frijns Notermans Habets Pustjens Lemmens Bours Paulissen Quaedvlieg Sistermans Wetzels].freeze

    # roles per hub role, in the order they are placed
    ROLES = {
      "town"   => %w[burgemeester herbergier smid],
      "lair"   => %w[jager],
      "shrine" => %w[kapelaan],
      "shop"   => %w[koopman]
    }.freeze
    ROLE_NL = { "burgemeester" => "burgemeester", "herbergier" => "herbergier", "smid" => "smid", "kapelaan" => "kapelaan",
                "abt" => "abt", "jager" => "drakenjager", "molenaar" => "molenaar", "koopman" => "koopman" }.freeze

    # How a person talks. `droog` says half of what they mean, `breed` twice as much, `kort` is busy, `joviaal` has
    # had one already and `achterdochtig` wants to know what you are doing here first. Game::Dialogue picks its lines
    # per trait; nothing else in the game reads them.
    TRAITS = %i[droog breed kort joviaal achterdochtig].freeze
    TRAIT_NL = { droog: "droog", breed: "breedsprakig", kort: "kortaf", joviaal: "joviaal", achterdochtig: "achterdochtig" }.freeze

    def self.person(rng) = "#{FIRST[rng.rand(FIRST.size)]} #{LAST[rng.rand(LAST.size)]}"

    # the temperament of a person, from their npc id ("p:1234/2"), stable for the life of the world
    def self.trait(npc_id) = TRAITS[Zlib.crc32("aard:#{npc_id}") % TRAITS.size]

    # the roles a hub gets: towns three, a kapelaan when a church stands in the town, mills a molenaar, abbeys an abt
    def self.roles_for(role, kind:, has_church: false)
      case role
      when "town"   then ROLES["town"] + (has_church ? %w[kapelaan] : [])
      when "shrine" then kind == "abbey" ? %w[abt] : %w[kapelaan]
      when "shop"   then kind == "mill" ? %w[molenaar] : %w[koopman]
      else ROLES.fetch(role, %w[koopman])
      end
    end
  end
end
