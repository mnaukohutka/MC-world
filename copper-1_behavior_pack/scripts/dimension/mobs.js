import { world, system } from "@minecraft/server";

/*
 * Mob population for the Copper Dimension.
 *
 * `spawn_rules/*.json` cannot help here: they match on a biome tag, and a
 * script-registered dimension has no custom biome to carry one, so nothing the
 * pack ships spawns by itself. This module is the replacement — a short roll
 * around each player, biased to the pack's own mobs.
 *
 * The copper workers arrive by their own element: bees in the air, fish in the
 * water, moles under the ground, keepers on the land. Each is placed where its
 * body can actually live, so none of them suffocates or drowns on arrival.
 */

const COPPER_DIMENSION = "pa:copper_dimension";

const BEE = "pa:copper_bee";
const FISH = "pa:copper_fish";
const MOLE = "pa:copper_mole";
const KEEPER = "pa:copper_keeper";

/* The dimension stays mostly peaceful; the golem is the old pack resident and
 * a rare creeper keeps the caves from being entirely safe. */
const COPPER_GOLEM = "minecraft:copper_golem";
const CREEPER = "minecraft:creeper";

const SPAWN_RADIUS = 32;
const MIN_DISTANCE = 14;
const MAX_NEARBY = 20;

const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);
const SOFT_GROUND = new Set([
  "pa:copper_stone",
  "pa:copper_soil",
  "pa:copper_grass",
  "pa:weathered_copper_stone",
  "pa:oxidized_copper_stone",
  "minecraft:stone",
  "minecraft:deepslate",
]);

system.runInterval(() => {
  for (const player of world.getPlayers()) {
    if (player.dimension.id !== COPPER_DIMENSION) continue;
    if (player.location.y < -60) continue;
    try {
      trySpawn(player);
    } catch (error) {
      console.warn(`[copper] mob spawn failed: ${error}`);
    }
  }
}, 300);

function trySpawn(player) {
  const dimension = player.dimension;
  if (nearbyCount(dimension, player.location) >= MAX_NEARBY) return;

  const angle = Math.random() * Math.PI * 2;
  const distance = MIN_DISTANCE + Math.random() * (SPAWN_RADIUS - MIN_DISTANCE);
  const x = Math.floor(player.location.x + Math.cos(angle) * distance);
  const z = Math.floor(player.location.z + Math.sin(angle) * distance);

  const surface = dimension.getTopmostBlock({ x, z });
  if (!surface) return;

  const ground = dimension.getBlock(surface.location);
  if (!ground || ground.isAir) return;

  const roll = Math.random();
  if (WATER.has(ground.typeId)) {
    // A column the player stands beside is the only place a fish can be placed
    // without guessing where the water body is.
    spawnInWater(dimension, x, surface.location.y, z);
    return;
  }

  if (roll < 0.3) {
    spawnFlying(dimension, x, surface.location.y, z);
  } else if (roll < 0.5) {
    spawnWalker(dimension, x, surface.location.y, z);
  } else if (roll < 0.68 && SOFT_GROUND.has(ground.typeId)) {
    spawnBurrower(dimension, x, surface.location.y, z);
  } else if (roll < 0.8) {
    spawnFlying(dimension, x, surface.location.y, z);
  } else if (roll < 0.95) {
    spawnEntity(dimension, COPPER_GOLEM, { x: x + 0.5, y: surface.location.y + 1, z: z + 0.5 });
  } else {
    spawnEntity(dimension, CREEPER, { x: x + 0.5, y: surface.location.y + 1, z: z + 0.5 });
  }
}

function spawnEntity(dimension, typeId, at) {
  if (!isAirAt(dimension, at)) return;
  dimension.spawnEntity(typeId, at);
}

function spawnFlying(dimension, x, y, z) {
  const at = { x: x + 0.5, y: y + 3, z: z + 0.5 };
  if (!isAirAt(dimension, at)) return;
  dimension.spawnEntity(BEE, at);
}

function spawnWalker(dimension, x, y, z) {
  const at = { x: x + 0.5, y: y + 1, z: z + 0.5 };
  if (!isAirAt(dimension, at)) return;
  dimension.spawnEntity(KEEPER, at);
}

function spawnBurrower(dimension, x, y, z) {
  // One block into the ground, which is where a mole belongs.
  const at = { x: x + 0.5, y, z: z + 0.5 };
  const block = dimension.getBlock({ x, y: Math.floor(y), z });
  if (!block || block.isAir) return;
  block.setType("minecraft:air");
  dimension.spawnEntity(MOLE, at);
}

function spawnInWater(dimension, x, y, z) {
  for (let dy = 0; dy > -6; dy--) {
    const at = { x: x + 0.5, y: y + dy, z: z + 0.5 };
    const block = dimension.getBlock({ x, y: Math.floor(at.y), z });
    if (!block || !WATER.has(block.typeId)) break;
    dimension.spawnEntity(FISH, at);
    return;
  }
}

function isAirAt(dimension, at) {
  const block = dimension.getBlock(at);
  return Boolean(block && block.isAir);
}

function nearbyCount(dimension, location) {
  try {
    return dimension
      .getEntities({ location, maxDistance: SPAWN_RADIUS, excludeTypes: ["minecraft:player", "minecraft:item"] })
      .length;
  } catch {
    return 0;
  }
}

// Referenced so the allow-list stays visible: villagers arrive with the village
// build; these constants document that nothing else is meant to spawn.
export const POPULATION = [BEE, FISH, MOLE, KEEPER, COPPER_GOLEM, CREEPER];
