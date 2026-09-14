module Game
  # The quests table behind Game::Quests::Board. Active quests are loaded when a player first talks or is looked at
  # and every change is written straight away; times travel as server milliseconds and are stored as timestamps.
  #
  # The table is also the town's memory. `history` reads back every quest a player ever took from one hub, finished
  # or not, and that list is what the standing at that hub is counted from — there is no reputation column anywhere,
  # because a number kept beside the rows could only ever drift away from them. It is one indexed query per player
  # per hub, cached in the board for as long as that player is in the room.
  #
  # The stages of a quest live inside the objective blob rather than in columns of their own. They are written once
  # at accept time and never queried; only the stage the player is on is a column, because that is the one thing a
  # crash has to be able to come back to.
  class QuestStore
    def load_active(player_id)
      Quest.where(player_id:, status: "active").order(:accepted_at).map { row_to_h(_1) }
    end

    # every quest this player ever took from this hub: what the people there remember about them
    def history(player_id, hub_key)
      Quest.where(player_id:, hub_key:).pluck(:key, :status, :line, :step).map do |key, status, line, step|
        { key:, status:, line:, step: step&.to_i }
      end
    end

    def save(q)
      row = { player_id: q[:player_id], key: q[:key], kind: q[:kind], status: q[:status], hub_key: q[:hub_key],
              line: q[:line], step: q[:step].to_i, stage: q[:stage].to_i,
              objective: objective_of(q), reward: q[:reward] || {}, progress: q[:progress] || {},
              accepted_at: ms_to_time(q[:accepted_at]), deadline_at: ms_to_time(q[:deadline_at]),
              expires_at: ms_to_time(q[:expires_at]), completed_at: ms_to_time(q[:completed_at]),
              created_at: Time.current, updated_at: Time.current }
      Quest.upsert(row, unique_by: %i[player_id key])
    end

    private

    def objective_of(q)
      { target_key: q[:target_key], title: q[:title], brief: q[:brief], text: q[:brief], requires: q[:requires],
        reason: q[:reason], npc_id: q[:npc_id], line_name: q[:line_name], last: q[:last], stages: q[:stages] }.compact
    end

    def row_to_h(r)
      o = r.objective.symbolize_keys
      { player_id: r.player_id, key: r.key, kind: r.kind, status: r.status, hub_key: r.hub_key, line: r.line,
        step: r.step, stage: r.stage.to_i, target_key: o[:target_key], title: o[:title], brief: o[:brief] || o[:text],
        requires: o[:requires], reason: o[:reason], npc_id: o[:npc_id], line_name: o[:line_name], last: o[:last],
        stages: stages_of(o, r),
        reward: r.reward.symbolize_keys, progress: r.progress.symbolize_keys,
        accepted_at: time_to_ms(r.accepted_at), deadline_at: time_to_ms(r.deadline_at),
        expires_at: time_to_ms(r.expires_at), completed_at: time_to_ms(r.completed_at) }
    end

    # A quest stored before quests had stages still has to be finishable, so one is made up out of what that row
    # does carry: go to the target it named (or kill what lives there) and the thing is done.
    def stages_of(objective, row)
      stages = Array(objective[:stages]).map { deep_symbolize(_1) }
      return stages if stages.any?
      [ { kind: row.kind == "hunt" ? "hunt" : "goto", target: { key: objective[:target_key] },
          radius: row.kind == "scout" ? 120.0 : 25.0, objective: objective[:title] } ]
    end

    # a stage comes back from jsonb with string keys, and its target hash with them too
    def deep_symbolize(value)
      case value
      when Hash  then value.to_h { |k, v| [ k.to_sym, deep_symbolize(v) ] }
      when Array then value.map { deep_symbolize(_1) }
      else value
      end
    end

    def ms_to_time(ms) = ms && Time.at(ms / 1000.0).utc
    def time_to_ms(t) = t && (t.to_f * 1000).round
  end
end
