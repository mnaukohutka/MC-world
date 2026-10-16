import { system, world } from "@minecraft/server";

/*
 * Structure generator pro copper dimenzi.
 */

const STRUCTURE_INTERVAL = 12000;
const COPPER_DIMENSION = "pa:copper_dimension";

const VANILLA_STRUCTURES = [
  ["minecraft:village_plains", 0.25, 100],
  ["minecraft:village_desert", 0.15, 150],
  ["minecraft:village_snowy", 0.1, 200],
  ["minecraft:village_taiga", 0.1, 200],
  ["minecraft:ancient_city", 0.06, 300],
  ["minecraft:trial_chambers", 0.08, 250],
  ["minecraft:pillager_outpost", 0.1, 180],
  ["minecraft:ruined_portal", 0.12, 50],
  ["minecraft:stronghold", 0.04, 400],
];

const SPECIAL_STRUCTURES = [
  ["copper_temple", 0.08, 250],
  ["copper_fontana", 0.05, 200],
  ["copper_lucerna-p", 0.06, 150],
  ["copper_lucerna-A", 0.06, 150],
  ["copper_lucerna-A1", 0.06, 150],
  ["copper_lucerna-P1", 0.06, 150],
];

function tryPlaceStructure(dim, structureId, x, y, z) {
  try {
    dim.runCommand(`structure load "${structureId}" ${x} ${y} ${z}`);
    return true;
  } catch (e) {
    return false;
  }
}

function findSurface(dim, x, z) {
  for (let y = 320; y > -64; y--) {
    const block = dim.getBlock({ x, y, z });
    if (block && !block.isAir) return y;
  }
  return -64;
}

let dimCache = null;
let dimErrorCount = 0;

system.runInterval(() => {
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

    const { x, z } = player.location;

    for (const [id, chance, minDist] of VANILLA_STRUCTURES) {
      if (Math.random() > chance) continue;
      const angle = Math.random() * Math.PI * 2;
      const dist = minDist + Math.random() * 64;
      const sx = Math.floor(x + Math.cos(angle) * dist);
      const sz = Math.floor(z + Math.sin(angle) * dist);
      const sy = findSurface(dim, sx, sz);
      if (sy > -64) tryPlaceStructure(dim, id, sx, sy + 1, sz);
    }

    for (const [id, chance, minDist] of SPECIAL_STRUCTURES) {
      if (Math.random() > chance) continue;
      const angle = Math.random() * Math.PI * 2;
      const dist = minDist + Math.random() * 64;
      const sx = Math.floor(x + Math.cos(angle) * dist);
      const sz = Math.floor(z + Math.sin(angle) * dist);
      const sy = findSurface(dim, sx, sz);
      if (sy > -64) tryPlaceStructure(dim, id, sx, sy + 1, sz);
    }
  }
}, STRUCTURE_INTERVAL);

console.log("[copper-1] Structure generator loaded");
