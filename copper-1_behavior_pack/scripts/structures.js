import { world, system, ItemStack } from "@minecraft/server";

/*
 * Points of interest for the Copper Dimension.
 *
 * The dimension is infinite, so the old design — a timer that rolled a structure
 * next to whichever player happened to be online — left the world almost empty
 * and could drop a build on top of the player who triggered the roll. This
 * module works from the tile instead: every 16x16 tile the terrain generator
 * finishes is offered here, and each region (a block of tiles) decides from its
 * coordinates alone what belongs in it. Two players walking the same ground
 * therefore see the same world, and the plan does not depend on anyone watching.
 *
 * The small builds are the pack's own `.mcstructure` files under `structures/`,
 * which the game exposes as `mystructure:<name>`. The four landmarks the
 * dimension would otherwise lack — an ancient city, trial chambers, a village
 * and a shelter — are laid out block by block here, because a script-registered
 * dimension cannot reach a vanilla structure id through `/place`.
 */

const REGION = 8;              // tiles per region; a region gets one small build
const LANDMARK_REGION = 24;    // tiles per landmark cell; a much bigger area
const CHEST_REGION = 8;        // tiles per chest cell; one chest at most

const BUILD_CHANCE = 0.22;     // pack builds (temple/fontana/lucerna)
const CHEST_CHANCE = 0.30;     // a chest in a chest cell, at most one
const LANDMARK_CHANCE = 0.85;  // a landmark in a landmark cell

/* The dimension floor/ceiling, used to reject builds that would leave them. */
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 320;
const BUILD_CLEARANCE = 40;
const SEA_LEVEL = 64;

/*
 * The top of the guaranteed solid stone band under every column, matching
 * `terrain.js`'s `MIN_Y + BOTTOM_MARGIN`. Landmarks that belong underground are
 * anchored inside this band so they are buried in rock rather than floating in
 * the open caves.
 */
const STONE_BOTTOM = -12;

/** The pack's own builds. Vanilla camps have no reachable structure id, so the
 * copper builds double as the dimension's landmarks. */
const BUILDS = [
  "copper_temple",
  "copper_fontana",
  "copper_lucerna-p",
  "copper_lucerna-A",
  "copper_lucerna-A1",
  "copper_lucerna-P1",
];

const SALT_CHEST = 0x9e37;
const SALT_LOOT = 0x4d2a;
const SALT_LANDMARK = 0x77f1;
const SALT_PORTAL = 0x2be3;
const SALT_VAULT = 0x51c9;

const done = new Set();
const landmarkDone = new Set();
let seed = 0;

function key(x, z) {
  return `${x},${z}`;
}

/** Same FNV-1a as terrain.js, so both agree on the world. */
export function seedPoints(worldSeed) {
  let h = 0x811c9dc5;
  for (const ch of String(worldSeed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  seed = h | 0;
  done.clear();
  landmarkDone.clear();
}

function random(x, z, salt) {
  let h = Math.imul(x, 0x165667b1);
  h = (h + Math.imul(z, 0x27d4eb2f)) | 0;
  h = (h + Math.imul(seed ^ salt, 0x55fdc781)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x4bf19f61);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function pick(list, x, z, salt) {
  return list[Math.floor(random(x, z, salt) * list.length) % list.length];
}

/** A short, deterministic orientation derived from the same noise. */
function rotationFor(x, z) {
  const options = ["None", "Rotate90", "Rotate180", "Rotate270"];
  return options[Math.floor(random(x, z, 0x77) * 4) % 4];
}

function groundY(dimension, x, z) {
  try {
    const top = dimension.getTopmostBlock({ x, z });
    if (!top) return undefined;
    const y = top.location.y + 1;
    /*
     * `getTopmostBlock` reports the build ceiling for a column that is still
     * unloaded, and `StructureManager.place` rejects any volume leaving the
     * world bounds — which is what produced "Invalid structure bounds". Reject
     * anything too close to the ceiling and let the tile regenerate later.
     */
    if (y <= WORLD_MIN_Y + 1 || y > WORLD_MAX_Y - BUILD_CLEARANCE) return undefined;
    return y;
  } catch {
    return undefined;
  }
}

function placeBuild(dimension, id, x, y, z) {
  try {
    world.structureManager.place(`mystructure:${id}`, dimension, { x, y, z }, {
      rotation: rotationFor(x, z),
      includeEntities: true,
    });
  } catch (error) {
    console.warn(`[copper] could not place "${id}" at ${x},${y},${z}: ${error}`);
  }
}

// ── Landmark builders ──────────────────────────────────────────────────────

/* Every landmark is raised from a small palette of blocks, and every write is
 * wrapped: a chunk can leave the loading window mid-build, and one failed block
 * must not abort the rest. */
const P = {
  stone: "minecraft:stone_bricks",
  deepBrick: "minecraft:deepslate_bricks",
  deepTile: "minecraft:deepslate_tiles",
  chiseledDeep: "minecraft:chiseled_deepslate",
  cobbledDeep: "minecraft:cobbled_deepslate",
  cutCopper: "minecraft:cut_copper",
  grate: "minecraft:copper_grate",
  bulb: "minecraft:copper_bulb",
  lantern: "minecraft:copper_lantern",
  chain: "minecraft:copper_chain",
  sculk: "minecraft:sculk",
  reinforced: "minecraft:reinforced_deepslate",
  trialSpawner: "minecraft:trial_spawner",
  vault: "minecraft:vault",
  copper: "minecraft:copper_block",
  gold: "minecraft:gold_block",
  diamond: "minecraft:diamond_block",
  emerald: "minecraft:emerald_block",
  iron: "minecraft:iron_block",
  tuffBrick: "minecraft:tuff_bricks",
  polishedTuff: "minecraft:polished_tuff",
  chiseledTuff: "minecraft:chiseled_tuff",
  planks: "minecraft:oak_planks",
  glass: "minecraft:glass_pane",
  bed: "minecraft:bed",
  barrel: "minecraft:barrel",
  crafting: "minecraft:crafting_table",
  furnace: "minecraft:furnace",
  bookshelf: "minecraft:bookshelf",
  hay: "minecraft:hay_block",
  composter: "minecraft:composter",
  bell: "minecraft:bell",
  campfire: "minecraft:campfire",
  water: "minecraft:water",
  copperChest: "minecraft:copper_chest",
  air: "minecraft:air",
};

function setBlock(dimension, x, y, z, id) {
  try {
    if (y <= WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
    dimension.getBlock({ x, y, z })?.setType(id);
  } catch {
    // Chunk unloaded mid-build; accept a partial landmark rather than throwing
    // out of the whole populate step.
  }
}

function fillBox(dimension, x0, y0, z0, x1, y1, z1, id) {
  const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) };
  const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) };
  try {
    dimension.fillBlocks(
      { x: lo.x, y: lo.y, z: lo.z },
      { x: hi.x, y: hi.y, z: hi.z },
      id,
      { ignoreChunkBoundErrors: true }
    );
  } catch {
    // Falls back to the fine-grained writes when the block fill refuses.
    for (let x = lo.x; x <= hi.x; x++) {
      for (let y = lo.y; y <= hi.y; y++) {
        for (let z = lo.z; z <= hi.z; z++) setBlock(dimension, x, y, z, id);
      }
    }
  }
}

/** A hollow room: walls, floor and ceiling, with the interior left clear. */
function buildRoom(dimension, x, y, z, halfX, halfZ, height, wall, floor, ceiling) {
  fillBox(dimension, x - halfX, y, z - halfZ, x + halfX, y, z + halfZ, floor);
  fillBox(dimension, x - halfX, y + height, z - halfZ, x + halfX, y + height, z + halfZ, ceiling);
  for (let dx = -halfX; dx <= halfX; dx++) {
    for (let dz = -halfZ; dz <= halfZ; dz++) {
      const edge = dx === -halfX || dx === halfX || dz === -halfZ || dz === halfZ;
      for (let dy = 1; dy < height; dy++) {
        setBlock(dimension, x + dx, y + dy, z + dz, edge ? wall : P.air);
      }
    }
  }
}

function addLantern(dimension, x, y, z) {
  setBlock(dimension, x, y, z, P.chain);
  setBlock(dimension, x, y - 1, z, P.lantern);
}

/** A small survival shelter: a hut on the surface with a bed and workstations. */
function buildShelter(dimension, x, y, z) {
  const half = 2;
  const height = 4;
  buildRoom(dimension, x, y, z, half, half, height, P.planks, P.stone, P.planks);

  // Doorway on the +z wall and glass on the sides.
  setBlock(dimension, x, y + 1, z + half, P.air);
  setBlock(dimension, x, y + 2, z + half, P.air);
  setBlock(dimension, x - half, y + 2, z, P.glass);
  setBlock(dimension, x + half, y + 2, z, P.glass);

  setBlock(dimension, x - 1, y + 1, z - 1, P.bed);
  setBlock(dimension, x + 1, y + 1, z - 1, P.crafting);
  setBlock(dimension, x + 1, y + 1, z + 1, P.furnace);
  setBlock(dimension, x - 1, y + 1, z + 1, P.barrel);
  addLantern(dimension, x, y + height - 1, z);

  placeChestAt(dimension, x, y + 1, z - 1, x, z);
  // A campfire and a hay bale outside read as a lived-in camp.
  setBlock(dimension, x + half + 1, y + 1, z, P.campfire);
  setBlock(dimension, x - half - 1, y + 1, z, P.hay);
}

/** A small village: a well, four huts around it, paths and a few villagers. */
function buildVillage(dimension, x, y, z) {
  // The well at the centre.
  fillBox(dimension, x - 1, y, z - 1, x + 1, y + 1, z + 1, P.stone);
  fillBox(dimension, x - 1, y + 1, z - 1, x + 1, y + 1, z + 1, P.air);
  setBlock(dimension, x, y, z, P.water);
  fillBox(dimension, x - 1, y + 3, z - 1, x + 1, y + 3, z + 1, P.planks);
  addLantern(dimension, x, y + 2, z);

  const huts = [[-7, 0], [7, 0], [0, -7], [0, 7]];
  for (let i = 0; i < huts.length; i++) {
    const [ox, oz] = huts[i];
    const hx = x + ox;
    const hz = z + oz;
    buildRoom(dimension, hx, y, hz, 2, 2, 4, P.planks, P.stone, P.planks);
    // Each hut opens towards the well.
    const doorX = ox === 0 ? hx : hx - Math.sign(ox) * 2;
    const doorZ = oz === 0 ? hz : hz - Math.sign(oz) * 2;
    setBlock(dimension, doorX, y + 1, doorZ, P.air);
    setBlock(dimension, doorX, y + 2, doorZ, P.air);
    setBlock(dimension, hx - 1, y + 1, hz - 1, i % 2 === 0 ? P.bed : P.barrel);
    setBlock(dimension, hx + 1, y + 1, hz + 1, i % 2 === 0 ? P.bookshelf : P.composter);
    addLantern(dimension, hx, y + 3, hz);
    // A path of cobble from the hut towards the well.
    for (let t = 2; t < 7; t++) {
      const px = ox === 0 ? hx : hx - Math.sign(ox) * t;
      const pz = oz === 0 ? hz : hz - Math.sign(oz) * t;
      setBlock(dimension, px, y, pz, P.cobbledDeep);
    }
  }
  setBlock(dimension, x + 3, y + 1, z + 3, P.bell);

  // Villagers and an iron golem to bring the place alive, deferred so the ground
  // under them has settled.
  system.run(() => {
    for (let i = 0; i < huts.length; i++) {
      const [ox, oz] = huts[i];
      try {
        dimension.spawnEntity("minecraft:villager", { x: x + ox + 0.5, y: y + 1, z: z + oz + 0.5 });
      } catch {
        // Chunk gone; fewer villagers is not worth an error.
      }
    }
    try {
      dimension.spawnEntity("minecraft:iron_golem", { x: x + 0.5, y: y + 1, z: z + 0.5 });
    } catch {
      // Same as above.
    }
  });
}

/** Trial chambers: a tuff-and-copper ruin sunk into the copper caves. */
function buildTrialChambers(dimension, x, y, z) {
  const half = 6;
  const height = 6;
  buildRoom(dimension, x, y, z, half, half, height, P.tuffBrick, P.polishedTuff, P.chiseledTuff);

  // Two wings off the main hall, each holding the pieces a trial chamber needs.
  buildRoom(dimension, x - half - 3, y, z, 2, 2, 4, P.tuffBrick, P.polishedTuff, P.chiseledTuff);
  buildRoom(dimension, x + half + 3, y, z, 2, 2, 4, P.tuffBrick, P.polishedTuff, P.chiseledTuff);

  setBlock(dimension, x, y + 1, z - half + 1, P.trialSpawner);
  setBlock(dimension, x - 2, y + 1, z + half - 1, P.vault);
  setBlock(dimension, x + 2, y + 1, z + half - 1, P.vault);
  setBlock(dimension, x - half - 3, y + 1, z, P.trialSpawner);
  setBlock(dimension, x + half + 3, y + 1, z, P.trialSpawner);

  // Copper trim and braziers light the ruin; a few pillars break up the floor.
  for (const [px, pz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    for (let dy = 0; dy < height; dy++) setBlock(dimension, x + px, y + dy, z + pz, P.cutCopper);
    setBlock(dimension, x + px, y + height, z + pz, P.bulb);
  }
  addLantern(dimension, x, y + height - 1, z - half + 1);
  addLantern(dimension, x, y + height - 1, z + half - 1);
  addLantern(dimension, x - half - 3, y + 3, z);
  addLantern(dimension, x + half + 3, y + 3, z);

  placeChestAt(dimension, x, y + 1, z, x, z);
}

/**
 * Ancient city: a sculk-lit deepslate complex, well under the copper caves. It
 * is decoration only — no chests, no vaults, no spawners, nothing that changes
 * how the game plays — so it can be explored or ignored without consequence.
 */
function buildAncientCity(dimension, x, y, z) {
  const half = 10;
  const height = 7;
  buildRoom(dimension, x, y, z, half, half, height, P.deepTile, P.cobbledDeep, P.deepBrick);

  // A cross of avenues, which is what makes the space read as a city rather
  // than a hall.
  for (let d = -half + 1; d <= half - 1; d++) {
    setBlock(dimension, x + d, y, z, P.deepBrick);
    setBlock(dimension, x + d, y + height, z, P.deepBrick);
    setBlock(dimension, x, y, z + d, P.deepBrick);
    setBlock(dimension, x, y + height, z + d, P.deepBrick);
  }

  // Ruined pillars, one in four replaced by chiselled deepslate.
  for (const [px, pz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
    for (let dy = 0; dy < height; dy++) {
      setBlock(dimension, x + px, y + dy, z + pz, random(px, pz, 0x18) < 0.25 ? P.chiseledDeep : P.deepTile);
    }
  }

  // Sculk creeping from two corners, plain blocks only — no catalyst, no
  // shrieker, so nothing here can summon anything.
  fillBox(dimension, x - half + 1, y, z - half + 1, x - half + 4, y, z - half + 4, P.sculk);
  fillBox(dimension, x + half - 4, y, z + half - 4, x + half - 1, y, z + half - 1, P.sculk);

  // The centre piece: a ring of copper grate around a slab of reinforced
  // deepslate, purely ornamental.
  setBlock(dimension, x, y + 1, z, P.reinforced);
  for (let dy = 1; dy <= 4; dy++) {
    setBlock(dimension, x - 1, y + dy, z, P.grate);
    setBlock(dimension, x + 1, y + dy, z, P.grate);
  }
  addLantern(dimension, x, y + height - 1, z);

  // The deep dark is not a place to walk without light, so light the aisles.
  for (const [dx, dz] of [[-half + 1, 0], [half - 1, 0], [0, -half + 1], [0, half - 1]]) {
    addLantern(dimension, x + dx, y + 3, z + dz);
  }
}

/**
 * Treasure vault: a small copper-lined room whose chests hold the metals the
 * pack cares about. It is deliberately rare and shallow, so it reads as a find
 * rather than a farm.
 */
function buildTreasureVault(dimension, x, y, z) {
  const half = 3;
  const height = 4;
  buildRoom(dimension, x, y, z, half, half, height, P.cutCopper, P.deepTile, P.cutCopper);

  // A grate ring and a lantern, so the room is lit and obviously deliberate.
  for (const [gx, gz] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
    for (let dy = 1; dy < height; dy++) setBlock(dimension, x + gx, y + dy, z + gz, P.grate);
  }
  addLantern(dimension, x, y + height - 1, z);

  // A row of chests along one wall, a coarse display of ore blocks opposite.
  placeChestAt(dimension, x - 1, y + 1, z - half + 1, x, z);
  placeChestAt(dimension, x, y + 1, z - half + 1, x, z);
  placeChestAt(dimension, x + 1, y + 1, z - half + 1, x, z);
  placeChestAt(dimension, x, y + 1, z, x, z);

  const display = [P.copper, P.gold, P.diamond, P.emerald, P.iron];
  for (let i = 0; i < display.length; i++) {
    setBlock(dimension, x - 2 + i, y + 1, z + half - 1, display[i]);
  }
}

/**
 * A standing portal: a copper frame holding the dimension's portal blocks, ready
 * to walk into. Only built where the column above is clear, so it never buries
 * itself in a hillside.
 */
function buildPortal(dimension, x, y, z) {
  const width = 3;
  const height = 4;
  const halfW = Math.floor(width / 2);

  // Clear the volume first so the frame is not swallowed by terrain.
  fillBox(dimension, x - halfW - 1, y, z, x + halfW + 1, y + height + 1, z, P.air);

  for (let dx = -halfW - 1; dx <= halfW + 1; dx++) {
    setBlock(dimension, x + dx, y - 1, z, P.cutCopper);
    setBlock(dimension, x + dx, y + height, z, P.cutCopper);
  }
  for (let dy = 0; dy < height; dy++) {
    setBlock(dimension, x - halfW - 1, y + dy, z, P.cutCopper);
    setBlock(dimension, x + halfW + 1, y + dy, z, P.cutCopper);
  }
  // The glowing interior spans Z, matching the frame's plane.
  for (let dx = -halfW; dx <= halfW; dx++) {
    for (let dy = 0; dy < height; dy++) {
      setBlock(dimension, x + dx, y + dy, z, "pa:dimension_copper_portal");
    }
  }
}

// ── Chests ──────────────────────────────────────────────────────────────────

/**
 * Loot pool for the scattered copper chests. Copper is common; the rest is the
 * usual chest fare, weighted so most chests hold a handful of useful things and
 * only occasionally something worth a trip.
 */
const LOOT = [
  { item: "minecraft:copper_ingot", min: 2, max: 6, weight: 10 },
  { item: "minecraft:raw_copper", min: 2, max: 8, weight: 8 },
  { item: "minecraft:copper_nugget", min: 3, max: 9, weight: 6 },
  { item: "minecraft:copper_block", min: 1, max: 2, weight: 4 },
  { item: "minecraft:cut_copper", min: 1, max: 3, weight: 3 },
  { item: "minecraft:copper_lantern", min: 1, max: 2, weight: 3 },
  { item: "minecraft:copper_chain", min: 1, max: 4, weight: 3 },
  { item: "minecraft:copper_grate", min: 1, max: 3, weight: 3 },
  { item: "minecraft:copper_bulb", min: 1, max: 2, weight: 2 },
  { item: "minecraft:iron_ingot", min: 1, max: 4, weight: 4 },
  { item: "minecraft:gold_ingot", min: 1, max: 3, weight: 2 },
  { item: "minecraft:emerald", min: 1, max: 2, weight: 2 },
  { item: "minecraft:diamond", min: 1, max: 1, weight: 1 },
  { item: "minecraft:bread", min: 1, max: 4, weight: 4 },
  { item: "minecraft:torch", min: 2, max: 6, weight: 4 },
];

const LOOT_WEIGHT = LOOT.reduce((sum, entry) => sum + entry.weight, 0);

/** Deterministically fills a chest block so everyone sees the same contents. */
function fillChest(dimension, x, y, z, salt) {
  const chest = dimension.getBlock({ x, y, z });
  const inventory = chest?.getComponent("minecraft:inventory")?.container;
  if (!inventory) return;

  const rolls = 2 + Math.floor(random(x + salt, z - salt, SALT_LOOT) * 4);
  const used = new Set();
  for (let i = 0; i < rolls; i++) {
    let ticket = random(x * 3 + i, z * 5 - i, SALT_LOOT + i) * LOOT_WEIGHT;
    const entry = LOOT.find((candidate) => (ticket -= candidate.weight) <= 0) ?? LOOT[0];
    const count = entry.min + Math.floor(random(x - i, z + i, SALT_LOOT + i) * (entry.max - entry.min + 1));
    // Slots are chosen by the same noise, so no slot gets the same roll twice.
    let slot = Math.floor(random(x + i * 7, z + i * 13, SALT_LOOT + i * 3) * inventory.size) % inventory.size;
    while (used.has(slot) && used.size < inventory.size) slot = (slot + 1) % inventory.size;
    if (used.has(slot) || inventory.getItem(slot)) continue;
    used.add(slot);
    try {
      inventory.setItem(slot, new ItemStack(entry.item, count));
    } catch {
      // An item this build does not know is simply left out.
    }
  }
}

function placeChestAt(dimension, x, y, z, saltX, saltZ) {
  try {
    dimension.getBlock({ x, y, z })?.setType(P.copperChest);
  } catch {
    // Chunk left the loading window; the terrain pass rebuilds the tile later.
    return;
  }
  /*
   * The container is not attached until the block settles, so the fill is put
   * off a tick. It runs once per chest; a chest that never loads simply stays
   * empty rather than erroring.
   */
  system.run(() => {
    try {
      fillChest(dimension, x, y, z, Math.floor(random(saltX, saltZ, 0x41) * 1000));
    } catch {
      // The chunk unloaded again before the fill; leave the chest as it is.
    }
  });
}

// ── Population ──────────────────────────────────────────────────────────────

/**
 * One chest in a chest cell, on its anchor column. Working from the cell rather
 * than the tile is what stops the old scatter from dropping several chests within
 * sight of each other.
 */
function populateChest(dimension, tileX, tileZ) {
  const cellX = Math.floor(tileX / CHEST_REGION);
  const cellZ = Math.floor(tileZ / CHEST_REGION);
  if (tileX !== cellX * CHEST_REGION || tileZ !== cellZ * CHEST_REGION) return;
  if (random(cellX, cellZ, SALT_CHEST) >= CHEST_CHANCE) return;

  // Offset from the cell's build anchor, so a chest never lands on top of the
  // pack build that may share the cell.
  const x = cellX * CHEST_REGION * 16 + 24;
  const z = cellZ * CHEST_REGION * 16 + 24;
  const y = groundY(dimension, x, z);
  if (y === undefined) return;
  placeChestAt(dimension, x, y, z, cellX, cellZ);
}

/** The small pack build, one per REGION cell, attempted from its anchor tile. */
function populateBuild(dimension, tileX, tileZ) {
  const regionX = Math.floor(tileX / REGION);
  const regionZ = Math.floor(tileZ / REGION);
  if (tileX !== regionX * REGION || tileZ !== regionZ * REGION) return;

  if (random(regionX, regionZ, 0x11) >= BUILD_CHANCE) return;
  const x = regionX * REGION * 16 + 8;
  const z = regionZ * REGION * 16 + 8;
  const y = groundY(dimension, x, z);
  if (y === undefined) return;
  placeBuild(dimension, pick(BUILDS, regionX, regionZ, 0x31), x, y, z);
}

/*
 * The big landmarks, one per LANDMARK cell. Each is chosen in turn so a cell can
 * hold any of them, and the two underground ones are sunk below the surface
 * rather than placed on it. A treasure vault is not part of this roll: it is
 * offered separately and far more rarely, so it stays a genuine find.
 */
const LANDMARKS = ["village", "shelter", "trial_chambers", "ancient_city"];
const TREASURE_VAULT_CHANCE = 0.04;

function populateLandmark(dimension, tileX, tileZ) {
  const cellX = Math.floor(tileX / LANDMARK_REGION);
  const cellZ = Math.floor(tileZ / LANDMARK_REGION);
  const id = key(cellX, cellZ);
  if (landmarkDone.has(id)) return;
  if (tileX !== cellX * LANDMARK_REGION || tileZ !== cellZ * LANDMARK_REGION) return;
  landmarkDone.add(id);

  if (random(cellX, cellZ, SALT_LANDMARK) >= LANDMARK_CHANCE) return;

  const x = cellX * LANDMARK_REGION * 16 + 8;
  const z = cellZ * LANDMARK_REGION * 16 + 8;
  const surface = groundY(dimension, x, z);
  if (surface === undefined) return;

  // The vault takes the cell on its own rare roll, before the usual landmark.
  if (random(cellX, cellZ, SALT_VAULT) < TREASURE_VAULT_CHANCE) {
    try {
      buildTreasureVault(dimension, x, STONE_BOTTOM + 24, z);
    } catch (error) {
      console.warn(`[copper] treasure vault failed at ${x},${z}: ${error}`);
    }
    return;
  }

  const kind = pick(LANDMARKS, cellX, cellZ, 0x42);
  try {
    switch (kind) {
      case "village":
        buildVillage(dimension, x, surface, z);
        break;
      case "shelter":
        buildShelter(dimension, x, surface, z);
        break;
      case "trial_chambers":
        buildTrialChambers(dimension, x, STONE_BOTTOM + 18, z);
        break;
      case "ancient_city":
        buildAncientCity(dimension, x, STONE_BOTTOM + 2, z);
        break;
    }
  } catch (error) {
    console.warn(`[copper] landmark "${kind}" failed at ${x},${z}: ${error}`);
  }
}

/** A rare standing portal, one per landmark cell, at most. */
function populatePortal(dimension, tileX, tileZ) {
  const cellX = Math.floor(tileX / LANDMARK_REGION);
  const cellZ = Math.floor(tileZ / LANDMARK_REGION);
  if (tileX !== cellX * LANDMARK_REGION || tileZ !== cellZ * LANDMARK_REGION) return;
  // Only a small share of landmark cells carry one, so a portal is a find.
  if (random(cellX, cellZ, SALT_PORTAL) >= 0.08) return;

  const x = cellX * LANDMARK_REGION * 16 + 40;
  const z = cellZ * LANDMARK_REGION * 16 + 40;
  const y = groundY(dimension, x, z);
  if (y === undefined || y <= SEA_LEVEL) return;
  buildPortal(dimension, x, y, z);
}

function populate(dimension, tileX, tileZ) {
  populateBuild(dimension, tileX, tileZ);
  populateChest(dimension, tileX, tileZ);
  populateLandmark(dimension, tileX, tileZ);
  populatePortal(dimension, tileX, tileZ);
}

/** Called by the terrain generator once a tile's ground exists. */
export function populateTile(dimension, tileX, tileZ) {
  const id = key(tileX, tileZ);
  if (done.has(id)) return;
  done.add(id);
  try {
    populate(dimension, tileX, tileZ);
  } catch (error) {
    console.warn(`[copper] points of interest failed for tile ${id}: ${error}`);
  }
}

// ── Rare portals in the Overworld ───────────────────────────────────────────

/*
 * The same portal, rarely offered in the Overworld. There is no tile loop to
 * hang it from there, so a slow roll picks a player and a ring of ground around
 * them. The chance is deliberately tiny and the spot has to be open sky, so it
 * reads as a find rather than something built into a player's base.
 */
const OVERWORLD_PORTAL_CHANCE = 0.004;
const OVERWORLD_PORTAL_INTERVAL = 600; // ticks between rolls
const PORTAL_MIN_DISTANCE = 48;
const PORTAL_MAX_DISTANCE = 96;

system.runInterval(() => {
  for (const player of world.getPlayers()) {
    if (player.dimension.id !== "minecraft:overworld") continue;
    if (Math.random() >= OVERWORLD_PORTAL_CHANCE) continue;
    try {
      placeOverworldPortal(player);
    } catch (error) {
      console.warn(`[copper] overworld portal failed: ${error}`);
    }
  }
}, OVERWORLD_PORTAL_INTERVAL);

function placeOverworldPortal(player) {
  const dimension = player.dimension;
  const angle = Math.random() * Math.PI * 2;
  const distance = PORTAL_MIN_DISTANCE + Math.random() * (PORTAL_MAX_DISTANCE - PORTAL_MIN_DISTANCE);
  const x = Math.floor(player.location.x + Math.cos(angle) * distance);
  const z = Math.floor(player.location.z + Math.sin(angle) * distance);

  const top = dimension.getTopmostBlock({ x, z });
  if (!top) return;
  const y = top.location.y + 1;
  if (y <= WORLD_MIN_Y + 1 || y > WORLD_MAX_Y - BUILD_CLEARANCE) return;

  // Only build under open sky: a portal under a canopy or a cave roof would be
  // half buried and look like a mistake.
  for (let dy = 0; dy <= 6; dy++) {
    const cell = dimension.getBlock({ x, y: y + dy, z });
    if (!cell || !cell.isAir) return;
  }

  buildPortal(dimension, x, y, z);
}
