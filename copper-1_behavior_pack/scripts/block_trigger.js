import { system, world } from '@minecraft/server';
import { setupCustomBlockDrop, decrementStack, getOppositeDirection, DirectionType, cardinalSides, randomFunction, shouldConnect, safeUpdateStairShape, stripLogWithAxe, pressCustomButton, orientCustomButton, safeSubscribe } from './utils/helper';
import { directionToVector3 } from './utils/math';

/*
 * Copper fluid flow.
 *
 * The fluid blocks used to drive themselves with `minecraft:queued_ticking`
 * and a `run_command` block event. Bedrock renamed that component to
 * `minecraft:tick` in 1.21.10 (dropping its `on_tick` trigger) and removed
 * block `events` entirely in 1.20.80, which left the fluids inert. The JSON now
 * only schedules ticks; the movement itself happens here, in the `onTick` hook
 * of the block's custom component.
 *
 * Rules, mirroring water's behaviour: a block drops straight down when the cell
 * below is open, otherwise it spreads sideways one strength weaker. Sources
 * never run dry; flowing cells disappear again once nothing feeds them.
 */
const FLUID_TYPES = new Set(['pa:fluid_copper', 'pa:fluid_copper_oxidized']);
const MAX_FLUID_DEPTH = 5;

function fluidAt(dimension, x, y, z) {
  try {
    return dimension.getBlock({ x, y, z });
  } catch {
    return undefined;
  }
}

function setFluid(block, typeId, isSource, depth) {
  block.setPermutation(
    BlockPermutation.resolve(typeId)
      .withState('block:source', isSource)
      .withState('block:depth', depth)
  );
}

function isFed(block, dimension, typeId, depth) {
  const above = fluidAt(dimension, block.x, block.y + 1, block.z);
  if (above && above.typeId === typeId) return true;

  for (const offset of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const side = fluidAt(dimension, block.x + offset[0], block.y, block.z + offset[1]);
    if (!side || side.typeId !== typeId) continue;
    if (side.permutation.getState('block:source') === true) return true;
    if (side.permutation.getState('block:depth') > depth) return true;
  }
  return false;
}

function spreadFluid(block, dimension, typeId, nextDepth) {
  if (nextDepth < 1) return;
  for (const offset of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const side = fluidAt(dimension, block.x + offset[0], block.y, block.z + offset[1]);
    if (side && side.isAir) setFluid(side, typeId, false, nextDepth);
  }
}

function flowFluid(block, dimension) {
  const typeId = block.typeId;
  if (!FLUID_TYPES.has(typeId)) return;

  const isSource = block.permutation.getState('block:source') === true;
  const depth = block.permutation.getState('block:depth');

  const below = fluidAt(dimension, block.x, block.y - 1, block.z);
  if (below && below.isAir) {
    // Falling fluid keeps a full column and does not also creep sideways.
    setFluid(below, typeId, false, MAX_FLUID_DEPTH);
    return;
  }

  if (isSource) {
    spreadFluid(block, dimension, typeId, MAX_FLUID_DEPTH);
    return;
  }

  spreadFluid(block, dimension, typeId, depth - 1);

  if (!isFed(block, dimension, typeId, depth)) {
    block.setType('minecraft:air');
  }
}

function tickFluid(event) {
  try {
    flowFluid(event.block, event.dimension);
  } catch (error) {
    console.warn(`[copper] fluid tick failed: ${error}`);
  }
}

safeSubscribe(system.beforeEvents.startup, initEvent => {
  initEvent.blockComponentRegistry.registerCustomComponent('pa_copper_portal:trigger', {
  onBreak: e => { const { x, y, z } = e.block.location;
const toolTags = [];
    const xpRange = [];

    setupCustomBlockDrop(e, false, toolTags, "blocks/pa_copper_portal", xpRange, true); },
onStepOn: e => { e.entity.addEffect("minecraft:levitation", 300.0, { amplifier: 1 }); },
});

initEvent.blockComponentRegistry.registerCustomComponent('pa_fluid_copper_oxidized:trigger', {
  onTick: tickFluid,
  onStepOn: e => { e.entity.addEffect("minecraft:night_vision", 3000.0, { amplifier: 1 }); },
  onStepOff: e => { e.entity.addEffect("minecraft:hunger", 1400.0, { amplifier: 1 }); },
});

initEvent.blockComponentRegistry.registerCustomComponent('pa_fluid_copper:trigger', {
  onTick: tickFluid,
  onStepOn: e => { e.entity.addEffect("minecraft:night_vision", 3000.0, { amplifier: 1 }); },
onStepOff: e => { e.entity.addEffect("minecraft:hunger", 1400.0, { amplifier: 1 }); },
});

initEvent.blockComponentRegistry.registerCustomComponent('pa_custom_sapling_copper:trigger', {
  onPlayerInteract: e => { const { x, y, z } = e.block.location;
const { block, dimension, player } = e;

if (!player) return;

const equippable = player.getComponent("minecraft:equippable");
if (!equippable) return;

const mainhand = equippable.getEquipmentSlot("Mainhand");
if (!mainhand.hasItem() || mainhand.typeId !== "minecraft:bone_meal")
    return;

if (mainhand.amount > 1) mainhand.amount--;
else mainhand.setItem(undefined);

block.setType('minecraft:air');
dimension.placeFeature("pa:tree_copper", block.location);

const effectLocation = block.center();
dimension.playSound("item.bone_meal.use", effectLocation);
dimension.spawnParticle(
    "minecraft:crop_growth_emitter",
    effectLocation
);
 },
onRandomTick: e => { const { x, y, z } = e.block.location;
const { block, dimension } = e;

block.setType('minecraft:air');
dimension.placeFeature("pa:tree_copper", block.location);
 },
});

}, 'system.beforeEvents.startup');
