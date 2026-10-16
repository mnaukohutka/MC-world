import { world, system } from "@minecraft/server";

/*
 * Mob population for the Copper Dimension.
 *
 * `spawn_rules/*.json` cannot help here: they match on a biome tag, and a
 * script-registered dimension has no custom biome to carry one, so nothing the
 * pack ships spawns by itself. This module is the replacement — a short roll
 * around each player, biased to the pack's own mobs.
 *
 * The dimension is meant to hold only villages, villagers, copper golems and
 * creepers, so the allow-list below is deliberately tiny.
 */

const COPPER_DIMENSION = "pa:copper_dimension";
const CREEPER = "minecraft:creeper";
const COPPER_GOLEM = "minecraft:copper_golem";
const VILLAGER = "minecraft:villager";

const SPAWN_RADIUS = 24;
const MIN_DISTANCE = 12;
const MAX_NEARBY = 12;

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
}, 400);

function trySpawn(player) {
  const dimension = player.dimension;
  if (nearbyCount(dimension, player.location) >= MAX_NEARBY) return;

  const angle = Math.random() * Math.PI * 2;
  const distance = MIN_DISTANCE + Math.random() * (SPAWN_RADIUS - MIN_DISTANCE);
  const x = Math.floor(player.location.x + Math.cos(angle) * distance);
  const z = Math.floor(player.location.z + Math.sin(angle) * distance);

  const surface = dimension.getTopmostBlock({ x, z });
  if (!surface) return;

  const type = Math.random() < 0.6 ? CREEPER : COPPER_GOLEM;
  const y = surface.location.y + 1;
  const below = dimension.getBlock(surface.location);
  if (!below || below.isAir || below.isLiquid) return;

  dimension.spawnEntity(type, { x: x + 0.5, y, z: z + 0.5 });
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
export const POPULATION = [CREEPER, COPPER_GOLEM, VILLAGER];
