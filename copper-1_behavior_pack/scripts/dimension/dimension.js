import {
  world,
  system,
  Player,
  BlockPermutation,
  BlockVolume,
  GameMode,
  ItemStack,
  CustomCommandStatus,
  CommandPermissionLevel,
} from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { safeSubscribe } from '../utils/helper';
import { buildSpawnPad, seedTerrain, startTerrainLoop } from "./terrain";

/*
 * Custom dimension runtime.
 *
 * A custom dimension is registered here, at startup, because scripting is the
 * only way to create one on Bedrock — a `dimensions/*.json` file is a Java
 * Edition feature and is ignored by Bedrock, which is why the pack used to log
 * "no parser available" and "Failed to load dimension". Registration only ever
 * produces a void generator, so `terrain.js` fills the space in around players.
 *
 * This module is a dispatcher: `runStep` has one arm per step kind and
 * `runAction` one per action kind. Adding a kind is one arm here and nothing
 * else.
 *
 * Requires Minecraft Bedrock 1.21.80+ and @minecraft/server with beta APIs.
 */

const registry = [];
const built = new Set();
const ready = new Set();
const MIN_Y = -64;
const MAX_Y = 320;
/** Builds currently running, so concurrent arrivals wait on one of them. */
const building = new Map();
const modules = new Map();
const arrivals = [];
let menu = null;

/** Registers one dimension. Called at module evaluation, before startup fires. */
export function registerDimension(config) {
  registry.push(config);
}

/** Installs the pack-wide travel form and the generated item's use handler. */
export function installTravelMenu(options) {
  menu = options;
}

/**
 * Lets a minigame module claim a name. `dimension_rules.js` calls the handler
 * when a `module` action fires, so a new minigame is a new asset plus a name.
 */
export function registerModule(name, handler) {
  modules.set(name, handler);
}

/**
 * Lets a feature run something every time a player lands in a dimension,
 * whatever route brought them — menu, item, command or portal all funnel
 * through `travelTo`. `dimension_portal.js` uses it to raise the return portal
 * beside the spawn, whichever route was taken.
 */
export function registerArrival(handler) {
  arrivals.push(handler);
}

export function startModule(name, player, config, tunables) {
  const handler = modules.get(name);
  if (!handler) {
    console.warn(`[dimension] no module named "${name}"`);
    return;
  }
  try {
    handler(player, config, tunables || {});
  } catch (error) {
    console.warn(`[dimension] module "${name}" failed: ${error}`);
  }
}

export function dimensionConfigs() {
  return registry;
}

export function configFor(typeId) {
  return registry.find((entry) => entry.typeId === typeId);
}

/** Ticking-area ids are plain identifiers; dimension ids contain a colon. */
function safeId(raw) {
  return String(raw).replace(/[^A-Za-z0-9_]/g, "_");
}

function vec(v, fallback) {
  return v || fallback || { x: 0, y: 64, z: 0 };
}

// ── Registration ───────────────────────────────────────────────────────────

safeSubscribe(system.beforeEvents.startup, (event) => {
  // The dimension ids are declared here, not in a JSON file: Bedrock only
  // builds the registry for script-created dimensions.
  for (const config of registry) {
    try {
      event.dimensionRegistry.registerCustomDimension(config.typeId);
    } catch (error) {
      console.warn(`[dimension] could not register ${config.typeId}: ${error}`);
    }
  }

  if (!menu) return;

  if (menu.itemComponent) {
    registerMenuItem(event, menu.itemComponent, () => null);
  }

  // Per-dimension items: each teleports straight to its own destination.
  for (const config of registry) {
    if (!config.itemComponent) continue;
    registerMenuItem(event, config.itemComponent, () => config);
  }

  registerCommand(event, menu.command, null);
  for (const config of registry) {
    if (config.command) registerCommand(event, config.command, config);
  }
}, 'system.beforeEvents.startup');

/**
 * `direct` returns the dimension to travel to, or null to open the menu.
 */
function registerMenuItem(event, componentId, direct) {
  try {
    event.itemComponentRegistry.registerCustomComponent(componentId, {
      onUse: (e) => {
        const player = e.source;
        if (!player || !(player instanceof Player)) return;
        const target = direct();
        // Deferred: onUse can run where teleport and runCommand are refused.
        system.run(() => (target ? beginTravel(player, target) : showTravelMenu(player)));
      },
    });
  } catch (error) {
    console.warn(`[dimension] could not register ${componentId}: ${error}`);
  }
}

function registerCommand(event, name, config) {
  if (!name) return;
  try {
    event.customCommandRegistry.registerCommand(
      {
        name,
        description: config ? `Travel to ${config.typeId}` : (menu && menu.title) || "Travel between dimensions",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
      },
      (origin) => {
        const player = origin.sourceEntity;
        if (!player || !(player instanceof Player)) {
          return { status: CustomCommandStatus.Failure, message: "This command can only be used by a player." };
        }
        system.run(() => (config ? beginTravel(player, config) : showTravelMenu(player)));
        return { status: CustomCommandStatus.Success };
      }
    );
  } catch (error) {
    console.warn(`[dimension] could not register command ${name}: ${error}`);
  }
}

// ── Build ──────────────────────────────────────────────────────────────────

safeSubscribe(world.afterEvents.worldLoad, () => {
  void buildAll();
}, 'world.afterEvents.worldLoad');

// Sequential: each dimension holds a temporary ticking area while it builds, so
// running them together would multiply the chunk cost by the dimension count.
async function buildAll() {
  for (const config of registry) {
    try {
      await ensureDimensionReady(config);
      await ensureBuilt(config);
    } catch (error) {
      console.warn(`[dimension] could not build ${config.typeId}: ${error}`);
    }
  }
}

/**
 * A custom dimension is registered empty, so the arrival pad has to exist before
 * anything can be teleported into it. It is laid down once per world, then the
 * surrounding terrain is generated around players as they explore.
 */
async function ensureDimensionReady(config) {
  if (ready.has(config.typeId)) return;
  ready.add(config.typeId);

  try {
    seedTerrain(world.seed);
  } catch (error) {
    console.warn(`[dimension] could not read the world seed: ${error}`);
  }

  const dimension = world.getDimension(config.typeId);
  const spawn = vec(config.spawn);
  const areaId = safeId(`${config.typeId}_spawn`);
  const options = {
    dimension,
    from: { x: spawn.x - 12, y: MIN_Y, z: spawn.z - 12 },
    to: { x: spawn.x + 12, y: MAX_Y, z: spawn.z + 12 },
  };

  if (!world.tickingAreaManager.hasCapacity(options)) {
    console.warn(`[dimension] not enough ticking capacity to prepare ${config.typeId}`);
    return;
  }

  await world.tickingAreaManager.createTickingArea(areaId, options);
  try {
    buildSpawnPad(dimension, spawn);
  } finally {
    if (world.tickingAreaManager.hasTickingArea(areaId)) {
      world.tickingAreaManager.removeTickingArea(areaId);
    }
  }

  startTerrainLoop(config.typeId);
}

export function ensureBuilt(config) {
  if (built.has(config.typeId)) return Promise.resolve();

  // Two players arriving for the first time together used to run the recipe
  // twice and, worse, each one's `finally` removed the build area the other was
  // still filling into — a half-built dimension nothing would ever repair,
  // because `built` was set anyway. They share one build now.
  const inFlight = building.get(config.typeId);
  if (inFlight) return inFlight;

  const promise = buildOnce(config);
  building.set(config.typeId, promise);
  // Cleared however it ends, so a build that failed can be retried by whoever
  // arrives next instead of every later caller inheriting the same rejection.
  const forget = () => building.delete(config.typeId);
  promise.then(forget, forget);
  return promise;
}

/*
 * Which recipe version each dimension was last built with, per world.
 *
 * Without it the recipe ran on every load: entity and item steps spawned
 * another copy each time, scatter kept adding, and every fill overwrote what
 * players had built in the meantime. `everyLoad` keeps that behaviour for
 * arenas that are meant to reset.
 */
function builtKey(config) {
  return `mam:dim_build:${config.typeId}`;
}

function alreadyBuilt(config) {
  if (config.buildMode === "everyLoad" || !config.buildHash) return false;
  try {
    return world.getDynamicProperty(builtKey(config)) === config.buildHash;
  } catch (error) {
    console.warn(`[dimension] could not read the build marker of ${config.typeId}: ${error}`);
    return false;
  }
}

function markBuilt(config) {
  built.add(config.typeId);
  if (config.buildMode === "everyLoad" || !config.buildHash) return;
  try {
    world.setDynamicProperty(builtKey(config), config.buildHash);
  } catch (error) {
    console.warn(`[dimension] could not save the build marker of ${config.typeId}: ${error}`);
  }
}

async function buildOnce(config) {
  const steps = config.build || [];
  if (steps.length === 0 || alreadyBuilt(config)) {
    built.add(config.typeId);
    return;
  }

  const dimension = world.getDimension(config.typeId);
  const areaId = safeId(`${config.typeId}_build`);

  // No bounds means nothing positional to place (a recipe of raw commands).
  if (!config.bounds) {
    runSteps(dimension, steps);
    markBuilt(config);
    return;
  }

  const bounds = withStructureSizes(config.bounds, steps);
  warnOutsideHeight(dimension, config, bounds);

  const areaOptions = { dimension, from: bounds.from, to: bounds.to };
  if (!world.tickingAreaManager.hasCapacity(areaOptions)) {
    console.warn(`[dimension] not enough ticking capacity to build ${config.typeId}`);
    return;
  }
  if (world.tickingAreaManager.hasTickingArea(areaId)) {
    world.tickingAreaManager.removeTickingArea(areaId);
  }

  // The await is the point: without loaded chunks the fills below land in a part
  // of the world that does not exist yet.
  await world.tickingAreaManager.createTickingArea(areaId, areaOptions);

  try {
    runSteps(dimension, steps);
    markBuilt(config);
  } finally {
    if (world.tickingAreaManager.hasTickingArea(areaId)) {
      world.tickingAreaManager.removeTickingArea(areaId);
    }
  }
}

/*
 * The editor only knows a structure step's anchor, so the bounds it sends
 * reserve a guess around it. A structure larger than the guess reached into
 * chunks nothing was holding, and `place` threw halfway. The real size is
 * readable here, so the ticking area grows to cover it.
 */
function withStructureSizes(bounds, steps) {
  let lo = { ...bounds.from };
  let hi = { ...bounds.to };
  const cover = (at, size) => {
    lo = { x: Math.min(lo.x, at.x), y: Math.min(lo.y, at.y), z: Math.min(lo.z, at.z) };
    hi = { x: Math.max(hi.x, at.x + size.x - 1), y: Math.max(hi.y, at.y + size.y - 1), z: Math.max(hi.z, at.z + size.z - 1) };
  };

  for (const step of steps) {
    const isStructure = step.kind === "structure" || (step.kind === "scatter" && step.what === "structure");
    if (!isStructure || !step.id) continue;

    let size;
    try {
      size = world.structureManager.get(`mystructure:${step.id}`)?.size;
    } catch (error) {
      console.warn(`[dimension] could not read the size of structure "${step.id}": ${error}`);
    }
    if (!size) continue;

    // A quarter turn swaps the footprint's axes.
    const turned = step.rotation === "Rotate90" || step.rotation === "Rotate270";
    const footprint = turned ? { x: size.z, y: size.y, z: size.x } : size;

    if (step.kind === "structure") {
      cover(step.at, footprint);
    } else {
      // Scatter picks origins anywhere in its area, so the far corner can carry
      // a whole structure past the area's edge.
      cover({ x: Math.max(step.from.x, step.to.x), y: Math.max(step.from.y, step.to.y), z: Math.max(step.from.z, step.to.z) }, footprint);
    }
  }
  return { from: lo, to: hi };
}

/** The editor checks this too; the game's own range is the authority. */
function warnOutsideHeight(dimension, config, bounds) {
  const range = dimension.heightRange;
  if (!range) return;
  if (bounds.from.y < range.min || bounds.to.y > range.max) {
    console.warn(
      `[dimension] the build of ${config.typeId} spans y ${bounds.from.y}..${bounds.to.y}, ` +
        `but the dimension only reaches ${range.min}..${range.max}. Blocks outside it will not be placed.`
    );
  }
}

/*
 * Features fail quietly by default — `placeFeature` returns false rather than
 * throwing — and a tree that simply never appears is the hardest kind of bug to
 * report. `shouldThrow` turns that into a reason worth printing.
 *
 * Nearly always the ground: a tree feature checks `may_grow_on` beneath its
 * origin, and needs the origin itself free. On a stone platform, at the floor's
 * own Y, both conditions fail.
 */
function placeFeature(dimension, step) {
  try {
    return dimension.placeFeature(step.id, step.at, true);
  } catch (error) {
    warnFeature("feature", step, error);
    return undefined;
  }
}

/*
 * Checked in game (26.51): the position only picks the chunk. The feature lands
 * at the chunk's corner plus the rule's distribution x/z, at the rule's own Y,
 * and the rule's biome filter is not checked. So a failure is about the rule's
 * distribution or its feature, never the dimension's biome.
 */
function placeFeatureRule(dimension, step) {
  try {
    // No shouldThrow on this one, so a false return is all there is.
    const placed = dimension.placeFeatureRule(step.id, step.at);
    if (placed === false) warnFeatureRule(step, "the game refused it");
    return placed;
  } catch (error) {
    warnFeatureRule(step, error);
    return undefined;
  }
}

function warnFeatureRule(step, reason) {
  const at = step.at || {};
  const cx = Math.floor((at.x || 0) / 16);
  const cz = Math.floor((at.z || 0) / 16);
  console.warn(
    `[dimension] feature rule "${step.id}" did not place in chunk ${cx},${cz}: ${reason}. ` +
      `The rule's distribution decides the spot inside that chunk (corner ${cx * 16}, ${cz * 16} plus its x/z, at its own y) — ` +
      `check there is ground its feature accepts at that spot.`
  );
}

function warnFeature(what, step, reason) {
  const at = step.at || {};
  console.warn(
    `[dimension] ${what} "${step.id}" did not place at ${at.x}, ${at.y}, ${at.z}: ${reason}. ` +
      `Aim at the first air block above the ground, and check the block beneath is one the feature accepts ` +
      `(a tree's "may grow on" list — stone is usually not on it).`
  );
}

function runSteps(dimension, steps) {
  for (const step of steps) {
    try {
      runStep(dimension, step);
    } catch (error) {
      console.warn(`[dimension] step "${step && step.kind}" failed: ${error}`);
    }
  }
}

/** One arm per step kind. Unknown kinds are skipped, never fatal. */
function runStep(dimension, step) {
  switch (step.kind) {
    case "fill":
      return fill(dimension, step.from, step.to, step.blockId, step.replaceOnly);
    case "hollow":
      return hollow(dimension, step.from, step.to, step.blockId, step.thickness || 1);
    case "block":
      return setBlock(dimension, step.at, step.blockId);
    case "platform":
      return platform(dimension, step);
    case "structure":
      return placeStructure(dimension, step);
    case "feature":
      return placeFeature(dimension, step);
    case "featureRule":
      return placeFeatureRule(dimension, step);
    // The editor no longer offers jigsaw steps — MAM cannot author the template
    // pools they need — but the arm stays so a project saved with one still
    // places it instead of being silently dropped.
    case "jigsaw":
      return world.structureManager.placeJigsawStructure(step.id, dimension, step.at);
    case "scatter":
      return scatter(dimension, step);
    case "entity":
      return spawnEntities(dimension, step);
    case "item":
      return spawnItems(dimension, step);
    case "command":
      return step.command ? dimension.runCommand(step.command) : undefined;
    default:
      console.warn(`[dimension] unsupported step kind "${step.kind}" — skipped`);
      return undefined;
  }
}

function fill(dimension, from, to, blockId, replaceOnly) {
  const options = replaceOnly ? { blockFilter: { includeTypes: [replaceOnly] } } : undefined;
  dimension.fillBlocks(new BlockVolume(from, to), BlockPermutation.resolve(blockId), {
    ignoreChunkBoundErrors: true,
    ...(options || {}),
  });
}

function setBlock(dimension, at, blockId) {
  dimension.getBlock(at)?.setPermutation(BlockPermutation.resolve(blockId));
}

function hollow(dimension, from, to, blockId, thickness) {
  const t = Math.max(1, thickness) - 1;
  const lo = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) };
  const hi = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) };

  fill(dimension, lo, { x: hi.x, y: lo.y + t, z: hi.z }, blockId); // floor
  fill(dimension, { x: lo.x, y: hi.y - t, z: lo.z }, hi, blockId); // ceiling
  fill(dimension, lo, { x: hi.x, y: hi.y, z: lo.z + t }, blockId);
  fill(dimension, { x: lo.x, y: lo.y, z: hi.z - t }, hi, blockId);
  fill(dimension, lo, { x: lo.x + t, y: hi.y, z: hi.z }, blockId);
  fill(dimension, { x: hi.x - t, y: lo.y, z: lo.z }, hi, blockId);
}

function platform(dimension, step) {
  const c = vec(step.center);
  const r = step.radius;

  fill(dimension, { x: c.x - r, y: c.y, z: c.z - r }, { x: c.x + r, y: c.y, z: c.z + r }, step.blockId);

  if (step.rails) {
    const yLow = c.y + 1;
    const yHigh = c.y + Math.max(1, step.railHeight);
    const b = step.railBlockId;
    fill(dimension, { x: c.x - r, y: yLow, z: c.z - r }, { x: c.x + r, y: yHigh, z: c.z - r }, b);
    fill(dimension, { x: c.x - r, y: yLow, z: c.z + r }, { x: c.x + r, y: yHigh, z: c.z + r }, b);
    fill(dimension, { x: c.x - r, y: yLow, z: c.z - r }, { x: c.x - r, y: yHigh, z: c.z + r }, b);
    fill(dimension, { x: c.x + r, y: yLow, z: c.z - r }, { x: c.x + r, y: yHigh, z: c.z + r }, b);
  }

  if (step.lights) {
    const offset = Math.max(1, r - 2);
    const y = c.y + Math.max(step.railHeight, 2) + 1;
    for (const dx of [-offset, offset]) {
      for (const dz of [-offset, offset]) {
        setBlock(dimension, { x: c.x + dx, y, z: c.z + dz }, step.lightBlockId);
      }
    }
  }
}

// Structures are written to behavior_pack/structures/<name>.mcstructure, which
// the game exposes under the `mystructure:` namespace.
function placeStructure(dimension, step) {
  if (!step.id) return;
  world.structureManager.place(`mystructure:${step.id}`, dimension, step.at, {
    rotation: step.rotation || "None",
    mirror: step.mirror || "None",
    integrity: typeof step.integrity === "number" ? step.integrity : 1,
    ...(step.integritySeed ? { integritySeed: step.integritySeed } : {}),
    includeEntities: step.includeEntities !== false,
  });
}

function scatter(dimension, step) {
  const failures = [];
  const lo = { x: Math.min(step.from.x, step.to.x), z: Math.min(step.from.z, step.to.z) };
  const hi = { x: Math.max(step.from.x, step.to.x), z: Math.max(step.from.z, step.to.z) };
  const spanX = hi.x - lo.x + 1;
  const spanZ = hi.z - lo.z + 1;
  const baseY = Math.max(step.from.y, step.to.y);

  for (let i = 0; i < step.count; i++) {
    const x = lo.x + Math.floor(Math.random() * spanX);
    const z = lo.z + Math.floor(Math.random() * spanZ);

    let y = baseY;
    if (step.onSurface) {
      const top = dimension.getTopmostBlock({ x, z }, baseY);
      if (!top) continue; // nothing to stand on — skip rather than float it
      y = top.location.y + 1;
    }
    const at = { x, y, z };

    try {
      switch (step.what) {
        case "feature":
          // shouldThrow, so a refused placement says why instead of vanishing.
          dimension.placeFeature(step.id, at, true);
          break;
        case "structure":
          world.structureManager.place(`mystructure:${step.id}`, dimension, at);
          break;
        case "entity":
          dimension.spawnEntity(step.id, at);
          break;
        default:
          setBlock(dimension, at, step.id);
      }
    } catch (error) {
      failures.push(`${x},${y},${z}: ${error}`);
    }
  }

  // One line per step: a scatter of 50 that all fail for the same reason is
  // one problem, not 50.
  if (failures.length > 0) {
    console.warn(
      `[dimension] scatter of ${step.what} "${step.id}" failed ${failures.length} of ${step.count} times. First: ${failures[0]}`
    );
  }
}

function spawnEntities(dimension, step) {
  for (let i = 0; i < step.count; i++) {
    const entity = dimension.spawnEntity(step.id, step.at);
    if (step.spawnEvent) entity.triggerEvent(step.spawnEvent);
  }
}

function spawnItems(dimension, step) {
  // One stack, clamped to what an ItemStack accepts; count above that would
  // throw rather than spill into a second stack.
  const amount = Math.max(1, Math.min(64, step.count));
  dimension.spawnItem(new ItemStack(step.id, amount), step.at);
}

// ── Travel ─────────────────────────────────────────────────────────────────

function menuEntries() {
  const entries = [];
  for (const config of registry) {
    if (config.showInMenu === false) continue;
    entries.push({ label: config.label, config });
  }
  for (const vanilla of (menu && menu.vanilla) || []) {
    entries.push({ label: vanilla.label, vanilla });
  }
  return entries;
}

function showTravelMenu(player) {
  const entries = menuEntries();
  if (entries.length === 0) {
    player.sendMessage("§cNo destinations are configured.");
    return;
  }

  const form = new ActionFormData()
    .title(`§l${(menu && menu.title) || "Dimensions"}`)
    .body(`You are in: §b${player.dimension.id}§r\n\n${(menu && menu.body) || "Choose a destination:"}`);

  for (const entry of entries) form.button(entry.label);

  form
    .show(player)
    .then((response) => {
      if (response.canceled || response.selection === undefined) return;
      const selected = entries[response.selection];
      if (!selected) return;

      if (selected.vanilla) {
        if (selected.vanilla.id === player.dimension.id) {
          player.sendMessage("§eYou are already in that dimension.");
          return;
        }
        system.run(() => {
          player.teleport(selected.vanilla.spawn, { dimension: world.getDimension(selected.vanilla.id) });
          player.sendMessage(`§aTeleported to ${selected.label}§a.`);
        });
        return;
      }

      beginTravel(player, selected.config);
    })
    .catch((error) => console.warn(`[dimension] travel menu failed: ${error}`));
}

/** Arrival needs its chunks loaded before the teleport, or the player falls. */
export async function travelTo(player, config, arrival) {
  if (config.typeId === player.dimension.id) {
    player.sendMessage("§eYou are already in that dimension.");
    return;
  }

  const dimension = world.getDimension(config.typeId);
  // Where to hold chunks open. A linked portal passes its own target; every
  // other route — menu, item, command — lands at the dimension's spawn.
  const anchor = vec(arrival && arrival.at, vec(config.spawn));
  // Per player, not per dimension. Two players travelling at once used to share
  // one area: the second removed the first's, re-anchored it on their own
  // destination, and the first then teleported into chunks nobody was holding —
  // and dropped through the world. Two anchors are only the same place by
  // coincidence now that portals link by position.
  const areaId = safeId(`${config.typeId}_arrive_${player.id}`);
  // A caller that has to look around before it can name the landing spot says so
  // by passing its own box; everyone else lands where they aimed.
  const box = (arrival && arrival.area) || {
    from: { x: anchor.x - 4, y: anchor.y - 4, z: anchor.z - 4 },
    to: { x: anchor.x + 4, y: anchor.y + 4, z: anchor.z + 4 },
  };
  const areaOptions = { dimension, from: box.from, to: box.to };

  // Refusing beats arriving: without the area the destination may never load,
  // and a player left falling in a void dimension has no way back.
  if (!world.tickingAreaManager.hasCapacity(areaOptions)) {
    player.sendMessage("§cToo much of the world is loaded right now — try again in a moment.");
    return;
  }

  player.sendMessage(`§eLoading ${config.label}§e...`);

  try {
    if (world.tickingAreaManager.hasTickingArea(areaId)) {
      world.tickingAreaManager.removeTickingArea(areaId);
    }
    await world.tickingAreaManager.createTickingArea(areaId, areaOptions);
    await ensureDimensionReady(config);
    await ensureBuilt(config);

    // Anything past here runs at least a tick after the player asked, and they
    // may have logged out in between. Every call below throws on a stale handle.
    if (!player.isValid) return;

    // Resolved here, not by the caller: finding ground or raising a portal
    // means reading blocks, and until the area above exists and the recipe has
    // run there is nothing there to read. A resolver that comes back empty
    // falls through to the anchor rather than stranding the player.
    let landing = anchor;
    if (arrival && arrival.resolve) {
      try {
        landing = vec(arrival.resolve(dimension, anchor), anchor);
      } catch (error) {
        console.warn(`[dimension] could not resolve the arrival in ${config.typeId}: ${error}`);
      }
    }

    player.teleport(landing, { dimension });
  } catch (error) {
    if (player.isValid) player.sendMessage(`§cCould not travel there: ${error}`);
    else console.warn(`[dimension] travel to ${config.typeId} ended with the player gone: ${error}`);
    return;
  } finally {
    if (world.tickingAreaManager.hasTickingArea(areaId)) {
      world.tickingAreaManager.removeTickingArea(areaId);
    }
  }

  if (player.isValid) applyArrival(player, config);
}

/**
 * Starts a trip nothing is going to await.
 *
 * The bare promise left a rejection unhandled whenever a player disconnected
 * mid-travel — common on a server, where the two awaits above are long enough to
 * quit inside.
 */
function beginTravel(player, config, arrival) {
  void travelTo(player, config, arrival).catch((error) => console.warn(`[dimension] travel failed: ${error}`));
}

function applyArrival(player, config) {
  const arrival = config.arrival || {};

  if (arrival.gameMode) {
    try {
      player.setGameMode(GameMode[arrival.gameMode] ?? undefined);
    } catch (error) {
      console.warn(`[dimension] could not set game mode: ${error}`);
    }
  }

  if (arrival.setRespawnHere) {
    try {
      player.setSpawnPoint({ ...vec(config.spawn), dimension: world.getDimension(config.typeId) });
    } catch (error) {
      console.warn(`[dimension] could not set spawn point: ${error}`);
    }
  }

  // Each handler is isolated: one that throws must not stop the rest, or a
  // failed return portal would also swallow the game-mode change.
  for (const handler of arrivals) {
    try {
      handler(player, config);
    } catch (error) {
      console.warn(`[dimension] arrival handler failed: ${error}`);
    }
  }
}
