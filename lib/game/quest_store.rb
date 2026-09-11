module Game
  # The quests table behind Game::Quests::Board: active quests are loaded when a player first talks or is looked at,
  # every change is written straight away. Times travel as server milliseconds.
  class QuestStore
    COLUMNS = %i[key kind status hub_key target_key title text requires reward progress accepted_at deadline_at completed_at reason].freeze

    def load_active(player_id)
      Quest.where(player_id:, status: "active").order(:accepted_at).map { row_to_h(_1) }
    end

    def save(q)
      row = { player_id: q[:player_id], key: q[:key], kind: q[:kind], status: q[:status], hub_key: q[:hub_key],
              objective: { target_key: q[:target_key], title: q[:title], text: q[:text], requires: q[:requires], reason: q[:reason] }.compact,
              reward: q[:reward] || {}, progress: q[:progress] || {},
              accepted_at: ms_to_time(q[:accepted_at]), deadline_at: ms_to_time(q[:deadline_at]), completed_at: ms_to_time(q[:completed_at]),
              created_at: Time.current, updated_at: Time.current }
      Quest.upsert(row, unique_by: %i[player_id key])
    end

    private

    def row_to_h(r)
      o = r.objective.symbolize_keys
      { player_id: r.player_id, key: r.key, kind: r.kind, status: r.status, hub_key: r.hub_key, target_key: o[:target_key], title: o[:title], text: o[:text],
        requires: o[:requires], reason: o[:reason], reward: r.reward.symbolize_keys, progress: r.progress.symbolize_keys,
        accepted_at: time_to_ms(r.accepted_at), deadline_at: time_to_ms(r.deadline_at), completed_at: time_to_ms(r.completed_at) }
    end

    def ms_to_time(ms) = ms && Time.at(ms / 1000.0).utc
    def time_to_ms(t) = t && (t.to_f * 1000).round
  end
end
