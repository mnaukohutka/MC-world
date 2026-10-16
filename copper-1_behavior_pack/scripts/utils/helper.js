import { system, ItemStack, Direction, GameMode, BlockPermutation, EquipmentSlot } from '@minecraft/server';
import { directionToVector3 } from './math';

/**
 * Subscribes to an event signal without assuming it exists.
 *
 * Signals differ between game versions and between stable and beta script
 * APIs, so a signal this world was not given would otherwise throw
 * "cannot read property 'subscribe' of undefined" and take the whole script
 * module down with it. Missing signals are reported once and skipped.
 *
 * @param {object} signal Event signal, or undefined when the game does not expose it.
 * @param {(event: any) => void} callback Handler invoked for each raised event.
 * @param {string} name Signal name, used for the diagnostic message.
 */
export function safeSubscribe(signal, callback, name) {
  if (!signal || typeof signal.subscribe !== 'function') {
    console.warn(`[copper] event signal "${name}" is not available on this game version; skipping.`);
    return undefined;
  }
  return signal.subscribe((event) => {
    try {
      callback(event);
    } catch (error) {
      console.warn(`[copper] handler for "${name}" failed: ${error}`);
    }
  });
}

export function randomFunction(funcList) {
    const index = Math.floor(Math.random() * funcList.length);
    return funcList[index];
}

export function randomFromRange([min, max]) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function decrementStack(player) {
    if (player.getGameMode() == 'creative') return;
    let item = player.getComponent('inventory').container.getItem(player.selectedSlotIndex);
    let inventory = player.getComponent('inventory').container;
    if (item.amount == 1)
        inventory.setItem(player.selectedSlotIndex, undefined);
    else
        inventory.setItem(player.selectedSlotIndex, new ItemStack(item.typeId, item.amount - 1));
}

export function updateLiquidBlock(dimension, location) {
    dimension.setBlockType(location, 'minecraft:bedrock');
    dimension.setBlockType(location, 'minecraft:air');
}

export function updateIfAir(dimension, block, blockLocation) {
    if (block.typeId == 'minecraft:air') updateLiquidBlock(dimension, blockLocation);
}

export const DirectionType = {
    HORIZONTAL: [
        Direction.North,
        Direction.South,
        Direction.West,
        Direction.East
    ]
};

export function getOppositeDirection(direction) {
    switch (direction) {
        case Direction.Up:
            return Direction.Down;
        case Direction.Down:
            return Direction.Up;
        case Direction.North:
            return Direction.South;
        case Direction.East:
            return Direction.West;
        case Direction.South:
            return Direction.North;
        case Direction.West:
            return Direction.East;
        default:
            break;
    }
}

export function doesBlockBlockMovement(block) {
    return (block.typeId != 'minecraft:cobweb' &&
        block.typeId != 'minecraft:bamboo_sapling' &&
        !block.isLiquid &&
        !block.isAir);
}

export const cardinalSides = Object.freeze({
    north: { left: 'east', right: 'west', },
    south: { left: 'west', right: 'east', },
    west: { left: 'north', right: 'south', },
    east: { left: 'south', right: 'north', }
});

/// Whether a fence or wall should join onto [block], which sits [towards] of it.
///
/// Vanilla's rule is about shape, not identity: a fence joins a neighbour that
/// fills its side of the cube, plus the things that join each other — fences,
/// walls, panes, bars and a gate turned the right way. Everything partial is
/// left alone: a single slab, a layer block short of its last layer, and every
/// plant, torch, rail and carpet.
///
/// Asked of the block's own states rather than its name. The list of names this
/// used to match on could only ever describe vanilla, so a custom block was
/// judged by whatever its creator happened to call it — a block named
/// `pa:grass_roof` was treated as grass — while a custom slab, which is exactly
/// the case that matters, was not covered at all.
export function shouldConnect(block, towards) {
    if (!block || !block.isValid) return false;
    if (block.isAir || block.isLiquid) return false;

    let states = {};
    try {
        states = block.permutation.getAllStates();
    } catch (error) {
        states = {};
    }

    // A MAM slab fills its cube only once it has been doubled.
    if (states['pa:is_double'] !== undefined) return states['pa:is_double'] === true;

    // A MAM layer block fills it only on the last of its eight layers.
    if (states['layer:states'] !== undefined) return states['layer:states'] >= 7;

    // Vanilla slabs: the doubled form is a block id of its own, so a block that
    // still carries the half state and is not that id is a single slab.
    if (states['minecraft:vertical_half'] !== undefined && !block.typeId.includes('double_')) return false;

    // Vanilla snow and the other height-stacked blocks.
    if (typeof states['height'] === 'number') return states['height'] >= 7;

    const id = block.typeId;

    // A gate joins the run only when it is turned across it — otherwise the
    // fence would meet the side the player walks through.
    if (isFenceGate(block, states)) return gateFacesAcross(states, towards);

    // The blocks that join each other regardless of shape.
    if (id.includes('fence') || id.includes('wall') || id.includes('pane') || id.includes('iron_bars')) return true;

    // Everything else has to fill its side of the cube. This is what rules out
    // plants, grass, torches, rails and carpets without naming any of them.
    return block.isSolid;
}

/// Bedrock's numeric facing, in the order the state's values are declared.
const CARDINAL_BY_INDEX = Object.freeze(['south', 'west', 'north', 'east']);

function isFenceGate(block, states) {
    if (block.typeId.includes('fence_gate')) return true;
    // A MAM gate is named by its creator, so it is known by what it carries: the
    // open state plus a facing, and no connection states of its own.
    return states['pa:open'] !== undefined && states['minecraft:cardinal_direction'] !== undefined;
}

function gateFacing(states) {
    const cardinal = states['minecraft:cardinal_direction'];
    if (typeof cardinal === 'string') return cardinal;

    const direction = states['direction'];
    if (typeof direction === 'number') return CARDINAL_BY_INDEX[direction];

    return undefined;
}

/// The axis a horizontal direction runs along. North and south are the same
/// axis, so which of a pair is passed does not matter.
function directionAxis(direction) {
    const name = `${direction}`.toLowerCase();
    return name === 'north' || name === 'south' ? 'z' : 'x';
}

function gateFacesAcross(states, towards) {
    const facing = gateFacing(states);
    // Nothing to judge by — join it, which is what happened before this rule.
    if (!facing || !towards) return true;

    return directionAxis(facing) !== directionAxis(towards);
}

/// Re-evaluates the fences and walls around [changed] after it appeared or went.
///
/// A connecting block only ever updated itself, in its own `onPlace` and
/// `onPlayerBreak`. That covers placing a fence beside a fence, and nothing
/// else: Bedrock raises no neighbour-changed callback on a block, so putting
/// any *other* block against a standing fence left the fence unchanged and the
/// run visibly broken. The world events below fire for whatever was placed or
/// broken, which is the only vantage point that sees it.
///
/// Only blocks that carry the connection states are touched, so this is a
/// four-position read on an event a player triggers by hand.
export function refreshConnections(changed) {
    if (!changed || !changed.isValid) return;

    for (const direction of DirectionType.HORIZONTAL) {
        try {
            const neighbour = changed.offset(directionToVector3(direction));
            if (!neighbour || !neighbour.isValid) continue;

            // From the neighbour's side, the block that changed lies the other
            // way — that is the state it holds the connection in.
            const towards = getOppositeDirection(direction);
            const stateName = `pa:${`${towards}`.toLowerCase()}`;
            if (neighbour.permutation.getState(stateName) === undefined) continue;

            const connect = shouldConnect(changed, towards);
            if (neighbour.permutation.getState(stateName) === connect) continue;

            neighbour.setPermutation(neighbour.permutation.withState(stateName, connect));
        } catch (error) { }
    }
}

export function safeUpdateStairShape(targetBlock, newShapeState) {
  system.run(() => {
    const currentPerm = targetBlock.permutation;

    if (currentPerm.getState('pa:shape') !== undefined) {
      targetBlock.setPermutation(currentPerm.withState('pa:shape', newShapeState));
    }
  });
}

export function setupCustomBlockDrop(event, isOre = false, allowedTools, lootTablePath, xpRange, hasDropItem = false) {
  if (!hasDropItem) return;

  const player = event.entitySource;
  if (!player || player.typeId !== "minecraft:player") return;

  if (player.getGameMode() === GameMode.Creative) return;

  const { x, y, z } = event.block.location;
  const equippable = player.getComponent("minecraft:equippable");
  if (!equippable) return;

  const mainhandSlot = equippable.getEquipmentSlot("Mainhand");
  const item = mainhandSlot.hasItem() ? mainhandSlot.getItem() : undefined;

  if (!item && !isOre) {
    event.dimension.runCommand(`execute positioned ${x} ${y} ${z} run loot spawn ~~~ loot "${lootTablePath}"`);
    return;
  }

  if (isOre) {
    const itemTags = item ? item.getTags() : [];
    let hasValidTool = false;
    if (allowedTools.length > 0) hasValidTool = allowedTools.some(toolTag => itemTags.includes(toolTag));
    if (!hasValidTool) return;
  }

  const enchantable = item.getComponent("minecraft:enchantable");
  const hasSilkTouch = enchantable?.getEnchantment("silk_touch") !== undefined;
  const fortuneEnch = enchantable?.getEnchantment("fortune");
  const fortuneLevel = fortuneEnch ? fortuneEnch.level : 0;

  if (hasSilkTouch) return;

  let dropMultiplier = 1;
  if (fortuneLevel > 0 && isOre) {
    const roll = Math.random();
    if (fortuneLevel === 1 && roll < 0.33) {
      dropMultiplier = 2;
    } else if (fortuneLevel === 2) {
      if (roll < 0.25) dropMultiplier = 2;
      else if (roll < 0.50) dropMultiplier = 3;
    } else if (fortuneLevel >= 3) {
      if (roll < 0.20) dropMultiplier = 2;
      else if (roll < 0.40) dropMultiplier = 3;
      else if (roll < 0.60) dropMultiplier = 4;
    }
  }

  for (let i = 0; i < dropMultiplier; i++) {
    event.dimension.runCommand(`execute positioned ${x} ${y} ${z} run loot spawn ~~~ loot "${lootTablePath}"`);
  }

  if (xpRange.length === 0) return;
  const xpAmount = Math.floor(Math.random() * (xpRange[1] - xpRange[0] + 1)) + xpRange[0];
  for (let i = 0; i < xpAmount; i++) {
    event.dimension.runCommand(`summon xp_orb ${x + 0.5} ${y + 0.3} ${z + 0.5}`);
  }
}

/**
 * Turns a custom log into its stripped counterpart when a player right-clicks
 * it with an axe, keeping the pillar orientation.
 *
 * Bedrock has no `minecraft:strippable` component — vanilla stripping is
 * hardcoded — so the whole interaction lives here.
 *
 * @param {object} event `onPlayerInteract` payload.
 * @param {string} strippedBlockId Identifier of the block to become.
 */
export function stripLogWithAxe(event, strippedBlockId) {
  const { block, dimension, player } = event;
  if (!player) return;

  const equippable = player.getComponent('minecraft:equippable');
  if (!equippable) return;

  // getEquipmentSlot gives a stable slot reference; getItem below is a COPY.
  const slot = equippable.getEquipmentSlot(EquipmentSlot.Mainhand);
  const stack = slot.getItem();
  if (!stack || !stack.typeId.endsWith('_axe')) return;

  // Only the axis is carried over. Copying every state would throw the moment
  // the two blocks stopped declaring exactly the same set.
  const axis = block.permutation.getState('pa:pillar_axis') ?? 'y';
  block.setPermutation(BlockPermutation.resolve(strippedBlockId, { 'pa:pillar_axis': axis }));

  // Bedrock files the axe-strip audio under use.wood; item.axe.strip is Java.
  dimension.playSound(
    'use.wood',
    { x: block.location.x + 0.5, y: block.location.y + 0.5, z: block.location.z + 0.5 },
    { volume: 1.0, pitch: 0.8 },
  );

  if (player.getGameMode() === GameMode.Creative) return;

  const durability = stack.getComponent('minecraft:durability');
  if (!durability || durability.unbreakable) return;

  if (durability.damage + 1 >= durability.maxDurability) {
    slot.setItem(undefined);
    player.playSound('random.break');
  } else {
    durability.damage += 1;
    // getItem() handed back a copy, so the mutation only lands on write-back.
    slot.setItem(stack);
  }
}

/// Offset from a button towards the block holding it up, by the face it was
/// placed against. `minecraft:block_face` names the face of the *other* block,
/// so a button reading 'up' sits on top of its support.
export const BUTTON_SUPPORT_OFFSET = Object.freeze({
  up: { x: 0, y: -1, z: 0 },
  down: { x: 0, y: 1, z: 0 },
  north: { x: 0, y: 0, z: 1 },
  south: { x: 0, y: 0, z: -1 },
  west: { x: 1, y: 0, z: 0 },
  east: { x: -1, y: 0, z: 0 },
});

/**
 * Swaps a freshly placed button for the block id that matches the face it was
 * placed against.
 *
 * A button has to strongly power the block holding it up, or dust, pistons,
 * dispensers, droppers, note blocks, TNT, rails, comparators, repeaters and
 * observers sitting against that block never fire. Only
 * `minecraft:redstone_producer` emits that signal, and the engine reads its
 * `strongly_powered_face` from the root `components` object alone — permutations
 * cannot change it, so the face is baked one block id per placement face.
 *
 * The id players actually place is the north-facing one; this is what moves it
 * to the right variant. The variants carry no orient component, so the swap
 * happens exactly once.
 *
 * @param {object} event `onPlace` payload.
 * @param {Record<string, string>} variants Placement face -> block id.
 */
export function orientCustomButton(event, variants) {
  const { block } = event;
  if (!block || !block.isValid) return;

  const face = block.permutation.getState('minecraft:block_face') ?? 'north';
  const variantId = variants[face] ?? variants.north;
  if (!variantId || variantId === block.typeId) return; // already the right id

  // onPlace runs while the placement is still being resolved; defer the swap so
  // the write lands on a settled block.
  system.run(() => {
    if (!block.isValid) return;
    const permutation = resolveButtonVariant(variantId, face);
    if (permutation) block.setPermutation(permutation);
  });
}

/// Carrying `minecraft:block_face` over is what keeps the support lookup in
/// button_manager.js working. It is a trait-provided state, so fall back to the
/// bare permutation if a future version stops accepting it through resolve(),
/// and to leaving the block untouched if the variant is missing entirely.
function resolveButtonVariant(variantId, face) {
  try {
    return BlockPermutation.resolve(variantId, { 'minecraft:block_face': face, 'pa:pressed': false });
  } catch (_) {
    try {
      return BlockPermutation.resolve(variantId);
    } catch (_) {
      console.warn(
        `custom button: block "${variantId}" is not registered. New block ids only load when the world does — leave the world and re-enter instead of running /reload.`,
      );
      return undefined;
    }
  }
}

/**
 * Presses a custom button: sets `pa:pressed`, plays the click, and schedules the
 * release.
 *
 * The redstone signal itself is not touched here — the block JSON carries
 * `minecraft:redstone_producer` at `power: 0` and the `pa:pressed` permutation
 * raises it, so the engine powers and unpowers the neighbours as the state
 * flips.
 *
 * @param {object} event `onPlayerInteract` payload.
 * @param {number} releaseTicks Ticks the button stays down.
 * @param {string} pressSound Sound id played on the way down.
 * @param {string} releaseSound Sound id played on the way back up.
 */
export function pressCustomButton(event, releaseTicks, pressSound, releaseSound) {
  const { block, dimension } = event;
  if (!block || !block.isValid) return;

  // Already down: the pending release still owns this button, and re-pressing
  // would schedule a second one that pops it early.
  if (block.permutation.getState('pa:pressed')) return;

  const typeId = block.typeId;
  const location = { x: block.location.x, y: block.location.y, z: block.location.z };
  const center = { x: location.x + 0.5, y: location.y + 0.5, z: location.z + 0.5 };

  block.setPermutation(block.permutation.withState('pa:pressed', true));

  // Scheduled before the sound on purpose: playSound throws on a sound id the
  // pack does not define, and anything thrown here would leave the button stuck
  // down with its signal on forever.
  system.runTimeout(() => {
    // Re-read through the dimension: the captured block handle goes stale if the
    // chunk unloads, and the player may have mined the button in the meantime.
    const current = dimension.getBlock(location);
    if (!current || !current.isValid || current.typeId !== typeId) return;
    if (!current.permutation.getState('pa:pressed')) return;

    current.setPermutation(current.permutation.withState('pa:pressed', false));
    playSoundSafely(dimension, releaseSound, center, 0.5);
  }, releaseTicks);

  playSoundSafely(dimension, pressSound, center, 0.6);
}

function playSoundSafely(dimension, soundId, location, pitch) {
  if (!soundId) return;
  try {
    dimension.playSound(soundId, location, { pitch, volume: 0.8 });
  } catch (_) {
    // An unknown sound id must never break the block it belongs to.
  }
}
