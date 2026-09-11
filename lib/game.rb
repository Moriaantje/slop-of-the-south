# The persistent fantasy world: one Game::WorldManager per room owns the players' sessions, the destruction verdicts,
# the actors (dragons) and the quests, and ticks four times a second. Server time is wall-clock milliseconds, the
# clock every client offsets itself against.
module Game
  # destruction keys the channel accepts: m:<bag id>, b:<building id>, t/l/g/s:<dm x>,<dm z>
  KEY_RE = /\A[mbtlgs]:[\w,.-]{1,40}\z/
  # hub keys: p:<places osm id> for towns, o:<n|w|r><osm id> for landmarks
  HUB_KEY_RE = /\A[po]:[nwr]?\d{1,12}\z/
  VEHICLES = %w[auto brommer trike monster tank bulldozer sloopkraan mech].freeze

  # Where the world starts when a player has no hub yet: on Rijksweg Noord in Geleen (RD ≈ 186293, 331407), facing
  # north-north-east towards Sittard. yaw is radians, 0 = north, positive turns left; see Vehicle.js.
  WORLD_SPAWN = { x: 1293.2, z: -1406.9, yaw: -0.611 }.freeze

  def self.now_ms = (Time.now.to_f * 1000).to_i

  # Key of a point object (tree, lamp post, traffic light, sign) from its game coordinates. Tiles round these to
  # 0.1 m, so decimetre integers make the client (Math.round(x * 10)) and the server agree exactly.
  def self.point_key(prefix, gx, gz) = "#{prefix}:#{(gx.round(1) * 10).round},#{(gz.round(1) * 10).round}"

  # compass radians → Vehicle.js yaw (0 north, positive turns left) in (-π, π]
  def self.yaw(compass) = (((Math::PI - compass) % (2 * Math::PI)) - Math::PI).round(3)
end
