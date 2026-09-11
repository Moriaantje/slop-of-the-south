require "test_helper"

class GameTest < ActiveSupport::TestCase
  test "compass headings become yaws in (-π, π]" do
    assert_in_delta 0, Game.yaw(0), 0.001
    assert_in_delta(-Math::PI / 2, Game.yaw(Math::PI / 2), 0.001)
    assert_in_delta Math::PI / 2, Game.yaw(3 * Math::PI / 2), 0.001
    assert_in_delta(-0.611, Game.yaw(0.611), 0.001)
  end

  test "point keys match the decimetre rounding of the tiles" do
    assert_equal "t:12937,-140690", Game.point_key("t", 1293.7, -14069.04)
    assert_equal "l:-5,0", Game.point_key("l", -0.46, 0.04)
  end

  test "hub keys" do
    assert_match Game::HUB_KEY_RE, "p:123456"
    assert_match Game::HUB_KEY_RE, "o:w98765"
    assert_no_match Game::HUB_KEY_RE, "x:1"
  end
end
