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
 * The builds are the pack's own `.mcstructure` files under `structures/`, which
 * the game exposes as `mystructure:<name>`.
 */

const REGION = 8;            // tiles per region; a region gets one build
const VILLAGE_CHANCE = 0.18;
const SPECIAL_CHANCE = 0.22;
const CHEST_CHANCE = 0.05;

/* The dimension floor/ceiling, used to reject builds that would leave them. */
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 320;
const BUILD_CLEARANCE = 40;

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

/** A temple is the closest thing the pack ships to a village centre. */
const VILLAGE_BUILD = "copper_temple";

const SALT_CHEST = 0x9e37;
const SALT_LOOT = 0x4d2a;

const done = new Set();
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

function placeChest(dimension, x, y, z) {
  try {
    dimension.getBlock({ x, y, z })?.setType("minecraft:copper_chest");
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
      fillChest(dimension, x, y, z, Math.floor(random(x, z, 0x41) * 1000));
    } catch {
      // The chunk unloaded again before the fill; leave the chest as it is.
    }
  });
}

function populate(dimension, tileX, tileZ) {
  const regionX = Math.floor(tileX / REGION);
  const regionZ = Math.floor(tileZ / REGION);
  const anchorX = regionX * REGION * 16 + 8;
  const anchorZ = regionZ * REGION * 16 + 8;

  /*
   * A region's build belongs at its anchor, but an anchor usually sits in a
   * tile other than the one currently generating — and `getTopmostBlock` over a
   * column that is not loaded reports the build ceiling, which is what made
   * `StructureManager.place` fail with "Invalid structure bounds". So the build
   * is only attempted from the tile that actually contains the anchor, where the
   * ground is loaded by the time this runs. That fires exactly once per region.
   */
  if (tileX === regionX * REGION && tileZ === regionZ * REGION) {
    const roll = random(regionX, regionZ, 0x11);
    const y = groundY(dimension, anchorX, anchorZ);
    if (y !== undefined) {
      if (roll < VILLAGE_CHANCE) {
        placeBuild(dimension, VILLAGE_BUILD, anchorX, y, anchorZ);
      } else if (roll < VILLAGE_CHANCE + SPECIAL_CHANCE) {
        placeBuild(dimension, pick(BUILDS, regionX, regionZ, 0x31), anchorX, y, anchorZ);
      }
    }
  }

  if (random(tileX, tileZ, SALT_CHEST) < CHEST_CHANCE) {
    const x = tileX * 16 + Math.floor(random(tileX, tileZ, 0x41) * 16);
    const z = tileZ * 16 + Math.floor(random(tileX, tileZ, 0x42) * 16);
    const y = groundY(dimension, x, z);
    if (y !== undefined) placeChest(dimension, x, y, z);
  }
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
