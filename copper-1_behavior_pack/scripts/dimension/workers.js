import { world, system, ItemStack } from "@minecraft/server";

/*
 * The copper workers' brain.
 *
 * Entity JSON can describe how a mob moves and what it attacks, but it cannot
 * describe a mob that *works* — inspecting a block, deciding on an action, and
 * carrying an item to where it is needed. That decision layer lives here: one
 * interval walks every loaded worker in the Copper Dimension and lets the
 * nearest one take a single, deliberate action.
 *
 * Four archetypes share the brain, each with a different craft:
 *
 *   pa:copper_bee      flies; pollinates the copper forest, planting saplings
 *   pa:copper_fish     swims; banks copper into chests it finds in the water
 *   pa:copper_mole     burrows; sniffs out copper ore and digs it free
 *   pa:copper_keeper   walks; collects loose copper and lights the lamps
 *
 * One action per worker per cycle keeps the cost bounded — a full sweep of a
 * worker's neighbourhood costs a handful of block reads, and the cooldown each
 * worker carries means the whole population does not act on the same tick.
 */

const COPPER_DIMENSION = "pa:copper_dimension";

const BEE = "pa:copper_bee";
const FISH = "pa:copper_fish";
const MOLE = "pa:copper_mole";
const KEEPER = "pa:copper_keeper";
const WORKERS = new Set([BEE, FISH, MOLE, KEEPER]);

const SENSE_INTERVAL = 60;    // ticks between a worker's turns (3 s)
const SENSE_RADIUS = 8;       // blocks a worker can see
const PLAYER_RADIUS = 48;     // workers this far from any player are skipped

/* Copper blocks worth the workers' attention. */
const COPPER_ORE = new Set([
  "pa:copper_ore",
  "pa:deepslate_copper_ore",
  "pa:weathered_copper_stone",
  "pa:oxidized_copper_stone",
]);
const SAPLING = "pa:custom_sapling_copper";
const COPPER_GRASS = "pa:copper_grass";
const COPPER_SOIL = "pa:copper_soil";
const LAMP = "pa:copper_lamp";
const BULB = "minecraft:copper_bulb";
const COPPER_LEAVES = "pa:copper_leaves";

/** Blocks a worker may place into — never overwrite anything the player built. */
const REPLACEABLE = new Set(["minecraft:air", "minecraft:short_grass", "minecraft:fern"]);

const nextTurn = new Map();

system.runInterval(() => {
  const dimension = safeDimension();
  if (!dimension) return;
  const players = world.getPlayers().filter((p) => p.dimension.id === COPPER_DIMENSION);
  if (players.length === 0) return;

  const tick = system.currentTick;
  const seen = new Set();
  for (const player of players) {
    let workers;
    try {
      workers = dimension.getEntities({
        families: ["pa_worker"],
        excludeTypes: ["minecraft:player", "minecraft:item"],
        location: player.location,
        maxDistance: SENSE_RADIUS + PLAYER_RADIUS,
      });
    } catch {
      continue;
    }
    for (const worker of workers) {
      if (seen.has(worker.id)) continue;
      seen.add(worker.id);
      if (!WORKERS.has(worker.typeId)) continue;
      if ((nextTurn.get(worker.id) ?? 0) > tick) continue;
      nextTurn.set(worker.id, tick + SENSE_INTERVAL + spread(worker.id));

      try {
        act(worker, dimension);
      } catch (error) {
        // A worker that meets an unexpected block state must not take the sweep
        // down with it; the next cycle simply tries again.
        console.warn(`[copper] worker ${worker.typeId} tripped: ${error}`);
      }
    }
  }
}, 20);

function act(worker, dimension) {
  switch (worker.typeId) {
    case BEE: return beeWork(worker, dimension);
    case FISH: return fishWork(worker, dimension);
    case MOLE: return moleWork(worker, dimension);
    case KEEPER: return keeperWork(worker, dimension);
    default: return undefined;
  }
}

// ── Bee: pollinate the forest ───────────────────────────────────────────────

/*
 * The bee looks for a mature copper tree and leaves a sapling on nearby grass,
 * the way a bee spreads flowers. If it finds no tree it simply drifts, so a
 * fresh plain slowly gains its first saplings.
 */
function beeWork(worker, dimension) {
  const target = findBlock(dimension, worker.location, SENSE_RADIUS, (id) =>
    id === COPPER_LEAVES || id === SAPLING
  );
  if (!target) {
    wander(worker);
    return;
  }

  const spot = findReplaceable(dimension, target, 4, (id) => id === COPPER_GRASS);
  if (!spot) {
    // Nothing to plant on: just show the bee working the canopy.
    dimension.spawnParticle("minecraft:crop_growth_emitter", above(target));
    return;
  }

  const ground = dimension.getBlock(spot);
  if (!ground) return;
  safeSet(dimension, spot, SAPLING);
  dimension.spawnParticle("minecraft:crop_growth_emitter", above(spot));
  dimension.playSound("random.orb", above(spot), { pitch: 1.6, volume: 0.4 });
}

// ── Fish: bank copper in underwater chests ──────────────────────────────────

/*
 * The fish carries a copper nugget and swims toward the nearest chest, leaving
 * the nugget behind when it arrives. It is a courier: chests near water slowly
 * fill up even with no player around.
 */
function fishWork(worker, dimension) {
  const chest = findBlock(dimension, worker.location, SENSE_RADIUS, (id) =>
    id.endsWith("copper_chest")
  );
  if (!chest) {
    idleSwim(worker);
    return;
  }

  const at = { x: chest.x + 0.5, y: chest.y + 1, z: chest.z + 0.5 };
  if (distance(worker.location, at) > 2.5) {
    // Still travelling: face the chest and keep swimming; the navigation
    // component does the actual movement.
    idleSwim(worker, at);
    return;
  }

  deposit(dimension, chest, new ItemStack("minecraft:copper_nugget", 1));
  dimension.spawnParticle("minecraft:basic_bubble_particle", above(chest));
}

// ── Mole: dig out copper ore ────────────────────────────────────────────────

/*
 * The mole burrows to the nearest copper ore, breaks it, and drops the raw
 * copper where it stood — a passive mining crew. It then fills the hole back in
 * with copper soil, so the ground is never left pocked.
 */
function moleWork(worker, dimension) {
  const ore = findBlock(dimension, worker.location, SENSE_RADIUS, (id) => COPPER_ORE.has(id));
  if (!ore) {
    // No ore in reach: burrow a little in a random direction, which is what
    // keeps moles distributed through the caves instead of pacing one spot.
    burrow(worker, dimension);
    return;
  }

  const block = dimension.getBlock(ore);
  if (!block) return;
  safeSet(dimension, ore, COPPER_SOIL);
  dimension.spawnParticle("minecraft:basic_crit_particle", above(ore));
  dimension.playSound("dig.stone", above(ore), { pitch: 0.8, volume: 0.5 });

  const drop = dimension.spawnItem(new ItemStack("minecraft:raw_copper", 1), above(ore));
  // A gentle nudge toward the mole's chest-less home keeps drops from piling up
  // inside the freshly sealed pocket.
  try {
    drop.applyImpulse({ x: 0, y: 0.1, z: 0 });
  } catch {
    // Impulses are best-effort; the item is already on the ground.
  }
}

// ── Keeper: collect copper and light the lamps ──────────────────────────────

/*
 * The keeper is the tidy one. It walks to loose copper items and swallows them
 * into its pack, and it lights any copper lamp it passes that is switched off.
 * Its pack is the dimension's slow storage: a keeper that fills up simply
 * stops collecting.
 */
function keeperWork(worker, dimension) {
  const lamp = findBlock(dimension, worker.location, SENSE_RADIUS, (id) => id === LAMP);
  if (lamp && !isLit(dimension, lamp)) {
    lightLamp(dimension, lamp);
    return;
  }

  // A copper bulb left dark reads as broken; the keeper lights those too.
  const bulb = findBlock(dimension, worker.location, SENSE_RADIUS, (id) => id === BULB);
  if (bulb && !isLitBulb(dimension, bulb)) {
    lightBulb(dimension, bulb);
    return;
  }

  const drop = nearestItem(worker, dimension);
  if (!drop) {
    wander(worker);
    return;
  }

  if (distance(worker.location, drop.location) > 2.0) return;
  try {
    drop.remove();
    dimension.playSound("random.pop", drop.location, { pitch: 1.2, volume: 0.4 });
  } catch {
    // The item left the world first; nothing to collect.
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function safeDimension() {
  try {
    return world.getDimension(COPPER_DIMENSION);
  } catch {
    return undefined;
  }
}

/** Scans the cube around a point for the first block matching `want`. */
function findBlock(dimension, origin, radius, want) {
  const base = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
  for (let r = 0; r <= radius; r++) {
    // Walk the shell at radius r so the nearest block wins, not the lowest.
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const at = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
          const block = tryBlock(dimension, at);
          if (block && want(block.typeId)) return at;
        }
      }
    }
  }
  return undefined;
}

/** Finds an air/replaceable block standing on a block matching `onType`. */
function findReplaceable(dimension, origin, radius, onType) {
  const base = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const at = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
        const here = tryBlock(dimension, at);
        const below = tryBlock(dimension, { x: at.x, y: at.y - 1, z: at.z });
        if (here && below && REPLACEABLE.has(here.typeId) && onType(below.typeId)) return at;
      }
    }
  }
  return undefined;
}

function nearestItem(worker, dimension) {
  try {
    const items = dimension.getEntities({
      type: "minecraft:item",
      location: worker.location,
      maxDistance: SENSE_RADIUS,
    });
    let best;
    let bestDistance = Infinity;
    for (const item of items) {
      const d = distance(worker.location, item.location);
      if (d < bestDistance) {
        bestDistance = d;
        best = item;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

function tryBlock(dimension, at) {
  try {
    return dimension.getBlock(at);
  } catch {
    return undefined;
  }
}

function safeSet(dimension, at, type) {
  try {
    dimension.getBlock(at)?.setType(type);
  } catch {
    // Out of the loading window; skip this action.
  }
}

/** Puts one item into a container block, if it has room. */
function deposit(dimension, at, value) {
  try {
    const container = dimension.getBlock(at)?.getComponent("minecraft:inventory")?.container;
    if (!container || container.emptySlotsCount === 0) return false;
    container.addItem(value);
    return true;
  } catch {
    return false;
  }
}

function isLit(dimension, at) {
  const block = tryBlock(dimension, at);
  if (!block) return true;
  try {
    return Boolean(block.permutation.getState("pa:lit"));
  } catch {
    return true;
  }
}

function lightLamp(dimension, at) {
  const block = tryBlock(dimension, at);
  if (!block) return;
  try {
    block.setPermutation(block.permutation.withState("pa:lit", true));
    dimension.playSound("random.click", above(at), { pitch: 1.2, volume: 0.5 });
  } catch {
    // The block does not carry the state; nothing to light.
  }
}

function isLitBulb(dimension, at) {
  const block = tryBlock(dimension, at);
  if (!block) return true;
  try {
    // Vanilla copper bulbs expose "lit" as a boolean state.
    return Boolean(block.permutation.getState("lit"));
  } catch {
    return true;
  }
}

function lightBulb(dimension, at) {
  const block = tryBlock(dimension, at);
  if (!block) return;
  try {
    block.setPermutation(block.permutation.withState("lit", true));
    dimension.playSound("random.click", above(at), { pitch: 1.0, volume: 0.5 });
  } catch {
    // The block does not carry the state; nothing to light.
  }
}

function wander(worker) {
  // Motion is the navigation component's job; the brain only steers the facing
  // so an idle worker does not stare at one spot forever.
  try {
    const rotation = worker.getRotation();
    rotation.y += (Math.random() - 0.5) * 90;
    worker.setRotation(rotation);
  } catch {
    // Rotation is best-effort.
  }
}

function idleSwim(worker, toward) {
  try {
    const rotation = worker.getRotation();
    if (toward) {
      const dx = toward.x - worker.location.x;
      const dz = toward.z - worker.location.z;
      rotation.y = (Math.atan2(-dx, dz) * 180) / Math.PI;
    } else {
      rotation.y = Math.random() * 360;
    }
    worker.setRotation(rotation);
  } catch {
    // Rotation is best-effort.
  }
}

/*
 * A mole with no ore in reach sinks a short tunnel instead of pacing. It
 * carves its own two-block passage so it is never sealed inside stone, which
 * also leaves the occasional exploratory burrow for a player to find.
 */
function burrow(worker, dimension) {
  const at = worker.location;
  const dx = Math.sign(Math.floor((Math.random() - 0.5) * 3)) || 1;
  const dz = Math.sign(Math.floor((Math.random() - 0.5) * 3)) || -1;
  const to = { x: at.x + dx, y: at.y, z: at.z + dz };
  try {
    for (const y of [Math.floor(to.y), Math.floor(to.y) + 1]) {
      dimension.getBlock({ x: Math.floor(to.x), y, z: Math.floor(to.z) })?.setType("minecraft:air");
    }
    worker.teleport(to, { dimension });
  } catch {
    // Teleport can be refused mid-motion; the next cycle retries.
  }
}

function above(at) {
  return { x: at.x + 0.5, y: at.y + 1, z: at.z + 0.5 };
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** A stable per-entity offset so a crowd does not all act on the same tick. */
function spread(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % SENSE_INTERVAL;
}

export const WORKER_TYPES = [BEE, FISH, MOLE, KEEPER];
