import { world, system } from "@minecraft/server";

/*
 * Mob population for the Copper Dimension.
 *
 * `spawn_rules/*.json` cannot help here: they match on a biome tag, and a
 * script-registered dimension has no custom biome to carry one, so nothing the
 * pack ships spawns by itself. This module is the replacement — a short roll
 * around each player, biased to the pack's own mobs.
 *
 * The copper workers arrive by their own element, and each is placed where its
 * body can actually live, so none of them suffocates or drowns on arrival:
 *
 *   dry land      keeper, shade (walkers)
 *   open air      bee, bat (flyers), wisp (hoverer)
 *   copper fluid  minnow (swimmer), fish in the deep, crab at the shore
 *   under ground  mole, mite (burrowers)
 *
 * Walking and flying mobs are placed as small herds rather than one at a time,
 * so the world reads as populated but the per-roll cost stays the same.
 */

const COPPER_DIMENSION = "pa:copper_dimension";

const BEE = "pa:copper_bee";
const FISH = "pa:copper_fish";
const MOLE = "pa:copper_mole";
const KEEPER = "pa:copper_keeper";
const MINNOW = "pa:copper_minnow";
const CRAB = "pa:copper_crab";
const SHADE = "pa:copper_shade";
const BAT = "pa:copper_bat";
const MITE = "pa:copper_mite";
const WISP = "pa:copper_wisp";

/* Round-7 residents: a second miner, two walkers and a drifter, so each class
 * of mob has company and the dimension reads as a population rather than a
 * handful of regulars. */
const BORER = "pa:copper_borer";
const GUARD = "pa:copper_guard";
const BOAR = "pa:copper_boar";
const JELLY = "pa:copper_jelly";
const VILLAGER = "pa:copper_villager";
const GHOST = "pa:copper_ghost";

/* The dimension stays mostly peaceful; the golem is the old pack resident and
 * a rare creeper keeps the caves from being entirely safe. */
const COPPER_GOLEM = "minecraft:copper_golem";
const CREEPER = "minecraft:creeper";

const SPAWN_RADIUS = 32;
const MIN_DISTANCE = 14;
const MAX_NEARBY = 24;
const MIN_UNDERGROUND_Y = -56;

/** The pack's own fluid, in both oxidation stages. */
const COPPER_FLUID = new Set(["pa:fluid_copper", "pa:fluid_copper_oxidized"]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);
const ANY_FLUID = new Set([...COPPER_FLUID, ...WATER]);

const SOFT_GROUND = new Set([
  "pa:copper_stone",
  "pa:copper_soil",
  "pa:copper_grass",
  "pa:weathered_copper_stone",
  "pa:oxidized_copper_stone",
  "minecraft:stone",
  "minecraft:deepslate",
]);

/** Mobs that cannot stand on the surface and must be placed in open air. */
const FLYERS = new Set([BEE, BAT, WISP]);

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

  // A fluid column is read first: everything below the surface is that fluid,
  // which is where the swimmers and the shore crab belong.
  if (ANY_FLUID.has(ground.typeId)) {
    if (COPPER_FLUID.has(ground.typeId)) spawnSchool(dimension, x, surface.location.y, z, MINNOW);
    else spawnSchool(dimension, x, surface.location.y, z, FISH);
    if (Math.random() < 0.32) spawnSchool(dimension, x, surface.location.y, z, JELLY);
    if (Math.random() < 0.35) spawnShore(dimension, x, surface.location.y, z);
    return;
  }

  /*
   * A player deep underground gets the cave population instead of the surface
   * one. This is what makes the caves feel inhabited: the burrowers and the
   * fungus-laden bat belong to the rock, and dropping them at the top of the
   * column would leave them on the grass instead.
   */
  if (player.location.y < surface.location.y - 6) {
    spawnUnderground(dimension, player, x, z, surface.location.y);
    return;
  }

  const roll = Math.random();
  if (roll < 0.16) {
    spawnHerd(dimension, x, surface.location.y, z, BEE, 3);
  } else if (roll < 0.28) {
    spawnHerd(dimension, x, surface.location.y, z, KEEPER, 2);
  } else if (roll < 0.36 && SOFT_GROUND.has(ground.typeId)) {
    spawnBurrower(dimension, x, surface.location.y, z, MOLE);
  } else if (roll < 0.44 && SOFT_GROUND.has(ground.typeId)) {
    spawnBurrower(dimension, x, surface.location.y, z, BORER);
  } else if (roll < 0.50 && SOFT_GROUND.has(ground.typeId)) {
    spawnBurrower(dimension, x, surface.location.y, z, MITE);
  } else if (roll < 0.58) {
    spawnHerd(dimension, x, surface.location.y, z, BAT, 2);
  } else if (roll < 0.66) {
    spawnHerd(dimension, x, surface.location.y, z, GUARD, 3);
  } else if (roll < 0.73) {
    spawnHerd(dimension, x, surface.location.y, z, BOAR, 3);
  } else if (roll < 0.79) {
    spawnHerd(dimension, x, surface.location.y, z, WISP, 2);
  } else if (roll < 0.84) {
    spawnHerd(dimension, x, surface.location.y, z, VILLAGER, 2);
  } else if (roll < 0.86) {
    // The happy ghost is a rare, warm surprise — rarer than anything else here.
    spawnEntity(dimension, GHOST, { x: x + 0.5, y: surface.location.y + 2, z: z + 0.5 });
  } else if (roll < 0.89) {
    // The shade is deliberately rarer than the keeper: light should mostly win.
    spawnHerd(dimension, x, surface.location.y, z, SHADE, 1);
  } else if (roll < 0.96) {
    spawnEntity(dimension, COPPER_GOLEM, { x: x + 0.5, y: surface.location.y + 1, z: z + 0.5 });
  } else {
    spawnEntity(dimension, CREEPER, { x: x + 0.5, y: surface.location.y + 1, z: z + 0.5 });
  }
}

/*
 * The cave population. A player's own depth is the reference, so a shaft is
 * populated with the burrowers that live in it rather than with surface animals
 * that happen to stand above it. The spawn cell is pulled to the player's own
 * level, in a small pocket of air, so arrivals are never placed inside rock.
 */
function spawnUnderground(dimension, player, x, z, surfaceY) {
  const y = Math.max(MIN_UNDERGROUND_Y, Math.min(surfaceY - 8, Math.floor(player.location.y)));
  const at = findAirPocket(dimension, { x: x + 0.5, y, z: z + 0.5 }, 4);
  if (!at) return;

  const roll = Math.random();
  if (roll < 0.26) {
    spawnHerd(dimension, at.x, at.y - 1, at.z, MOLE, 2);
  } else if (roll < 0.5) {
    spawnHerd(dimension, at.x, at.y - 1, at.z, BORER, 2);
  } else if (roll < 0.72) {
    spawnHerd(dimension, at.x, at.y - 1, at.z, MITE, 2);
  } else if (roll < 0.94) {
    // Bats hover a block or two above the cave floor, still inside the pocket.
    spawnCaveFlyers(dimension, at, BAT, 3);
  } else {
    // Caves are mostly safe, but not entirely.
    spawnEntity(dimension, CREEPER, at);
  }
}

/** Scatters flyers through the air cells directly above a cave anchor. */
function spawnCaveFlyers(dimension, at, typeId, count) {
  for (let i = 0; i < count; i++) {
    const spot = {
      x: at.x + (Math.random() - 0.5) * 3,
      y: at.y + (Math.random() < 0.5 ? 1 : 2),
      z: at.z + (Math.random() - 0.5) * 3,
    };
    if (isAirAt(dimension, spot) && isAirAt(dimension, { x: spot.x, y: spot.y + 1, z: spot.z })) {
      dimension.spawnEntity(typeId, spot);
    }
  }
}

/** The first air block within `radius` of `origin`, scanning up then outwards. */
function findAirPocket(dimension, origin, radius) {
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const at = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
          if (!isAirAt(dimension, at)) continue;
          // Require a solid floor and headroom, so nothing spawns mid-fall.
          const below = dimension.getBlock({ x: Math.floor(at.x), y: Math.floor(at.y) - 1, z: Math.floor(at.z) });
          if (below && !below.isAir && !below.isLiquid && isAirAt(dimension, { x: at.x, y: at.y + 1, z: at.z })) {
            return { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y), z: Math.floor(at.z) + 0.5 };
          }
        }
      }
    }
  }
  return undefined;
}

function spawnEntity(dimension, typeId, at) {
  if (!isAirAt(dimension, at)) return;
  dimension.spawnEntity(typeId, at);
}

/** A small cluster of a ground or flying mob, scattered a block or two apart. */
function spawnHerd(dimension, x, y, z, typeId, count) {
  for (let i = 0; i < count; i++) {
    const ox = Math.floor((Math.random() - 0.5) * 3);
    const oz = Math.floor((Math.random() - 0.5) * 3);
    const height = FLYERS.has(typeId) ? 3 : 1;
    const at = { x: x + ox + 0.5, y: y + height, z: z + oz + 0.5 };
    if (!isAirAt(dimension, at)) continue;
    dimension.spawnEntity(typeId, at);
  }
}

/** A shoal of up to four swimmers in the fluid column below the surface. */
function spawnSchool(dimension, x, y, z, typeId) {
  const count = 1 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    const ox = Math.floor((Math.random() - 0.5) * 4);
    const oz = Math.floor((Math.random() - 0.5) * 4);
    for (let dy = -1; dy > -8; dy--) {
      const at = { x: x + ox + 0.5, y: y + dy, z: z + oz + 0.5 };
      const block = dimension.getBlock({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) });
      if (!block || !ANY_FLUID.has(block.typeId)) break;
      dimension.spawnEntity(typeId, at);
      break;
    }
  }
}

/** A crab on the first solid block beside the fluid, if there is one. */
function spawnShore(dimension, x, y, z) {
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const at = { x: x + ox + 0.5, y, z: z + oz + 0.5 };
    const block = dimension.getBlock({ x: x + ox, y: Math.floor(y), z: z + oz });
    if (block && !block.isAir && !ANY_FLUID.has(block.typeId) && isAirAt(dimension, at)) {
      dimension.spawnEntity(CRAB, at);
      return;
    }
  }
}

function spawnBurrower(dimension, x, y, z, typeId) {
  // One block into the ground, which is where a mole or a mite belongs.
  const at = { x: x + 0.5, y, z: z + 0.5 };
  const block = dimension.getBlock({ x, y: Math.floor(y), z });
  if (!block || block.isAir) return;
  block.setType("minecraft:air");
  dimension.spawnEntity(typeId, at);
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
export const POPULATION = [
  BEE, FISH, MOLE, KEEPER, MINNOW, CRAB, SHADE, BAT, MITE, WISP,
  BORER, GUARD, BOAR, JELLY, VILLAGER, GHOST, COPPER_GOLEM, CREEPER,
];
