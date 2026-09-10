module Api
  class WorldController < ApplicationController
    def show
      render json: {
        origin: { x: World::ORIGIN_X, y: World::ORIGIN_Y },
        tile_size: World::TILE_SIZE,
        height_step: World::HEIGHT_STEP,
        height_n: World::HEIGHT_N,
        # Spawn in game units: on Rijksweg Noord in Geleen (RD ≈ 186293, 331407), facing north-north-east
        # towards Sittard. yaw is radians, 0 = north, positive turns left; see Vehicle.js.
        spawn: { x: 1293.2, z: -1406.9, yaw: -0.611 }
      }
    end
  end
end
