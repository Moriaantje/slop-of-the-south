# Credits and licences

Slop of the South is built from open data and open assets. Keep these credits with the game.

## Geodata

- **OpenStreetMap** — roads, places, landmarks, fallback buildings. © OpenStreetMap contributors, ODbL.
- **3D BAG** (TU Delft) — LoD2.2 building models. CC BY 4.0.
- **BGT** (Basisregistratie Grootschalige Topografie, via PDOK) — land cover, water, trees, lamp posts, signal poles. Publiek domein / CC0.
- **AHN** (Actueel Hoogtebestand Nederland, via PDOK) — terrain heights. CC0.
- **NDW** (Nationaal Dataportaal Wegverkeer) — traffic signs. CC0.
- **Bestuurlijke Gebieden** (Kadaster, via PDOK) — the province border. CC0.
- **Luchtfoto Actueel Ortho 25 cm RGB** (Beeldmateriaal Nederland, via PDOK) — the aerial photographs on the terrain.
  **CC BY 4.0** — "Luchtfoto © Beeldmateriaal Nederland, via PDOK".
- **Wikipedia (nl)** — place descriptions and photographs on the loading screen. Text CC BY-SA 4.0; images carry their
  own licences on Wikimedia Commons.

## Assets

- **ambientCG** (ambientcg.com) — photo-scanned PBR materials, CC0, under `public/textures/<name>/`:
  asphalt = Asphalt012, klinker = PavingStones085, pavers = PavingStones070, gravel = Gravel022, concrete = Concrete034,
  brick = Bricks059, brick2 = Bricks090, plaster = Plaster001, rooftile = RoofingTiles005 (1K JPG sets; colour + GL
  normal at 1024 px, roughness downscaled to 512 px). Refresh with `bin/rails assets:textures`.
- **Quaternius** (quaternius.com) — rigged and animated glTF models, CC0 1.0, under `public/models/` (converted losslessly
  from the packs' embedded-buffer `.gltf` to `.glb`):
  `mech.glb` = Stan from the Animated Mech pack (Idle, Walk, Run, Jump, Shoot, Punch, Kick, Death …);
  `wizard.glb` = Wizard from the RPG Character pack (Idle, Walk, Run, Spell1, Spell2, Staff_Attack …);
  `npc_a/b/c.glb` = Casual_Male, Casual_Female, OldClassy_Male from the Ultimate Animated Character pack (Idle, Walk,
  Run, PickUp, Victory, SitDown, Death …). Pack pages: quaternius.com/packs/{ultimatemonsters,animatedmech,rpgcharacters,ultimatedanimatedcharacter}.html
- **three.js** — MIT.
