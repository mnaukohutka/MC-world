import { registerDimension, installTravelMenu } from "./dimension";
import "./dimension_rules";
import "./dimension_portal";
import "./mobs";

/*
 * The Copper Dimension lives outside the Overworld. Terrain is generated in
 * script (`dimension/terrain.js`) because a registered custom dimension always
 * starts as void — the spawn pad in particular is laid down by
 * `ensureDimensionReady` before the first teleport.
 */
registerDimension({
  "typeId": "pa:copper_dimension",
  "label": "§6Copper Dimension§r",
  "showInMenu": true,
  "spawn": {"x": 0, "y": 70, "z": 0},
  "build": [],
  "rules": [],
  "arrival": {"setRespawnHere": false, "fallBelowY": -72, "fallAction": "teleportBack"},
  "portal": {
    "blockId": "pa:dimension_copper_portal",
    "cooldownTicks": 300,
    "dwellTicks": 40,
    "linkByPosition": true,
    "particleId": "minecraft:basic_portal_particle",
    "frame": {
      "blockId": "pa:copper_portal",
      "igniterId": "minecraft:flint_and_steel",
      "minWidth": 2,
      "minHeight": 3
    }
  }
});

installTravelMenu({
  "command": "customdim:dimensions",
  "title": "Dimension Traveler",
  "body": "Choose a destination:",
  "vanilla": [
    {"label": "§aOverworld§r", "id": "minecraft:overworld", "spawn": {"x": 0, "y": 64, "z": 0}},
    {"label": "§4The Nether§r", "id": "minecraft:nether", "spawn": {"x": 0, "y": 64, "z": 0}},
    {"label": "§5The End§r", "id": "minecraft:the_end", "spawn": {"x": 0, "y": 64, "z": 0}}
  ],
  "itemComponent": "pa:dimension_menu_use"
});
