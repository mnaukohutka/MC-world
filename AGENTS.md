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


## Round-6: more mobs

- A custom mob needs three files, not one: the BP `entities/<id>.json`
  definition, the RP `entity/<id>.entity.json` client definition, and a texture
  under `textures/entity/pa_mobs/`. The client entity also needs a
  `spawn_egg` block and both lang keys (`entity.<id>.name` and
  `item.spawn_egg.entity.<id>.name`), or the egg is nameless.
- The RP client entity can borrow the game's own geometry, animations and
  animation controllers: `geometry.bat_v2`, `geometry.endermite`,
  `geometry.allay`, `animation.bat.flying`, `controller.animation.allay.general`
  etc. ship with the title, so a copper reskin only needs a recoloured texture,
  not new blocks and joints. Keep `render_controllers` on the pack's own
  `controller.render.default` and `materials` on `entity_alphatest`.
- Vanilla client entities list their controller in `animation_controllers` and
  drive it from `scripts.animate` by the local name given in `animations`
  (`"move": "controller.animation.bat.move"`, then `"animate": ["move"]`).
  Naming the controller straight in `animations` without listing it in
  `animation_controllers` also works and is what most of this pack's client
  entities do.
- Copper textures are generated by luminance-mapping a vanilla texture onto the
  copper ramp. New fauna follows the same palette so the dimension stays
  coherent.
- Flying mobs cannot be placed on the ground surface: give them air height when
  spawning (`FLYERS` in `scripts/dimension/mobs.js`), and carve the burrower's
  space before spawning it, or it suffocates or is stuck in the block.


## Round-9: every mob works, natural spawns, caves and structures

- The Molang "unknown variable" errors for variable.animationamountprev,
  animationamountblend, tcos_left/right_side and squid.tentacle_angle /
  swim_rotation are all the same mistake: reusing a vanilla animation on a
  custom entity whose entity definition never sets the variables that animation
  reads. Those variables are filled by the vanilla mob own pre_animation; a
  custom entity that plays the vanilla animation gets nothing. Two fixes: copy
  the pre_animation in only when every variable it needs is query-derived (goat
  tcos_* is; cod and squid are not, because they also read engine-only vars),
  otherwise write a small custom animation under resource_pack/animations/ that
  uses query.anim_time only.
- Squid-only AI goals (minecraft:behavior.squid_*) refuse to load unless the
  mob is a squid; the same applies to other vanilla-goal families. Use the
  generic water goals (random_swim, look_at_player) for a custom aquatic mob.
- An animation-controller loop comes from a shortname colliding with itself: a
  client entity whose animations key move maps to controller.animation.silverfish.move
  while scripts.animate also says move -- the controller own state plays move
  internally, so it references itself. Mirror the vanilla client entity exactly:
  list the controller under animation_controllers, map move to the animation,
  and drive the controller by a different shortname (or none).
- BlockComponentStepOn/OffEvent.entity is optional -- it is undefined for a step
  with no source entity (falling block, vehicle, projectile). Guard the access:
  e.entity?.addEffect(...).
- Script-registered dimensions have no custom biome, so spawn_rules/*.json
  (which match on a biome tag) never fire there and the pack mobs would never
  appear on their own. Spawning is done in scripts/dimension/mobs.js, which
  rolls a site around each player and picks the mob by niche -- surface land,
  open air, fluid column, shore, or cave (chosen from the player own depth).
- Every custom mob job lives in scripts/dimension/workers.js: one interval picks
  the nearest worker and lets it take a single action. Adding a mob with a craft
  means adding it to WORKERS/WORKER_TYPES and a case in act(). random3ish(worker)
  gives a stable-but-varying roll per worker so it does not flip-flop each cycle.
- New structures go in scripts/structures.js as build* functions wired into
  LANDMARKS + the switch in gatherLandmark. Surface builds use withSurface, shore
  builds use withShore, and anything underground is anchored at STONE_BOTTOM + n
  so it is buried in the rock band rather than floating in the caves.
- A custom ghost mob needs its own geometry if the borrowed vanilla one has
  engine-driven bones or a face baked into shared UV space. A hand-written
  geometry.pa_ghost with an explicit per-cube uv block gives full control of the
  face; the texture is drawn at 64x64 with the face cells at the cube north and
  south UV rectangles.
