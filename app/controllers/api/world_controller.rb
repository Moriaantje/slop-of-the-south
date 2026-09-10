module Api
  class WorldController < ApplicationController
    def show
      render json: {
        origin: { x: World::ORIGIN_X, y: World::ORIGIN_Y },
        tile_size: World::TILE_SIZE,
        height_step: World::HEIGHT_STEP,
        height_n: World::HEIGHT_N,
        # Spawn in game units, roughly Geleen station (RD ≈ 185900, 331680). Tune once tiles exist.
        spawn: { x: 900, z: -1680, yaw: 0 }
      }
    end
  end
end
