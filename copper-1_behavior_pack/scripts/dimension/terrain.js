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

const STONE = "pa:copper_stone";
const GRASS = "pa:copper_grass";
const LEAVES = "pa:copper_leaves";
const LOG = "pa:copper_wood";
const FLUID_A = "pa:fluid_copper";
const FLUID_B = "pa:fluid_copper_oxidized";

const PLAIN = "pa:copper_plain";
const FOREST = "pa:copper_forest";
const MOUNTAIN = "pa:copper_moutain";
const OCEAN = "pa:copper_ocean";

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

/** How mountainous the column is, -1..1. */
function mountainness(x, z) {
  return fbm(x / 140, z / 140, 2, 0x33);
}

/** How wet the column is, -1..1. Drives forest against plain. */
function wetness(x, z) {
  return fbm(x / 90 + 100, z / 90 + 100, 2, 0x77);
}

/** Which of the four copper biomes a column belongs to. */
function biomeAt(x, z, height) {
  if (mountainness(x, z) > MOUNTAIN_BASE) return MOUNTAIN;
  if (height <= SEA_LEVEL) return OCEAN;
  if (wetness(x, z) > 0.12) return FOREST;
  return PLAIN;
}

/** Rolling copper hills with real mountains; flatter plateau near the origin. */
function surfaceHeight(x, z) {
  const nearOrigin = Math.abs(x) <= 24 && Math.abs(z) <= 24;
  const broad = fbm(x / 96, z / 96, 4, 0x65);
  const fine = fbm(x / 28, z / 28, 3, 0x65);
  const ridge = mountainness(x, z);
  let height = SURFACE_Y + broad * 10 + fine * 3;
  if (ridge > MOUNTAIN_BASE) height += (ridge - MOUNTAIN_BASE) * 60;
  if (nearOrigin) return Math.max(SURFACE_Y, Math.round(height));
  return Math.round(height);
}

function isTreeAt(x, z, biome) {
  if (biome !== FOREST && biome !== PLAIN) return false;
  if (Math.abs(x) <= 6 && Math.abs(z) <= 6) return false;
  const density = biome === FOREST ? 0.014 : 0.003;
  return random2(x, z, 0x5ab) < density;
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

      dimension.fillBlocks(new BlockVolume({ x, y: bottom, z }, { x, y: top - 1, z }), stone(), {
        ignoreChunkBoundErrors: true,
      });

      const surface = biome === MOUNTAIN ? stone() : grass();
      dimension.getBlock({ x, y: top, z })?.setPermutation(surface);

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
      placeTree(dimension, x, columnTops[index], z);
    }
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
  if (biome === MOUNTAIN) return;
  const pool = fbm(x / 22 + 500, z / 22 + 500, 2, 0xa5);
  if (pool < 0.55 || pool > 0.72) return;
  dimension.getBlock({ x, y: top, z })?.setPermutation(pool > 0.635 ? fluidB() : fluidA());
}

function placeTree(dimension, x, groundY, z) {
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
      // The ocean floor can sit well below the average surface, so only lift a
      // player who has fallen past the dimension floor itself.
      if (player.location.y < MIN_Y + 8) {
        player.teleport({ x: player.location.x, y: SURFACE_Y + 2, z: player.location.z }, { dimension: player.dimension });
        player.sendMessage("§eThe dimension was still forming — you were lifted back up.");
      }
    }
    void runQueue(world.getDimension(dimensionId));
  }, 20);
}
