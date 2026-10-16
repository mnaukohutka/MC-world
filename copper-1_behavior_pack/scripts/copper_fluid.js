import { system, world, BlockPermutation, ItemStack, EquipmentSlot, GameMode } from "@minecraft/server";
import { safeSubscribe } from "./utils/helper";

/*
 * Copper fluid.
 *
 * Two custom liquids, `pa:fluid_copper` and `pa:fluid_copper_oxidized`, behave
 * like water: a source cell keeps a full column, a flowing cell spreads one
 * strength weaker and dries up once nothing feeds it. Block JSON cannot drive
 * that any more — `minecraft:queued_ticking` was renamed to `minecraft:tick` and
 * its `on_tick` trigger removed in 1.21.10, and block `events` were removed in
 * 1.20.80 — so the JSON only schedules ticks and the movement happens here in
 * the `onTick` hook.
 *
 * Buckets: filling works through `itemUseOn` (a vanilla bucket on a fluid cell),
 * emptying through the item's `minecraft:block_placer`. The special-liquid
 * effect on players is deliberately left to the block's own `onStepOn` hooks.
 */

const MAX_DEPTH = 5;
const SOURCE_BUCKETS = {
  "pa:fluid_copper": "pa:fluid_copper_bucket",
  "pa:fluid_copper_oxidized": "pa:fluid_copper_oxidized_bucket",
};
const PLAIN_BUCKET = "minecraft:bucket";
const FLUID_TYPES = new Set(Object.keys(SOURCE_BUCKETS));
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function blockAt(dimension, x, y, z) {
  try {
    return dimension.getBlock({ x, y, z });
  } catch {
    return undefined;
  }
}

function isFluid(block) {
  return block !== undefined && FLUID_TYPES.has(block.typeId);
}

function setFluid(block, typeId, isSource, depth) {
  block.setPermutation(
    BlockPermutation.resolve(typeId)
      .withState("block:source", isSource)
      .withState("block:depth", depth)
  );
}

/** True when a neighbouring source, or a stronger neighbour, feeds this cell. */
function isFed(block, dimension, typeId, depth) {
  const above = blockAt(dimension, block.x, block.y + 1, block.z);
  if (isFluid(above) && above.typeId === typeId) return true;

  for (const [ox, oz] of SIDES) {
    const side = blockAt(dimension, block.x + ox, block.y, block.z + oz);
    if (!isFluid(side) || side.typeId !== typeId) continue;
    if (side.permutation.getState("block:source") === true) return true;
    if (side.permutation.getState("block:depth") > depth) return true;
  }
  return false;
}

function spreadSideways(block, dimension, typeId, nextDepth) {
  if (nextDepth < 1) return;
  for (const [ox, oz] of SIDES) {
    const side = blockAt(dimension, block.x + ox, block.y, block.z + oz);
    if (side && side.isAir) setFluid(side, typeId, false, nextDepth);
  }
}

function flow(block, dimension) {
  const typeId = block.typeId;
  if (!FLUID_TYPES.has(typeId)) return;

  const isSource = block.permutation.getState("block:source") === true;
  let depth = block.permutation.getState("block:depth");

  if (isSource && depth !== MAX_DEPTH) {
    depth = MAX_DEPTH;
    setFluid(block, typeId, true, depth);
  }

  const below = blockAt(dimension, block.x, block.y - 1, block.z);
  if (below && below.isAir) {
    // Falling liquid keeps a full column and does not also creep sideways.
    setFluid(below, typeId, false, MAX_DEPTH);
    if (!isSource && !isFed(block, dimension, typeId, depth)) block.setType("minecraft:air");
    return;
  }

  spreadSideways(block, dimension, typeId, isSource ? MAX_DEPTH : depth - 1);

  if (!isSource && !isFed(block, dimension, typeId, depth)) {
    block.setType("minecraft:air");
  }
}

export function tickFluid(event) {
  try {
    flow(event.block, event.dimension);
  } catch (error) {
    console.warn(`[copper] fluid tick failed: ${error}`);
  }
}

/** Replaces one held item with another, respecting creative mode. */
function swapHeldItem(player, fromTypeId, toTypeId) {
  if (player.getGameMode() === GameMode.creative) {
    const equip = player.getComponent("minecraft:equippable");
    equip?.setEquipment(EquipmentSlot.Mainhand, new ItemStack(toTypeId, 1));
    return true;
  }

  const equip = player.getComponent("minecraft:equippable");
  const slot = equip?.getEquipmentSlot(EquipmentSlot.Mainhand);
  if (!slot || slot.typeId !== fromTypeId) return false;

  if (slot.amount > 1) slot.amount -= 1;
  else slot.setItem(undefined);

  const container = player.getComponent("minecraft:inventory")?.container;
  if (!container) return false;
  if (container.emptySlotsCount === 0) return false;
  container.addItem(new ItemStack(toTypeId, 1));
  return true;
}

/** Scooping a fluid cell up with an empty bucket. */
function tryFillBucket(event) {
  const player = event.player;
  if (!player) return;
  if (event.itemStack?.typeId !== PLAIN_BUCKET) return;

  const block = event.block;
  if (!isFluid(block)) return;
  const bucket = SOURCE_BUCKETS[block.typeId];
  const dimension = block.dimension;

  system.run(() => {
    if (!player.isValid) return;
    if (!swapHeldItem(player, PLAIN_BUCKET, bucket)) return;
    try {
      block.setType("minecraft:air");
      dimension.playSound("bucket.fill_water", block.location);
    } catch {
      // Chunk unloaded between the event and the deferred run; the block stays.
    }
  });
}

safeSubscribe(world.afterEvents.playerInteractWithBlock, tryFillBucket, "world.afterEvents.playerInteractWithBlock");

/** Force a freshly placed source cell to a full column on its next tick. */
safeSubscribe(world.afterEvents.playerPlaceBlock, (event) => {
  const block = event.block;
  if (!isFluid(block)) return;
  const typeId = block.typeId;
  system.run(() => {
    try {
      if (isFluid(block) && block.typeId === typeId) setFluid(block, typeId, true, MAX_DEPTH);
    } catch {
      // Block gone already.
    }
  });
}, "world.afterEvents.playerPlaceBlock");
