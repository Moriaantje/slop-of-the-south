require "zlib"
require "date"

module Game
  # Quests: what the people at the hubs ask of you, and what the world does about it. A quest is a small state
  # machine over a list of stages, and a stage is one thing this file can check four times a second without asking
  # anybody: be within so many metres of a point, stand there a while, be in the mech, kill the dragon of a lair, get
  # home before the clock runs out. That is the whole vocabulary, and everything the game asks of you — a delivery
  # that turns into a flight, a hunt that starts with a trail in a field, a vigil that only counts after dark — is
  # spelled with it. The blueprints live in Game::QuestLines and the words in Game::Dialogue; this file is the rules.
  #
  # Two things make a hub worth returning to. The first is the chains: a line of two or three quests owned by one
  # person, where the next one is only offered once the last one is done, so the smith in the village you helped in
  # the morning has something else by the afternoon. The second is standing, which is not stored anywhere — it is
  # counted from the quest rows themselves, because the record of what you did for a town IS what the town
  # remembers, and a number kept next to it could only ever disagree with it. Standing buys better greetings, better
  # work and a bigger purse.
  #
  # Failure is real: a fragile cargo is lost when a dragon catches you, a stage deadline that runs out fails the
  # quest and not just the stage, and everything you are carrying goes stale after its hour or two whether you touch
  # it or not. Every one of those costs standing, which is why the people in a town you have let down are terser
  # than the people in the one next door.
  #
  # The board answers the channel's `quest` verb on the player's personal stream and is driven by the world manager:
  # `tick` for arrivals, dwells, deadlines and expiry, `on_kill`, `on_discover`, `on_death` and `on_hurt` for the
  # things that happen to you. Talking and accepting need you within TALK_R of the hub centre.
  module Quests
    MAX_ACTIVE   = 3
    TALK_R       = 60.0                 # metres from the hub centre: close enough to talk
    ARRIVE_R     = 25.0                 # metres: the default arrival radius of a stage
    RANK_PAY     = 0.15                 # extra share of gold and xp per rank of standing
    SKILL_GOLD   = 250                  # what a promised skill point is worth in gold while nothing can grant one
    UNLOCK_GOLD  = 400                  # the same for a promised unlock
    REP = { "done" => 2, "finale" => 3, "failed" => -2, "expired" => -1 }.freeze   # standing points per outcome

    # ------------------------------------------------------------------------------------------------------------
    class Board
      attr_accessor :on_change            # ->(session) after gold/xp/hp changed, so the manager sends a `you`
      attr_accessor :dragons              # ->(lair_key) → the dragon there, for the writing; nil when not wired up

      def initialize(hubs, store: nil, today: -> { Date.today }, clock: nil)
        @hubs = hubs                      # key → Hub::Ref
        @store = store || QuestStore.new
        @today = today
        @clock = clock                    # ->(now_ms) → game hour, for the tests; DayClock otherwise
        @active = {}                      # player_id → [quest]
        @hist = {}                        # [player_id, hub_key] → [{ key:, status:, line:, step: }]
        @on_change = nil
        @dragons = nil
      end

      # ---- WorldManager hooks --------------------------------------------------------------------------------------

      def for_player(s) = active(s.id).map { client(_1) }

      def forget(player_id)
        @active.delete(player_id)
        @hist.reject! { |(pid, _), _| pid == player_id }
      end

      # arrivals, dwells, stage deadlines and the slow death of a quest nobody finished
      def tick(now, sessions, personal_msgs)
        sessions.each_value do |s|
          active(s.id).dup.each do |q|
            next expire!(s, q, now, personal_msgs) if q[:expires_at] && now > q[:expires_at]
            next fail!(s, q, "de tijd is om", now, personal_msgs) if q[:deadline_at] && now > q[:deadline_at]
            next unless s.x && s.alive?
            check_stage(s, q, now, personal_msgs)
          end
        end
      end

      def on_kill(lair_key, ids, now, sessions, personal_msgs)
        ids.each do |id|
          s = sessions[id] or next
          active(id).dup.each do |q|
            st = stage(q)
            advance!(s, q, now, personal_msgs) if st && st[:kind] == "hunt" && target_key(st, q) == lair_key
          end
        end
      end

      # Arriving somewhere is handled by `tick`, which watches the position anyway; what a discovery is good for is
      # telling the client that this hub has work, so the people there get a marker over their heads before you have
      # spoken to any of them.
      def on_discover(hub_key, s, now, personal_msgs)
        personal_msgs << [ s.id, board_msg(hub_key, s, now) ] if @hubs[hub_key]
      end

      def on_death(s, now, personal_msgs)
        active(s.id).dup.each do |q|
          st = stage(q)
          next unless st
          fail!(s, q, "je bent verslagen; wat je bij je had is weg", now, personal_msgs) if st[:fragile] || st[:peril]
        end
      end

      # A dragon (or anything else) took hit points off a player. Fragile cargo does not survive that, which is the
      # whole reason a delivery is worth more than a drive. Wired from WorldManager#burn; without it a fragile stage
      # only fails on death, which is the old behaviour.
      def on_hurt(s, damage, now, personal_msgs)
        return unless damage.to_f.positive?
        active(s.id).dup.each do |q|
          st = stage(q)
          fail!(s, q, "de lading is eraan gegaan", now, personal_msgs) if st && st[:fragile]
        end
      end

      # ---- the channel verb: returns personal payloads ---------------------------------------------------------------

      def handle(action, s, now, hub_key: nil, npc_id: nil, key: nil)
        case action
        when "talk"    then talk(s, hub_key, npc_id, now)
        when "topic"   then topic(s, hub_key, npc_id, key, now)
        when "accept"  then accept(s, hub_key, key, now)
        when "abandon" then abandon(s, key, now)
        when "heal"    then heal(s, hub_key, now)
        when "board"   then board(s, hub_key, now)
        else refuse("action")
        end
      end

      def talk(s, hub_key, npc_id, now)
        hub = @hubs[hub_key] or return refuse("unknown")
        return refuse("far") unless near?(s, hub)
        npc = npc_at(hub, npc_id)
        scene = scene_for(hub, npc, s, now)
        offers = offers_for_npc(hub, npc, s, now)
        full = active(s.id).size >= MAX_ACTIVE
        lines = Dialogue.greeting(scene, offers:, full: full && offers.any?)
        [ { type: "dialogue", npc: npc.slice(:id, :name, :role).merge(trait: Names.trait(npc[:id]).to_s),
            hub: { key: hub.key, name: hub.name, role: hub.role, x: hub.x, z: hub.z },
            standing: standing_payload(scene), clock: clock_payload(now),
            lines:, offers: offers.map { client_offer(_1) }, topics: Dialogue.topics(scene).map { _1.slice(:key, :label) },
            actions: hub_actions(hub) } ]
      end

      # "vertel eens over Meerssen": the same person, a few lines deeper
      def topic(s, hub_key, npc_id, key, now)
        hub = @hubs[hub_key] or return refuse("unknown")
        return refuse("far") unless near?(s, hub)
        npc = npc_at(hub, npc_id)
        scene = scene_for(hub, npc, s, now)
        found = Dialogue.topics(scene).find { _1[:key] == key } or return refuse("unknown")
        [ { type: "dialogue", action: "topic", topic: key, npc: npc.slice(:id, :name, :role),
            hub: { key: hub.key, name: hub.name, role: hub.role, x: hub.x, z: hub.z },
            standing: standing_payload(scene), lines: found[:lines],
            offers: offers_for_npc(hub, npc, s, now).map { client_offer(_1) },
            topics: Dialogue.topics(scene).map { _1.slice(:key, :label) }, actions: hub_actions(hub) } ]
      end

      def accept(s, hub_key, key, now)
        hub = @hubs[hub_key] or return refuse("unknown")
        return refuse("far") unless near?(s, hub)
        return refuse("active") if active(s.id).any? { _1[:key] == key }
        offer = offers_for(hub, s, now).find { _1[:key] == key } or return refuse("unknown")
        return refuse("max") if active(s.id).size >= MAX_ACTIVE
        return refuse("mech") if offer[:requires] == "mech" && s.vehicle != "mech"
        q = start(offer, s, now)
        active(s.id) << q
        @store.save(q)
        remember(s.id, q, "active")     # a retried step's cached row still said "failed", and would bar its own retry
        npc = npc_at(hub, offer[:npc_id])
        [ { type: "quest", action: "accepted", quest: client(q), said: Dialogue.accepted(scene_for(hub, npc, s, now)) } ]
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
        s.hp = s.respond_to?(:max_hp) ? s.max_hp : Session::MAX_HP
        s.hurt_at = nil
        s.changed = true
        @on_change&.call(s)
        [ { type: "quest", action: "healed", hub_key: hub.key } ]
      end

      # what the client paints over the people of a hub: how much work is on offer and how well you are known there
      def board(s, hub_key, now)
        return refuse("unknown") unless @hubs[hub_key]
        [ board_msg(hub_key, s, now) ]
      end

      # ---- the offers ---------------------------------------------------------------------------------------------

      # Everything a hub has today: the daily jobs, the same for everyone from a seed of hub and date, plus the next
      # step of every chain this player has unlocked there. Without a session only the dailies exist, which is what
      # makes them testable on their own.
      def offers_for(hub, s = nil, now = Game.now_ms)
        date = @today.call.to_s
        rng = Random.new(Zlib.crc32("#{hub.key}:#{date}"))
        dailies = QuestLines.daily_kinds(hub.role).each_with_index.filter_map do |kind, i|
          build_daily(hub, kind, i, rng, date)
        end
        return dailies unless s
        # A daily is gone once it is settled either way: you had your chance at it today. A chain step is only gone
        # once it is DONE. Barring a failed step for ever killed the whole line — the key carries no date, so a single
        # missed deadline, one press of abandon or one death in a dragon finale ended the story at that hub
        # permanently, which is the opposite of the reason chains exist.
        taken = active(s.id).map { _1[:key] }
        rows = history(s.id, hub.key)
        done = rows.select { _1[:status] == "done" }.map { _1[:key] }
        settled = rows.reject { _1[:status] == "active" }.map { _1[:key] }
        r = rank(s.id, hub.key)
        (dailies + chain_offers(hub, s, now))
          .reject { |o| taken.include?(o[:key]) || (o[:line] ? done : settled).include?(o[:key]) }
          .map { _1.merge(reward: promise(scale(_1[:reward], r), s)) }
      end

      # the standing a player has at a hub, in points and in rank
      def standing(player_id, hub_key)
        points = history(player_id, hub_key).sum do |row|
          case row[:status]
          when "done"    then row[:line] && row[:step] && last_step?(row) ? REP["done"] + REP["finale"] : REP["done"]
          when "failed"  then REP["failed"]
          when "expired" then REP["expired"]
          else 0
          end
        end
        [ points, 0 ].max
      end

      def rank(player_id, hub_key) = Dialogue.rank_for(standing(player_id, hub_key))

      private

      # ---- building a quest ----------------------------------------------------------------------------------------

      def build_daily(hub, kind, i, rng, date)
        ctx = QuestLines::Ctx.new(hub:, hubs: @hubs, rng:)
        blueprint = QuestLines.daily(ctx, kind) or return nil
        finish_offer(blueprint, hub, "#{hub.key}|#{kind}|#{date}|#{i}")
      end

      # the next step of every line whose owner stands at this hub and whose rank gate the player has cleared
      def chain_offers(hub, s, _now)
        rows = history(s.id, hub.key)
        r = rank(s.id, hub.key)
        roles = hub.npcs.to_a.map { _1[:role] }.uniq
        roles = Names.roles_for(hub.role, kind: hub.kind) if roles.empty?
        roles.flat_map { |role| QuestLines.for_role(role) }.uniq { _1[:id] }.filter_map do |line|
          next if r < line[:rank]
          step = next_step(rows, line[:id])
          next if step > line[:steps].size
          next if rows.any? { _1[:line] == line[:id] && _1[:step] == step && _1[:status] == "active" }
          rng = Random.new(Zlib.crc32("#{hub.key}:#{line[:id]}:#{step}"))
          blueprint = QuestLines.build(line[:id], step, QuestLines::Ctx.new(hub:, hubs: @hubs, rng:)) or next
          finish_offer(blueprint, hub, "#{hub.key}|#{line[:id]}|#{step}")
        end
      end

      # the lowest step of a line that has not been finished yet
      def next_step(rows, line_id)
        done = rows.select { _1[:line] == line_id && _1[:status] == "done" }.map { _1[:step].to_i }
        (done.max || 0) + 1
      end

      def last_step?(row) = row[:step].to_i >= QuestLines.steps(row[:line]).to_i && QuestLines.steps(row[:line]).positive?

      # the offer as it leaves the blueprint: a key, resolved radii and the person at this hub who owns it
      def finish_offer(blueprint, hub, key)
        stages = Array(blueprint[:stages]).map { |st| st.merge(radius: (st[:radius] || ARRIVE_R).to_f) }
        npc = hub.npcs.to_a.find { Array(blueprint[:giver_role]).include?(_1[:role]) } || hub.npcs.to_a.first
        blueprint.merge(key:, hub_key: hub.key, npc_id: npc && npc[:id], stages:,
                        target_key: stages.first && stages.first.dig(:target, :key),
                        deadline_s: stages.first && stages.first[:deadline_s],
                        requires: blueprint[:requires] || stages.first&.fetch(:requires, nil))
      end

      # What may honestly be put on the poster. A skill point or an unlock is only promised when the session can
      # actually be handed one; otherwise the promise is turned into gold here, so the offer, the stored quest and
      # the payout all say the same thing and nobody is told about a point that will never arrive.
      def promise(reward, s)
        r = reward.dup
        if r[:skill_point].to_i.positive? && !s.respond_to?(:grant_points!)
          r[:gold] += SKILL_GOLD * r.delete(:skill_point).to_i
        end
        if r[:unlock] && !s.respond_to?(:grant_unlock!)
          r.delete(:unlock)
          r[:gold] += UNLOCK_GOLD
        end
        r
      end

      # standing is worth money: every rank adds a share to the purse of everything the hub hands out
      def scale(reward, rank)
        r = (reward || {}).dup
        factor = 1.0 + RANK_PAY * rank
        r[:gold] = (r[:gold].to_i * factor).round
        r[:xp]   = (r[:xp].to_i * factor).round
        r
      end

      # an accepted offer becomes a live quest: stage nought, its clock started
      def start(offer, s, now)
        q = offer.merge(player_id: s.id, status: "active", stage: 0, accepted_at: now, stage_at: now,
                        progress: {}, expires_at: now + (offer[:expires_s] || QuestLines::DAILY_EXPIRES_S) * 1000)
        q.delete(:expires_s)
        q[:deadline_at] = stage_deadline(q, now)
        q
      end

      def stage_deadline(q, now)
        st = stage(q)
        st && st[:deadline_s] ? now + st[:deadline_s] * 1000 : nil
      end

      # ---- the stage machine ---------------------------------------------------------------------------------------

      def stage(q) = Array(q[:stages])[q[:stage].to_i]

      def target_key(st, _q) = st.dig(:target, :key)

      # where a stage points: a hub by key, or a bare spot in the fields
      def point(st, q)
        t = st[:target] || {}
        if t[:key] && (hub = @hubs[t[:key]])
          { key: hub.key, name: hub.name, x: hub.x, z: hub.z }
        elsif t[:x] && t[:z]
          { key: nil, name: t[:name] || "de plek", x: t[:x].to_f, z: t[:z].to_f }
        elsif (hub = @hubs[q[:hub_key]])
          { key: hub.key, name: hub.name, x: hub.x, z: hub.z }
        end
      end

      def check_stage(s, q, now, msgs)
        st = stage(q) or return
        return if st[:kind] == "hunt"                                   # those end on a kill, not on a position
        p = point(st, q) or return
        inside = Math.hypot(p[:x] - s.x, p[:z] - s.z) <= st[:radius].to_f
        inside &&= s.vehicle == st[:requires] if st[:requires]
        inside &&= dark?(now) if st[:when_dark]
        q[:progress] ||= {}
        dwell = st[:dwell_s].to_i
        unless inside
          # The clock on a search only runs while you are there, and the client draws that bar, so both edges of
          # standing still are worth a message; nothing else about a stage changes often enough to need one.
          if q[:progress][:in_since]
            q[:progress][:in_since] = nil
            msgs << [ s.id, { type: "quest", action: "dwell", key: q[:key], since: nil } ] if dwell.positive?
          end
          return
        end
        return advance!(s, q, now, msgs) if dwell.zero?
        unless q[:progress][:in_since]
          q[:progress][:in_since] = now
          msgs << [ s.id, { type: "quest", action: "dwell", key: q[:key], since: now } ]
        end
        advance!(s, q, now, msgs) if now - q[:progress][:in_since] >= dwell * 1000
      end

      # one stage done: either the next one starts, with its own clock and its own line, or the quest is finished
      def advance!(s, q, now, msgs)
        q[:stage] = q[:stage].to_i + 1
        q[:progress] = (q[:progress] || {}).merge(in_since: nil)
        q[:stage_at] = now
        return complete!(s, q, now, msgs) unless stage(q)
        q[:deadline_at] = stage_deadline(q, now)
        @store.save(q)
        msgs << [ s.id, { type: "quest", action: "stage", quest: client(q), note: stage(q)[:note] } ]
      end

      def complete!(s, q, now, msgs)
        active(s.id).delete(q)
        q[:status] = "done"
        q[:completed_at] = now
        q[:stage] = Array(q[:stages]).size
        given = pay!(s, q)
        @store.save(q)
        remember(s.id, q, "done")
        hub = @hubs[q[:hub_key]]
        said = hub && Dialogue.done(scene_for(hub, npc_at(hub, q[:npc_id]), s, now))
        msgs << [ s.id, { type: "quest", action: "completed", quest: client(q), given:, said: } ]
      end

      def fail!(s, q, reason, now, msgs, action: "failed", status: "failed")
        active(s.id).delete(q)
        q[:status] = status
        q[:completed_at] = now
        q[:reason] = reason
        @store.save(q)
        remember(s.id, q, status)
        hub = @hubs[q[:hub_key]]
        said = hub && Dialogue.failed(scene_for(hub, npc_at(hub, q[:npc_id]), s, now))
        msgs << [ s.id, { type: "quest", action:, quest: client(q), said: } ]
      end

      def expire!(s, q, now, msgs) = fail!(s, q, "verlopen; ze zijn er in #{@hubs[q[:hub_key]]&.name || 'het dorp'} klaar mee",
                                           now, msgs, action: "expired", status: "expired")

      # ---- paying ---------------------------------------------------------------------------------------------------

      # What the player actually got, which is not always what the quest promised: a skill point or an unlock is only
      # handed over when the session knows how to hold one. Until Game::Progression grows a way to grant either
      # without charging the player for it, the promise is paid out in gold, and the message says so rather than
      # claiming a point that does not exist.
      def pay!(s, q)
        r = q[:reward] || {}
        given = { gold: r[:gold].to_i, xp: r[:xp].to_i }
        if r[:skill_point].to_i.positive?
          if s.respond_to?(:grant_points!)
            s.grant_points!(r[:skill_point].to_i)
            given[:skill_point] = r[:skill_point].to_i
          else
            given[:gold] += SKILL_GOLD * r[:skill_point].to_i
          end
        end
        if (key = r[:unlock])
          if s.respond_to?(:grant_unlock!) && !(s.respond_to?(:unlocked?) && s.unlocked?(key))
            s.grant_unlock!(key)
            given[:unlock] = key
          else
            given[:gold] += UNLOCK_GOLD
          end
        end
        s.gold += given[:gold]
        s.xp += given[:xp]
        s.changed = true
        @on_change&.call(s)
        given
      end

      # ---- standing and history -------------------------------------------------------------------------------------

      def history(player_id, hub_key) = @hist[[ player_id, hub_key ]] ||= @store.history(player_id, hub_key)

      def remember(player_id, q, status)
        rows = history(player_id, q[:hub_key])
        row = rows.find { _1[:key] == q[:key] }
        if row then row[:status] = status
        else rows << { key: q[:key], status:, line: q[:line], step: q[:step] }
        end
      end

      # ---- the people and the scene ---------------------------------------------------------------------------------

      def npc_at(hub, npc_id)
        hub.npcs.to_a.find { _1[:id] == npc_id } || hub.npcs.to_a.first ||
          { id: "#{hub.key}/0", name: hub.name, role: default_role(hub) }
      end

      def default_role(hub) = Names.roles_for(hub.role, kind: hub.kind).first || "koopman"

      def scene_for(hub, npc, s, now)
        lair = nearest_lair(hub)
        Dialogue::Scene.new(npc:, hub:, rank: rank(s.id, hub.key), standing: standing(s.id, hub.key),
                            phase: phase(now), sky: Weather.for(@today.call), trait: Names.trait(npc[:id]),
                            blurb: TownInfo.sentence(hub.name, hub.kind), landmark: lair&.name || nearest_mark(hub)&.name,
                            dragon: dragon_for(lair), now:)
      end

      def nearest_lair(hub) = @hubs.values.select { _1.role == "lair" && dist(hub, _1) < 6_000 }.min_by { dist(hub, _1) }
      def nearest_mark(hub) = @hubs.values.select { _1.key != hub.key && dist(hub, _1) < 5_000 }.min_by { dist(hub, _1) }

      def dragon_for(lair)
        return nil unless lair && @dragons
        d = @dragons.call(lair.key) or return nil
        { name: d.respond_to?(:name) ? d.name : nil, awake: d.respond_to?(:awake?) ? d.awake? : false,
          alive: d.respond_to?(:alive?) ? d.alive? : true }
      rescue StandardError
        nil
      end

      def hub_actions(hub) = %w[town shrine].include?(hub.role) ? [ "heal" ] : []

      def standing_payload(scene)
        { rank: scene.rank, name: Dialogue.rank_name(scene.rank), points: scene.standing, line: Dialogue.standing_line(scene) }
      end

      def clock_payload(now) = { phase: phase(now).to_s, hour: hours(now).round(2), weather: Weather.for(@today.call).key.to_s }

      def board_msg(hub_key, s, now)
        hub = @hubs[hub_key]
        offers = hub ? offers_for(hub, s, now) : []
        { type: "quest", action: "board", hub_key:, offers: offers.size,
          chain: offers.any? { _1[:line] }, rank: rank(s.id, hub_key), rank_name: Dialogue.rank_name(rank(s.id, hub_key)),
          npcs: offers.filter_map { _1[:npc_id] }.uniq, turn_in: active(s.id).any? { _1[:hub_key] == hub_key && stage(_1)&.dig(:kind) == "return" } }
      end

      def offers_for_npc(hub, npc, s, now)
        all = offers_for(hub, s, now)
        mine = all.select { _1[:npc_id] == npc[:id] }
        mine.any? || hub.npcs.to_a.size > 1 ? mine : all
      end

      # ---- the clock ------------------------------------------------------------------------------------------------

      def hours(now) = @clock ? @clock.call(now) : DayClock.hours(now)
      def phase(now) = DayClock.phase_of(hours(now))
      def dark?(now) = DayClock.dark_hour?(hours(now))

      # ---- the rest -------------------------------------------------------------------------------------------------

      def dist(a, b) = Math.hypot(a.x - b.x, a.z - b.z)
      def near?(s, hub) = s.x && Math.hypot(hub.x - s.x, hub.z - s.z) <= TALK_R
      def refuse(reason) = [ { type: "quest", ok: false, reason: } ]

      def active(player_id) = @active[player_id] ||= @store.load_active(player_id)

      def client_offer(o)
        st = Array(o[:stages]).first || {}
        t = point(st, o)
        { key: o[:key], kind: o[:kind], title: o[:title], text: o[:brief], brief: o[:brief], requires: o[:requires],
          line: o[:line], line_name: o[:line_name], step: o[:step], steps: o[:line] ? QuestLines.steps(o[:line]) : 1,
          stages: Array(o[:stages]).size, deadline_s: st[:deadline_s], expires_s: o[:expires_s],
          reward: o[:reward], npc_id: o[:npc_id], objective: st[:objective], target: t }
      end

      # everything the client needs to draw a quest: where it points now, what it wants now, how long it has
      def client(q)
        st = stage(q)
        t = st && point(st, q)
        { key: q[:key], kind: q[:kind], status: q[:status], title: q[:title], text: q[:brief], brief: q[:brief],
          line: q[:line], line_name: q[:line_name], step: q[:step], steps: q[:line] ? QuestLines.steps(q[:line]) : 1,
          hub_key: q[:hub_key], hub_name: @hubs[q[:hub_key]]&.name, npc_id: q[:npc_id],
          stage: q[:stage].to_i, stage_count: Array(q[:stages]).size,
          objective: st && st[:objective], stage_kind: st && st[:kind], peril: st ? !!st[:peril] : false,
          fragile: st ? !!st[:fragile] : false, when_dark: st ? !!st[:when_dark] : false,
          dwell_s: st && st[:dwell_s], dwell_since: q.dig(:progress, :in_since), radius: st && st[:radius],
          requires: st ? st[:requires] : q[:requires], target: t, reward: q[:reward],
          accepted_at: q[:accepted_at], deadline_at: q[:deadline_at], expires_at: q[:expires_at],
          completed_at: q[:completed_at], reason: q[:reason] }
      end
    end
  end
end
