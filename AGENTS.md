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

## Validation without the game

- JSON: `python3 -c "import json,glob; [json.load(open(f)) for f in glob.glob('**/*.json', recursive=True)]"`
- Scripts: `node --check <file>` for every `.js`.
