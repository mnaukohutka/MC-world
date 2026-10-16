import { system, world } from '@minecraft/server';
import { setupCustomBlockDrop, decrementStack, getOppositeDirection, DirectionType, cardinalSides, randomFunction, shouldConnect, safeUpdateStairShape, stripLogWithAxe, pressCustomButton, orientCustomButton, safeSubscribe } from './utils/helper';
import { directionToVector3 } from './utils/math';

safeSubscribe(system.beforeEvents.startup, initEvent => {
  initEvent.blockComponentRegistry.registerCustomComponent('pa_copper_portal:trigger', {
  onBreak: e => { const { x, y, z } = e.block.location;
const toolTags = [];
    const xpRange = [];

    setupCustomBlockDrop(e, false, toolTags, "blocks/pa_copper_portal", xpRange, true); },
onStepOn: e => { e.entity.addEffect("minecraft:levitation", 300.0, { amplifier: 1 }); },
});

initEvent.blockComponentRegistry.registerCustomComponent('pa_fluid_copper_oxidized:trigger', {
  onStepOn: e => { e.entity.addEffect("minecraft:night_vision", 3000.0, { amplifier: 1 }); },
  onStepOff: e => { e.entity.addEffect("minecraft:hunger", 1400.0, { amplifier: 1 }); },
});

initEvent.blockComponentRegistry.registerCustomComponent('pa_fluid_copper:trigger', {
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
