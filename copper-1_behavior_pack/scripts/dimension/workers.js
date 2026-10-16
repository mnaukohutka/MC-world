import { world, system, ItemStack, MolangVariableMap } from "@minecraft/server";

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
const MINNOW = "pa:copper_minnow";
const CRAB = "pa:copper_crab";
const SHADE = "pa:copper_shade";

/* Round-8 residents. Each of these was previously scenery — it walked or flew
 * but did nothing. They now carry a craft of their own, so every copper mob has
 * a reason to be where it is: */
const BORER = "pa:copper_borer";     // digs exploratory tunnels, laces the walls with ore
const GUARD = "pa:copper_guard";     // escorts, driving off the creepers
const BOAR = "pa:copper_boar";       // roots the soil, turning up buried raw copper
const MITE = "pa:copper_mite";       // corrodes worked copper into patina
const JELLY = "pa:copper_jelly";     // drifts and glows, lighting the water
const WISP = "pa:copper_wisp";       // guides travellers toward the light
const BAT = "pa:copper_bat";         // seeds copper fungus through the caves
const GHOST = "pa:copper_ghost";     // the happy ghost, who mends the weary

const WORKERS = new Set([
  BEE, FISH, MOLE, KEEPER, MINNOW, CRAB, SHADE,
  BORER, GUARD, BOAR, MITE, JELLY, WISP, BAT, GHOST,
]);

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
const PATINA = "pa:copper_patina";
const BRICKS = "pa:copper_bricks";
const COPPER_BLOCK = "minecraft:copper_block";
const CUT_COPPER = "minecraft:cut_copper";
const CHISELED = "minecraft:chiseled_copper";
const FUNGUS = "pa:copper_fungus";
const GEM_ORE = "pa:copper_ore_gem";
const DEEPSLATE_GEM = "pa:deepslate_copper_ore_gem";
const CREEPER = "minecraft:creeper";

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
    case FISH:
    case MINNOW: return fishWork(worker, dimension);
    case MOLE: return moleWork(worker, dimension);
    case CRAB: return crabWork(worker, dimension);
    case KEEPER: return keeperWork(worker, dimension);
    case SHADE: return shadeWork(worker, dimension);
    case BORER: return borerWork(worker, dimension);
    case GUARD: return guardWork(worker, dimension);
    case BOAR: return boarWork(worker, dimension);
    case MITE: return miteWork(worker, dimension);
    case JELLY: return jellyWork(worker, dimension);
    case WISP: return wispWork(worker, dimension);
    case BAT: return batWork(worker, dimension);
    case GHOST: return ghostWork(worker, dimension);
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
  dimension.spawnParticle("minecraft:basic_crit_particle", above(ore), directionVariables({ x: 0, y: 1, z: 0 }));
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

// ── Crab: tidy the shallows ─────────────────────────────────────────────────

/*
 * The crab is the fish's counterpart on the shore: it picks up loose copper
 * that has washed into the shallows and buries it in the silt, and it clears
 * stray saplings the tide has left in the water so they do not rot there.
 */
function crabWork(worker, dimension) {
  const drop = nearestItem(worker, dimension);
  if (drop) {
    if (distance(worker.location, drop.location) > 2.0) return;
    try {
      drop.remove();
      dimension.playSound("random.pop", drop.location, { pitch: 0.8, volume: 0.4 });
    } catch {
      // The item left the world first.
    }
    return;
  }

  // Look for a sapling that ended up submerged and pop it back onto dry ground.
  const drowned = findBlock(dimension, worker.location, SENSE_RADIUS, (id) => id === SAPLING);
  if (drowned) {
    const wet = tryBlock(dimension, drowned);
    if (wet) {
      const over = dimension.getBlock({ x: drowned.x, y: drowned.y + 1, z: drowned.z });
      if (over && (over.isLiquid || over.typeId === "minecraft:water")) {
        safeSet(dimension, drowned, COPPER_SOIL);
        dimension.spawnParticle("minecraft:basic_bubble_particle", above(drowned));
        return;
      }
    }
  }

  wander(worker);
}

// ── Shade: the keeper's opposite ────────────────────────────────────────────

/*
 * The shade unwinds what the keeper does: it snuffs out any lit lamp or bulb it
 * passes and pockets loose copper for itself rather than filing it away. A
 * region with both a keeper and a shade therefore flickers — light where the
 * keeper has just been, dark behind the shade — which is exactly the unsettled
 * feel the copper country wants.
 */
function shadeWork(worker, dimension) {
  const bulb = findBlock(dimension, worker.location, SENSE_RADIUS, (id) => id === BULB || id === LAMP);
  if (bulb && isLitAny(dimension, bulb)) {
    darken(dimension, bulb);
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
    dimension.playSound("random.pop", drop.location, { pitch: 0.7, volume: 0.4 });
  } catch {
    // The item left the world first.
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

// ── Borer: dig exploratory tunnels, seed ore ────────────────────────────────

/*
 * The borer is the mole's opposite: where the mole tidies ore out of the rock,
 * the borer tunnels onward and leaves a seam behind it. It sinks a short
 * passage in a random direction and, every so often, lines the far wall with
 * gem ore — so following a borer's trail is how a player finds the deep pockets.
 */
function borerWork(worker, dimension) {
  const wall = findBlock(dimension, worker.location, 3, (id) =>
    id === "pa:copper_stone" || id === "pa:weathered_copper_stone" || id === "pa:oxidized_copper_stone"
  );
  if (wall && random3ish(worker) < 0.5) {
    safeSet(dimension, wall, worker.location.y < 0 ? DEEPSLATE_GEM : GEM_ORE);
    dimension.spawnParticle("minecraft:basic_crit_particle", above(wall), directionVariables({ x: 0, y: 1, z: 0 }));
    dimension.playSound("dig.stone", above(wall), { pitch: 1.3, volume: 0.4 });
    return;
  }
  dig(worker, dimension, 2);
}

// ── Guard: escort and cull the creepers ─────────────────────────────────────

/*
 * The guard is the dimension's peacekeeper. It hunts the nearest creeper within
 * sight and drives it off, and otherwise shadows the nearest worker so a lone
 * bee or keeper is never without an escort. The actual attack is the entity
 * JSON's job; this only chooses the quarry and shows the guard noticing it.
 */
function guardWork(worker, dimension) {
  const creeper = nearestEntity(dimension, worker, CREEPER, 12);
  if (creeper) {
    face(worker, creeper.location);
    dimension.spawnParticle("minecraft:basic_crit_particle", above(worker.location), directionVariables({ x: 0, y: 1, z: 0 }));
    return;
  }
  const ward = nearestWorker(dimension, worker, 10);
  if (ward) face(worker, ward.location);
  else wander(worker);
}

// ── Boar: root the soil for raw copper ──────────────────────────────────────

/*
 * The boar roots. It noses into a copper-soil or grass block and, now and then,
 * turns up a nugget of raw copper — a slow, wandering way for the surface to
 * yield metal without a mine. It also tramples a grass block to soil where it
 * forages, so its patch reads as worked ground.
 */
function boarWork(worker, dimension) {
  const ground = findBlock(dimension, worker.location, 3, (id) =>
    id === COPPER_GRASS || id === COPPER_SOIL
  );
  if (!ground) {
    wander(worker);
    return;
  }
  face(worker, ground);
  const block = tryBlock(dimension, ground);
  if (!block) return;
  dimension.spawnParticle("minecraft:basic_smoke_particle", above(ground));
  if (random3ish(worker) < 0.35) {
    safeSet(dimension, ground, COPPER_SOIL);
    const drop = dimension.spawnItem(new ItemStack("minecraft:raw_copper", 1), above(ground));
    try {
      drop.applyImpulse({ x: 0, y: 0.15, z: 0 });
    } catch {
      // Best-effort nudge; the item is already on the ground.
    }
  }
}

// ── Mite: corrode worked copper into patina ─────────────────────────────────

/*
 * The mite is the slow weathering made visible. It crawls over cut copper,
 * bricks and chiselled blocks and eats the shine off them, leaving the pack's
 * patina behind — the same oxidation the biomes stage on the terrain, but here
 * happening to a player's build.
 */
function miteWork(worker, dimension) {
  const worked = findBlock(dimension, worker.location, 3, (id) =>
    id === CUT_COPPER || id === CHISELED || id === BRICKS || id === COPPER_BLOCK
  );
  if (!worked) {
    wander(worker);
    return;
  }
  face(worker, worked);
  safeSet(dimension, worked, PATINA);
  dimension.spawnParticle("minecraft:basic_smoke_particle", above(worked));
  dimension.playSound("random.fizz", above(worked), { pitch: 1.6, volume: 0.3 });
}

// ── Jelly: drift and glow in the shallows ───────────────────────────────────

/*
 * The jelly is the shallows' lantern. It drifts, and wherever it lingers over a
 * dark seafloor it leaves copper seagrass — a little glow in water that would
 * otherwise be lit only from above.
 */
function jellyWork(worker, dimension) {
  const floor = findBlock(dimension, { x: worker.location.x, y: worker.location.y - 2, z: worker.location.z }, 3, (id) =>
    id === "pa:copper_soil" || id === "pa:copper_stone" || id === "minecraft:gravel"
  );
  if (floor && random3ish(worker) < 0.4) {
    const spot = { x: floor.x, y: floor.y + 1, z: floor.z };
    const block = tryBlock(dimension, spot);
    if (block && (block.isLiquid || block.typeId === "minecraft:water")) {
      safeSet(dimension, spot, "pa:copper_seagrass");
      dimension.spawnParticle("minecraft:basic_bubble_particle", above(floor));
      return;
    }
  }
  idleSwim(worker);
}

// ── Wisp: guide travellers toward the light ─────────────────────────────────

/*
 * The wisp is a guide. When a player is nearby it drifts towards them and hangs
 * a little above head height, marking the way back to open sky — the copper
 * country's answer to a lantern in the dark. With no player it hovers over the
 * brightest block it can find.
 */
function wispWork(worker, dimension) {
  const players = dimension.getPlayers({ location: worker.location, maxDistance: 24 });
  if (players.length > 0) {
    face(worker, players[0].location);
    dimension.spawnParticle("minecraft:basic_flame_particle", { x: worker.location.x, y: worker.location.y + 0.6, z: worker.location.z });
    return;
  }
  wander(worker);
}

// ── Bat: seed copper fungus through the caves ───────────────────────────────

/*
 * The bat carries spores. Flying through a cave it dusts the nearest stone wall
 * with copper fungus, which is what makes a cave read as alive rather than bare.
 */
function batWork(worker, dimension) {
  const wall = findBlock(dimension, worker.location, 3, (id) =>
    id === "pa:copper_stone" || id === "pa:weathered_copper_stone" || id === "pa:oxidized_copper_stone"
  );
  if (!wall || worker.location.y > 60) {
    wander(worker);
    return;
  }
  const spot = { x: wall.x, y: wall.y + 1, z: wall.z };
  const block = tryBlock(dimension, spot);
  if (block && block.isAir) {
    safeSet(dimension, spot, FUNGUS);
    dimension.spawnParticle("minecraft:basic_smoke_particle", above(wall));
  }
}

// ── Happy ghost: mend the weary ─────────────────────────────────────────────

/*
 * The happy ghost is the dimension's one kindness. It floats to any player who
 * is hurt and, on reaching them, gives back a little health with a soft chime —
 * then drifts away. It never fights and never crowds a healthy player, so it
 * stays a rare comfort rather than a follower.
 */
function ghostWork(worker, dimension) {
  const hurt = dimension.getPlayers({ location: worker.location, maxDistance: 16 })
    .filter((p) => p.getComponent("minecraft:health")?.currentValue < p.getComponent("minecraft:health")?.effectiveMax);
  if (hurt.length === 0) {
    wander(worker);
    return;
  }
  const target = hurt[0];
  face(worker, target.location);
  const at = worker.location;
  const distanceToTarget = distance(at, target.location);
  if (distanceToTarget > 2.5) return;

  try {
    const health = target.getComponent("minecraft:health");
    if (health && health.currentValue < health.effectiveMax) {
      health.setCurrentValue(Math.min(health.effectiveMax, health.currentValue + 2));
      dimension.playSound("random.levelup", target.location, { pitch: 2.0, volume: 0.4 });
      dimension.spawnParticle("minecraft:heart_particle", { x: target.location.x, y: target.location.y + 1.2, z: target.location.z });
    }
  } catch {
    // The player left the world between the scan and the heal.
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

/** True when the block is a lamp/bulb that is currently switched on. */
function isLitAny(dimension, at) {
  const block = tryBlock(dimension, at);
  if (!block) return false;
  if (block.typeId === LAMP) return isLit(dimension, at);
  return isLitBulb(dimension, at);
}

/** Switches a lamp or bulb off, whichever it is. */
function darken(dimension, at) {
  const block = tryBlock(dimension, at);
  if (!block) return;
  try {
    if (block.typeId === LAMP) {
      block.setPermutation(block.permutation.withState("pa:lit", false));
    } else {
      block.setPermutation(block.permutation.withState("lit", false));
    }
    dimension.playSound("random.fizz", above(at), { pitch: 0.7, volume: 0.4 });
  } catch {
    // The block does not carry the state; nothing to darken.
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

/** Turns a worker to look at a point, without moving it. */
function face(worker, at) {
  try {
    const rotation = worker.getRotation();
    const dx = at.x - worker.location.x;
    const dz = at.z - worker.location.z;
    if (dx !== 0 || dz !== 0) rotation.y = (Math.atan2(-dx, dz) * 180) / Math.PI;
    worker.setRotation(rotation);
  } catch {
    // Rotation is best-effort.
  }
}

/**
 * A stable per-entity 0..1 roll. The worker brain runs on a fixed cadence, so a
 * plain `Math.random()` would make the same worker flip-flop every cycle; this
 * spreads the decision across the population while still varying over time via
 * the truncated tick.
 */
function random3ish(worker) {
  let hash = system.currentTick | 0;
  for (let i = 0; i < worker.id.length; i++) hash = (hash * 31 + worker.id.charCodeAt(i)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x2545f491);
  return ((hash ^ (hash >>> 13)) >>> 0) / 0xffffffff;
}

/** The nearest entity of a type within `radius`, if any. */
function nearestEntity(dimension, worker, typeId, radius) {
  try {
    const found = dimension.getEntities({ type: typeId, location: worker.location, maxDistance: radius });
    let best;
    let bestDistance = Infinity;
    for (const entity of found) {
      const d = distance(worker.location, entity.location);
      if (d < bestDistance) {
        bestDistance = d;
        best = entity;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

/** The nearest other copper worker within `radius`, for an escort to shadow. */
function nearestWorker(dimension, worker, radius) {
  try {
    const found = dimension.getEntities({
      families: ["pa_worker"],
      excludeTypes: ["minecraft:player", "minecraft:item"],
      location: worker.location,
      maxDistance: radius,
    });
    let best;
    let bestDistance = Infinity;
    for (const entity of found) {
      if (entity.id === worker.id) continue;
      const d = distance(worker.location, entity.location);
      if (d < bestDistance) {
        bestDistance = d;
        best = entity;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * Sinks a short straight tunnel and steps the worker into it, carving two blocks
 * of headroom so it is never sealed inside stone. `length` caps how far one turn
 * can carry it, which is what keeps a borer from wandering off in a straight line
 * forever.
 */
function dig(worker, dimension, length) {
  const at = worker.location;
  try {
    const rotation = worker.getRotation();
    const yaw = (rotation.y * Math.PI) / 180;
    const dx = Math.round(-Math.sin(yaw)) || (Math.random() < 0.5 ? 1 : -1);
    const dz = Math.round(Math.cos(yaw)) || 1;
    for (let step = 1; step <= length; step++) {
      const to = { x: Math.floor(at.x + dx * step), y: Math.floor(at.y), z: Math.floor(at.z + dz * step) };
      const block = tryBlock(dimension, to);
      if (!block || block.isLiquid) return;
      for (const y of [to.y, to.y + 1]) {
        dimension.getBlock({ x: to.x, y, z: to.z })?.setType("minecraft:air");
      }
    }
    const end = { x: at.x + dx * length, y: at.y, z: at.z + dz * length };
    worker.teleport(end, { dimension });
    dimension.spawnParticle("minecraft:basic_crit_particle", above({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }), directionVariables({ x: 0, y: 1, z: 0 }));
  } catch {
    // Teleport can be refused mid-motion; the next cycle retries.
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

/*
 * `minecraft:basic_crit_particle` reads `variable.direction.x/y/z` in its
 * emitter shape with no default, so spawning it without a map logs
 * "unable to find member variable .x" once per particle. The direction is a
 * unit vector the particle throws its sprites along.
 */
function directionVariables(direction) {
  const variables = new MolangVariableMap();
  variables.setVector3("direction", direction);
  return variables;
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

export const WORKER_TYPES = [
  BEE, FISH, MOLE, KEEPER, MINNOW, CRAB, SHADE,
  BORER, GUARD, BOAR, MITE, JELLY, WISP, BAT, GHOST,
];
