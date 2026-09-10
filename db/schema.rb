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

ActiveRecord::Schema[8.1].define(version: 2026_09_10_000003) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"
  enable_extension "postgis"

  create_table "buildings", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "st_polygon"}, null: false
    t.float "height", default: 6.0, null: false
    t.string "kind"
    t.integer "levels"
    t.string "name"
    t.bigint "osm_id", null: false
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_buildings_on_geom", using: :gist
    t.index ["osm_id"], name: "index_buildings_on_osm_id", unique: true
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
end
