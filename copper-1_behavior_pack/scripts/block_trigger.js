import { system, world } from '@minecraft/server';
import { setupCustomBlockDrop, decrementStack, getOppositeDirection, DirectionType, cardinalSides, randomFunction, shouldConnect, safeUpdateStairShape, stripLogWithAxe, pressCustomButton, orientCustomButton, safeSubscribe } from './utils/helper';
import { directionToVector3 } from './utils/math';
import { tickFluid } from './copper_fluid';

/* Block custom components: the fluid tick, the portal step effect, and the
 * copper sapling, which grows into the dimension-exclusive copper tree. */
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
    /*
     * Growth rides the block's `minecraft:tick` component. `minecraft:random_ticking`
     * - and with it `onRandomTick` - is gone from the block format, so the modern
     * `onTick` hook is what keeps the sapling growing. It rolls on every tick the
     * block is scheduled for, so growth is not guaranteed on the first tick.
     */
    onTick: e => {
      if (Math.random() > 0.2) return;
      growSapling(e.block, e.dimension);
    },
    onPlayerInteract: e => {
    const { block, dimension, player } = e;
    if (!player) return;

    const equippable = player.getComponent("minecraft:equippable");
    if (!equippable) return;

    const mainhand = equippable.getEquipmentSlot("Mainhand");
    if (!mainhand.hasItem() || mainhand.typeId !== "minecraft:bone_meal") return;

    if (mainhand.amount > 1) mainhand.amount--;
    else mainhand.setItem(undefined);

    growSapling(block, dimension);
    const effectLocation = block.center();
    dimension.playSound("item.bone_meal.use", effectLocation);
    dimension.spawnParticle("minecraft:crop_growth_emitter", effectLocation);
  },
});

/** Grows a copper tree from a sapling, feature first, script build as fallback. */
function growSapling(block, dimension) {
  const at = { ...block.location };
  at.x = Math.floor(at.x);
  at.y = Math.floor(at.y);
  at.z = Math.floor(at.z);

  /*
   * The worldgen feature is tried first so its rules win when they can, but a
   * script-registered dimension has no biome for the feature to match and the
   * placement is refused, which is why saplings never grew. A hand-built tree
   * guarantees growth either way.
   */
  try {
    if (dimension.placeFeature("pa:tree_copper", at, false)) {
      block.setType("minecraft:air");
      return;
    }
  } catch (error) {
    // Refused for any reason; fall through to the script build.
  }

  buildCopperTree(dimension, at);
}

/*
 * A trunk of 5-7 logs with a small canopy and an occasional hanging lantern,
 * mirroring the pack's `pa:tree_copper` feature closely enough that the two are
 * hard to tell apart. Only air is overwritten, so an existing build is never
 * damaged, and a low roof above the sapling refuses the growth rather than
 * cutting the canopy in half.
 */
const TREE_LOG = "pa:copper_wood";
const TREE_LEAF = "pa:copper_leaves";
const TREE_CHAIN = "minecraft:copper_chain";
const TREE_LANTERN = "minecraft:copper_lantern";

function cellAt(dimension, x, y, z) {
  try {
    return dimension.getBlock({ x, y, z });
  } catch (error) {
    return undefined;
  }
}

function buildCopperTree(dimension, at) {
  const trunk = 5 + Math.floor(Math.random() * 3);

  for (let i = 0; i <= trunk; i++) {
    const cell = cellAt(dimension, at.x, at.y + i, at.z);
    if (!cell) return;
    if (!(cell.isAir || cell.typeId === TREE_LEAF || cell.typeId === "pa:custom_sapling_copper")) return;
  }

  for (let i = 0; i < trunk; i++) {
    cellAt(dimension, at.x, at.y + i, at.z)?.setType(TREE_LOG);
  }

  const canopy = at.y + trunk;
  for (let dy = -2; dy <= 1; dy++) {
    const radius = dy <= -1 ? 2 : 1;
    for (let ox = -radius; ox <= radius; ox++) {
      for (let oz = -radius; oz <= radius; oz++) {
        if (ox === 0 && oz === 0 && dy <= 0) continue;
        const cell = cellAt(dimension, at.x + ox, canopy + dy, at.z + oz);
        if (cell && cell.isAir) cell.setType(TREE_LEAF);
      }
    }
  }
  cellAt(dimension, at.x, canopy + 1, at.z)?.setType(TREE_LEAF);

  if (Math.random() >= 0.2) return;
  const [ox, oz] = [[2, 0], [-2, 0], [0, 2], [0, -2]][Math.floor(Math.random() * 4)];
  const links = Math.random() < 0.5 ? 1 : 2;
  for (let i = 0; i < links; i++) {
    const cell = cellAt(dimension, at.x + ox, canopy - 1 - i, at.z + oz);
    if (!cell || !cell.isAir) return;
    cell.setType(TREE_CHAIN);
  }
  const socket = cellAt(dimension, at.x + ox, canopy - 1 - links, at.z + oz);
  if (socket && socket.isAir) socket.setType(TREE_LANTERN);
}

}, 'system.beforeEvents.startup');
