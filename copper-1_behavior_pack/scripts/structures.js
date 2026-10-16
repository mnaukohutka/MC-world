import { world } from "@minecraft/server";

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

const done = new Set();
const planned = new Set();
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
  planned.clear();
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
    return top ? top.location.y + 1 : undefined;
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

function placeChest(dimension, x, y, z) {
  try {
    dimension.getBlock({ x, y, z })?.setType("minecraft:copper_chest");
  } catch {
    // Chunk left the loading window; the terrain pass rebuilds the tile later.
  }
}

function populate(dimension, tileX, tileZ) {
  const regionX = Math.floor(tileX / REGION);
  const regionZ = Math.floor(tileZ / REGION);
  const regionKey = key(regionX, regionZ);

  if (!planned.has(regionKey)) {
    planned.add(regionKey);
    const roll = random(regionX, regionZ, 0x11);
    const anchorX = regionX * REGION * 16 + 8;
    const anchorZ = regionZ * REGION * 16 + 8;
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
