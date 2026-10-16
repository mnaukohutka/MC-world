import { world, system, GameMode, BlockPermutation, BlockVolume, Direction, MolangVariableMap } from "@minecraft/server";
import { dimensionConfigs, registerArrival, travelTo } from "./dimension";
import { safeSubscribe } from '../utils/helper';

/*
 * Portal blocks.
 *
 * There is no portal type to register and no "entity is inside this block"
 * event, so a portal is emulated: poll the block a traveller stands in, hold
 * them there for a moment, then teleport.
 *
 * The same block id works in both directions. Touching it outside the dimension
 * travels in; touching it inside travels back to wherever the traveller came
 * from. That is what makes one field enough — the return portal is just a build
 * step placing the same block.
 *
 * Modelled on the nether portal throughout: build a frame and light it, stand in
 * it for a beat, break the frame and it collapses, and the far side raises its
 * own portal so there is always a way home.
 *
 * Players only. Carrying mobs and dropped items was built and then withdrawn:
 * Bedrock's cross-dimension move is not dependable for a non-player — it reports
 * success and does not always rebuild the entity on the far side — and every way
 * of working around that traded one silent failure for another. A portal that
 * loses a player's animals is worse than one that ignores them.
 */

/** Where the traveller entered from, so the return trip has somewhere to go. */
const ORIGIN_KEY = "mam:portal_origin";

/** Tick of the traveller's last portal use. */
const COOLDOWN_KEY = "mam:portal_tick";

const DEFAULT_COOLDOWN = 300;

/** Mirrors `DimensionPortal.defaultDwellTicks`, for a config written without one. */
const DEFAULT_DWELL = 40;

/** Poll period. Also the granularity of the dwell timer. */
const POLL_TICKS = 4;

/**
 * Block state carrying the frame's axis. Declared by `DimensionExporter`, which
 * rotates the portal plane 90° for `z`; the two names must agree.
 */
const AXIS_STATE = "pa:axis";

let portalIdCache;

/**
 * Block ids that teleport on contact. Empty set means the pack has no portal.
 *
 * Memoized, because the block-break handler needs it and that event is hot.
 * Computed on first use rather than at module evaluation: `registerDimension`
 * runs after this module's import, so the registry is empty until then.
 */
function portalIds() {
  if (portalIdCache === undefined) {
    portalIdCache = new Set();
    for (const config of dimensionConfigs()) {
      const portal = config.portal;
      if (portal && portal.blockId) portalIdCache.add(portal.blockId);
    }
  }
  return portalIdCache;
}

/** The dimension whose portal uses `blockId`, or undefined. */
function portalOwner(blockId) {
  const matches = dimensionConfigs().filter((config) => {
    const portal = config.portal;
    return portal && portal.blockId === blockId;
  });
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    // Two dimensions claiming one block is a mistake the editor cannot see
    // across items, so say which one wins rather than picking silently.
    console.warn(`[dimension] ${matches.length} dimensions use ${blockId} as a portal; using ${matches[0].typeId}`);
  }
  return matches[0];
}

/** `getBlock` throws in an unloaded chunk or outside the world. */
function blockAt(dimension, location) {
  try {
    return dimension.getBlock(location);
  } catch (error) {
    return undefined;
  }
}

/**
 * The portal block oriented for a frame whose interior runs along `axis`.
 *
 * Falls back to the stateless permutation for a pack exported before the block
 * gained its axis state — an old pack must keep working, just unrotated.
 */
function portalPermutation(blockId, axis) {
  try {
    return BlockPermutation.resolve(blockId, { [AXIS_STATE]: axis });
  } catch (error) {
    return BlockPermutation.resolve(blockId);
  }
}

// ── Cooldown ───────────────────────────────────────────────────────────────

/*
 * Without this the feature does not work at all: the arriving traveller lands on
 * or beside the return portal, the next poll sees the same block, and they
 * bounce forever. Vanilla solves it the same way, with a per-entity cooldown.
 */
function onCooldown(traveller, ticks) {
  const last = traveller.getDynamicProperty(COOLDOWN_KEY);
  if (typeof last !== "number") return false;
  // A reloaded world restarts the tick counter, so a stamp from the future is
  // stale rather than a cooldown that lasts until the counter catches up.
  if (last > system.currentTick) return false;
  return system.currentTick - last < ticks;
}

function stampCooldown(traveller) {
  traveller.setDynamicProperty(COOLDOWN_KEY, system.currentTick);
}

// ── Origin ─────────────────────────────────────────────────────────────────

function rememberOrigin(traveller) {
  try {
    const location = traveller.location;
    traveller.setDynamicProperty(
      ORIGIN_KEY,
      JSON.stringify({
        d: String(traveller.dimension.id),
        x: Math.floor(location.x),
        y: Math.floor(location.y),
        z: Math.floor(location.z),
      })
    );
  } catch (error) {
    console.warn(`[dimension] could not remember portal origin: ${error}`);
  }
}

function readOrigin(traveller) {
  const raw = traveller.getDynamicProperty(ORIGIN_KEY);
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.d !== "string") return undefined;
    // The id is resolved by the caller: `getDimension` throws for a dimension a
    // later export removed, and falling back to world spawn beats stranding the
    // traveller.
    return parsed;
  } catch (error) {
    return undefined;
  }
}

/** World spawn, used when a traveller reaches the dimension without a portal. */
function worldSpawn() {
  const dimension = world.getDimension("overworld");
  const spawn = world.getDefaultSpawnLocation();
  // y is 32767 when the world spawn has no fixed height.
  if (Number.isFinite(spawn.y) && spawn.y < 320) return { dimension, location: spawn };
  let y = 64;
  try {
    const top = dimension.getTopmostBlock({ x: spawn.x, z: spawn.z });
    if (top) y = top.y + 1;
  } catch (error) {
    // Chunk not loaded; 64 is above the void in every vanilla overworld.
  }
  return { dimension, location: { x: spawn.x, y, z: spawn.z } };
}

/**
 * The remembered spot, or the ground above it when something has filled it in.
 *
 * A portal can be mined, buried or overgrown while its owner is away, and the
 * stored coordinate is wherever they stood when they left. Landing inside a
 * solid block suffocates, which reads as the portal having eaten them.
 */
function safeReturn(dimension, location, portalBlockId) {
  const block = blockAt(dimension, location);
  // Unloaded: trust the record rather than move the landing on a guess.
  if (!block) return location;
  if (block.isAir || block.isLiquid || block.typeId === portalBlockId) return location;
  try {
    const top = dimension.getTopmostBlock({ x: location.x, z: location.z });
    if (top) return { x: location.x, y: top.y + 1, z: location.z };
  } catch (error) {
    // Nothing better to offer; the original at least matches the record.
  }
  return location;
}

// ── Travel ─────────────────────────────────────────────────────────────────

/*
 * Sound and particles, each isolated.
 *
 * They fail for unrelated reasons — a bad sound id versus an unloaded chunk —
 * and one try block meant a particle error swallowed the sound that had already
 * been queued behind it.
 */
function playPortalSound(traveller, portal) {
  if (!portal.soundId) return;
  try {
    traveller.playSound(portal.soundId);
  } catch (error) {
    console.warn(`[dimension] portal sound "${portal.soundId}" failed: ${error}`);
  }
}

function feedback(traveller, portal) {
  playPortalSound(traveller, portal);

  if (!portal.particleId) return;
  try {
    traveller.dimension.spawnParticle(portal.particleId, traveller.location, particleVariables());
  } catch (error) {
    // Most often LocationInUnloadedChunkError: the chunk the traveller just
    // landed in is loaded but not yet ticking. Cosmetic, so it stays a warning.
    console.warn(`[dimension] portal particle "${portal.particleId}" failed: ${error}`);
  }
}

/*
 * Molang inputs for the particle.
 *
 * Direction-driven vanilla particles read a *vector* — `variable.direction.x`
 * and friends — which is why "unable to find member variable .x" survived
 * setting three scalars. The block supplies it in vanilla; `spawnParticle` does
 * not, and the failure surfaces in the renderer, after the API call returned
 * fine, so no try/catch here can see it.
 *
 * Both forms are supplied because the naming is not uniform across particles,
 * and setting a variable a particle ignores costs nothing.
 */
function particleVariables() {
  const variables = new MolangVariableMap();
  const up = { x: 0, y: 1, z: 0 };
  variables.setVector3("direction", up);
  variables.setFloat("x", up.x);
  variables.setFloat("y", up.y);
  variables.setFloat("z", up.z);
  return variables;
}

function returnHome(traveller, portal) {
  const origin = readOrigin(traveller);
  let target;
  if (origin) {
    try {
      const dimension = world.getDimension(origin.d);
      target = { dimension, location: safeReturn(dimension, { x: origin.x, y: origin.y, z: origin.z }, portal.blockId) };
    } catch (error) {
      target = undefined;
    }
  }
  target = target || worldSpawn();

  // Before the teleport, not after: the destination chunk is not ticking on the
  // arrival tick, so a particle spawned there throws instead of showing.
  feedback(traveller, portal);

  try {
    // Both writes before the teleport: the ordering costs nothing, and the trip
    // out and the trip back are separate uses — the traveller may now be
    // standing on the entry portal.
    traveller.setDynamicProperty(ORIGIN_KEY, undefined);
    stampCooldown(traveller);
    traveller.teleport(target.location, { dimension: target.dimension });
  } catch (error) {
    traveller.sendMessage(`§cCould not return: ${error}`);
  }
}

/** Spawn point of a dimension, defensively — a config could carry anything. */
function spawnOf(config) {
  const spawn = config.spawn || {};
  return {
    x: Number.isFinite(spawn.x) ? spawn.x : 0,
    y: Number.isFinite(spawn.y) ? spawn.y : 64,
    z: Number.isFinite(spawn.z) ? spawn.z : 0,
  };
}

/**
 * One portal contact that has cleared cooldown and dwell. `config` is the
 * dimension owning the block; the traveller may be standing outside it (travel
 * in) or inside it (travel back).
 */
function usePortal(traveller, config) {
  const portal = config.portal;
  if (!portal) return;

  const here = String(traveller.dimension.id);

  if (here === config.typeId) {
    returnHome(traveller, portal);
    return;
  }

  // Inside some *other* custom dimension: its own portal handles its exit, so
  // treat this as a normal trip in rather than a return.
  stampCooldown(traveller);
  rememberOrigin(traveller);
  feedback(traveller, portal);

  void travelTo(traveller, config, linkedArrival(config, traveller.location))
    .then(() => stampCooldown(traveller))
    .catch((error) => console.warn(`[dimension] portal travel failed: ${error}`));
}

// ── Dwell ──────────────────────────────────────────────────────────────────

/*
 * Vanilla makes you stand in a nether portal for a moment before it fires, and
 * skips the wait in creative. Both matter: an instant teleport on contact sends
 * a player who clipped the corner of a portal somewhere they never chose, and a
 * creative builder placing portal blocks wants to step through immediately.
 *
 * Ticks in contact, keyed by entity id. In memory only — a dwell that survived a
 * reload would teleport someone who had walked away and come back.
 */
const dwelling = new Map();

function isCreative(traveller) {
  try {
    const mode = traveller.getGameMode();
    // The enum spelling changed across API versions; both are cheap to accept.
    return mode === GameMode.Creative || mode === "creative";
  } catch (error) {
    return false;
  }
}

/** Ticks this player must hold, after the creative exemption. */
function dwellFor(traveller, portal) {
  const ticks = typeof portal.dwellTicks === "number" ? portal.dwellTicks : DEFAULT_DWELL;
  if (ticks <= 0) return 0;
  return isCreative(traveller) ? 0 : ticks;
}

/**
 * Advances the timer and reports whether the portal may fire. The sound plays on
 * the first sample, so the wait reads as the portal starting up rather than as
 * the block doing nothing.
 */
function dwellReached(traveller, portal) {
  const required = dwellFor(traveller, portal);
  if (required <= 0) return true;

  const soFar = (dwelling.get(traveller.id) || 0) + POLL_TICKS;
  dwelling.set(traveller.id, soFar);
  if (soFar === POLL_TICKS) playPortalSound(traveller, portal);
  return soFar >= required;
}

// ── Detection ──────────────────────────────────────────────────────────────

/*
 * Contact poll. A pack with no portal cancels the loop on its first tick, so it
 * costs one tick rather than one per four forever.
 */
const pollId = system.runInterval(() => {
  const watched = portalIds();
  if (watched.size === 0) {
    system.clearRun(pollId);
    return;
  }

  const seen = new Set();
  for (const player of world.getAllPlayers()) {
    seen.add(player.id);
    poll(player, watched);
  }

  // Anyone who left between polls never reaches `poll`, so their counter would
  // sit in the map forever.
  for (const id of dwelling.keys()) {
    if (!seen.has(id)) dwelling.delete(id);
  }
}, POLL_TICKS);

/** One traveller's contact for this poll. */
function poll(traveller, watched) {
  // The sweep collects entities a few lines before this runs, and a mob can be
  // killed in between. Checked first: every other property throws on a handle
  // this stale, `id` included.
  if (!traveller.isValid) return;

  const hit = touchedPortal(traveller, watched);
  if (!hit) {
    dwelling.delete(traveller.id);
    return;
  }

  const config = portalOwner(hit);
  if (!config) {
    dwelling.delete(traveller.id);
    return;
  }

  const portal = config.portal;
  const cooldown = Math.max(20, portal.cooldownTicks || DEFAULT_COOLDOWN);
  if (onCooldown(traveller, cooldown)) {
    // Not just a skip: the dwell has to start over once the cooldown lifts, or
    // an arriving player standing on the return portal is sent straight back the
    // tick it expires.
    dwelling.delete(traveller.id);
    return;
  }

  // Standing in a portal is also how the registry relearns one it has no record
  // of — built before this pack was added, or dropped by an eviction.
  rememberPortal(traveller.dimension.id, traveller.location, hit);

  if (!dwellReached(traveller, portal)) return;
  dwelling.delete(traveller.id);
  usePortal(traveller, config);
}

/**
 * The portal block a player is touching, or undefined.
 *
 * Two cells, feet and head: a portal is entered by walking into it, and the
 * frame's bottom row is at knee height when you step off a rise.
 *
 * The generated portal block has no collision box, so a player can always enter
 * it — which is the whole reason the block is generated rather than picked.
 */
function touchedPortal(traveller, ids) {
  const at = traveller.location;
  const block = blockAt(traveller.dimension, at);
  if (block && ids.has(block.typeId)) return block.typeId;

  const head = blockAt(traveller.dimension, { x: at.x, y: at.y + 1, z: at.z });
  return head && ids.has(head.typeId) ? head.typeId : undefined;
}

// ── Portal registry ────────────────────────────────────────────────────────

/*
 * Every portal the runtime has seen: lit by a player, raised on arrival, or
 * stood in. Linking reads it to decide whether a trip needs a new portal at the
 * far end, and the mob sweep reads it to know where to look.
 *
 * Persisted, unlike the rest of this module's state. A registry that emptied on
 * reload would raise a second portal beside every existing one the first time
 * anybody travelled after a restart.
 */
const REGISTRY_KEY = "mam:portals";

/** Entries kept. At ~50 bytes each this is nowhere near the property's ceiling. */
const REGISTRY_MAX = 128;

let registryCache;

function keyOf(entry) {
  return `${entry.d} ${entry.x},${entry.y},${entry.z}`;
}

function registry() {
  if (registryCache === undefined) {
    registryCache = new Map();
    try {
      const raw = world.getDynamicProperty(REGISTRY_KEY);
      if (typeof raw === "string") {
        for (const entry of JSON.parse(raw)) {
          // Hand-checked rather than trusted: this survives across exports, and
          // a half-written entry would poison every lookup that reads it.
          if (entry && typeof entry.d === "string" && typeof entry.b === "string") registryCache.set(keyOf(entry), entry);
        }
      }
    } catch (error) {
      console.warn(`[dimension] could not read the portal registry: ${error}`);
    }
  }
  return registryCache;
}

function saveRegistry() {
  try {
    world.setDynamicProperty(REGISTRY_KEY, JSON.stringify([...registry().values()]));
  } catch (error) {
    console.warn(`[dimension] could not save the portal registry: ${error}`);
  }
}

/**
 * Cells this close to a recorded one belong to the same portal.
 *
 * Without it the registry counts cells, not portals: a player walking through an
 * ordinary 2x3 doorway touches six of them, and six entries for one portal would
 * push everything else out of a list this size in an afternoon.
 */
const SAME_PORTAL_RADIUS = 3;

function rememberPortal(dimensionId, location, blockId) {
  const entry = {
    d: String(dimensionId),
    x: Math.floor(location.x),
    y: Math.floor(location.y),
    z: Math.floor(location.z),
    b: blockId,
  };
  const map = registry();
  const key = keyOf(entry);
  if (map.has(key)) return;

  // Checked after the exact cell, which is the hot path: a player standing still
  // in a portal comes through here every poll.
  const near = findPortal(entry.d, entry, SAME_PORTAL_RADIUS);
  if (near && near.b === entry.b) return;

  // Oldest out first: Map iterates in insertion order, so the front of it is the
  // portal least recently discovered.
  if (map.size >= REGISTRY_MAX) map.delete(map.keys().next().value);
  map.set(key, entry);
  saveRegistry();
}

function forgetPortal(entry) {
  if (!registry().delete(keyOf(entry))) return;
  saveRegistry();
}

/** The recorded portal nearest `near` in `dimensionId`, within `radius`. */
function findPortal(dimensionId, near, radius) {
  let best;
  let bestDistance = Infinity;
  for (const entry of registry().values()) {
    if (entry.d !== dimensionId) continue;
    const distance = Math.hypot(entry.x - near.x, entry.y - near.y, entry.z - near.z);
    if (distance > radius || distance >= bestDistance) continue;
    best = entry;
    bestDistance = distance;
  }
  return best;
}

// ── Linking ────────────────────────────────────────────────────────────────

/*
 * A nether portal leads somewhere derived from where it stands, not to one fixed
 * spawn, and that is what makes a second portal worth building. The same idea
 * here, at 1:1 — but clamped into the dimension's authored build.
 *
 * The clamp is the whole difference from vanilla, and it is not a shortcut: a
 * custom dimension is void everywhere the recipe did not touch, so a faithful
 * scaled coordinate would drop players into nothing a thousand blocks from the
 * only floor in the world.
 */

/** Room for the frame ring, so a clamped target cannot straddle the edge. */
const LINK_MARGIN = 2;

/** Half-box used when a recipe places nothing positional to measure. */
const LINK_SPREAD = 32;

/**
 * Reuse a recorded portal within this of the target instead of raising one.
 *
 * A sixteenth of vanilla's 128, and it has to be: vanilla searches an infinite
 * nether, while every link here is clamped into a build that is often only tens
 * of blocks across. At 128 every portal in a pack would collapse onto the first
 * one raised, which is the behaviour linking exists to end.
 */
const LINK_RADIUS = 8;

/**
 * How far the resolver may look for a portal that appeared while it waited.
 *
 * Smaller than [LINK_RADIUS] on purpose: `travelTo` anchored its ticking area on
 * the target, so a spot further out than this may not be loaded, and a block
 * read there would report the portal missing and condemn a standing one.
 */
const RELINK_RADIUS = 4;

/**
 * Blocks of floor a portal needs on either side of it.
 *
 * Room to step out of a doorway, and the measure the rim check uses: ground
 * directly under the portal is not enough when the block beside it is void.
 */
const STEP_OUT_ROOM = 2;

/**
 * Slack on the held area, over and above the target and the spawn.
 *
 * It has to cover everywhere the resolver can put someone, not just where it was
 * aimed: [RELINK_RADIUS] for a portal that appeared nearby while it waited, plus
 * [STEP_OUT_ROOM] so the arrival can walk out of it, plus room for the frame.
 * A landing outside the area is a landing in chunks nobody is holding — which
 * for an entity means it leaves here and never arrives there.
 */
const ARRIVAL_PAD = RELINK_RADIUS + STEP_OUT_ROOM + 4;

/** Ceiling on the ground scan, in blocks. Covers a full-height build. */
const GROUND_SCAN_MAX = 192;

/**
 * How far `DimensionSteps.boundsOf` pads a recipe's real extent.
 *
 * That padding exists to size a ticking area, not to describe where the floor
 * is. Clamping into the padded box put every link on the outermost solid block
 * of the build — the rim — and a player arriving there stepped straight off it.
 */
const BOUNDS_PADDING = 2;

/** The volume a link may land in: the build's own footprint, without the padding. */
function linkBox(config) {
  const bounds = config.bounds;
  if (bounds && bounds.from && bounds.to) {
    // Horizontal only. The scan wants the full vertical range, and reading a
    // couple of blocks above the build costs nothing.
    return {
      from: { x: bounds.from.x + BOUNDS_PADDING, y: bounds.from.y, z: bounds.from.z + BOUNDS_PADDING },
      to: { x: bounds.to.x - BOUNDS_PADDING, y: bounds.to.y, z: bounds.to.z - BOUNDS_PADDING },
    };
  }
  const spawn = spawnOf(config);
  return {
    from: { x: spawn.x - LINK_SPREAD, y: spawn.y - LINK_SPREAD, z: spawn.z - LINK_SPREAD },
    to: { x: spawn.x + LINK_SPREAD, y: spawn.y + LINK_SPREAD, z: spawn.z + LINK_SPREAD },
  };
}

function clampAxis(value, a, b) {
  const min = Math.min(a, b) + LINK_MARGIN;
  const max = Math.max(a, b) - LINK_MARGIN;
  // A build narrower than its own margins has no room to spread links across;
  // everything funnels to the middle, which is the best answer available.
  if (max < min) return Math.floor((a + b) / 2);
  return Math.min(max, Math.max(min, value));
}

/**
 * Where a portal standing at `from` should lead. Pure arithmetic on the config,
 * so it can run before any chunk is loaded — which is what lets `travelTo`
 * anchor its ticking area on the answer.
 */
function linkTarget(config, from) {
  const box = linkBox(config);
  return {
    x: clampAxis(Math.floor(from.x), box.from.x, box.to.x),
    y: Math.floor(spawnOf(config).y),
    z: clampAxis(Math.floor(from.z), box.from.z, box.to.z),
  };
}

/**
 * The first free cell above solid ground in this column, or undefined when the
 * column is empty all the way down.
 *
 * Scans from the top of the build rather than from the traveller's own height:
 * the two dimensions share no vertical frame of reference, and a player entering
 * at y=12 in a cave has no business landing at y=12 in a sky platform.
 */
function groundBase(dimension, x, z, box, spawnY) {
  const top = Math.max(box.to.y, spawnY) + 1;
  const bottom = Math.min(box.from.y, spawnY) - 1;
  for (let y = top; y >= bottom && top - y <= GROUND_SCAN_MAX; y--) {
    const block = blockAt(dimension, { x, y, z });
    if (block && !block.isAir && !block.isLiquid) return y + 1;
  }
  return undefined;
}

/** Sites tried between the clamped target and the spawn before giving up. */
const SITE_ATTEMPTS = 6;

/**
 * Is there floor under the portal *and* under a step out of it?
 *
 * Ground directly beneath is not enough. The rim of a platform has ground under
 * the portal and void one block over, which is how an arrival became a fall.
 */
function standingRoom(dimension, x, z, base, width) {
  for (let dx = -STEP_OUT_ROOM; dx <= STEP_OUT_ROOM; dx++) {
    for (let dz = -1; dz <= width; dz++) {
      const under = blockAt(dimension, { x: x + dx, y: base - 1, z: z + dz });
      if (!under || under.isAir) return false;
    }
  }
  return true;
}

/**
 * The first spot between the clamped target and the spawn with real standing
 * room, or undefined when the build offers none.
 *
 * Walking inward rather than refusing outright: the target is already inside the
 * build, so the ground it wants is usually a few blocks further in.
 */
function safeSite(dimension, config, at, width) {
  const spawn = spawnOf(config);
  const box = linkBox(config);
  for (let i = 0; i <= SITE_ATTEMPTS; i++) {
    const t = i / SITE_ATTEMPTS;
    const x = Math.round(at.x + (spawn.x - at.x) * t);
    const z = Math.round(at.z + (spawn.z - at.z) * t);
    const base = groundBase(dimension, x, z, box, spawn.y);
    if (base !== undefined && standingRoom(dimension, x, z, base, width)) return { x, y: base, z };
  }
  return undefined;
}

/**
 * Builds a portal at `at` and returns the cell to land in, or undefined.
 *
 * This is the counterpart to a nether portal materialising on the far side, and
 * it is why a link never needs the player to have been there before.
 */
function raisePortal(dimension, config, at, onRecordedSite) {
  const portal = config.portal;
  const frame = portal.frame;
  const width = Math.max(1, frame ? frame.minWidth : RETURN_PORTAL_WIDTH);
  const height = Math.max(1, frame ? frame.minHeight : RETURN_PORTAL_HEIGHT);

  const spawnY = spawnOf(config).y;

  // A recorded site was ground-resolved when it was first raised, and its own
  // frame is usually still standing. Scanning again would find the top of that
  // frame and stack a second portal on the first.
  let site;
  if (onRecordedSite) {
    site = { x: at.x, y: Math.floor(at.y), z: at.z };
  } else {
    // Real floor if the build has any within reach, otherwise the target as
    // clamped — which the pad below then makes standable.
    site = safeSite(dimension, config, at, width) || {
      x: at.x,
      y: groundBase(dimension, at.x, at.z, linkBox(config), spawnY) ?? Math.floor(spawnY),
      z: at.z,
    };
  }

  const from = { x: site.x, y: site.y, z: site.z };
  const to = { x: site.x, y: site.y + height - 1, z: site.z + width - 1 };

  // Covers both a column that is void all the way down and a spot on the rim
  // with ground under the portal and nothing beside it.
  const needsPad = !onRecordedSite && !standingRoom(dimension, site.x, site.z, site.y, width);

  try {
    if (frame && frame.blockId) {
      if (needsPad) fillPad(dimension, from, to, frame.blockId);
      fillRing(dimension, from, to, frame.blockId);
    }
    dimension.fillBlocks(new BlockVolume(from, to), portalPermutation(portal.blockId, "z"));
  } catch (error) {
    console.warn(`[dimension] could not raise a linked portal in ${config.typeId}: ${error}`);
    return undefined;
  }

  rememberPortal(dimension.id, from, portal.blockId);
  return from;
}

/**
 * The arrival a portal hands `travelTo`: an anchor it can hold chunks open
 * around, and a resolver that runs once they are.
 *
 * Split in two because the halves need opposite things — the anchor must be
 * knowable with no chunks loaded, and the resolver needs them loaded.
 */
function linkedArrival(config, from) {
  const portal = config.portal;
  if (!portal || portal.linkByPosition === false) return undefined;

  const target = linkTarget(config, from);
  const existing = findPortal(config.typeId, target, LINK_RADIUS);
  const at = existing ? { x: existing.x, y: existing.y, z: existing.z } : target;

  // Spanning the spawn as well as the target, because the resolver may walk the
  // site inward looking for floor, and a spot it has not loaded reads as void.
  // Both ends sit inside the build, so this is bounded by the recipe's own size.
  const spawn = spawnOf(config);
  const span = (a, b, pad) => ({ lo: Math.min(a, b) - pad, hi: Math.max(a, b) + pad });
  const x = span(at.x, spawn.x, ARRIVAL_PAD);
  const y = span(at.y, spawn.y, ARRIVAL_PAD);
  const z = span(at.z, spawn.z, ARRIVAL_PAD);

  return {
    at,
    area: { from: { x: x.lo, y: y.lo, z: z.lo }, to: { x: x.hi, y: y.hi, z: z.hi } },
    resolve: (dimension) => {
      // Looked up again rather than reused from above: `travelTo` awaited its
      // chunks in between, and another player travelling alongside may have
      // raised this very portal while it did. Without the recheck both of them
      // build one, a few blocks apart.
      const current = findPortal(config.typeId, at, RELINK_RADIUS) || existing;
      if (current) {
        const spot = { x: current.x, y: current.y, z: current.z };
        const block = blockAt(dimension, spot);
        if (block && block.typeId === portal.blockId) return spot;
        // Mined or collapsed while its owner was away. The site itself is still
        // a legal one, and its chunks are the loaded ones, so rebuild there
        // rather than sending the traveller somewhere new.
        forgetPortal(current);
        return raisePortal(dimension, config, spot, true);
      }
      return raisePortal(dimension, config, at);
    },
  };
}

// ── Frames ─────────────────────────────────────────────────────────────────

/*
 * Nether-portal-style construction: build a frame, light it with an item, the
 * interior fills with the portal block. From then on it is an ordinary portal —
 * the travel code above does not know a frame was involved.
 *
 * Vanilla's ceiling on the interior. Also the scan's guard rail: without it one
 * gap in a frame would let the walk run to the chunk edge.
 */
const FRAME_MAX = 21;

/** Step one block along a clicked face. */
function faceOffset(face) {
  switch (face) {
    case Direction.Up:
      return { x: 0, y: 1, z: 0 };
    case Direction.Down:
      return { x: 0, y: -1, z: 0 };
    case Direction.North:
      return { x: 0, y: 0, z: -1 };
    case Direction.South:
      return { x: 0, y: 0, z: 1 };
    case Direction.East:
      return { x: 1, y: 0, z: 0 };
    case Direction.West:
      return { x: -1, y: 0, z: 0 };
    default:
      return { x: 0, y: 0, z: 0 };
  }
}

/** The dimension lit by `itemId` when used on `blockId`, or undefined. */
function igniterOwner(itemId, blockId) {
  return dimensionConfigs().find((config) => {
    const frame = config.portal && config.portal.frame;
    return frame && frame.igniterId === itemId && frame.blockId === blockId;
  });
}

/** Interior cells are empty air or an already-lit portal block. */
function isInterior(block, portalBlockId) {
  if (!block) return false;
  return block.isAir || block.typeId === portalBlockId;
}

/**
 * First interior cell to scan from. The player clicks a *frame* block, so step
 * through the clicked face; a click on the frame's top (the common case for a
 * base block) lands on the frame itself, so try straight up as a fallback.
 */
function seedFrom(dimension, at, face, portalBlockId) {
  const offset = faceOffset(face);
  const candidates = [
    { x: at.x + offset.x, y: at.y + offset.y, z: at.z + offset.z },
    { x: at.x, y: at.y + 1, z: at.z },
  ];
  for (const candidate of candidates) {
    if (isInterior(blockAt(dimension, candidate), portalBlockId)) return candidate;
  }
  return undefined;
}

/**
 * Walk from `seed` along `axis` in `step` until the frame block stops it.
 * Returns the last interior coordinate, or undefined when the run is unbounded,
 * over-long, or blocked by something that is neither interior nor frame.
 */
function walk(dimension, seed, axis, step, frameBlockId, portalBlockId) {
  let last = seed[axis];
  for (let i = 1; i <= FRAME_MAX + 1; i++) {
    const probe = { x: seed.x, y: seed.y, z: seed.z };
    probe[axis] = seed[axis] + step * i;
    const block = blockAt(dimension, probe);
    if (!block) return undefined;
    if (block.typeId === frameBlockId) return last;
    if (!isInterior(block, portalBlockId)) return undefined;
    last = probe[axis];
  }
  return undefined;
}

/**
 * Interior rectangle in the plane whose horizontal axis is `axis`, or undefined.
 *
 * Walks a cross through the seed for the extents, then verifies every interior
 * cell and the frame ring around it. Corners are exempt, as in vanilla.
 */
function scanPlane(dimension, seed, axis, frame, portalBlockId) {
  const other = axis === "x" ? "z" : "x";
  const lo = walk(dimension, seed, axis, -1, frame.blockId, portalBlockId);
  const hi = walk(dimension, seed, axis, 1, frame.blockId, portalBlockId);
  const bottom = walk(dimension, seed, "y", -1, frame.blockId, portalBlockId);
  const top = walk(dimension, seed, "y", 1, frame.blockId, portalBlockId);
  if (lo === undefined || hi === undefined || bottom === undefined || top === undefined) return undefined;

  const width = hi - lo + 1;
  const height = top - bottom + 1;
  if (width < (frame.minWidth || 1) || height < (frame.minHeight || 1)) return undefined;
  if (width > FRAME_MAX || height > FRAME_MAX) return undefined;

  const cell = (h, y) => {
    const location = { x: seed.x, y, z: seed.z };
    location[axis] = h;
    location[other] = seed[other];
    return location;
  };

  let alreadyLit = true;
  for (let h = lo; h <= hi; h++) {
    for (let y = bottom; y <= top; y++) {
      const block = blockAt(dimension, cell(h, y));
      if (!isInterior(block, portalBlockId)) return undefined;
      if (block.typeId !== portalBlockId) alreadyLit = false;
    }
    // Frame above and below this column.
    for (const y of [bottom - 1, top + 1]) {
      const block = blockAt(dimension, cell(h, y));
      if (!block || block.typeId !== frame.blockId) return undefined;
    }
  }
  for (let y = bottom; y <= top; y++) {
    for (const h of [lo - 1, hi + 1]) {
      const block = blockAt(dimension, cell(h, y));
      if (!block || block.typeId !== frame.blockId) return undefined;
    }
  }

  // The axis rides along so the fill can rotate the plane into the frame rather
  // than leaving every portal facing the same way.
  return { from: cell(lo, bottom), to: cell(hi, top), axis, alreadyLit };
}

/**
 * The interior to fill, or undefined when this is not a portal waiting to be
 * lit. Read-only, so it can run inside a `before` handler.
 */
function planIgnition(dimension, at, face, config) {
  const frame = config.portal.frame;
  const portalBlockId = config.portal.blockId;

  const seed = seedFrom(dimension, at, face, portalBlockId);
  if (!seed) return undefined;

  // Both vertical planes: a frame stands in one of them and the player has no
  // way to tell us which.
  const rect = scanPlane(dimension, seed, "x", frame, portalBlockId) || scanPlane(dimension, seed, "z", frame, portalBlockId);
  if (!rect || rect.alreadyLit) return undefined;
  return rect;
}

function lightPortal(player, config, rect) {
  try {
    player.dimension.fillBlocks(new BlockVolume(rect.from, rect.to), portalPermutation(config.portal.blockId, rect.axis));
  } catch (error) {
    console.warn(`[dimension] could not light the portal for ${config.typeId}: ${error}`);
    return;
  }
  rememberPortal(player.dimension.id, rect.from, config.portal.blockId);
  feedback(player, config.portal);
  player.sendMessage(`§aPortal to ${config.label} opened.`);
}

/*
 * The frame is scanned here, in the `before` handler, so the interaction is
 * cancelled only when it really is a portal. An invalid frame is left alone
 * entirely — no message, and the igniter behaves as vanilla, which beats eating
 * the use and saying nothing.
 *
 * `before` handlers may read the world but not write it, so the fill is deferred
 * to `system.run`.
 */
safeSubscribe(world.beforeEvents.playerInteractWithBlock, (event) => {
  if (!event.isFirstEvent) return;
  const item = event.itemStack;
  const block = event.block;
  if (!item || !block) return;

  const config = igniterOwner(item.typeId, block.typeId);
  if (!config) return;

  const player = event.player;
  const rect = planIgnition(player.dimension, block.location, event.blockFace, config);
  if (!rect) return;

  event.cancel = true;
  system.run(() => lightPortal(player, config, rect));
}, 'world.beforeEvents.playerInteractWithBlock');

// ── Collapse ───────────────────────────────────────────────────────────────

/*
 * A portal dies with its frame, as in vanilla.
 *
 * The rule is simply "a broken block next to a portal block collapses it", which
 * needs no knowledge of which block was broken: the only things touching a
 * portal block are its own frame and other portal blocks. It also gets corners
 * right for free — a corner is diagonal to the interior, so breaking one leaves
 * the portal standing, which is what the scan's corner-optional rule implies.
 */

/** Cap on one collapse: the largest legal interior plus slack. */
const COLLAPSE_MAX = 512;

function neighbours(at) {
  return [
    { x: at.x + 1, y: at.y, z: at.z },
    { x: at.x - 1, y: at.y, z: at.z },
    { x: at.x, y: at.y + 1, z: at.z },
    { x: at.x, y: at.y - 1, z: at.z },
    { x: at.x, y: at.y, z: at.z + 1 },
    { x: at.x, y: at.y, z: at.z - 1 },
  ];
}

/** Flood-remove every portal block connected to `from`. */
function collapsePortal(dimension, from, portalBlockId) {
  const seen = new Set();
  const queue = [from];
  let removed = 0;

  while (queue.length > 0 && removed < COLLAPSE_MAX) {
    const at = queue.pop();
    const key = `${at.x},${at.y},${at.z}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const block = blockAt(dimension, at);
    if (!block || block.typeId !== portalBlockId) continue;

    try {
      block.setType("minecraft:air");
      removed++;
    } catch (error) {
      continue;
    }
    for (const next of neighbours(at)) queue.push(next);
  }
}

safeSubscribe(world.afterEvents.playerBreakBlock, (event) => {
  const dimension = event.dimension;
  const ids = portalIds();
  if (ids.size === 0) return;

  for (const at of neighbours(event.block.location)) {
    const block = blockAt(dimension, at);
    if (!block || !ids.has(block.typeId)) continue;
    // Deferred: an after handler may write, but collapsing from inside the break
    // event has broken drops before on other blocks.
    const typeId = block.typeId;
    system.run(() => collapsePortal(dimension, at, typeId));
  }
}, 'world.afterEvents.playerBreakBlock');

// ── Return portal ──────────────────────────────────────────────────────────

/*
 * Vanilla raises the linked portal for you, and players expect that: arriving in
 * a void dimension with no way out reads as a bug. So every arrival — by menu,
 * item, command or portal — makes sure one stands next to the landing spot.
 *
 * Idempotent: it checks for the portal block before placing anything, so it
 * costs one block read per arrival once the portal exists.
 */

/** Blocks clear of the landing spot, so a player never lands inside it. */
const RETURN_PORTAL_OFFSET = 3;

/** Interior of the raised portal when the dimension configures no frame. */
const RETURN_PORTAL_WIDTH = 2;
const RETURN_PORTAL_HEIGHT = 3;

function ensureReturnPortal(player, config) {
  const portal = config.portal;
  if (!portal || !portal.blockId) return;

  // Came through a portal, so they are standing in one already. Raising a second
  // at the spawn is where "why are there two portals in here?" came from: the
  // linked arrival is the way home, and the spawn copy is only needed by the
  // routes that do not involve a portal at all — menu, item, command.
  const landed = findPortal(String(player.dimension.id), player.location, SAME_PORTAL_RADIUS);
  if (landed && landed.b === portal.blockId) return;

  const spawn = spawnOf(config);
  const frame = portal.frame;
  const width = Math.max(1, frame ? frame.minWidth : RETURN_PORTAL_WIDTH);
  const height = Math.max(1, frame ? frame.minHeight : RETURN_PORTAL_HEIGHT);

  // Runs along Z so the offset along X keeps the whole portal clear of the
  // player, however wide it is.
  const x = Math.floor(spawn.x) + RETURN_PORTAL_OFFSET;
  const z0 = Math.floor(spawn.z);
  const y0 = Math.floor(spawn.y);
  const interiorFrom = { x, y: y0, z: z0 };
  const interiorTo = { x, y: y0 + height - 1, z: z0 + width - 1 };

  const dimension = player.dimension;
  const existing = blockAt(dimension, interiorFrom);
  if (!existing) return; // chunk not loaded yet; the next arrival retries
  if (existing.typeId === portal.blockId) {
    rememberPortal(dimension.id, interiorFrom, portal.blockId);
    return;
  }

  try {
    // The frame first: filling the interior second means a frame block can
    // never overwrite a portal block.
    if (frame && frame.blockId) {
      fillRing(dimension, interiorFrom, interiorTo, frame.blockId);
    }
    // The interior spans Z, so the plane has to be the one rotated to match.
    dimension.fillBlocks(new BlockVolume(interiorFrom, interiorTo), portalPermutation(portal.blockId, "z"));
    rememberPortal(dimension.id, interiorFrom, portal.blockId);
  } catch (error) {
    console.warn(`[dimension] could not raise the return portal in ${config.typeId}: ${error}`);
  }
}

/**
 * One layer of floor under a raised portal, a block wider than the frame on
 * every side, for a column the recipe left hollow.
 *
 * Laid before the ring, which reaches the same row: both are the frame block, so
 * the overlap is the same block written twice.
 */
function fillPad(dimension, from, to, blockId) {
  // Wide enough for [STEP_OUT_ROOM]: over a hollow column the spot beside the
  // portal needs a floor as much as the portal itself does.
  const reach = STEP_OUT_ROOM + 1;
  dimension.fillBlocks(
    new BlockVolume({ x: from.x - reach, y: from.y - 1, z: from.z - 2 }, { x: from.x + reach, y: from.y - 1, z: to.z + 2 }),
    BlockPermutation.resolve(blockId)
  );
}

/**
 * Frame ring around an interior that spans Z and Y at a fixed X. Corners are
 * included — nothing here has to match vanilla's corner-optional rule, and a
 * closed ring is what the scan would accept if a player rebuilt it.
 */
function fillRing(dimension, from, to, blockId) {
  const permutation = BlockPermutation.resolve(blockId);
  const spans = [
    // Below and above.
    [{ x: from.x, y: from.y - 1, z: from.z - 1 }, { x: from.x, y: from.y - 1, z: to.z + 1 }],
    [{ x: from.x, y: to.y + 1, z: from.z - 1 }, { x: from.x, y: to.y + 1, z: to.z + 1 }],
    // Either side.
    [{ x: from.x, y: from.y, z: from.z - 1 }, { x: from.x, y: to.y, z: from.z - 1 }],
    [{ x: from.x, y: from.y, z: to.z + 1 }, { x: from.x, y: to.y, z: to.z + 1 }],
  ];
  for (const [a, b] of spans) {
    dimension.fillBlocks(new BlockVolume(a, b), permutation);
  }
}

registerArrival(ensureReturnPortal);
