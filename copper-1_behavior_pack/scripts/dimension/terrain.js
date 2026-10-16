import { world, system, BlockPermutation, BlockVolume } from "@minecraft/server";
import { seedPoints, buildTileContent, placeStarterChest } from "../structures";

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
const WEATHERED_STONE = "pa:weathered_copper_stone";
const OXIDIZED_STONE = "pa:oxidized_copper_stone";
const SOIL = "pa:copper_soil";
const PATINA = "pa:copper_patina";
const BRICKS = "pa:copper_bricks";
const LAMP_BLOCK = "minecraft:copper_bulb";
const GRASS = "pa:copper_grass";
const LEAVES = "pa:copper_leaves";
const LOG = "pa:copper_wood";
const FLUID_A = "pa:fluid_copper";
const FLUID_B = "pa:fluid_copper_oxidized";

/* Copper flora: the cross-rendered ground cover and the sapling. */
const FERN = "pa:copper_fern";
const BLOOM = "pa:copper_bloom";
const FUNGUS = "pa:copper_fungus";
const SAPLING = "pa:custom_sapling_copper";

/*
 * Round-7 flora. The herbs join the fern/bloom/fungus in the ground cover, the
 * bushes are scattered in the temperate biomes, and two more tree species join
 * the copper tree, each keyed to a climate so a forest has more than one canopy.
 */
const CLEMATIS = "pa:copper_clematis";
const LUNGWORT = "pa:copper_lungwort";
const THISTLE = "pa:copper_thistle";
const LICHEN = "pa:copper_lichen";
const BERRY_BUSH = "pa:copper_berry_bush";
const AZALEA = "pa:copper_azalea";

/* Underwater flora: these stand on the seabed and reach up through the fluid. */
const SEAGRASS = "pa:copper_seagrass";
const KELP = "pa:copper_kelp";
const CORAL = "pa:copper_coral";

/* Second and third tree species: birch-like vermilion, spruce-like verdigris. */
const VERMILION_WOOD = "pa:vermilion_wood";
const VERMILION_LEAVES = "pa:vermilion_leaves";
const VERMILION_SAPLING = "pa:vermilion_sapling";
const VERDIGRIS_WOOD = "pa:verdigris_wood";
const VERDIGRIS_LEAVES = "pa:verdigris_leaves";
const VERDIGRIS_SAPLING = "pa:verdigris_sapling";

/*
 * Indicative ore. The plain ore hides its companion metals; these three show
 * them, so a vein can be read before it is broken. `oreAt` picks a variant by a
 * roll, which is what makes a wall advertise what a lucky strike it is.
 */
const ORE_IRON = "pa:copper_ore_iron";
const ORE_GOLD = "pa:copper_ore_gold";
const ORE_GEM = "pa:copper_ore_gem";
const DEEPSLATE_ORE_IRON = "pa:deepslate_copper_ore_iron";
const DEEPSLATE_ORE_GOLD = "pa:deepslate_copper_ore_gold";
const DEEPSLATE_ORE_GEM = "pa:deepslate_copper_ore_gem";

/* The three custom copper stones, ordered fresh -> oxidized like the vanilla
 * family, so a biome can pick the stage its rock is in. */
const STONE_STAGES = [STONE, WEATHERED_STONE, OXIDIZED_STONE];

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
 * Vanilla copper family, used as surface flavour on top of the pack's own
 * copper rock. The four oxidation stages are ordered fresh -> oxidized, so a
 * biome can pick a stage and get a consistent look instead of sprinkling the
 * whole set at random. Only the full-block members are listed: stairs and slabs
 * need their own shape states and would read as gaps in the ground.
 */
const COPPER_STAGES = [
  ["minecraft:copper_block", "minecraft:cut_copper", "minecraft:chiseled_copper", "minecraft:copper_grate"],
  ["minecraft:exposed_copper", "minecraft:exposed_cut_copper", "minecraft:exposed_chiseled_copper", "minecraft:exposed_copper_grate"],
  ["minecraft:weathered_copper", "minecraft:weathered_cut_copper", "minecraft:weathered_chiseled_copper", "minecraft:weathered_copper_grate"],
  ["minecraft:oxidized_copper", "minecraft:oxidized_cut_copper", "minecraft:oxidized_chiseled_copper", "minecraft:oxidized_copper_grate"],
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

/* Raw copper pockets inside the rock, so a cave wall reads as ore-bearing. */
const RAW_COPPER = "minecraft:raw_copper_block";

/*
 * The dimension's own ore. It replaces vanilla copper ore rather than sitting
 * beside it: when mined it yields raw copper plus the metals that historically
 * travel with copper — iron, gold, and the odd gem — so prospecting the copper
 * caves pays in more than one metal.
 *
 * The lamp post cap is vanilla's own copper bulb rather than a bespoke lamp, so
 * the light matches the copper family's oxidation stages for free.
 */
const COPPER_ORE = "pa:copper_ore";
const DEEPSLATE_COPPER_ORE = "pa:deepslate_copper_ore";
const MOSS = "minecraft:moss_block";
const CLAY = "minecraft:clay";
const SAND = "minecraft:sand";
const GRAVEL = "minecraft:gravel";
const MUD = "minecraft:mud";
const SNOW_LAYER = "minecraft:snow_layer";
/* The shaft of a lamp post, and the cover block for small ground clutter. */
const CONNECTOR = "minecraft:chiseled_copper";

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

/** The custom copper rock at the biome's oxidation stage. */
function stoneAt(biome) {
  return permutation(STONE_STAGES[(BIOME_COPPER_STAGE[biome] ?? 0) % STONE_STAGES.length]);
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

/**
 * Copper ore veins. The dimension's own ore, so a cave wall yields copper and a
 * companion metal at once. Deepslate ore sits below y=0 where the rock turns
 * dark, matching how the rest of the world grades.
 *
 * Most of the vein is the plain ore, which keeps the metal a surprise. A share
 * of it is an indicative variant instead — its texture carries the companion
 * metal — so a wall can be read before it is broken, and a lucky strike can be
 * picked out from across a cave.
 */
function oreAt(biome, x, y, z) {
  const roll = random2(x * 31 + y, z * 17 - y, 0x0e);
  if (roll < 0.30) {
    const deep = y < 0;
    const variant = random2(x * 13 - y, z * 7 + y, 0x0f);
    if (variant < 0.40) return permutation(deep ? DEEPSLATE_ORE_IRON : ORE_IRON);
    if (variant < 0.75) return permutation(deep ? DEEPSLATE_ORE_GOLD : ORE_GOLD);
    if (variant < 0.95) return permutation(deep ? DEEPSLATE_ORE_GEM : ORE_GEM);
    return permutation(deep ? DEEPSLATE_COPPER_ORE : COPPER_ORE);
  }
  return stoneAt(biome);
}

/**
 * Per-biome surface material. Everything here is copper-first: the pack's own
 * soil, patina and brick, with the few vanilla materials that read as copper
 * country (gravel, clay, sand, mud, moss) used sparingly.
 */
function soilAt(biome, x, z) {
  switch (biome) {
    case OCEAN: return permutation(CLAY);
    case BEACH: return permutation(SAND);
    case MOUNTAIN: return random2(x, z, 0x54) < 0.5 ? permutation(GRAVEL) : stoneAt(biome);
    case BADLANDS: return permutation(BRICKS);
    case SNOW: return permutation(SOIL);
    case SWAMP: return random2(x, z, 0x53) < 0.5 ? permutation(MUD) : grass();
    case MUSHROOM: return permutation(PATINA);
    case FOREST: return random2(x, z, 0x50) < 0.6 ? permutation(MOSS) : grass();
    default: return grass();
  }
}

/** The single block laid at the very top of a column. */
function topCap(biome, x, z) {
  switch (biome) {
    case MOUNTAIN: return random2(x, z, 0x70) < 0.35 ? stoneAt(biome) : grass();
    case BEACH: return permutation(SAND);
    case BADLANDS: return permutation(BRICKS);
    case SNOW: return permutation(SOIL);
    default: return soilAt(biome, x, z);
  }
}

let seed = 0;
const generated = new Set();
/*
 * Tiles whose surroundings are complete enough to carry a structure. A tile is
 * plain terrain first; once its 3x3 neighbourhood exists, any build waiting on
 * it is raised and the tile is stamped `decorated`.
 */
const decorated = new Set();
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

/*
 * Caverns are the counterpoint to the tunnels: broad rooms rather than winding
 * passages. A single smooth field opened above a threshold carves one big void
 * per cell instead of a web of thin ones, which is what a player reads as a
 * chamber to explore. The threshold is high enough that caverns stay rare and
 * the tunnels between them still do the connecting.
 */
const CAVERN_SIZE = 90;
function isCavern(x, y, z) {
  const field = valueNoise3(x / CAVERN_SIZE, y / (CAVERN_SIZE * 0.55), z / CAVERN_SIZE, 0x7a);
  return field > 0.62;
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

/**
 * The biomes this dimension knows, in the order they should appear in a command
 * enum, with the short key a player types in place of the block identifier.
 */
export const BIOMES = [
  { id: PLAIN, key: "plain", label: "Copper Plain" },
  { id: FOREST, key: "forest", label: "Copper Forest" },
  { id: MOUNTAIN, key: "mountain", label: "Copper Mountain" },
  { id: OCEAN, key: "ocean", label: "Copper Ocean" },
  { id: SWAMP, key: "swamp", label: "Copper Swamp" },
  { id: MUSHROOM, key: "mushroom", label: "Copper Mushroom" },
  { id: BADLANDS, key: "badlands", label: "Copper Badlands" },
  { id: SNOW, key: "snow", label: "Copper Snow" },
  { id: BEACH, key: "beach", label: "Copper Beach" },
];

const BIOME_BY_KEY = new Map(BIOMES.map((biome) => [biome.key, biome.id]));

/** The biome identifier for a short key, or `undefined` if it is unknown. */
export function biomeFor(key) {
  return BIOME_BY_KEY.get(key);
}

/** The biome a column belongs to, from its coordinates alone — no block reads. */
export function biomeAtColumn(x, z) {
  return biomeAt(x, z, surfaceHeight(x, z));
}

/** The generated surface height of a column, from its coordinates alone. */
export function predictedSurface(x, z) {
  return surfaceHeight(x, z);
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

/*
 * Which tree grows on a column. The copper tree dominates the wet forest, but a
 * warmer forest leans to vermilion and a colder one to verdigris, so a single
 * biome shows more than one canopy. Each species carries its own wood, leaves
 * and sapling so growth and shape stay consistent.
 */
const COPPER_TREE = { wood: LOG, leaves: LEAVES, sapling: SAPLING };
const VERMILION_TREE = { wood: VERMILION_WOOD, leaves: VERMILION_LEAVES, sapling: VERMILION_SAPLING };
const VERDIGRIS_TREE = { wood: VERDIGRIS_WOOD, leaves: VERDIGRIS_LEAVES, sapling: VERDIGRIS_SAPLING };

function treeSpeciesAt(x, z, biome) {
  const temp = temperature(x, z);
  const pick = random2(x, z, 0x5ac);
  if (biome === FOREST) {
    if (temp > 0.15 && pick < 0.45) return VERMILION_TREE;
    if (temp < -0.15 && pick < 0.45) return VERDIGRIS_TREE;
    return pick < 0.2 ? VERMILION_TREE : COPPER_TREE;
  }
  if (biome === SWAMP) return pick < 0.25 ? VERDIGRIS_TREE : COPPER_TREE;
  if (biome === SNOW) return VERDIGRIS_TREE;
  if (biome === PLAIN) return pick < 0.4 ? VERMILION_TREE : COPPER_TREE;
  if (biome === MUSHROOM) return pick < 0.5 ? VERDIGRIS_TREE : COPPER_TREE;
  return COPPER_TREE;
}

/** Carves the cave network out of one already-solid column. */
function carveColumn(dimension, x, z, bottom, top) {
  const tunnelled = caveColumn(x, z);
  // Caves are kept to the reachable band, which also keeps the scan short.
  const from = Math.max(bottom + 1, MIN_CAVE_Y);
  for (let y = from; y < top - 1; y++) {
    const inTunnel = tunnelled && isCave(x, y, z);
    const inCavern = !inTunnel && y < top - 10 && isCavern(x, y, z);
    if (!inTunnel && !inCavern) continue;
    const block = dimension.getBlock({ x, y, z });
    if (!block) continue;
    // Copper veins run thicker through the deep rock, so a cavern floor is
    // worth digging over and a tunnel wall still pays for the torch it costs.
    const veinChance = inCavern ? 0.4 : 0.35;
    if (y < 0 && random3(x, y, z, 0x0f) < veinChance) {
      block.setPermutation(oreAt("pa:copper_plain", x, y, z));
    } else {
      block.setPermutation(permutation("minecraft:air"));
    }
  }
}

/**
 * Dresses the floor and ceiling of a cavern once its rock is carved. Ore already
 * flakes the walls from `carveColumn`; this adds the standing detail — patina
 * crusts, copper fungus and a scattering of raw-copper boulders — so a chamber
 * reads as a place rather than an empty bubble.
 */
function decorateCavern(dimension, x, z, bottom, top) {
  if (!caveColumn(x, z)) return;
  for (let y = Math.max(bottom + 2, MIN_CAVE_Y); y < top - 2; y++) {
    // Only touch the open cells of the cavern itself.
    const here = dimension.getBlock({ x, y, z });
    if (!here) continue;
    if (!here.isAir) {
      // A solid cell just above a cavern void is its ceiling: hang a little
      // fungus, lichen or a glowing copper bulb there, so a deep chamber is lit
      // from above rather than pitch black.
      const below = dimension.getBlock({ x, y: y - 1, z });
      if (below && below.isAir) {
        const roll = random3(x, y, z, 0x2c);
        if (roll < 0.015) {
          here.setPermutation(BlockPermutation.resolve(LAMP_BLOCK).withState("lit", true));
        } else if (roll < 0.10) {
          here.setPermutation(permutation(random3(x, y, z, 0x2d) < 0.5 ? FUNGUS : LICHEN));
        }
      }
      continue;
    }
    const below = dimension.getBlock({ x, y: y - 1, z });
    if (!below || below.isAir) continue;
    // This is a cavern floor cell. Give it occasional cover and ore boulders.
    const roll = random3(x, y, z, 0x2e);
    if (roll < 0.05) here.setPermutation(permutation(PATINA));
    else if (roll < 0.09) here.setPermutation(permutation(FUNGUS));
    else if (roll < 0.12) here.setPermutation(permutation(LICHEN));
    else if (roll < 0.15) here.setPermutation(permutation(RAW_COPPER));
    else if (roll < 0.17) here.setPermutation(permutation(STONE));
  }
}

/** Turns a solid column into layered rock, raw-copper pockets and a surface cap. */
function buildColumn(dimension, x, z, top, bottom, biome) {
  dimension.fillBlocks(new BlockVolume({ x, y: bottom, z }, { x, y: top - 1, z }), stoneAt(biome), {
    ignoreChunkBoundErrors: true,
  });

  carveColumn(dimension, x, z, bottom, top);

  // Cavern floors and ceilings get their standing detail after the rock is gone.
  decorateCavern(dimension, x, z, bottom, top);

  /*
   * A shallow band of copper soil and raw copper under the surface gives each
   * biome a distinct cross-section; scattered copper-family blocks at and just
   * under the surface are what make a walk through the world look like copper
   * country.
   */
  for (let y = top - 4; y < top; y++) {
    const block = dimension.getBlock({ x, y, z });
    if (!block || block.isAir) continue;
    if (random2(x * 7 + y, z * 13 - y, 0x44) < 0.35) block.setPermutation(soilAt(biome, x, z));
  }

  for (let y = top - 6; y <= top - 1; y++) {
    const block = dimension.getBlock({ x, y, z });
    if (!block || block.isAir) continue;
    const roll = random2(x * 3 + y, z * 5 - y, 0x33);
    if (roll < 0.08) block.setPermutation(oreAt(biome, x, y, z));
    else if (roll < 0.16) block.setPermutation(permutation(RAW_COPPER));
    else if (roll < 0.30) block.setPermutation(copperAt(biome, x, z));
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
}

/** True once every tile in the 3x3 block around (tileX, tileZ) has ground. */
function neighbourhoodReady(tileX, tileZ) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!generated.has(key(tileX + dx, tileZ + dz))) return false;
    }
  }
  return true;
}

/*
 * Final ground cover for a tile, run once its neighbourhood exists. Doing it
 * only now — rather than during `buildTile` — means a column's biome is taken
 * from finished terrain, so a flower is not planted in a spot that a later tile
 * would have flattened, and a build raised nearby does not leave half its
 * meadow buried. It is written into air only, so it never digs into a structure.
 */
function decorateTile(dimension, tileX, tileZ) {
  const baseX = tileX * TILE;
  const baseZ = tileZ * TILE;
  for (let dx = 1; dx < TILE - 1; dx++) {
    for (let dz = 1; dz < TILE - 1; dz++) {
      const x = baseX + dx;
      const z = baseZ + dz;
      const top = surfaceHeight(x, z);
      const biome = biomeAt(x, z, top);
      decorateColumn(dimension, x, top, z, biome);
    }
  }
}

/*
 * Ground cover per biome. Everything is written only into air, so a decoration
 * can never replace the terrain it stands on, and each is rare enough not to
 * carpet the biome. The flavour is copper: lamp posts on their own copper rock,
 * patina and raw-copper clusters, and a copper grate skylight where a cave
 * mouth would be.
 *
 * The flora is deliberately varied per biome — five cross-rendered herbs plus
 * the fern/bloom/fungus, the odd copper sapling, and two bushes — so a walk
 * reads as a landscape rather than one repeated prop. Lamp posts are kept scarce
 * (roughly one per 100-300 columns) so they mark a path instead of lighting up
 * the whole biome.
 */
function decorateColumn(dimension, x, top, z, biome) {
  const ground = dimension.getBlock({ x, y: top, z });
  if (!ground || ground.isAir || ground.isLiquid) return;

  const roll = random2(x * 11, z * 17, 0x8a);
  const sprout = random2(x * 5, z * 23, 0xbb);
  const herb = pickHerb(x, z, biome);

  if (biome === MUSHROOM) {
    if (roll < 0.01) placeLampPost(dimension, x, top, z);
    else if (sprout < 0.14) setCover(dimension, x, top, z, FUNGUS);
    else if (sprout < 0.17) setCover(dimension, x, top, z, SAPLING);
    else if (sprout < 0.24) setCover(dimension, x, top, z, herb);
    return;
  }
  if (biome === BADLANDS) {
    if (roll < 0.007) placeLampPost(dimension, x, top, z);
    else if (roll < 0.05) setCover(dimension, x, top, z, PATINA);
    else if (sprout < 0.05) setCover(dimension, x, top, z, BLOOM);
    else if (sprout < 0.09) setCover(dimension, x, top, z, THISTLE);
    return;
  }
  if (biome === SNOW) {
    setCover(dimension, x, top, z, SNOW_LAYER);
    if (sprout < 0.03) setCover(dimension, x, top + 1, z, FERN);
    else if (sprout < 0.05) setCover(dimension, x, top + 1, z, LUNGWORT);
    return;
  }
  if (biome === SWAMP) {
    if (sprout < 0.2) setCover(dimension, x, top, z, FERN);
    else if (sprout < 0.26) setCover(dimension, x, top, z, FUNGUS);
    else if (sprout < 0.3) setCover(dimension, x, top, z, SAPLING);
    else if (sprout < 0.36) placeBush(dimension, x, top, z, BERRY_BUSH);
    else if (sprout < 0.40) setCover(dimension, x, top, z, LICHEN);
    return;
  }
  if (biome === FOREST) {
    if (roll < 0.0025) placeLampPost(dimension, x, top, z);
    else if (sprout < 0.08) setCover(dimension, x, top, z, FERN);
    else if (sprout < 0.12) setCover(dimension, x, top, z, BLOOM);
    else if (sprout < 0.14) setCover(dimension, x, top, z, SAPLING);
    else if (sprout < 0.19) setCover(dimension, x, top, z, herb);
    else if (sprout < 0.22) placeBush(dimension, x, top, z, AZALEA);
    else if (sprout < 0.25) placeBush(dimension, x, top, z, BERRY_BUSH);
    return;
  }
  if (biome === PLAIN || biome === BEACH) {
    if (roll < 0.002) placeLampPost(dimension, x, top, z);
    else if (roll < 0.03) setCover(dimension, x, top, z, PATINA);
    else if (sprout < 0.05) setCover(dimension, x, top, z, FERN);
    else if (sprout < 0.08) setCover(dimension, x, top, z, BLOOM);
    else if (sprout < 0.12) setCover(dimension, x, top, z, herb);
    else if (sprout < 0.14) setCover(dimension, x, top, z, LICHEN);
    return;
  }
  if (biome === MOUNTAIN) {
    if (sprout < 0.04) setCover(dimension, x, top, z, FERN);
    else if (sprout < 0.06) setCover(dimension, x, top, z, THISTLE);
    else if (sprout < 0.08) setCover(dimension, x, top, z, LICHEN);
  }
}

/*
 * The herb a temperate column grows, if it grows one. A single roll picks among
 * the five, so a meadow mixes them rather than repeating one flower, and the
 * biome biases which one is commonest.
 */
function pickHerb(x, z, biome) {
  const roll = random2(x * 3, z * 5, 0xbc);
  if (biome === PLAIN || biome === BEACH) {
    if (roll < 0.35) return CLEMATIS;
    if (roll < 0.6) return THISTLE;
    if (roll < 0.8) return LUNGWORT;
    return LICHEN;
  }
  if (roll < 0.4) return LUNGWORT;
  if (roll < 0.7) return CLEMATIS;
  if (roll < 0.9) return LICHEN;
  return THISTLE;
}

/** A two-block bush: a leafy crown on a short woody stem, both in copper. */
function placeBush(dimension, x, top, z, typeId) {
  const stem = dimension.getBlock({ x, y: top + 1, z });
  const crown = dimension.getBlock({ x, y: top + 2, z });
  if (!stem || !stem.isAir) return;
  if (crown && !crown.isAir) {
    // No headroom; a berry bush is a single block and can still go down.
    if (typeId !== BERRY_BUSH) return;
    stem.setType(typeId);
    return;
  }
  stem.setType(typeId === BERRY_BUSH ? BERRY_BUSH : LOG);
  if (crown) crown.setType(typeId === BERRY_BUSH ? BERRY_BUSH : typeId);
}

/** Puts a single block of cover on top of the column, if the space is free. */
function setCover(dimension, x, top, z, blockId) {
  const above = dimension.getBlock({ x, y: top + 1, z });
  if (above && above.isAir) above.setType(blockId);
}

/** A copper post: a copper-wood shaft, capped by a lamp that lights the way. */
function placeLampPost(dimension, x, top, z) {
  const height = 2 + Math.floor(random2(x, z, 0x9f) * 2);
  for (let i = 1; i <= height; i++) {
    const block = dimension.getBlock({ x, y: top + i, z });
    if (!block || !block.isAir) return;
    block.setType(CONNECTOR);
  }
  const cap = dimension.getBlock({ x, y: top + height + 1, z });
  if (cap && cap.isAir) {
    // The bulb is the lamp: it is placed already lit, so a post is a landmark
    // even before a keeper passes, and a shade can dim it again.
    cap.setPermutation(BlockPermutation.resolve(LAMP_BLOCK).withState("lit", true));
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
  plantSeabed(dimension, x, floorY, z);
}

/*
 * The three underwater plants. They are written into the fluid just above the
 * bed, so a shallow sea carries a bed of seagrass and coral and a deep one grows
 * kelp partway to the surface. Only fluid is replaced, so none of them floats
 * over the seabed or eats a block a swimmer needs.
 */
function plantSeabed(dimension, x, floorY, z) {
  const depth = SEA_LEVEL - floorY;
  if (depth < 2) return;
  const roll = random2(x * 19, z * 29, 0x7a);
  if (roll > 0.22) return;

  const kind = random2(x * 7, z * 11, 0x7b);
  const plant = kind < 0.5 ? SEAGRASS : kind < 0.8 ? CORAL : KELP;
  // Coral keeps to the shallows; kelp is the deep one and grows taller.
  if (plant === CORAL && depth > 8) return;
  if (plant === KELP && depth < 6) return;

  const height = plant === KELP ? Math.min(depth - 1, 3 + Math.floor(random2(x, z, 0x7c) * 4)) : 1;
  for (let i = 1; i <= height; i++) {
    const block = dimension.getBlock({ x, y: floorY + i, z });
    if (!block || !(block.isLiquid || block.typeId === "minecraft:water")) return;
    block.setType(plant);
  }
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

function placeTree(dimension, x, groundY, z, biome, species) {
  const tree = species || treeSpeciesAt(x, z, biome);
  const trunk = 5 + Math.floor(random2(x, z, 0x1f) * 3);
  for (let i = 1; i <= trunk; i++) {
    dimension.getBlock({ x, y: groundY + i, z })?.setPermutation(permutation(tree.wood));
  }

  const top = groundY + trunk;
  for (let dy = -2; dy <= 1; dy++) {
    const radius = dy <= -1 ? 2 : 1;
    for (let ox = -radius; ox <= radius; ox++) {
      for (let oz = -radius; oz <= radius; oz++) {
        if (ox === 0 && oz === 0 && dy <= 0) continue;
        const block = dimension.getBlock({ x: x + ox, y: top + dy, z: z + oz });
        if (block && block.isAir) block.setPermutation(permutation(tree.leaves));
      }
    }
  }
  dimension.getBlock({ x, y: top + 1, z })?.setPermutation(permutation(tree.leaves));

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

async function drainQueue(dimension) {
  while (queued.length > 0) {
    const job = queued.shift();
    queueKeys.delete(key(job.tileX, job.tileZ));
    const tileId = key(job.tileX, job.tileZ);
    if (decorated.has(tileId)) continue;

    const from = { x: job.tileX * TILE, y: MIN_Y, z: job.tileZ * TILE };
    const to = { x: from.x + TILE - 1, y: MAX_Y, z: from.z + TILE - 1 };
    const areaId = `pa_gen_${job.playerId}_${job.tileX}_${job.tileZ}`;
    const options = { dimension, from, to };
    if (!world.tickingAreaManager.hasCapacity(options)) break;

    await world.tickingAreaManager.createTickingArea(areaId, options);
    try {
      /*
       * Two passes. A tile lays plain terrain first; only once its 3x3
       * neighbourhood exists does it raise the structures that span it and
       * take its final ground cover. Building a landmark the moment its own
       * tile finished would let the very next tile's column work plough
       * through it, which is exactly what left the dimension almost empty.
       */
      if (!generated.has(tileId)) {
        buildTile(dimension, job.tileX, job.tileZ);
        generated.add(tileId);
      }
      if (neighbourhoodReady(job.tileX, job.tileZ) && !decorated.has(tileId)) {
        // Ground cover first, then the structures: a build should overwrite a
        // stray flower, not the other way round.
        decorateTile(dimension, job.tileX, job.tileZ);
        buildTileContent(dimension, job.tileX, job.tileZ);
        decorated.add(tileId);
      }
    } catch (error) {
      // One bad tile must not drain the whole queue: the terrain loop keeps
      // feeding it, and a single unknown block would otherwise stall the
      // dimension for every player. Leave the tile unmarked so it can be
      // rebuilt once the cause is fixed.
      console.warn(`[copper] tile ${job.tileX},${job.tileZ} failed: ${error}`);
    } finally {
      if (world.tickingAreaManager.hasTickingArea(areaId)) {
        world.tickingAreaManager.removeTickingArea(areaId);
      }
    }
    await yieldToGame();
  }
}

async function runQueue(dimension) {
  if (running) return;
  running = true;
  try {
    await drainQueue(dimension);

    /*
     * Closing pass. The drain stops as soon as the queue is empty, but a tile
     * that was waiting on neighbours when it was first offered is never offered
     * again by the player-driven loop — the player has already moved on. Walk
     * the built tiles once more and re-offer every one whose neighbourhood has
     * since arrived, so a build at the trailing edge of the generation window
     * still gets raised instead of sitting in a permanent half-finished state.
     */
    for (;;) {
      const before = decorated.size;
      for (const tileId of generated) {
        if (decorated.has(tileId)) continue;
        const [tx, tz] = tileId.split(",").map(Number);
        if (neighbourhoodReady(tx, tz)) enqueueTile("settle", tx, tz);
      }
      if (queued.length === 0) break;
      await drainQueue(dimension);
      // A tile that keeps throwing must not spin the pass forever.
      if (decorated.size === before) break;
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
  // Re-offer a tile until it is fully decorated, not merely built: its
  // neighbourhood may still be missing, and that is the guard for raising the
  // structures that span it.
  if (decorated.has(id) || queueKeys.has(id)) return;
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
  // A guaranteed chest beside the pad: the scattered chests are deliberately
  // sparse, and a player should still see the loot system on arrival.
  placeStarterChest(dimension, spawn);
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
