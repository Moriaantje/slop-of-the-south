# Slop of the South

_(formerly Mijnstreek Drive; the Rails module is still `MijnstreekDrive`)_

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
| Land cover & water | **BGT** `begroeidterreindeel` (meadows, arable fields, orchards, woods, lawns), `onbegroeidterreindeel` (yards, pavement), `waterdeel` | Painted per tile into a 512 px terrain texture (fields keep a stable colour per polygon); water is also drawn as a draped skin. Area shares classify each tile into a biome: water, stad, woonwijk, dorp, bos, boomgaarden, akkerland, weiland, platteland (`LandCover.biome`). Orchards get hoogstam fruit trees on a 9 m lattice. |
| Province border | **Bestuurlijke Gebieden** (Kadaster) via PDOK OGC API Features, `provinciegebied` | `rake border:fetch` stores the Limburg polygon; `/api/world` serves it simplified to 25 m. Outside it the world is a wall of flames (`game/FlameWall.js`); crossing it burns you back to your last position inside. |
| Trees | **BGT** (Basisregistratie Grootschalige Topografie) via PDOK OGC API Features | `vegetatieobject_punt` gives every registered tree (`plus_type = boom`); woodland polygons from `begroeidterreindeel` (loofbos, naaldbos, gemengd bos, houtwal) are filled with deterministically scattered trees (`ST_GeneratePoints`). `rake bgt:fetch bgt:import`. |
| Terrain | **AHN** (Actueel Hoogtebestand Nederland) DTM via PDOK WCS | OSM has no elevation. AHN is 0.5 m lidar; the WCS resamples it to the 10 m grid on request, `gdal_fillnodata` fills the holes under buildings and water. Zuid-Limburg is genuinely hilly — 27 m at the Maas to 114 m on the plateau within the phase-1 box. |
| Traffic signs | **NDW** Verkeersborden (Nationaal Dataportaal Wegverkeer, `traffic-signs/v4/current-state`) | The API answers with the whole country as one 1.2 GB GeoJSON (its filters are ignored), so `rake ndw:fetch` downloads it once and `rake ndw:import` streams it through `jq --stream` into `traffic_signs` for the world bbox (227k signs in Limburg). Every sign face is painted from its RVV code and value on a canvas (`game/Signs.js`: A1 speed discs, B6 yield, G11 cycle path, E4 parking, H1 town entry, J warnings, onderborden with their text …) and faces against the traffic it applies to (`bearing` + 180°). Signs at one spot share a pole. |
| Lamp posts | **BGT** `Paal` with `plus-type = lichtmast` (bulk extracts, `BGT_BULK_TYPES=paal rake bgt:bulk_fetch bgt:paal_import`) | 101k masts in Limburg, arm turned towards the nearest road, 9 m on main roads, 6 m elsewhere. `Paal` is an optional IMGeo object: the Parkstad municipalities (Heerlen, Kerkrade, Landgraaf, Brunssum …) deliver none; there OSM `highway=street_lamp` (`rake osm:pbf_points`) is the sparse fallback. |
| Traffic lights | **BGT** `Paal` with `plus-type = verkeersregelinstallatiepaal` (990 poles) + OSM `highway=traffic_signals` nodes (2.4k) | Each BGT pole becomes a signal head facing the traffic that approaches it (side of the road decides the direction); where BGT has no poles the OSM node gets one pole per approaching road. Heads run a shared 40 s cycle on the wall clock, phased by axis, so all players see the same colours. Live iVRI state via Talking Traffic is a later stretch goal. |


Everything above is open data. Keep attribution ("© OpenStreetMap contributors", "AHN", "3D BAG", "BGT", "NDW")
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
                                            ├── trees[]          [x, z, kind, height]   (BGT; kind 0 street tree, 1 broadleaf wood, 2 conifer, 3 fruit tree)
                                            ├── cover[]          [code, ring…]          (BGT land cover, dm offsets from the tile corner; painted)
                                            ├── furniture        {lamps: [x, z, dir, h], signals: [x, z, face, group], signs: [x, z, face, code, black?, text?]}
                                            └── biome            "akkerland" | "woonwijk" | …

Tiles are static JSON served by nginx/Rails' static file server — no DB hit while playing.

### 1.4a Time of day

A full day takes 6 real minutes (`game/DayNight.js`, `DAY_SECONDS`), on the wall clock so every player sees the same
time; the HUD shows the game clock. Sunrise 06:00, noon 12:00, sunset 18:00, twilight until about 19:00. The sun
light swings east → south → west and gives way to a faint moon; sky, fog and hemisphere light darken with it. The sky
is a shaded dome around the camera (horizon → zenith gradient per phase, a glow banked around the sun at dawn and
dusk, stars once the sun is well below the horizon); the fog takes the horizon colour so the land fades into it. The
sun and the moon are visible as sprites far out along their compass directions on a flattened arc (2°–18° up, since
the chase camera only sees ~22° above the horizon); the sun reddens and fades at the horizon, the moon rises low in
the opposite sky as the sun sets. Face them to see them: east in the morning, south at midday, west in the afternoon. A
`darkness` value (0 day … 1 night) switches on the street lamps (glowing heads plus an additive light pool on the
ground, sodium orange on streets, LED white on main roads), makes sign faces retro-reflective and turns on car lights:
two spotlights on the player's car, emissive headlights and tail lights on every car, brake lights while braking
(the brake flag travels with the position over Action Cable). `?time=22.5` freezes the clock at that hour.

### 1.5 Multiplayer

Every other player carries a beacon (`game/RemoteCars.js`): a label with their name and distance in km floating in the
sky above their car with a line down to it. It is always in view: labels of players farther than 3 km are drawn 3 km
out in their direction and climb with the distance, so you can head towards anyone in the province. Your own name
comes from `localStorage.driverName`, settable with `?name=Pietje`.

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
    game/Cover.js            land cover → per-tile canvas texture on the terrain; water polygons → draped skins
    game/Trees.js            procedural branching trees, a few seeded variants per kind, instanced per tile;
                             variant, rotation, width and tint come from the tree position, so every tree is stable
    game/Locator.js          nearest named road + nearest place for the street sign
    game/FlameWall.js        animated fire curtain along the province border; even-odd inside test for the burn-back
    game/Minimap.js          map drawn from our own data (MapBuilder → public/map): overview + 1 km detail cells;
                             M expands, drag pans, wheel zooms, F fits the bounds, click teleports
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
7. **Scale** — full bounding box (WORLD_BBOX=full for every fetch task); the Maas and Julianakanaal lie just outside the phase-1 box. *(trees, water, land cover done via BGT)*

---

## 2. Setup

```bash
# System deps
brew install gdal                          # ogr2ogr, gdalwarp, gdal_fillnodata; PostgreSQL + PostGIS via Postgres.app or brew

rails new mijnstreek-drive -d postgresql --skip-jbuilder
cd mijnstreek-drive
# copy the files from this scaffold over the generated app, then:
bundle add activerecord-postgis-adapter importmap-rails
bin/rails importmap:install
# three.js and its addons are vendored into vendor/javascript (see config/importmap.rb)
```

Edit `config/database.yml` and set `adapter: postgis` for every environment.

The world is the province of Limburg by default (`WORLD_BBOX=limburg`; `phase1` = Sittard–Geleen, `full` = the
Mijnstreek box). Every task below works on that area.

```bash
bin/rails db:create db:migrate
bin/rails border:fetch         # Limburg province polygon (PDOK) → boundaries table; the edge of the world
bin/rails osm:pbf_fetch        # Geofabrik limburg-latest.osm.pbf (100 MB)
bin/rails osm:pbf_import       # → roads (101k) and places (1k) via ogr2ogr
bin/rails bag3d:fetch          # 3D BAG GeoPackage tiles for the box → data/bag3d/tiles (1075 tiles, ~2.5 GB gz / 13 GB)
bin/rails bag3d:import         # → PostGIS buildings (LoD1.3 parts) and building_meshes (LoD2.2)
bin/rails bgt:bulk_fetch       # BGT extracts per municipality via PDOK's download API → data/bgt/bulk/*.zip (~5 GB)
bin/rails bgt:bulk_import      # → land_covers (terrain, pavement, water) and trees (registered, woods, orchards)
BGT_BULK_TYPES=paal bin/rails bgt:bulk_fetch   # lamp posts, signal poles, sign posts → data/bgt/bulk/*-paal.zip (18 MB)
bin/rails bgt:paal_import      # → poles (101k lamp posts, 990 signal poles …)
bin/rails osm:pbf_points       # → poles: OSM traffic_signals nodes, signalised crossings, fallback street lamps
bin/rails ndw:fetch            # NDW traffic-sign register, all of NL (1.2 GB) → data/ndw/current-state.json
bin/rails ndw:import           # → traffic_signs inside the world bbox (227k), streamed with jq
bin/rails dem:fetch            # AHN terrain model from PDOK WCS, chunked → data/dem_raw.tif (10 m)
bin/rails dem:build            # fill holes, convert → data/dem.raw + dem.json (binary, read lazily)
bin/rails tiles:build          # → public/tiles/*.json for every tile inside the province (~9k)
bin/rails map:build            # → public/map/overview.json + 1 km cells for the minimap (also built on demand)
bin/dev                        # Rails (Puma on :3000)
```

For a small area (`WORLD_BBOX=phase1`) the paged alternatives still work: `osm:fetch osm:import` (Overpass) and
`bgt:fetch bgt:import` (OGC API Features).

Edit `config/database.yml` and set `adapter: postgis` for every environment.

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
Controls: W/↑ accelerate, S/↓ brake/reverse, A/D or ←/→ steer, Space handbrake, R reset to road, M expand the minimap
(drag to pan, scroll to zoom, F fits the whole area, click to teleport, Esc closes). `?spawn=x,z,yaw` in the URL
spawns at game coordinates.
