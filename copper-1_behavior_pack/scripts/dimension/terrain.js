import { world, system, BlockPermutation, BlockVolume } from "@minecraft/server";

/*
 * Script-driven world generation for the Copper Dimension.
 *
 * `registerCustomDimension` only offers the void generator, so a custom
 * dimension ships empty: nothing exists until this module fills it in. Terrain
 * is produced in 16x16 tiles around each player and cached with a build marker,
 * which is the same approach the reference "The Sift" add-on uses.
 *
 * Everything here is deterministic: `hash`-based value noise seeded from the
 * world seed, so the same coordinates always yield the same ground and a tile
 * can be rebuilt after a reload without the world growing a seam.
 */

const TILE = 16;
const GEN_RADIUS = 3;         // tiles kept filled around a player
const SURFACE_Y = 70;         // average ground height
const MIN_GROUND = 8;         // thinnest tile column
const BOTTOM_MARGIN = 52;     // blocks of solid stone under every column
const MIN_Y = -64;            // dimension floor
const MAX_Y = 320;            // dimension ceiling
const MAX_TICKS_PER_TILE = 40;

const STONE = "pa:copper_stone";
const GRASS = "pa:copper_grass";
const LEAVES = "pa:copper_leaves";
const LOG = "pa:copper_wood";

const stone = BlockPermutation.resolve(STONE);
const grass = BlockPermutation.resolve(GRASS);
const leaves = BlockPermutation.resolve(LEAVES);

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

function valueNoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const tx = smooth(x - xi);
  const tz = smooth(z - zi);
  const a = random2(xi, zi, 0x65);
  const b = random2(xi + 1, zi, 0x65);
  const c = random2(xi, zi + 1, 0x65);
  const d = random2(xi + 1, zi + 1, 0x65);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return (top + (bottom - top) * tz) * 2 - 1;
}

function fbm(x, z, octaves) {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * frequency, z * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / norm;
}

/** Rolling copper hills, with a flatter plateau near the origin. */
function surfaceHeight(x, z) {
  const nearOrigin = Math.abs(x) <= 24 && Math.abs(z) <= 24;
  const broad = fbm(x / 96, z / 96, 4);
  const fine = fbm(x / 28, z / 28, 3);
  const height = SURFACE_Y + broad * 14 + fine * 4;
  if (nearOrigin) return Math.max(SURFACE_Y, Math.round(height));
  return Math.round(height);
}

function isTreeAt(x, z) {
  if (random2(x, z, 0x5ab) > 0.006) return false;
  if (Math.abs(x) <= 6 && Math.abs(z) <= 6) return false;
  return true;
}

/** Fills one 16x16 tile of ground, then adds trees on top of it. */
function buildTile(dimension, tileX, tileZ) {
  const baseX = tileX * TILE;
  const baseZ = tileZ * TILE;
  const columnTops = new Int32Array(TILE * TILE);

  for (let dx = 0; dx < TILE; dx++) {
    for (let dz = 0; dz < TILE; dz++) {
      const x = baseX + dx;
      const z = baseZ + dz;
      const top = surfaceHeight(x, z);
      const bottom = Math.max(MIN_Y + 1, Math.min(top - MIN_GROUND, MIN_Y + BOTTOM_MARGIN));
      columnTops[dx * TILE + dz] = top;
      dimension.fillBlocks(new BlockVolume({ x, y: bottom, z }, { x, y: top - 1, z }), stone, {
        ignoreChunkBoundErrors: true,
      });
      dimension.getBlock({ x, y: top, z })?.setPermutation(grass);
    }
  }

  // Trees are placed after the ground so their trunk bases sit on real blocks.
  for (let dx = 6; dx < TILE - 6; dx++) {
    for (let dz = 6; dz < TILE - 6; dz++) {
      const x = baseX + dx;
      const z = baseZ + dz;
      if (!isTreeAt(x, z)) continue;
      placeTree(dimension, x, columnTops[dx * TILE + dz], z);
    }
  }
}

function placeTree(dimension, x, groundY, z) {
  const trunk = 5 + Math.floor(random2(x, z, 0x1f) * 3);
  for (let i = 1; i <= trunk; i++) {
    dimension.getBlock({ x, y: groundY + i, z })?.setPermutation(BlockPermutation.resolve(LOG));
  }

  const top = groundY + trunk;
  for (let dy = -2; dy <= 1; dy++) {
    const radius = dy <= -1 ? 2 : 1;
    for (let ox = -radius; ox <= radius; ox++) {
      for (let oz = -radius; oz <= radius; oz++) {
        if (ox === 0 && oz === 0 && dy <= 0) continue;
        const block = dimension.getBlock({ x: x + ox, y: top + dy, z: z + oz });
        if (block && block.isAir) block.setPermutation(leaves);
      }
    }
  }
  dimension.getBlock({ x, y: top + 1, z })?.setPermutation(leaves);
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
  const dimension = world.getDimension(player.dimension.id);
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
    stone,
    { ignoreChunkBoundErrors: true }
  );
  dimension.fillBlocks(
    new BlockVolume(
      { x: spawn.x - radius, y: spawn.y, z: spawn.z - radius },
      { x: spawn.x + radius, y: spawn.y, z: spawn.z + radius }
    ),
    grass,
    { ignoreChunkBoundErrors: true }
  );
}

export function seedTerrain(worldSeed) {
  seed = hashString(worldSeed);
}

export function startTerrainLoop(dimensionId) {
  system.runInterval(() => {
    for (const player of world.getPlayers()) {
      if (player.dimension.id !== dimensionId) continue;
      queueTerrainAround(player, dimensionId);
      // Terrain is filled a few tiles at a time, so a sprinting player can
      // outrun it. Catch anyone who fell through before their tile existed.
      if (player.location.y < MIN_Y + 8) {
        player.teleport({ x: player.location.x, y: SURFACE_Y + 2, z: player.location.z }, { dimension: player.dimension });
        player.sendMessage("§eThe dimension was still forming — you were lifted back up.");
      }
    }
    void runQueue(world.getDimension(dimensionId));
  }, 20);
}
