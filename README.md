# Mijnstreek Drive

A multiplayer arcade driving game set in the Westelijke Mijnstreek (Sittard, Geleen, Beek, Neerbeek,
Stein, Urmond, Brunssum and everything in between), built from real geodata.

Backend: Ruby on Rails 8.1 + PostgreSQL/PostGIS + Action Cable.
Frontend: Three.js as native ES modules via `importmap-rails` (no Node toolchain).

---

## 1. The plan

### 1.1 Play area

Bounding box (WGS84) covering all named places plus the villages between them
(Elsloo, Meers, Berg aan de Maas, Obbicht, Grevenbicht, Born, Limbricht, Guttecoven, Einighausen,
Munstergeleen, Spaubeek, Sweikhuizen, Puth, Schinnen, Oirsbeek, Amstenrade, Doenrade, Merkelbeek,
Schinveld, Jabeek, Bingelrade, Genhout, Kelmond, Geverik):

    lat 50.90 – 51.05   lon 5.70 – 6.02      (~17 km × 22 km ≈ 375 km²)

That is a lot of buildings (well over 100k). Everything is therefore cut into **500 m tiles**
that stream in around the player. Start development on a smaller "phase 1" box around
Sittard–Geleen (`lat 50.94–51.01, lon 5.78–5.90`) and widen later. Both boxes live in
`config/initializers/world.rb`.

### 1.2 Coordinate system

All world data is stored in **RD New (EPSG:28992)**, the Dutch national grid. It is in metres and
nearly distortion-free over Limburg, so 1 unit = 1 metre in Three.js with no per-frame maths.
PostGIS does the reprojection during import (`ST_Transform(..., 28992)`).

Game space is RD minus a fixed origin so floats stay small:

    game.x =  (rd.x - ORIGIN_X)        east
    game.z = -(rd.y - ORIGIN_Y)        south  (Three.js is y-up, right-handed)
    game.y =  elevation in metres NAP

### 1.3 Data sources

| Layer | Source | Notes |
|---|---|---|
| Roads, water, land use | OpenStreetMap via Overpass (MVP) or Geofabrik Limburg `.pbf` + `osm2pgsql` (full box) | `rake osm:fetch osm:import` |
| Buildings | **3D BAG** (3dbag.nl, TU Delft, CC BY 4.0) | LoD2.2 surfaces: the real roof planes and walls per building (`building_meshes`, ~12 faces per house), triangulated on the client. LoD1.3 parts are imported too as a fallback for the few buildings without a LoD2.2 model. `rake bag3d:fetch bag3d:import` downloads the GeoPackage tiles and loads them with `ogr2ogr`. |
| Buildings (fallback) | OpenStreetMap footprints | Only used where no 3D BAG building overlaps, i.e. across the German border. `height` / `building:levels` tags, fallback 6 m. |
| Place names | OpenStreetMap `place=*` nodes (towns, villages, wijken) | Drive the HUD street sign (nearest named road + nearest place) |
| Trees | **BGT** (Basisregistratie Grootschalige Topografie) via PDOK OGC API Features | `vegetatieobject_punt` gives every registered tree (`plus_type = boom`); woodland polygons from `begroeidterreindeel` (loofbos, naaldbos, gemengd bos, houtwal) are filled with deterministically scattered trees (`ST_GeneratePoints`). `rake bgt:fetch bgt:import`. |
| Terrain | **AHN** (Actueel Hoogtebestand Nederland) DTM via PDOK WCS | OSM has no elevation. AHN is 0.5 m lidar; the WCS resamples it to the 10 m grid on request, `gdal_fillnodata` fills the holes under buildings and water. Zuid-Limburg is genuinely hilly — 27 m at the Maas to 114 m on the plateau within the phase-1 box. |

Everything above is open data. Keep attribution ("© OpenStreetMap contributors", "AHN", "3D BAG")
in the game's about screen.

### 1.4 Pipeline

    Overpass/PBF ──► PostGIS (roads, buildings; EPSG:28992)
    AHN GeoTIFF  ──► gdalwarp ──► data/dem.asc (10 m ASCII grid, EPSG:28992)
                                    │
                                    ▼
                      rake tiles:build ──► public/tiles/{tx}_{ty}.json
                                            ├── heights[51×51]   (10 m spacing)
                                            ├── roads[]          {kind, width, pts}
                                            ├── buildings[]      {base, height, footprint}   (OSM / fallback boxes)
                                            ├── meshes[]         {id, roof, o, f: [[label, ring…]…]} (3D BAG LoD2.2 faces, cm offsets)
                                            └── trees[]          [x, z, kind, height]   (BGT; kind 0 street tree, 1 broadleaf wood, 2 conifer)

Tiles are static JSON served by nginx/Rails' static file server — no DB hit while playing.

### 1.5 Multiplayer

- One `GameChannel` per room (default room `"main"`).
- Clients send `move` at 10 Hz: `{x, y, z, yaw, speed}`. Server stamps it with the player id and
  broadcasts to the room. Client-authoritative — fine for a fun game with friends; cheating is
  a "later" problem.
- Remote cars are interpolated ~100 ms behind real time so they move smoothly.
- Presence: `subscribed` / `unsubscribed` broadcast `join` / `leave`.
- Solid Cable (the Rails 8 default) is enough for a handful of players. For dozens+, switch to
  Redis or AnyCable — the client code doesn't change.

### 1.6 Frontend architecture

    entrypoints/game.js      boot, game loop
    game/World.js            renderer, camera, sky, fog, lights
    game/ChunkManager.js     loads/unloads tiles in a radius around the car
    game/TerrainTile.js      heightmap → mesh, bilinear heightAt(x, z)
    game/Roads.js            polylines → draped ribbons
    game/Buildings.js        footprints → extruded, merged meshes (OSM / fallback)
    game/BuildingMeshes.js   3D BAG LoD2.2 faces → triangulated, flat-shaded meshes
    game/Trees.js            procedural branching trees, a few seeded variants per kind, instanced per tile;
                             variant, rotation, width and tint come from the tree position, so every tree is stable
    game/Locator.js          nearest named road + nearest place for the street sign
    game/Vehicle.js          arcade bicycle-model car physics
    game/Input.js            keyboard
    game/Network.js          Action Cable
    game/RemoteCars.js       interpolation of other players

### 1.7 Milestones

1. **Drive on terrain** — flat tiles, one car, WASD, chase camera. *(this scaffold)*
2. **Real roads & buildings** — Overpass import for the phase-1 box; tiles stream. *(done: 6.3k roads, 60k buildings, street sign HUD)*
3. **Real terrain** — AHN heights; buildings sit correctly on slopes. *(done: `dem:fetch dem:build`, 10 m grid from PDOK WCS)*
4. **Multiplayer** — see each other drive; name tags. *(channel + client already scaffolded)*
5. **Feel** — sound, skid marks, better car model, day/night, collisions with buildings.
6. **Game** — checkpoints between the villages, time trials, leaderboards (Solid Queue jobs),
   maybe a "deliver the vlaai" delivery mode.
7. **Scale** — full bounding box, water (Maas, Julianakanaal). *(trees done via BGT)*

---

## 2. Setup

```bash
# System deps
brew install postgresql postgis gdal      # or apt: postgresql postgis gdal-bin

rails new mijnstreek-drive -d postgresql --skip-jbuilder
cd mijnstreek-drive
# copy the files from this scaffold over the generated app, then:
bundle add activerecord-postgis-adapter importmap-rails
bin/rails importmap:install
# three.js and its addons are vendored into vendor/javascript (see config/importmap.rb)
```

Edit `config/database.yml` and set `adapter: postgis` for every environment.

```bash
bin/rails db:create db:migrate
bin/rails osm:fetch            # Overpass → data/osm/*.json  (phase-1 box, ~1–3 min)
bin/rails osm:import           # → PostGIS
bin/rails bag3d:fetch          # 3D BAG GeoPackage tiles for the box → data/bag3d/tiles (~160 MB for phase 1)
bin/rails bag3d:import         # → PostGIS buildings (source bag3d); needs GDAL
bin/rails bgt:fetch            # BGT trees + vegetated areas → data/bgt (paged GeoJSON, ~400 MB for phase 1)
bin/rails bgt:import           # → PostGIS trees (registered trees + scattered woodland trees)
# real terrain (needs GDAL: brew install gdal):
bin/rails dem:fetch            # AHN terrain model from PDOK WCS → data/dem_raw.tif (10 m, ~1 min)
bin/rails dem:build            # fill holes, convert → data/dem.asc
bin/rails tiles:build          # → public/tiles/*.json  (flat terrain if no dem.asc)
bin/dev                        # Rails (Puma on :3000)
```

Open http://localhost:3000 in two browser windows and drive.

### Local setup notes

- No Node needed: JavaScript is served as ES modules through `importmap-rails` and Propshaft. Imports use bare
  specifiers (`game/World`, `three`, `three/addons/...`) that `config/importmap.rb` resolves; relative imports would
  bypass the digested asset paths, so keep using bare specifiers.
- Three.js is vendored by hand (single-file jsDelivr `+esm` bundle) because the jspm build that `bin/importmap pin`
  downloads is split into chunk files. To add an addon, download it into `vendor/javascript` and pin it under
  `three/addons/...` — see the comment in `config/importmap.rb`.
- `osm:fetch` retries with backoff when the public Overpass server answers 429/504 (common). Set `OVERPASS_URL`
  to use a mirror, e.g. `OVERPASS_URL=https://maps.mail.ru/osm/tools/overpass/api/interpreter bin/rails osm:fetch`.
  Downloads are cached per cell in `data/osm/`, so rerunning only fetches what is missing.
- The `json` gem is pinned below 3.0 in the Gemfile: json 3.x made `JSON.parse` keyword-only, and Rails 8.1.3 still
  passes a positional options hash when reading signed cookies. Remove the pin once Rails ships the fix.
- `config/cable.yml` uses the `async` adapter in development (Rails default, in-process, fine for one server process)
  and Solid Cable in production.
- Tiles are requested from `public/tiles/` first and fall back to `/api/tiles/:tx/:ty`, which builds the tile and caches it
  on disk, so an empty database yields a flat 40 m NAP world and a 404 per tile in the dev log on first load.
- With LoD2.2 buildings a dense town tile is about 1 MB of JSON (roughly 100 MB for phase 1). Fine locally; serve
  `public/tiles` gzipped (or move to a binary tile format) before putting it on the internet.
Controls: W/↑ accelerate, S/↓ brake/reverse, A/D or ←/→ steer, Space handbrake, R reset to road.
