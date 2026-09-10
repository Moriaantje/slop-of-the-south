# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_09_10_000008) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"
  enable_extension "postgis"
  enable_extension "postgis_sfcgal"

  create_table "building_meshes", force: :cascade do |t|
    t.string "bag_id", null: false
    t.geometry "center", limit: {srid: 28992, type: "st_point"}, null: false
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "multi_polygon", has_z: true}, null: false
    t.float "ground_height"
    t.integer "labels", default: [], null: false, array: true
    t.string "roof_type"
    t.datetime "updated_at", null: false
    t.index ["bag_id"], name: "index_building_meshes_on_bag_id", unique: true
    t.index ["center"], name: "index_building_meshes_on_center", using: :gist
  end

  create_table "buildings", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "st_polygon"}, null: false
    t.float "ground_height"
    t.float "height", default: 6.0, null: false
    t.string "kind"
    t.integer "levels"
    t.string "name"
    t.float "roof_height"
    t.string "roof_type"
    t.string "source", default: "osm", null: false
    t.string "source_id", null: false
    t.datetime "updated_at", null: false
    t.integer "year"
    t.index ["geom"], name: "index_buildings_on_geom", using: :gist
    t.index ["source", "source_id"], name: "index_buildings_on_source_and_source_id", unique: true
    t.index ["source"], name: "index_buildings_on_source"
  end

  create_table "land_covers", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "multi_polygon"}, null: false
    t.string "kind", null: false
    t.string "layer", null: false
    t.string "source_id", null: false
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_land_covers_on_geom", using: :gist
    t.index ["layer"], name: "index_land_covers_on_layer"
    t.index ["source_id"], name: "index_land_covers_on_source_id", unique: true
  end

  create_table "places", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "st_point"}, null: false
    t.string "kind", null: false
    t.string "name", null: false
    t.bigint "osm_id", null: false
    t.integer "population"
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_places_on_geom", using: :gist
    t.index ["kind"], name: "index_places_on_kind"
    t.index ["osm_id"], name: "index_places_on_osm_id", unique: true
  end

  create_table "roads", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "line_string"}, null: false
    t.string "highway", null: false
    t.string "name"
    t.boolean "oneway", default: false, null: false
    t.bigint "osm_id", null: false
    t.datetime "updated_at", null: false
    t.float "width", default: 5.5, null: false
    t.index ["geom"], name: "index_roads_on_geom", using: :gist
    t.index ["osm_id"], name: "index_roads_on_osm_id", unique: true
  end

  create_table "trees", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "st_point"}, null: false
    t.float "height", null: false
    t.string "kind", null: false
    t.string "source", null: false
    t.string "source_id", null: false
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_trees_on_geom", using: :gist
    t.index ["source", "source_id"], name: "index_trees_on_source_and_source_id", unique: true
  end
end
