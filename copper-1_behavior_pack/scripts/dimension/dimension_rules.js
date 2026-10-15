import { world, system, GameMode, WeatherType, InputPermissionCategory } from "@minecraft/server";
import { dimensionConfigs, startModule } from "./dimension";

/*
 * Rule engine: trigger -> actions.
 *
 * One subscription per trigger kind for the whole pack, filtered by dimension
 * id, rather than one per dimension — the event cost is paid once no matter how
 * many dimensions a pack has.
 *
 * `runAction` is a dispatch table keyed by the same strings the Dart model
 * emits, so a new action is one arm here.
 */

/** Rules of one kind across every dimension, as [config, rule] pairs. */
function rulesOf(trigger) {
  const out = [];
  for (const config of dimensionConfigs()) {
    for (const rule of config.rules || []) {
      if (rule.trigger === trigger) out.push({ config, rule });
    }
  }
  return out;
}

function fire(rule, player, config) {
  for (const action of rule.actions || []) {
    try {
      runAction(action, player, config);
    } catch (error) {
      console.warn(`[dimension] action "${action && action.kind}" failed: ${error}`);
    }
  }
}

function runAction(action, player, config) {
  const dimension = world.getDimension(config.typeId);

  switch (action.kind) {
    case "effect":
      return player?.addEffect(action.effectId, Math.max(1, action.seconds) * 20, {
        amplifier: action.amplifier,
        showParticles: action.showParticles,
      });

    case "weather":
      return dimension.setWeather(WeatherType[action.weather] ?? WeatherType.Clear, action.durationTicks);

    case "text":
      if (!player) return undefined;
      switch (action.mode) {
        case "subtitle":
          return player.onScreenDisplay.setTitle(" ", { subtitle: action.text });
        case "actionbar":
          return player.onScreenDisplay.setActionBar(action.text);
        case "chat":
          return player.sendMessage(action.text);
        default:
          return player.onScreenDisplay.setTitle(action.text);
      }

    case "sound":
      if (!player) return dimension.playSound(action.soundId, { x: 0, y: 64, z: 0 });
      if (action.isMusic) return player.playMusic(action.soundId, { loop: action.loop });
      return player.playSound(action.soundId);

    case "gamemode":
      return player?.setGameMode(GameMode[action.mode] ?? undefined);

    case "input":
      return player?.inputPermissions.setPermissionCategory(
        InputPermissionCategory[capitalize(action.category)] ?? InputPermissionCategory.Movement,
        action.enabled
      );

    case "setSpawn":
      return player?.setSpawnPoint({ ...(config.spawn || { x: 0, y: 64, z: 0 }), dimension });

    case "teleport": {
      if (!player) return undefined;
      const target = action.dimensionId ? world.getDimension(action.dimensionId) : dimension;
      return player.teleport(action.to, { dimension: target });
    }

    case "command":
      return action.command ? dimension.runCommand(action.command) : undefined;

    case "spawnEntity":
      return dimension.spawnEntity(action.id, action.at || config.spawn);

    case "module":
      return player ? startModule(action.module, player, config, action.tunables) : undefined;

    default:
      console.warn(`[dimension] unsupported action kind "${action.kind}" — skipped`);
      return undefined;
  }
}

function capitalize(value) {
  const s = String(value || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Triggers ───────────────────────────────────────────────────────────────

world.afterEvents.worldLoad.subscribe(() => {
  for (const { config, rule } of rulesOf("onWorldLoad")) {
    fire(rule, undefined, config);
  }
  startIntervals();
  startFallOutWatch();
});

world.afterEvents.playerDimensionChange.subscribe((event) => {
  const to = String(event.toDimension.id);
  const from = String(event.fromDimension.id);

  for (const { config, rule } of rulesOf("onLeave")) {
    if (config.typeId === from) fire(rule, event.player, config);
  }
  for (const { config, rule } of rulesOf("onEnter")) {
    if (config.typeId === to) fire(rule, event.player, config);
  }
});

world.afterEvents.playerSpawn.subscribe((event) => {
  // initialSpawn is a join, not a respawn.
  if (event.initialSpawn) return;
  const id = String(event.player.dimension.id);
  for (const { config, rule } of rulesOf("onRespawn")) {
    if (config.typeId === id) fire(rule, event.player, config);
  }
});

/**
 * `onInterval` rules, one `system.runInterval` per distinct period so a rule
 * asking for every 20 ticks does not force every other rule to that rate.
 */
function startIntervals() {
  const byPeriod = new Map();
  for (const { config, rule } of rulesOf("onInterval")) {
    const period = Math.max(20, rule.value || 100);
    if (!byPeriod.has(period)) byPeriod.set(period, []);
    byPeriod.get(period).push({ config, rule });
  }

  for (const [period, entries] of byPeriod) {
    system.runInterval(() => {
      for (const { config, rule } of entries) {
        for (const player of world.getDimension(config.typeId).getPlayers()) {
          fire(rule, player, config);
        }
      }
    }, period);
  }
}

/**
 * The void safety net, plus weather lock and ambient loops. All are "check the
 * players in this dimension every so often", so they share one slow interval
 * rather than each adding their own.
 */
const FALL_OUT_PERIOD = 20;

/*
 * Safety net for players who fall off whatever the dimension built. A void
 * dimension has no floor below the build, so without this a slip is an endless
 * drop with no way back.
 */
function startFallOutWatch() {
  const configs = dimensionConfigs();
  if (configs.length === 0) return;

  system.runInterval(() => {
    for (const config of configs) {
      const fallBelow = config.arrival?.fallBelowY;
      if (fallBelow === undefined || fallBelow === null) continue;

      const dimension = world.getDimension(config.typeId);
      for (const player of dimension.getPlayers()) {
        if (player.location.y >= fallBelow) continue;
        switch (config.arrival.fallAction) {
          case "kill":
            player.applyDamage(1000);
            break;
          case "none":
            break;
          default:
            player.teleport(config.spawn || { x: 0, y: 64, z: 0 }, { dimension });
            player.sendMessage("§eYou fell out — sent back to the start.");
        }
      }
    }
  }, FALL_OUT_PERIOD);
}

// `onFallBelow` as an explicit trigger runs off the same slow loop, so a rule
// can react to falling with anything, not just the built-in safety net.
system.runInterval(() => {
  for (const { config, rule } of rulesOf("onFallBelow")) {
    const threshold = rule.value ?? 40;
    for (const player of world.getDimension(config.typeId).getPlayers()) {
      if (player.location.y < threshold) fire(rule, player, config);
    }
  }
}, 20);
