import {
  world,
  system,
  CustomCommandStatus,
  CustomCommandParamType,
  CommandPermissionLevel,
} from "@minecraft/server";
import { safeSubscribe } from "../utils/helper";
import { BIOMES, biomeFor, biomeAtColumn, predictedSurface } from "./terrain";
import {
  PLAN_CELLS,
  LANDMARK_KINDS,
  buildAt,
  chestAt,
  landmarkAt,
  groundY,
  BUILDS,
} from "../structures";

/*
 * `/locate` for the Copper Dimension.
 *
 * The world is generated in script and every point of interest is decided from
 * its coordinates and the world seed alone, so the search here needs no scan: it
 * walks the plan grids outward from the player and reports the first cell whose
 * roll produced the thing being looked for. That is why the builders expose
 * `buildAt` / `chestAt` / `landmarkAt` — the command and the generator run the
 * same arithmetic, so a reported spot is always a spot that exists.
 *
 * Two commands are registered:
 *   /locate:structure <kind>  — a build, a chest, or a landmark kind
 *   /locate:biome     <biome> — the nearest column of a copper biome
 *
 * A biome is a slowly varying noise field rather than a discrete cell, so its
 * search walks outward in rings of columns and returns the first column that
 * classifies as the target. The biome is decided from `biomeAtColumn`, the same
 * function the terrain generator uses on the surface.
 */

const NAMESPACE = "locate";

/*
 * How far each search will look.
 *
 * The biome field is low-frequency, so its search covers thousands of blocks;
 * the perimeter walk below keeps that affordable. The cap is deliberate: a
 * command callback runs on the main thread, and an unbounded loop would trip the
 * script watchdog on a world where the target does not exist nearby.
 */
const STRUCTURE_RANGE_BLOCKS = 2048;  // blocks out from the player
const BIOME_RANGE = 1600;             // blocks out from the player
const BIOME_STEP = 8;                 // sampling step between columns

/** The structure kinds a player can name, mapped to how each is planned. */
const STRUCTURE_KINDS = {
  build: "build",
  chest: "chest",
  ...Object.fromEntries(BUILDS.map((id) => [enumToken(id), "build"])),
  ...Object.fromEntries(LANDMARK_KINDS.map((kind) => [kind, "landmark"])),
};

/*
 * A build id is matched by its file name ("copper_lucerna-A1"), which carries
 * hyphens and capitals — neither of which a command enum accepts. The token is
 * folded to lowercase with underscores, and a `tokens` map holds the reverse so
 * a search can go back to the real id.
 */
const TOKENS = new Map();
for (const id of BUILDS) TOKENS.set(enumToken(id), id);
for (const kind of LANDMARK_KINDS) TOKENS.set(kind, kind);

function enumToken(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

const KIND_VALUES = ["build", "chest", ...TOKENS.keys()];

/*
 * The cells to try, nearest first, as a square spiral. A cell is `PLAN_CELLS`
 * tiles wide, so the same block range is a different number of cells for each
 * plan; the spiral is built once, out to the widest of them, and a search stops
 * early on its own limit.
 */
function spiralCells(range) {
  const cells = [{ x: 0, z: 0 }];
  for (let r = 1; r <= range; r++) {
    for (let d = -r; d <= r; d++) {
      cells.push({ x: d, z: -r }, { x: d, z: r }, { x: -r, z: d }, { x: r, z: d });
    }
  }
  return cells;
}

/** How many cells of a plan fit inside the search range. */
function cellsFor(plan) {
  return Math.ceil(STRUCTURE_RANGE_BLOCKS / (PLAN_CELLS[plan] * 16));
}

const SPIRAL = spiralCells(Math.max(cellsFor("build"), cellsFor("chest"), cellsFor("landmark")));

/** Registers both commands against the dimension, at startup. */
export function installLocateCommand(options) {
  safeSubscribe(
    system.beforeEvents.startup,
    (event) => {
      const registry = event.customCommandRegistry;
      if (!registry) return;

      try {
        registry.registerEnum(`${NAMESPACE}:structures`, KIND_VALUES);
        registry.registerEnum(
          `${NAMESPACE}:biomes`,
          BIOMES.map((biome) => biome.key)
        );
      } catch (error) {
        console.warn(`[locate] could not register the enums: ${error}`);
      }

      registerStructureCommand(registry, options);
      registerBiomeCommand(registry, options);
    },
    "system.beforeEvents.startup"
  );
}

function registerStructureCommand(registry, options) {
  try {
    registry.registerCommand(
      {
        name: `${NAMESPACE}:structure`,
        description: "Find the nearest copper build, chest or landmark.",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
          { name: `${NAMESPACE}:structures`, type: CustomCommandParamType.Enum },
        ],
      },
      (origin, kind) => locateStructure(origin, kind, options)
    );
  } catch (error) {
    console.warn(`[locate] could not register /locate:structure: ${error}`);
  }
}

function registerBiomeCommand(registry, options) {
  try {
    registry.registerCommand(
      {
        name: `${NAMESPACE}:biome`,
        description: "Find the nearest column of a copper biome.",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
          { name: `${NAMESPACE}:biomes`, type: CustomCommandParamType.Enum },
        ],
      },
      (origin, key) => locateBiome(origin, key, options)
    );
  } catch (error) {
    console.warn(`[locate] could not register /locate:biome: ${error}`);
  }
}

/** The player or command-block entity that ran the command. */
function originEntity(origin) {
  return origin?.initiator ?? origin?.sourceEntity;
}

function locateStructure(origin, kind, options) {
  const entity = originEntity(origin);
  if (!entity) {
    return { status: CustomCommandStatus.Failure, message: "This command needs a position to search from." };
  }

  const plan = STRUCTURE_KINDS[kind];
  if (!plan) {
    return { status: CustomCommandStatus.Failure, message: `Unknown structure "${kind}".` };
  }
  // The enum hands back a folded token; the planner wants the real build id.
  const target = TOKENS.get(kind) ?? kind;

  const cell = PLAN_CELLS[plan];
  const at = entity.location;
  const centerX = Math.floor(at.x / 16 / cell);
  const centerZ = Math.floor(at.z / 16 / cell);
  const limit = cellsFor(plan);

  const found = searchStructure(plan, target, centerX, centerZ, limit);
  if (!found) {
    return { status: CustomCommandStatus.Failure, message: `No ${labelFor(target)} within ${STRUCTURE_RANGE_BLOCKS} blocks.` };
  }

  return report(entity, found, options, labelFor(found.kind));
}

/** Walks the plan grid outward and returns the first matching cell's position. */
function searchStructure(plan, kind, centerX, centerZ, limit) {
  for (const step of SPIRAL) {
    if (Math.max(Math.abs(step.x), Math.abs(step.z)) > limit) break;
    const cx = centerX + step.x;
    const cz = centerZ + step.z;
    let hit;
    if (plan === "build") {
      const build = buildAt(cx, cz);
      if (!build) continue;
      // "build" matches any build; a named build matches only its own id.
      if (kind !== "build" && build.id !== kind) continue;
      hit = { kind: build.id, x: build.x, z: build.z, y: undefined };
    } else if (plan === "chest") {
      const chest = chestAt(cx, cz);
      if (!chest) continue;
      hit = { kind: "chest", x: chest.x, z: chest.z, y: undefined };
    } else {
      const landmark = landmarkAt(cx, cz);
      if (!landmark || landmark.kind !== kind) continue;
      hit = landmark;
    }
    return hit;
  }
  return undefined;
}

/**
 * Fills in the Y of a found structure and formats the reply.
 *
 * A buried landmark already knows its Y from the depth table. A surface build
 * does not: its Y is the ground, which only exists once a player has been near
 * enough for the terrain generator to run. A loaded column reports its real
 * height; an unloaded one falls back to the generator's own predicted surface,
 * which is the height it will have when it is finally built.
 */
function report(entity, found, options, label) {
  const dimensionId = options && options.typeId;
  const dimension = dimensionId ? world.getDimension(dimensionId) : entity.dimension;

  let y = found.y;
  if (y === undefined) {
    const real = groundY(dimension, found.x, found.z);
    y = real ?? predictedSurface(found.x, found.z) + 1;
  }

  const dx = found.x - entity.location.x;
  const dz = found.z - entity.location.z;
  const distance = Math.floor(Math.sqrt(dx * dx + dz * dz));
  const direction = compass(dx, dz);

  return {
    status: CustomCommandStatus.Success,
    message:
      `§aThe nearest ${label} is at §b${found.x}, ${y}, ${found.z}§a ` +
      `(${distance} blocks ${direction}).`,
  };
}

function locateBiome(origin, key, options) {
  const entity = originEntity(origin);
  if (!entity) {
    return { status: CustomCommandStatus.Failure, message: "This command needs a position to search from." };
  }

  const biome = biomeFor(key);
  if (!biome) {
    return { status: CustomCommandStatus.Failure, message: `Unknown biome "${key}".` };
  }

  const at = entity.location;
  const found = searchBiome(biome, Math.floor(at.x), Math.floor(at.z));
  if (!found) {
    return { status: CustomCommandStatus.Failure, message: `No ${labelForBiome(biome)} within ${BIOME_RANGE} blocks.` };
  }

  const dx = found.x - at.x;
  const dz = found.z - at.z;
  const distance = Math.floor(Math.sqrt(dx * dx + dz * dz));
  const direction = compass(dx, dz);
  const y = predictedSurface(found.x, found.z) + 1;

  return {
    status: CustomCommandStatus.Success,
    message:
      `§aThe nearest ${labelForBiome(biome)} is at §b${found.x}, ${y}, ${found.z}§a ` +
      `(${distance} blocks ${direction}).`,
  };
}

/*
 * Ring search over columns. The biome field varies over hundreds of blocks, so a
 * coarse step is enough; every step-aligned column lies on exactly one ring, so
 * nothing on the sampled grid is skipped. Only the ring's perimeter is walked,
 * which keeps a search that reaches the full range linear in the radius rather
 * than quadratic in the area.
 */
function searchBiome(biome, x0, z0) {
  const hit = (x, z) => biomeAtColumn(x0 + x, z0 + z) === biome;
  if (hit(0, 0)) return { x: x0, z: z0 };

  for (let r = BIOME_STEP; r <= BIOME_RANGE; r += BIOME_STEP) {
    for (let d = -r; d <= r; d += BIOME_STEP) {
      // Four edges of the square at radius r: top, bottom, left, right.
      if (hit(d, -r)) return { x: x0 + d, z: z0 - r };
      if (hit(d, r)) return { x: x0 + d, z: z0 + r };
      if (hit(-r, d)) return { x: x0 - r, z: z0 + d };
      if (hit(r, d)) return { x: x0 + r, z: z0 + d };
    }
  }
  return undefined;
}

function labelFor(kind) {
  if (kind === "chest") return "chest";
  if (kind === "treasure_vault") return "treasure vault";
  if (kind === "ancient_city") return "ancient city";
  if (kind === "trial_chambers") return "trial chambers";
  if (kind === "collapsed_mine") return "collapsed mine";
  if (kind === "mine_shaft") return "mine shaft";
  if (kind === "farmstead") return "farmstead";
  if (kind === "observatory") return "observatory";
  return kind.replace(/[_-]/g, " ").replace(/\bcopper\b/, "").trim() || kind;
}

function labelForBiome(biome) {
  const entry = BIOMES.find((b) => b.id === biome);
  return entry ? entry.label.toLowerCase() : biome;
}

const COMPASS = [
  { limit: 22.5, name: "south" },
  { limit: 67.5, name: "south-west" },
  { limit: 112.5, name: "west" },
  { limit: 157.5, name: "north-west" },
  { limit: 202.5, name: "north" },
  { limit: 247.5, name: "north-east" },
  { limit: 292.5, name: "east" },
  { limit: 337.5, name: "south-east" },
  { limit: 360.0, name: "south" },
];

/** A compass word for an X/Z offset. Bedrock's +Z is south, +X is east. */
function compass(dx, dz) {
  let angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  for (const step of COMPASS) {
    if (angle <= step.limit) return step.name;
  }
  return "south";
}
