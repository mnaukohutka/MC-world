import { world, system, GameMode } from "@minecraft/server";

/*
 * Swimming in the copper fluids.
 *
 * A custom block cannot carry the engine's water material, so the fluids are not
 * liquids as far as the physics is concerned: a player who steps into one falls
 * straight through and sinks. This module fakes the missing behaviour — while a
 * player is inside a fluid cell they get buoyancy, a slow sink, and head-above-
 * water control, which together read as swimming.
 *
 * The scan is driven from the slow player loop rather than from the fluid block's
 * own tick: a fluid cell that ticks cannot tell who is standing in it, and the
 * block tick fires for every cell of a large ocean.
 */

const FLUIDS = new Set(["pa:fluid_copper", "pa:fluid_copper_oxidized"]);
const COPPER_DIMENSION = "pa:copper_dimension";

/** Player eye height; the head cell is what decides "underwater". */
const EYE_HEIGHT = 1.6;

const SCAN_PERIOD = 4;

/** Buoyancy applied while a player's feet are in a fluid and no jump is held. */
const BUOYANCY = 0.055;
/** Downward drift so a player still sinks slowly instead of hovering. */
const SINK = 0.02;
/** Steer adjust applied per scan while submerged, kept gentle to stay smooth. */
const STEER = 0.09;

function blockAt(dimension, x, y, z) {
  try {
    return dimension.getBlock({ x, y, z });
  } catch {
    return undefined;
  }
}

function isFluid(dimension, x, y, z) {
  const block = blockAt(dimension, x, y, z);
  return block !== undefined && FLUIDS.has(block.typeId);
}

/** True when the player's body overlaps a fluid cell at their location. */
function feetInFluid(dimension, location) {
  const x = Math.floor(location.x);
  const y = Math.floor(location.y);
  const z = Math.floor(location.z);
  return isFluid(dimension, x, y, z) || isFluid(dimension, x, y - 1, z);
}

/** True when the fluid reaches the player's head, so they are fully under. */
function headInFluid(dimension, location) {
  const x = Math.floor(location.x);
  const z = Math.floor(location.z);
  return isFluid(dimension, x, Math.floor(location.y + EYE_HEIGHT), z);
}

function swim(player) {
  const dimension = player.dimension;
  let location;
  try {
    location = player.location;
  } catch {
    return;
  }
  if (!feetInFluid(dimension, location)) return;

  // Creative players fly on their own; adding buoyancy fights the controls.
  try {
    if (player.getGameMode() === GameMode.Creative) return;
  } catch {
    // Game mode unreadable this tick; treat as survival and keep the assist.
  }

  // A jump from inside the water becomes an upward stroke, which is what lets a
  // player rise to the surface; otherwise they drift down a touch, so the fluid
  // reads as water rather than a lift.
  let heldJump = false;
  try {
    heldJump = player.isJumping;
  } catch {
    heldJump = false;
  }

  const vertical = heldJump ? BUOYANCY * 3 : BUOYANCY - SINK;

  // Steering follows the player's own movement vector, so a controller or
  // keyboard both work without this module knowing the input layout. The vector
  // is horizontal and already normalised, so it only needs scaling.
  let steerX = 0;
  let steerZ = 0;
  try {
    const move = player.inputInfo.getMovementVector();
    steerX = move.x;
    steerZ = move.y;
  } catch {
    // No input information (e.g. a server-side player); leave steering alone.
  }

  try {
    player.applyImpulse({ x: steerX * STEER, y: vertical, z: steerZ * STEER });
  } catch {
    // The player left or the dimension unloaded between the scan and the write.
  }

  // Full submersion slows the world down as vanilla water does, which is the
  // clearest signal to the player that they are underwater.
  try {
    if (headInFluid(dimension, location)) {
      player.addEffect("minecraft:slowness", SCAN_PERIOD + 4, { amplifier: 0, showParticles: false });
    }
  } catch {
    // Effect application failed; the movement assist is the important part.
  }
}

system.runInterval(() => {
  for (const player of world.getPlayers()) {
    if (player.dimension.id !== COPPER_DIMENSION) continue;
    try {
      swim(player);
    } catch (error) {
      console.warn(`[copper] swim assist failed: ${error}`);
    }
  }
}, SCAN_PERIOD);
