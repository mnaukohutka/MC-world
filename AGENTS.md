# MC-world — Copper Dimension addon

Minecraft Bedrock addon (`copper-1_behavior_pack` + `copper-1_resource_pack`).

## Custom dimensions on Bedrock

- A `dimensions/*.json` file is a **Java Edition** feature. Bedrock ignores it
  and logs `no parser available for version ...` / `Failed to load dimension`.
  Do not add one.
- A custom dimension must be registered **from script** during
  `system.beforeEvents.startup` via `event.dimensionRegistry.registerCustomDimension(id)`.
  Available in stable `@minecraft/server` (>= 2.8.0), no beta experiment needed.
- Registration only ever creates a **void** generator, so the space is empty
  until script fills it. `scripts/dimension/terrain.js` generates 16x16 tiles
  around players and places the spawn pad before the first teleport.
- `world.tickingAreaManager.createTickingArea(...)` must be awaited before
  reading/writing blocks in a fresh dimension, or the chunks are not loaded.
- Script-registered dimensions have **no biome system**: biome and client_biome
  JSON are only used by vanilla terrain generation. Keeping them only produces
  `Loaded client biome but no biome with that name exists` and
  `Missing referenced asset` errors, so this pack ships none and paints the
  surface with blocks instead.

## Validation without the game

- JSON: `python3 -c "import json,glob; [json.load(open(f)) for f in glob.glob('**/*.json', recursive=True)]"`
- Scripts: `node --check <file>` for every `.js`.


## Bedrock feature removals that bite this pack

Several "errors" are really the game rejecting content that Bedrock removed.
Check these before inventing a fix.

- **Early execution**: a native call (BlockPermutation.resolve, world.*,
  new BlockVolume, ...) at a module top level throws while modules are first
  evaluated. Because imports are static, that aborts main.js and every later
  module — commands and block/item custom components then never register, which
  surfaces as "cannot read property subscribe of undefined" and "custom
  component ... is not being used by a block". Keep module scope declarative;
  resolve/cache on first use inside a function.
- minecraft:queued_ticking was renamed to minecraft:tick in 1.21.10 and its
  on_tick trigger was dropped. Use minecraft:tick plus the onTick hook of a
  custom component.
- Block "events" (and run_command / set_block_state / die / ... responses) were
  removed in 1.20.80. Move that logic into script.
- minecraft:custom_components was removed in 1.21.90: custom components are
  listed directly in components, like vanilla ones.
- minecraft:tags only exists from 1.26.20; below that it is invalid.
- menu_category.group needs a namespace (minecraft:itemGroup.name.wood).
- Resource-pack blocks.json must not use the legacy "format_version": [1,1,0]
  array: it makes the game read every key in the minecraft namespace, giving
  "The block named minecraft:<x> used in a blocks.json file does not exist".

Official schemas (block/item JSON) are the fastest way to settle a syntax
question: clone Mojang/bedrock-samples and read
metadata/json_schemas/server/block/<ver>/.

- minecraft:random_ticking was removed as well. A block that still carries it
  fails with "Block definition parsing failed" (and drags its custom component
  down with it). Its onRandomTick hook goes too: gate a minecraft:tick block on
  Math.random() inside onTick instead.
- A custom block must not declare minecraft:geometry "geometry.fluid.N" from a
  resource-pack model and also carry a matching blocks.json entry: the pair logs
  "trying to override the Geometry component with blocks.json". Keep the model
  in the behaviour pack's geometry component and out of blocks.json.
- Script-registered dimensions start void and cannot use biome JSON, so a pack
  that ships biomes/*.biome.json gets "no parser available for version 1.21.0",
  "Loaded client biome but no biome with that name exists" and
  feature_rules/features pointed at those biomes are dead. Reproduce the biomes
  in script instead; delete the biome files and the rules that reference them.

## Round-3: runtime behaviour (fluid, biomes, structures)

- A block's `minecraft:tick` can fire for a cell whose chunk is no longer
  ticking; every read/write then throws `LocationInUnloadedChunkError`. Treat
  that as "come back later" and return quietly, not as a warning: the fluid's
  own tick will fire again when the chunk is live.
- Custom blocks are not liquids to the physics. `minecraft:liquid_detection`
  only accepts `"water"` as a `liquid_type` (schema: server/block/*/Liquid
  Type.json), so a custom fluid cannot be made swimmable by JSON alone. Emulate
  it in script instead - buoyancy plus a movement assist keyed off
  `player.inputInfo.getMovementVector()`.
- A script dimension has no biome for a worldgen feature to match, so
  `Dimension.placeFeature` refuses and saplings never grow. Always pair the
  feature with a script fallback that builds the tree block by block.
- `world.getTopmostBlock` over an unloaded column reports the build ceiling; a
  structure placed there is rejected with "Invalid structure bounds". Only build
  from the tile that actually contains the anchor.
- Structures a script dimension cannot reach via `/place` (vanilla village,
  ancient city, trial chambers, ...) have to be laid out block by block from a
  palette; every write must be guarded because a chunk can unload mid-build.
- Space scatter (one roll per tile) clusters: several features can land within a
  few blocks. Anchor anything that should be rare to its own larger grid cell
  (cell_size tiles) and roll once per cell.

## Round-4: copper-first dimension

- Minecraft already ships the whole copper family (cut/chiseled/grate/bulb/bars/
  chain/lantern/torch/door/trapdoor/chest/statue, at all four oxidation stages).
  Reuse those ids for builds and leave `pa:` blocks for the shapes vanilla
  lacks: full copper rock at three stages, soil, grass, leaves, patina, lamp,
  bricks and the dimension's own ore.
- The dimension's ore is `pa:copper_ore` / `pa:deepslate_copper_ore`, not the
  vanilla ids: their loot tables (in `loot_tables/blocks/`) drop raw copper and
  copper ingots alongside iron, gold and the odd gem, so a vein pays in more
  than one metal. They are the only ore laid in the caves.
- The resource pack no longer ships `blocks.json`: every custom block carries its
  own `minecraft:material_instances`, so a tone entry there is dead weight and
  the vanilla-id entries ("block ... does not exist in the registry") came from
  it. Add textures through `terrain_texture.json` and the block JSON instead.
- `pa:copper_lamp` carries a `pa:lit` state; its permutations swap the texture
  and `minecraft:light_emission`, and `pa_copper_lamp:trigger` toggles the state
  on interact. There is no script hook for redstone power on a custom block, so
  a redstone-driven lamp is not possible — the interact is deliberate.
- A block's custom-component key is the *registered* id verbatim, not the block
  id plus a suffix. Writing `"pa:copper_lamp:trigger"` where the script
  registered `pa_copper_lamp:trigger` is an identifier with two colons: Bedrock
  rejects it ("child ... not valid here"), the whole block fails to parse, and
  the fallout reads as unrelated errors — "Block type pa:copper_lamp not found",
  a broken recipe and terrain generation stopping. Keep the key and
  `registerCustomComponent` argument byte-identical.
- Two shaped recipes with the same pattern and key items collide: Bedrock logs a
  duplicate-recipe warning and only one wins. Give a custom recipe its own
  ingredients rather than reusing a vanilla pattern (e.g. patina from oxidized
  copper *grate*, not the plain oxidized copper that already makes cut copper).
- Script-driven terrain must finish a tile's *neighbourhood* before it raises
  anything that spans tiles. `buildTile` writes whole columns from `MIN_Y` to
  `MAX_Y`, so a landmark placed the moment its own tile finished was ploughed
  through by the next tile's column work — the dimension looked almost empty
  while the builders themselves worked. The queue now lays plain ground first,
  and only calls `buildTileContent` (landmarks, pack builds, chests, portals) and
  `decorateTile` (biome ground cover) once all nine tiles of the 3x3 are
  `generated`. Any build whose footprint is larger than one tile needs this.
- `groundY` uses `dimension.getTopmostBlock`, which reports the *build* ceiling
  for a still-unloaded column. Structures placed from that height land at y=320
  and vanish. Keep the ceiling rejection in `groundY`.

## Round-5: workers and chests

- `spawn_rules/*.json` matches on a biome tag and a script-registered dimension
  has no biome, so nothing the pack ships spawns on its own. Mobs must be
  spawned from script (`scripts/dimension/mobs.js`): roll around each player,
  then place the body where the type can actually live (flyer in air, fish
  inside water, burrower after carving its own space), or it suffocates.
- A chest's inventory component is only attached while its chunk is inside a
  ticking area. `system.run(...)` defers past that window — the area is removed
  the moment the tile finishes — so a deferred fill leaves the chest empty.
  Fill immediately and fall back to `system.run` only if the container is
  missing.
- A custom mob's `family` list is what `dimension.getEntities({ families })`
  filters on. Give every worker a shared `pa_worker` family so one ticker can
  drive them all, plus a movement family (`pa_flyer`/`pa_swimmer`/`pa_walker`/
  `pa_burrower`).
- `@minecraft/server` V2 exposes only `blockComponentRegistry` and
  `itemComponentRegistry`; there is no entity component registry, so custom mob
  AI is a central `system.runInterval` ticker, not a registered component.
- The copper bulb is `minecraft:copper_bulb` and its state is `lit` (unlike the
  pack's own `pa:copper_lamp:pa:lit`). Particle ids are the full identifiers:
  `minecraft:basic_bubble_particle`, `minecraft:basic_crit_particle`,
  `minecraft:crop_growth_emitter`, not the file names.

