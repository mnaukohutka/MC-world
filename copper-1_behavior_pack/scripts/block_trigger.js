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
   * Growth rides the block's `minecraft:random_ticking` component. The hook
   * itself was fine before; the block simply never had anything to raise a
   * random tick, so the sapling sat there forever.
   */
  onRandomTick: e => {
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

/** Replaces a sapling with the copper tree feature, if the feature can run. */
function growSapling(block, dimension) {
  const at = { ...block.location };
  try {
    dimension.placeFeature("pa:tree_copper", at, true);
  } catch (error) {
    // Growth onto an unsupported block throws; leave the sapling standing.
    return;
  }
  block.setType('minecraft:air');
}

}, 'system.beforeEvents.startup');
