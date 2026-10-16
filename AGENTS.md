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
