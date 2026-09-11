module Api
  class WorldController < ApplicationController
    def show
      render json: {
        origin: { x: World::ORIGIN_X, y: World::ORIGIN_Y },
        tile_size: World::TILE_SIZE,
        height_step: World::HEIGHT_STEP,
        height_n: World::HEIGHT_N,
        # where a new player starts until they have a hub of their own (game units; see Game::WORLD_SPAWN)
        spawn: Game::WORLD_SPAWN,
        # Towns, villages and districts (game units) for the street sign
        places: Place.for_client,
        # the hubs: towns, lairs, shrines and shops with their spawn road and the people standing there
        hubs: Hub.all_for_client,
        # play area in RD metres [x0, y0, x1, y1] (the minimap shows this when expanded)
        bounds: World.bounds_rd,
        # province border rings in game units: outside them is a wall of flames
        border: Boundary.rings_for_client,
        # changes whenever tiles:build rewrites public/tiles, so browsers drop their cached tile files (the static
        # file server sends a two-day max-age)
        tiles_version: (dir = Rails.root.join("public", "tiles")).exist? ? File.mtime(dir).to_i : 0,
        # the newest file under public/textures and public/models: the client appends it to their URLs
        assets_version: Dir[Rails.root.join("public", "{textures,models}", "**", "*").to_s].map { File.mtime(_1).to_i }.max || 0,
        # aerial photos: a prefetched copy under public/ortho (ortho:fetch) is tried first, PDOK live unless ORTHO_LIVE=0
        ortho: { local: (od = Rails.root.join("public", "ortho")).exist?, live: ENV["ORTHO_LIVE"] != "0", version: od.exist? ? File.mtime(od).to_i : 0 },
        # server clock in milliseconds; the client offsets Date.now() by it so every player sees the same world
        now: Game.now_ms
      }
    end
  end
end
