import { system, world } from "@minecraft/server";

/*
 * Fluid interactions pro copper dimenzi.
 * - fluid_copper + fluid_copper_oxidized = voda
 * - fluid_copper + lava = med (honey_block)
 * - fluid_copper_oxidized + lava = med
 */

const FLUID_COPPER = "pa:fluid_copper";
const FLUID_OXIDIZED = "pa:fluid_copper_oxidized";
const COPPER_DIMENSION = "pa:copper_dimension";
const WATER = "minecraft:water";
const LAVA = "minecraft:lava";
const HONEY = "minecraft:honey_block";

const CHECK_INTERVAL = 10;

function getBlock(dim, x, y, z) {
  try {
    return dim.getBlock({ x, y, z });
  } catch {
    return null;
  }
}

function checkFluidInteraction(dim, x, y, z) {
  const center = getBlock(dim, x, y, z);
  if (!center) return;

  const neighbors = [
    getBlock(dim, x + 1, y, z),
    getBlock(dim, x - 1, y, z),
    getBlock(dim, x, y, z + 1),
    getBlock(dim, x, y, z - 1),
    getBlock(dim, x, y + 1, z),
    getBlock(dim, x, y - 1, z),
  ].filter(Boolean);

  if (center.typeId === FLUID_COPPER) {
    for (const n of neighbors) {
      if (n.typeId === FLUID_OXIDIZED) {
        center.setType(WATER);
        n.setType(WATER);
        return;
      }
      if (n.typeId === LAVA) {
        center.setType(HONEY);
        n.setType(HONEY);
        return;
      }
    }
  }

  if (center.typeId === FLUID_OXIDIZED) {
    for (const n of neighbors) {
      if (n.typeId === FLUID_COPPER) {
        center.setType(WATER);
        n.setType(WATER);
        return;
      }
      if (n.typeId === LAVA) {
        center.setType(HONEY);
        n.setType(HONEY);
        return;
      }
    }
  }
}

let dimCache = null;
let dimErrorCount = 0;

system.runInterval(() => {
  // Získat dimenzi s cache a error handling
  if (!dimCache) {
    try {
      dimCache = world.getDimension(COPPER_DIMENSION);
      dimErrorCount = 0;
    } catch (e) {
      dimErrorCount++;
      if (dimErrorCount === 1) {
        console.warn("[copper-1] Dimension not available yet, retrying...");
      }
      return;
    }
  }

  const dim = dimCache;

  for (const player of world.getPlayers()) {
    if (player.dimension.id !== COPPER_DIMENSION) continue;

    const { x, y, z } = player.location;
    const range = 8;

    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        for (let dz = -range; dz <= range; dz++) {
          checkFluidInteraction(dim, Math.floor(x + dx), Math.floor(y + dy), Math.floor(z + dz));
        }
      }
    }
  }
}, CHECK_INTERVAL);

console.log("[copper-1] Fluid interactions loaded");
