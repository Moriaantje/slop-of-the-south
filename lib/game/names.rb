module Game
  # Names and roles for the people at the hubs, Limburgish where it counts. Deterministic given an rng.
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

    def self.person(rng) = "#{FIRST[rng.rand(FIRST.size)]} #{LAST[rng.rand(LAST.size)]}"

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
