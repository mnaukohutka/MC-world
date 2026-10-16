import { world, system, BlockPermutation, BlockVolume } from "@minecraft/server";
import { seedPoints, populateTile } from "../structures";

/*
 * Script-driven world generation for the Copper Dimension.
 *
 * `registerCustomDimension` only offers the void generator, and Bedrock cannot
 * attach custom biome JSON to a script-created dimension — biome files drive the
 * Overworld's generator, which a script dimension does not use. So the four
 * copper biomes (plain, forest, mountain, ocean) are reproduced here in script:
 * the region is chosen from the same shape of noise a biome map would use, and
 * each region gets its own surface palette, its own mobs and its own decoration.
 * That keeps the dimension infinite and self-consistent without depending on a
 * world-generation feature the engine does not expose.
 *
 * Everything is deterministic: `hash`-based value noise seeded from the world
 * seed, so the same coordinates always yield the same ground and a tile can be
 * rebuilt after a reload without the world growing a seam.
 */

const TILE = 16;
const GEN_RADIUS = 3;         // tiles kept filled around a player
const SURFACE_Y = 70;         // average ground height
const SEA_LEVEL = 64;         // fluid sits at or below this
const MOUNTAIN_BASE = 0.45;   // noise above this lifts the ground
const MIN_GROUND = 8;         // thinnest tile column
const BOTTOM_MARGIN = 52;     // blocks of solid stone under every column
const MIN_Y = -64;            // dimension floor
const MAX_Y = 320;            // dimension ceiling
const MIN_CAVE_Y = MIN_Y + 4; // deepest level caves are carved at

const STONE = "pa:copper_stone";
const GRASS = "pa:copper_grass";
const LEAVES = "pa:copper_leaves";
const LOG = "pa:copper_wood";
const FLUID_A = "pa:fluid_copper";
const FLUID_B = "pa:fluid_copper_oxidized";

/*
 * Biomes. Nine, where there were four: the original four plus swamp, mushroom,
 * badlands and snow, chosen by a temperature/humidity pair the way vanilla does
 * rather than by the single wetness field. The fields are deliberately low
 * frequency, so a biome spans a few hundred blocks instead of a few dozen.
 */
const PLAIN = "pa:copper_plain";
const FOREST = "pa:copper_forest";
const MOUNTAIN = "pa:copper_moutain";
const OCEAN = "pa:copper_ocean";
const SWAMP = "pa:copper_swamp";
const MUSHROOM = "pa:copper_mushroom";
const BADLANDS = "pa:copper_badlands";
const SNOW = "pa:copper_snow";
const BEACH = "pa:copper_beach";

/*
 * Vanilla copper family, used as surface flavour. The four oxidation stages are
 * ordered fresh -> oxidized, so a biome can pick a stage and get a consistent
 * look instead of sprinkling the whole set at random.
 */
const COPPER_STAGES = [
  ["minecraft:copper_block", "minecraft:cut_copper", "minecraft:chiseled_copper", "minecraft:copper_grate", "minecraft:copper_bulb"],
  ["minecraft:exposed_copper", "minecraft:exposed_cut_copper", "minecraft:exposed_chiseled_copper", "minecraft:exposed_copper_grate", "minecraft:exposed_copper_bulb"],
  ["minecraft:weathered_copper", "minecraft:weathered_cut_copper", "minecraft:weathered_chiseled_copper", "minecraft:weathered_copper_grate", "minecraft:weathered_copper_bulb"],
  ["minecraft:oxidized_copper", "minecraft:oxidized_cut_copper", "minecraft:oxidized_chiseled_copper", "minecraft:oxidized_copper_grate", "minecraft:oxidized_copper_bulb"],
];

/** Each biome owns one oxidation stage, which is what makes them read apart. */
const BIOME_COPPER_STAGE = {
  [PLAIN]: 0,
  [FOREST]: 1,
  [MOUNTAIN]: 2,
  [OCEAN]: 3,
  [SWAMP]: 1,
  [MUSHROOM]: 3,
  [BADLANDS]: 2,
  [SNOW]: 1,
  [BEACH]: 0,
};

const ORE = "minecraft:copper_ore";
const DEEPSLATE_ORE = "minecraft:deepslate_copper_ore";
const RAW_COPPER = "minecraft:raw_copper_block";
const MOSS = "minecraft:moss_block";
const GRAVEL = "minecraft:gravel";
const CLAY = "minecraft:clay";
const SAND = "minecraft:sand";
const MUD = "minecraft:mud";
const MYCELIUM = "minecraft:mycelium";
const SNOW_BLOCK = "minecraft:snow";
const ICE = "minecraft:ice";
const TERRACOTTA = "minecraft:hardened_clay";
const ORANGE_TERRACOTTA = "minecraft:orange_terracotta";
const SNOW_LAYER = "minecraft:snow_layer";
const RED_MUSHROOM = "minecraft:red_mushroom";
const BROWN_MUSHROOM = "minecraft:brown_mushroom";

/* Lanterns hang below a chain, so the two ids come in matching pairs. */
const LANTERNS = [
  ["minecraft:copper_chain", "minecraft:copper_lantern"],
  ["minecraft:exposed_copper_chain", "minecraft:exposed_copper_lantern"],
  ["minecraft:weathered_copper_chain", "minecraft:weathered_copper_lantern"],
  ["minecraft:oxidized_copper_chain", "minecraft:oxidized_copper_lantern"],
];

const permutationCache = new Map();

function permutation(typeId) {
  let cached = permutationCache.get(typeId);
  if (!cached) {
    cached = BlockPermutation.resolve(typeId);
    permutationCache.set(typeId, cached);
  }
  return cached;
}

function stone() {
  return permutation(STONE);
}

function grass() {
  return permutation(GRASS);
}

function leaves() {
  return permutation(LEAVES);
}

function log() {
  return permutation(LOG);
}

function fluidA() {
  return permutation(FLUID_A).withState("block:source", true).withState("block:depth", 5);
}

function fluidB() {
  return permutation(FLUID_B).withState("block:source", true).withState("block:depth", 5);
}

/** One block of the copper family, chosen by the column's biome stage. */
function copperAt(biome, x, z) {
  const stage = COPPER_STAGES[BIOME_COPPER_STAGE[biome] ?? 0];
  return permutation(stage[Math.floor(random2(x, z, 0xc0) * stage.length) % stage.length]);
}

/** The chain+lantern pair that matches the biome's oxidation stage. */
function lanternAt(biome, x, z) {
  const [chain, lantern] = LANTERNS[BIOME_COPPER_STAGE[biome] ?? 0];
  return { chain: permutation(chain), lantern: permutation(lantern) };
}

/** Freshly exposed rock pockets inside a column, so caves read as copper veins. */
function oreAt(x, y, z) {
  return random2(x * 31 + y, z * 17 - y, 0x0e) < 0.5 ? permutation(ORE) : permutation(DEEPSLATE_ORE);
}

/** Per-biome surface material, so a biome is readable from the ground itself. */
function soilAt(biome, x, z) {
  switch (biome) {
    case OCEAN: return permutation(CLAY);
    case BEACH: return permutation(SAND);
    case MOUNTAIN: return permutation(GRAVEL);
    case BADLANDS: return permutation(random2(x, z, 0x51) < 0.5 ? TERRACOTTA : ORANGE_TERRACOTTA);
    case SNOW: return permutation(random2(x, z, 0x52) < 0.35 ? ICE : SNOW_BLOCK);
    case SWAMP: return random2(x, z, 0x53) < 0.5 ? permutation(MUD) : grass();
    case MUSHROOM: return permutation(MYCELIUM);
    case FOREST: return random2(x, z, 0x50) < 0.6 ? permutation(MOSS) : grass();
    default: return grass();
  }
}

/** The single block laid at the very top of a column. */
function topCap(biome, x, z) {
  switch (biome) {
    case MOUNTAIN: return random2(x, z, 0x70) < 0.3 ? stone() : grass();
    case BEACH: return permutation(SAND);
    case BADLANDS: return soilAt(biome, x, z);
    case SNOW: return soilAt(biome, x, z);
    case SWAMP: return soilAt(biome, x, z);
    case MUSHROOM: return soilAt(biome, x, z);
    case FOREST: return soilAt(biome, x, z);
    default: return grass();
  }
}

let seed = 0;
const generated = new Set();
let running = false;
const queued = [];
const queueKeys = new Set();

function key(x, z) {
  return `${x},${z}`;
}

/** FNV-1a over the world seed, kept in 32 bits for the noise mixers. */
function hashString(value) {
  let h = 0x811c9dc5;
  for (const ch of String(value)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function random2(x, z, salt) {
  let h = Math.imul(x, 0x165667b1);
  h = (h + Math.imul(z, 0x27d4eb2f)) | 0;
  h = (h + Math.imul(seed ^ salt, 0x55fdc781)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x4bf19f61);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x, z, salt) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const tx = smooth(x - xi);
  const tz = smooth(z - zi);
  const a = random2(xi, zi, salt);
  const b = random2(xi + 1, zi, salt);
  const c = random2(xi, zi + 1, salt);
  const d = random2(xi + 1, zi + 1, salt);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return (top + (bottom - top) * tz) * 2 - 1;
}

function fbm(x, z, octaves, salt) {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * frequency, z * frequency, salt) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / norm;
}

/** Same hash family as random2, but over three coordinates. */
function random3(x, y, z, salt) {
  let h = Math.imul(x, 0x165667b1);
  h = (h + Math.imul(y, 0x9e3779b1)) | 0;
  h = (h + Math.imul(z, 0x27d4eb2f)) | 0;
  h = (h + Math.imul(seed ^ salt, 0x55fdc781)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x4bf19f61);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function valueNoise3(x, y, z, salt) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const tx = smooth(x - xi);
  const ty = smooth(y - yi);
  const tz = smooth(z - zi);
  const c000 = random3(xi, yi, zi, salt);
  const c100 = random3(xi + 1, yi, zi, salt);
  const c010 = random3(xi, yi + 1, zi, salt);
  const c110 = random3(xi + 1, yi + 1, zi, salt);
  const c001 = random3(xi, yi, zi + 1, salt);
  const c101 = random3(xi + 1, yi, zi + 1, salt);
  const c011 = random3(xi, yi + 1, zi + 1, salt);
  const c111 = random3(xi + 1, yi + 1, zi + 1, salt);
  const x00 = c000 + (c100 - c000) * tx;
  const x10 = c010 + (c110 - c010) * tx;
  const x01 = c001 + (c101 - c001) * tx;
  const x11 = c011 + (c111 - c011) * tx;
  const y0 = x00 + (x10 - x00) * ty;
  const y1 = x01 + (x11 - x01) * ty;
  return (y0 + (y1 - y0) * tz) * 2 - 1;
}

/*
 * Caves are the intersection of two thin isosurfaces of independent 3D noise,
 * which carves winding tunnels rather than a single connected void. Both fields
 * are read a fair distance underground only; a per-column coarse check keeps
 * columns the tunnels never reach out of the expensive inner loop.
 */
const CAVE_WIDTH = 0.15;

function caveColumn(x, z) {
  return fbm(x / 72, z / 72, 2, 0xcd) > -0.2;
}

function isCave(x, y, z) {
  const a = valueNoise3(x / 46, y / 26, z / 46, 0xca);
  if (Math.abs(a) > CAVE_WIDTH) return false;
  const b = valueNoise3(x / 34 + 400, y / 20 + 400, z / 34 + 400, 0xcb);
  return Math.abs(b) <= CAVE_WIDTH;
}

/** How mountainous the column is, -1..1. */
function mountainness(x, z) {
  return fbm(x / 240, z / 240, 2, 0x33);
}

/** How wet the column is, -1..1. Drives forest against plain. */
function wetness(x, z) {
  return fbm(x / 260 + 100, z / 260 + 100, 2, 0x77);
}

/** How hot the column is, -1..1. Drives badlands and snow apart. */
function temperature(x, z) {
  return fbm(x / 300 + 300, z / 300 + 300, 2, 0x21);
}

/** How weird the column is, -1..1. Spikes on the mushroom islands. */
function weirdness(x, z) {
  return fbm(x / 210 + 700, z / 210 + 700, 2, 0x9d);
}

/**
 * Which copper biome a column belongs to.
 *
 * Ocean wins wherever the ground is at or below sea level, then a beach ring
 * sits just above it. On land the temperature/humidity pair picks the biome the
 * way vanilla's climate parameters do, which is what keeps the extra biomes in
 * sensible neighbourhoods — snow never touching badlands, swamp hugging forest.
 */
function biomeAt(x, z, height) {
  if (mountainness(x, z) > MOUNTAIN_BASE) return MOUNTAIN;
  if (height <= SEA_LEVEL) return OCEAN;
  if (height <= SEA_LEVEL + 2) return BEACH;

  const wet = wetness(x, z);
  const temp = temperature(x, z);

  // A rare high-weirdness pocket becomes mushroom country regardless of climate.
  if (weirdness(x, z) > 0.62 && wet > 0.2) return MUSHROOM;
  if (temp < -0.35 && wet > -0.1) return SNOW;
  if (temp > 0.4 && wet < -0.1) return BADLANDS;
  if (wet > 0.35 && temp > -0.2) return SWAMP;
  if (wet > 0.12) return FOREST;
  return PLAIN;
}

/** Rolling copper hills with real mountains; flatter plateau near the origin. */
function surfaceHeight(x, z) {
  const nearOrigin = Math.abs(x) <= 24 && Math.abs(z) <= 24;
  const broad = fbm(x / 280, z / 280, 4, 0x65);
  const fine = fbm(x / 60, z / 60, 3, 0x65);
  const ridge = mountainness(x, z);
  let height = SURFACE_Y + broad * 12 + fine * 3;
  if (ridge > MOUNTAIN_BASE) height += (ridge - MOUNTAIN_BASE) * 70;
  // Badlands get a little extra relief, so their terraces read as plateaus.
  if (temperature(x, z) > 0.4 && wetness(x, z) < -0.1) height += fine * 4;
  if (nearOrigin) return Math.max(SURFACE_Y, Math.round(height));
  return Math.round(height);
}

/** Trees per biome. Swamp is dense and mushroom is spore-laden; snow is sparse. */
function treeDensity(biome) {
  switch (biome) {
    case FOREST: return 0.014;
    case SWAMP: return 0.018;
    case PLAIN: return 0.003;
    case SNOW: return 0.004;
    case MUSHROOM: return 0.006;
    default: return 0;
  }
}

function isTreeAt(x, z, biome) {
  const density = treeDensity(biome);
  if (density === 0) return false;
  if (Math.abs(x) <= 6 && Math.abs(z) <= 6) return false;
  return random2(x, z, 0x5ab) < density;
}

/** Carves the cave network out of one already-solid column. */
function carveColumn(dimension, x, z, bottom, top) {
  if (!caveColumn(x, z)) return;
  // Caves are kept to the reachable band, which also keeps the scan short.
  const from = Math.max(bottom + 1, MIN_CAVE_Y);
  for (let y = from; y < top - 1; y++) {
    if (!isCave(x, y, z)) continue;
    // Every so often a cave wall keeps its copper, so the tunnels are not bare.
    const block = dimension.getBlock({ x, y, z });
    if (!block) continue;
    block.setPermutation(y < 0 && random3(x, y, z, 0x0f) < 0.35 ? oreAt(x, y, z) : permutation("minecraft:air"));
  }
}

/** Turns a solid column into layered stone, ore pockets and a surface cap. */
function buildColumn(dimension, x, z, top, bottom, biome) {
  dimension.fillBlocks(new BlockVolume({ x, y: bottom, z }, { x, y: top - 1, z }), stone(), {
    ignoreChunkBoundErrors: true,
  });

  carveColumn(dimension, x, z, bottom, top);

  /*
   * A shallow gravel/clay band under the surface gives each biome a distinct
   * cross-section, and scattered copper-family blocks at and just under the
   * surface are what make a walk through the world look like copper country.
   */
  for (let y = top - 4; y < top; y++) {
    const block = dimension.getBlock({ x, y, z });
    if (!block || block.isAir) continue;
    if (random2(x * 7 + y, z * 13 - y, 0x44) < 0.35) block.setPermutation(soilAt(biome, x, z));
  }

  for (let y = top - 3; y <= top; y++) {
    const block = dimension.getBlock({ x, y, z });
    if (!block || block.isAir) continue;
    if (random2(x * 3 + y, z * 5 - y, 0x33) < 0.16) block.setPermutation(copperAt(biome, x, z));
  }

  dimension.getBlock({ x, y: top, z })?.setPermutation(biome === OCEAN ? soilAt(biome, x, z) : topCap(biome, x, z));
}

/** Fills one 16x16 tile of ground, then decorates it per biome. */
function buildTile(dimension, tileX, tileZ) {
  const baseX = tileX * TILE;
  const baseZ = tileZ * TILE;
  const columnTops = new Int32Array(TILE * TILE);
  const columnBiome = new Array(TILE * TILE);

  for (let dx = 0; dx < TILE; dx++) {
    for (let dz = 0; dz < TILE; dz++) {
      const x = baseX + dx;
      const z = baseZ + dz;
      const top = surfaceHeight(x, z);
      const biome = biomeAt(x, z, top);
      const bottom = Math.max(MIN_Y + 1, Math.min(top - MIN_GROUND, MIN_Y + BOTTOM_MARGIN));
      const index = dx * TILE + dz;
      columnTops[index] = top;
      columnBiome[index] = biome;

      buildColumn(dimension, x, z, top, bottom, biome);

      if (top <= SEA_LEVEL) {
        fillSeas(dimension, x, z, top);
      } else {
        scatterPool(dimension, x, z, top, biome);
      }
    }
  }

  // Trees are placed after the ground so their trunk bases sit on real blocks.
  for (let dx = 2; dx < TILE - 2; dx++) {
    for (let dz = 2; dz < TILE - 2; dz++) {
      const index = dx * TILE + dz;
      const x = baseX + dx;
      const z = baseZ + dz;
      if (!isTreeAt(x, z, columnBiome[index])) continue;
      placeTree(dimension, x, columnTops[index], z, columnBiome[index]);
    }
  }

  // Small ground cover last, so nothing overgrows it: mushrooms on mycelium,
  // cacti on the badlands floor, snow caps on the cold biome.
  for (let dx = 1; dx < TILE - 1; dx++) {
    for (let dz = 1; dz < TILE - 1; dz++) {
      const index = dx * TILE + dz;
      decorateColumn(dimension, baseX + dx, columnTops[index], baseZ + dz, columnBiome[index]);
    }
  }
}

/*
 * Ground cover per biome. Everything is written only into air, so a decoration
 * can never replace the terrain it stands on, and each is rare enough not to
 * carpet the biome.
 */
function decorateColumn(dimension, x, top, z, biome) {
  const ground = dimension.getBlock({ x, y: top, z });
  if (!ground || ground.isAir || ground.isLiquid) return;

  const roll = random2(x * 11, z * 17, 0x8a);
  if (biome === MUSHROOM) {
    if (roll < 0.05) setCover(dimension, x, top, z, roll < 0.025 ? RED_MUSHROOM : BROWN_MUSHROOM);
    return;
  }
  if (biome === BADLANDS) {
    if (roll < 0.02) placeCactus(dimension, x, top, z, 1 + (Math.floor(roll * 1000) % 3));
    return;
  }
  if (biome === SNOW) {
    setCover(dimension, x, top, z, SNOW_LAYER);
    return;
  }
}

function setCover(dimension, x, top, z, blockId) {
  const above = dimension.getBlock({ x, y: top + 1, z });
  if (above && above.isAir) above.setType(blockId);
}

function placeCactus(dimension, x, top, z, height) {
  for (let i = 1; i <= height; i++) {
    const block = dimension.getBlock({ x, y: top + i, z });
    if (!block || !block.isAir) return;
    block.setType("minecraft:cactus");
  }
}

/** Ocean: both fluids, laid down as sources up to sea level. */
function fillSeas(dimension, x, z, floorY) {
  const from = { x, y: floorY + 1, z };
  const to = { x, y: SEA_LEVEL, z };
  const deep = fbm(x / 48, z / 48, 2, 0x91);
  dimension.fillBlocks(new BlockVolume(from, to), deep > 0 ? fluidA() : fluidB(), {
    ignoreChunkBoundErrors: true,
  });
}

/** Occasional surface pools of the fluid on land, so both occur inland too. */
function scatterPool(dimension, x, z, top, biome) {
  if (biome === MOUNTAIN || biome === BADLANDS || biome === SNOW) return;
  // Swamp and mushroom country are wettest, so pools are commoner there.
  const wetBand = (biome === SWAMP || biome === MUSHROOM) ? 0.5 : 0.55;
  const pool = fbm(x / 22 + 500, z / 22 + 500, 2, 0xa5);
  if (pool < wetBand || pool > wetBand + 0.17) return;
  dimension.getBlock({ x, y: top, z })?.setPermutation(pool > wetBand + 0.085 ? fluidB() : fluidA());
}

function placeTree(dimension, x, groundY, z, biome) {
  const trunk = 5 + Math.floor(random2(x, z, 0x1f) * 3);
  for (let i = 1; i <= trunk; i++) {
    dimension.getBlock({ x, y: groundY + i, z })?.setPermutation(log());
  }

  const top = groundY + trunk;
  for (let dy = -2; dy <= 1; dy++) {
    const radius = dy <= -1 ? 2 : 1;
    for (let ox = -radius; ox <= radius; ox++) {
      for (let oz = -radius; oz <= radius; oz++) {
        if (ox === 0 && oz === 0 && dy <= 0) continue;
        const block = dimension.getBlock({ x: x + ox, y: top + dy, z: z + oz });
        if (block && block.isAir) block.setPermutation(leaves());
      }
    }
  }
  dimension.getBlock({ x, y: top + 1, z })?.setPermutation(leaves());

  hangLanterns(dimension, x, top, z, biome);
}

/*
 * A chain of one or two links under a canopy edge, ended by a lantern. It only
 * overwrites air, so it never eats the leaves it hangs from, and it is rare
 * enough that a forest reads as decorated rather than lit up.
 */
function hangLanterns(dimension, x, top, z, biome) {
  if (random2(x, z, 0x1a) > 0.18) return;
  const { chain, lantern } = lanternAt(biome, x, z);
  const offsets = [
    [2, 0], [-2, 0], [0, 2], [0, -2],
  ];
  const [ox, oz] = offsets[Math.floor(random2(x, z, 0x2b) * offsets.length) % offsets.length];

  // Start under the outer canopy layer, which sits one block lower than `top`.
  const y = top - 1;
  const links = random2(x, z, 0x3c) < 0.5 ? 1 : 2;
  for (let i = 0; i < links; i++) {
    const block = dimension.getBlock({ x: x + ox, y: y - i, z: z + oz });
    if (!block || !block.isAir) return;
    block.setPermutation(chain);
  }
  const socket = dimension.getBlock({ x: x + ox, y: y - links, z: z + oz });
  if (socket && socket.isAir) socket.setPermutation(lantern);
}

async function runQueue(dimension) {
  if (running) return;
  running = true;
  try {
    while (queued.length > 0) {
      const job = queued.shift();
      queueKeys.delete(key(job.tileX, job.tileZ));
      if (generated.has(key(job.tileX, job.tileZ))) continue;

      const from = { x: job.tileX * TILE, y: MIN_Y, z: job.tileZ * TILE };
      const to = { x: from.x + TILE - 1, y: MAX_Y, z: from.z + TILE - 1 };
      const areaId = `pa_gen_${job.playerId}_${job.tileX}_${job.tileZ}`;
      const options = { dimension, from, to };
      if (!world.tickingAreaManager.hasCapacity(options)) break;

      await world.tickingAreaManager.createTickingArea(areaId, options);
      try {
        buildTile(dimension, job.tileX, job.tileZ);
        populateTile(dimension, job.tileX, job.tileZ);
        generated.add(key(job.tileX, job.tileZ));
      } finally {
        if (world.tickingAreaManager.hasTickingArea(areaId)) {
          world.tickingAreaManager.removeTickingArea(areaId);
        }
      }
      await yieldToGame();
    }
  } catch (error) {
    console.warn(`[copper] terrain generation stopped: ${error}`);
  } finally {
    running = false;
  }
}

/** Awaits a tick so a long generation run does not stall the server. */
function yieldToGame() {
  return new Promise((resolve) => system.run(resolve));
}

function enqueueTile(playerId, tileX, tileZ) {
  const id = key(tileX, tileZ);
  if (generated.has(id) || queueKeys.has(id)) return;
  queueKeys.add(id);
  queued.push({ playerId, tileX, tileZ });
}

function queueAround(player) {
  const tileX = Math.floor(player.location.x / TILE);
  const tileZ = Math.floor(player.location.z / TILE);
  for (let dx = -GEN_RADIUS; dx <= GEN_RADIUS; dx++) {
    for (let dz = -GEN_RADIUS; dz <= GEN_RADIUS; dz++) {
      enqueueTile(player.id, tileX + dx, tileZ + dz);
    }
  }
}

/** Queues the tiles around a player. Returns true when the player is in ours. */
export function queueTerrainAround(player, dimensionId) {
  if (player.dimension.id !== dimensionId) return false;
  queueAround(player);
  return true;
}

/** Lays the arrival platform so the first teleport never lands in the void. */
export function buildSpawnPad(dimension, spawn) {
  const radius = 6;
  dimension.fillBlocks(
    new BlockVolume(
      { x: spawn.x - radius, y: spawn.y - 5, z: spawn.z - radius },
      { x: spawn.x + radius, y: spawn.y - 1, z: spawn.z + radius }
    ),
    stone(),
    { ignoreChunkBoundErrors: true }
  );
  dimension.fillBlocks(
    new BlockVolume(
      { x: spawn.x - radius, y: spawn.y, z: spawn.z - radius },
      { x: spawn.x + radius, y: spawn.y, z: spawn.z + radius }
    ),
    grass(),
    { ignoreChunkBoundErrors: true }
  );
}

export function seedTerrain(worldSeed) {
  seed = hashString(worldSeed);
  seedPoints(worldSeed);
}

export function startTerrainLoop(dimensionId) {
  system.runInterval(() => {
    for (const player of world.getPlayers()) {
      if (player.dimension.id !== dimensionId) continue;
      queueTerrainAround(player, dimensionId);
      // The ocean floor can sit well below the average surface, and exploration
      // can take a player deep into the copper caves, so the lift only fires
      // once they are past the dimension floor — never mid-exploration.
      if (player.location.y < MIN_Y + 1) {
        player.teleport({ x: player.location.x, y: SURFACE_Y + 2, z: player.location.z }, { dimension: player.dimension });
        player.sendMessage("§eThe dimension was still forming — you were lifted back up.");
      }
    }
    void runQueue(world.getDimension(dimensionId));
  }, 20);
}
