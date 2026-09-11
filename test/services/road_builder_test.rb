require "test_helper"

# The private geometry helpers of RoadBuilder run on any object with #sample(x, y), so no roads table is needed.
class RoadBuilderTest < ActiveSupport::TestCase
  Slope = Struct.new(:base, :grade) do
    def sample(_x, y) = base + grade * y
  end

  def road(kind: "residential", width: 5.5, bridge: false, pts: [ [ 0.0, 0.0 ], [ 200.0, 0.0 ] ])
    RoadBuilder::RoadRow.new(1, kind, "Teststraat", width, nil, nil, nil, bridge, false, pts)
  end

  def builder(grid = Geo::HeightGrid::Flat.new) = RoadBuilder.new(grid)

  test "deformer seats the bed at the road level, the verge a curb higher and blends back over the shoulder" do
    piece = [ road, [ [ 0.0, 0.0, 41.0, 0 ], [ 200.0, 0.0, 41.0, 0 ] ] ]
    deform = builder.send(:deformer, [ piece ], {})
    flat = Geo::HeightGrid::FLAT_HEIGHT
    hw = World::HEIGHT_STEP / 2.0                       # 5.5 m road → bed half-width is the 5 m minimum
    assert_in_delta 41.0, deform.call(100.0, 0.0, flat), 1e-9, "bed under the centreline"
    assert_in_delta 41.0, deform.call(100.0, hw - 0.1, flat), 1e-9, "bed to the edge of the band"
    assert_in_delta 41.0 + RoadBuilder::CURB, deform.call(100.0, hw + 0.1, flat), 1e-9, "verge just outside the bed"
    assert_in_delta 41.0 + RoadBuilder::CURB, deform.call(100.0, hw + RoadBuilder::VERGE - 0.1, flat), 1e-9, "verge to the end of the strip"
    mid = hw + RoadBuilder::VERGE + RoadBuilder::SHOULDER / 2
    expected = (41.0 + RoadBuilder::CURB + flat) / 2
    assert_in_delta expected, deform.call(100.0, mid, flat), 1e-9, "halfway along the shoulder"
    assert_in_delta flat, deform.call(100.0, hw + RoadBuilder::VERGE + RoadBuilder::SHOULDER + 1, flat), 1e-9, "natural terrain beyond"
    assert_in_delta flat, deform.call(100.0, 60.0, flat), 1e-9
  end

  test "deformer leaves the ground alone under bridge decks and paths" do
    deck = [ road, [ [ 0.0, 0.0, 45.0, 1 ], [ 200.0, 0.0, 45.0, 1 ] ] ]
    path = [ road(kind: "cycleway", width: 2.5), [ [ 0.0, 50.0, 41.0, 0 ], [ 200.0, 50.0, 41.0, 0 ] ] ]
    deform = builder.send(:deformer, [ deck, path ], {})
    assert_in_delta 40.0, deform.call(100.0, 0.0, 40.0), 1e-9
    assert_in_delta 40.0, deform.call(100.0, 50.0, 40.0), 1e-9
  end

  test "deformer seats junction patches that the pieces were cut back from" do
    nodes = { [ 0, 0 ] => { x: 100.0, y: 0.0, h: 42.0, r: 3.75, degree: 3, roads: [ 0, 1 ] } }
    deform = builder.send(:deformer, [], nodes)
    assert_in_delta 42.0, deform.call(100.0, 0.0, 40.0), 1e-9, "the disc centre"
    assert_in_delta 42.0, deform.call(100.0, 4.0, 40.0), 1e-9, "the disc rim (radius + 0.5, at least half a height step)"
    assert_in_delta 42.0 + RoadBuilder::CURB, deform.call(100.0, 6.0, 40.0), 1e-9, "verge around the disc"
  end

  test "pin! keeps a minor road within the cut and fill limits of the terrain, bridges excepted" do
    grid = Slope.new(40.0, 0.2)                          # 20 % climb along y
    rd = road(pts: [ [ 0.0, 0.0 ], [ 0.0, 400.0 ] ])
    b = builder(grid)
    prof = b.send(:profile, rd)
    prof.each { |p| p[5] = false }
    prof.each { |p| p[3] = p[2] + 3.0 }                  # pretend the smoothing floated the road 3 m up
    b.send(:pin!, [ [ rd, prof ] ], {})
    prof.each { |p| assert_in_delta p[2] + RoadBuilder::FILL_LIMIT[:minor], p[3], 1e-9 }
    prof.each { |p| p[3] = p[2] - 3.0 }                  # …or sank it 3 m
    b.send(:pin!, [ [ rd, prof ] ], {})
    prof.each { |p| assert_in_delta p[2] - RoadBuilder::CUT_LIMIT, p[3], 1e-9 }

    bridge = road(bridge: true, pts: [ [ 0.0, 0.0 ], [ 0.0, 400.0 ] ])
    bprof = b.send(:profile, bridge)
    bprof.each { |p| p[5] = true; p[3] = p[2] + 3.0 }
    b.send(:pin!, [ [ bridge, bprof ] ], {})
    bprof.each { |p| assert_in_delta p[2] + 3.0, p[3], 1e-9, "bridges float" }
  end

  test "roads meeting at a node share its height after pinning" do
    grid = Slope.new(40.0, 0.05)
    a = road(pts: [ [ 0.0, 0.0 ], [ 100.0, 0.0 ] ])
    c = road(kind: "primary", width: 8.0, pts: [ [ 100.0, -100.0 ], [ 100.0, 0.0 ] ])
    d = road(kind: "primary", width: 8.0, pts: [ [ 100.0, 0.0 ], [ 100.0, 100.0 ] ])
    b = builder(grid)
    profiles = [ a, c, d ].map { |rd| [ rd, b.send(:profile, rd) ] }
    profiles.each { |_, prof| prof.each { |p| p[5] = false } }
    nodes = b.send(:junction_nodes, profiles)
    node = nodes[[ 10_000, 0 ]]
    assert node, "node at (100, 0)"
    assert_equal 3, node[:degree]
    b.send(:pin!, profiles, nodes)
    ends = profiles.map { |_, prof| prof.find { |p| (p[0] - 100.0).abs < 1e-6 && p[1].abs < 1e-6 }[3] }
    assert_in_delta ends[0], ends[1], 1e-9
    assert_in_delta node[:h], ends[0], 1e-9
    assert_operator node[:h], :<=, grid.sample(100.0, 0.0) + RoadBuilder::FILL_LIMIT[:minor], "node clamped to the tightest class"
  end
end
