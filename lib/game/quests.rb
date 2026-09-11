require "zlib"
require "date"

module Game
  # Quests: what the people at the hubs ask of you. Every hub offers a small deterministic set per day (the same for
  # everyone, from a seed of hub key and date): a town sends you to deliver a vlaai to another town, to race there, or
  # to scout a landmark; a lair's hunter wants its dragon dead (in the mech); shrines and shops mix these. The Board
  # tracks the active quests per player (at most three), checks arrivals and deadlines every tick, hears about
  # discoveries, kills and deaths from the WorldManager, pays out gold and xp, and answers the channel's `quest` verb
  # with `dialogue` and `quest` messages on the player's personal stream. Talking and accepting need you within 60 m.
  module Quests
    MAX_ACTIVE = 3
    TALK_R     = 60.0
    ARRIVE_R   = 25.0
    ITEMS = [ "een vlaai", "een pan zoervleisj", "nonnevotten", "knapkook", "een rommedoe", "een krat Gulpener", "Limburgse mosterd", "een zak sjtoemp" ].freeze
    GREETINGS = {
      "burgemeester" => [ "Welkom in %{hub}. Ik ben %{name}, burgemeester hier.", "Goed dat je er bent, %{hub} kan wel wat hulp gebruiken." ],
      "herbergier"   => [ "Kom binnen, kom binnen. %{name}, van de herberg.", "Een pintje? Of liever een klusje?" ],
      "smid"         => [ "%{name}, smid. Handen vol werk, dus kort maar krachtig.", "Die machine van jou kan ik wel wat aan verbeteren, ooit." ],
      "kapelaan"     => [ "Vrede zij met je. Ik ben %{name}, de kapelaan van %{hub}.", "Rust hier even uit; de kapel geneest wie er binnenkomt." ],
      "abt"          => [ "De abdij heet je welkom. %{name}, abt.", "Wie hier komt, mag op adem komen." ],
      "jager"        => [ "Sst. %{name}, drakenjager. Hij zit daar, bij %{hub}.", "Alleen in die tovenaarsmech maak je een kans tegen dat beest." ],
      "koopman"      => [ "%{name}, koopman. Alles te koop, alles te bezorgen.", "Handel is bewegen. En jij beweegt snel, hoor ik." ],
      "molenaar"     => [ "%{name}, molenaar van %{hub}. Het meel moet de deur uit.", "De wieken draaien, de zakken staan klaar." ],
    }.freeze
    NO_OFFERS = "Vandaag heb ik niets meer voor je. Kom morgen terug."

    # ------------------------------------------------------------------------------------------------------------
    class Board
      attr_accessor :on_change            # ->(session) after gold/xp/hp changed, so the manager sends a `you`

      def initialize(hubs, store: nil, today: -> { Date.today })
        @hubs = hubs                      # key → Hub::Ref
        @store = store || QuestStore.new
        @today = today
        @active = {}                      # player_id → [quest]
        @on_change = nil
      end

      # ---- WorldManager hooks --------------------------------------------------------------------------------------

      def for_player(s) = active(s.id).map { client(_1) }
      def forget(player_id) = @active.delete(player_id)

      def tick(now, sessions, personal_msgs)
        sessions.each_value do |s|
          next unless s.x
          active(s.id).dup.each do |q|
            if q[:deadline_at] && now > q[:deadline_at] then fail!(s, q, "de tijd is om", now, personal_msgs)
            elsif %w[deliver race].include?(q[:kind]) && (t = @hubs[q[:target_key]]) && Math.hypot(t.x - s.x, t.z - s.z) <= ARRIVE_R
              complete!(s, q, now, personal_msgs)
            end
          end
        end
      end

      def on_kill(lair_key, ids, now, sessions, personal_msgs)
        ids.each do |id|
          s = sessions[id] or next
          active(id).select { _1[:kind] == "hunt" && _1[:target_key] == lair_key }.each { complete!(s, _1, now, personal_msgs) }
        end
      end

      def on_discover(hub_key, s, now, personal_msgs)
        active(s.id).select { _1[:kind] == "scout" && _1[:target_key] == hub_key }.each { complete!(s, _1, now, personal_msgs) }
      end

      def on_death(s, now, personal_msgs)
        active(s.id).select { _1[:kind] == "deliver" }.each { fail!(s, _1, "je bent verslagen, de bezorging is verloren", now, personal_msgs) }
      end

      # ---- the channel verb: returns personal payloads ---------------------------------------------------------------

      def handle(action, s, now, hub_key: nil, npc_id: nil, key: nil)
        case action
        when "talk"    then talk(s, hub_key, npc_id, now)
        when "accept"  then accept(s, hub_key, key, now)
        when "abandon" then abandon(s, key, now)
        when "heal"    then heal(s, hub_key, now)
        else refuse("action")
        end
      end

      def talk(s, hub_key, npc_id, now)
        hub = @hubs[hub_key] or return refuse("unknown")
        return refuse("far") unless near?(s, hub)
        npc = hub.npcs.find { _1[:id] == npc_id } || hub.npcs.first || { id: "#{hub.key}/0", name: hub.name, role: "koopman" }
        taken = active(s.id).map { _1[:key] }
        offers = offers_for(hub, now).reject { taken.include?(_1[:key]) }
        greet = GREETINGS.fetch(npc[:role], GREETINGS["koopman"]).map { _1 % { hub: hub.name, name: npc[:name] } }
        lines = greet + [ offers.any? ? "Ik heb #{offers.size == 1 ? 'iets' : 'een paar dingen'} voor je." : NO_OFFERS ]
        actions = %w[town shrine].include?(hub.role) ? [ "heal" ] : []
        [ { type: "dialogue", npc: npc.slice(:id, :name, :role), hub: { key: hub.key, name: hub.name, role: hub.role },
            lines:, offers: offers.map { client_offer(_1) }, actions: } ]
      end

      def accept(s, hub_key, key, now)
        hub = @hubs[hub_key] or return refuse("unknown")
        return refuse("far") unless near?(s, hub)
        offer = offers_for(hub, now).find { _1[:key] == key } or return refuse("unknown")
        return refuse("active") if active(s.id).any? { _1[:key] == key }
        return refuse("max") if active(s.id).size >= MAX_ACTIVE
        return refuse("mech") if offer[:requires] == "mech" && s.vehicle != "mech"
        q = offer.merge(player_id: s.id, status: "active", accepted_at: now, deadline_at: offer[:deadline_s] && now + offer[:deadline_s] * 1000, progress: {})
        q.delete(:deadline_s)
        active(s.id) << q
        @store.save(q)
        [ { type: "quest", action: "accepted", quest: client(q) } ]
      end

      def abandon(s, key, now)
        q = active(s.id).find { _1[:key] == key } or return refuse("unknown")
        msgs = []
        fail!(s, q, "opgegeven", now, msgs, action: "abandoned")
        msgs.map(&:last)
      end

      def heal(s, hub_key, now)
        hub = @hubs[hub_key] or return refuse("unknown")
        return refuse("far") unless near?(s, hub)
        return refuse("place") unless %w[town shrine].include?(hub.role)
        s.hp = Session::MAX_HP
        s.hurt_at = nil
        s.changed = true
        @on_change&.call(s)
        [ { type: "quest", action: "healed", hub_key: hub.key } ]
      end

      # ---- the offers ---------------------------------------------------------------------------------------------

      # the same offers for everyone at a hub on a day
      def offers_for(hub, _now = nil)
        date = @today.call.to_s
        rng = Random.new(Zlib.crc32("#{hub.key}:#{date}"))
        kinds = case hub.role
                when "town"   then %w[deliver race scout]
                when "lair"   then %w[hunt]
                when "shrine" then %w[scout deliver]
                else               %w[deliver race]
                end
        kinds.each_with_index.filter_map { |kind, i| offer(hub, kind, i, rng, date) }
      end

      private

      def offer(hub, kind, i, rng, date)
        key = "#{hub.key}|#{kind}|#{date}|#{i}"
        case kind
        when "deliver"
          target = pick(hub, rng, %w[town shop], 1500, 6000) or return nil
          item = ITEMS[rng.rand(ITEMS.size)]
          dist = dist(hub, target)
          { key:, kind:, hub_key: hub.key, target_key: target.key, title: "Bezorg #{item} in #{target.name}",
            text: "Breng #{item} naar #{target.name} (#{km(dist)}). Rijd er binnen de tijd heen; ga je eraan, dan is de bezorging weg.",
            deadline_s: (60 + dist / 8).round, reward: { gold: 40 + (dist / 50).round, xp: 40 + (dist / 50).round } }
        when "race"
          target = pick(hub, rng, %w[town shrine], 1000, 5000) or return nil
          dist = dist(hub, target)
          { key:, kind:, hub_key: hub.key, target_key: target.key, title: "Race naar #{target.name}",
            text: "Zo snel als je kunt naar #{target.name} (#{km(dist)}). De klok loopt zodra je ja zegt.",
            deadline_s: (20 + dist / 14).round, reward: { gold: 60 + (dist / 40).round, xp: 60 + (dist / 40).round } }
        when "scout"
          target = pick(hub, rng, %w[lair shrine shop], 500, 8000) or return nil
          { key:, kind:, hub_key: hub.key, target_key: target.key, title: "Verken #{target.name}",
            text: "Ga kijken bij #{target.name} (#{km(dist(hub, target))}) en kom terug met een verhaal. Dichtbij komen is genoeg.",
            deadline_s: nil, reward: { gold: 50, xp: 50 } }
        when "hunt"
          { key:, kind:, hub_key: hub.key, target_key: hub.key, title: "Versla de draak van #{hub.name}", requires: "mech",
            text: "De draak van #{hub.name} moet dood. Alleen de tovenaarsmech kan hem raken: vuurballen en bliksem, tot hij valt.",
            deadline_s: nil, reward: { gold: 300, xp: 300 } }
        end
      end

      # a hub of one of the roles between min and max metres away, chosen from the seed; the nearest one if none is in range
      def pick(hub, rng, roles, min, max)
        cands = @hubs.values.select { _1.key != hub.key && roles.include?(_1.role) }
        return nil if cands.empty?
        inside = cands.select { dist(hub, _1).between?(min, max) }
        return cands.min_by { dist(hub, _1) } if inside.empty?
        inside.sort_by(&:key)[rng.rand(inside.size)]
      end

      def dist(a, b) = Math.hypot(a.x - b.x, a.z - b.z)
      def km(d) = d < 950 ? "#{(d / 50).round * 50} m" : "#{(d / 1000.0).round(1)} km"
      def near?(s, hub) = s.x && Math.hypot(hub.x - s.x, hub.z - s.z) <= TALK_R
      def refuse(reason) = [ { type: "quest", ok: false, reason: } ]

      def active(player_id) = @active[player_id] ||= @store.load_active(player_id)

      def complete!(s, q, now, personal_msgs)
        active(s.id).delete(q)
        q[:status] = "done"; q[:completed_at] = now
        s.gold += q.dig(:reward, :gold).to_i
        s.xp += q.dig(:reward, :xp).to_i
        s.changed = true
        @on_change&.call(s)
        @store.save(q)
        personal_msgs << [ s.id, { type: "quest", action: "completed", quest: client(q) } ]
      end

      def fail!(s, q, reason, now, personal_msgs, action: "failed")
        active(s.id).delete(q)
        q[:status] = "failed"; q[:completed_at] = now; q[:reason] = reason
        @store.save(q)
        personal_msgs << [ s.id, { type: "quest", action:, quest: client(q) } ]
      end

      def client_offer(o)
        t = @hubs[o[:target_key]]
        { key: o[:key], kind: o[:kind], title: o[:title], text: o[:text], requires: o[:requires], deadline_s: o[:deadline_s], reward: o[:reward],
          target: t && { key: t.key, name: t.name, x: t.x, z: t.z } }
      end

      def client(q)
        t = @hubs[q[:target_key]]
        { key: q[:key], kind: q[:kind], status: q[:status], title: q[:title], text: q[:text], hub_key: q[:hub_key], hub_name: @hubs[q[:hub_key]]&.name,
          target: t && { key: t.key, name: t.name, x: t.x, z: t.z }, reward: q[:reward], accepted_at: q[:accepted_at], deadline_at: q[:deadline_at],
          completed_at: q[:completed_at], reason: q[:reason] }
      end
    end
  end
end
