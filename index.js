/**
 * ============================================================================
 * PROJECT: TACTICAL MINECRAFT SURVIVAL AGENT (FULL UNCOMPRESSED PACKAGE)
 * ============================================================================
 */

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;
const { Vec3 } = require('vec3');
const http = require('http');
const express = require('express');
const socketIo = require('socket.io');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

// ---------------------------------------------------------------------------
// 1. CONFIGURATION & STATE VARIABLES
// ---------------------------------------------------------------------------
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const WEB_PORT = process.env.PORT || 3000;

const botState = {
  followingPlayer: null,
  guardMode: true,
  antiAfk: false,
  antiAfkInterval: null,
  isFishing: false,
  autoFarm: false,
  farmingInterval: null,
  autoSmelt: false,
  smeltingInterval: null,
  isBusyCrafting: false,
  netherMission: {
    active: false,
    stage: 'IDLE',
    debrisGathered: 0,
    targetDebris: 4,
    homeCoords: null,
    portalCoords: null
  }
};

const BLOCK_ALIASES = {
  wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  planks: ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'],
  stone: ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore'],
  debris: ['ancient_debris'],
  ancient_debris: ['ancient_debris']
};

const HAZARD_BLOCKS = ['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'sulfur_cube', 'sweet_berry_bush'];
const HOSTILE_MOBS = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'drowned', 'husk', 'stray', 'hoglin', 'piglin_brute', 'wither_skeleton'];

let currentActiveBot = null;
let discordAttached = false;

// ---------------------------------------------------------------------------
// 2. DISCORD & GOOGLE GEMINI AI
// ---------------------------------------------------------------------------
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

let discordChannel = null;

if (DISCORD_BOT_TOKEN) {
  discordClient.on('clientReady', async () => {
    console.log(`[DISCORD LIVE] Connected as ${discordClient.user.tag}`);
    discordClient.user.setActivity('Nokar SMP Core', { type: ActivityType.Watching });
    if (DISCORD_CHANNEL_ID) {
      discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
    }
  });
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => console.error('[DISCORD ERROR]', err.message));
}

function safeChat(bot, message) {
  if (!bot || !bot.chat) return;
  try {
    bot.chat(String(message).replace(/[\r\n]+/g, ' ').slice(0, 256));
  } catch (err) {
    console.error('[CHAT ERROR]', err.message);
  }
}

async function askAiBrain(prompt, context = {}) {
  const cleanKey = (GEMINI_API_KEY || '').trim();
  if (!cleanKey) return "AI setup nahi hai (GEMINI_API_KEY missing).";

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${cleanKey}`;
  const payload = {
    contents: [{
      parts: [{
        text: `You are 'Nokar', an elite autonomous Minecraft bot companion. Speak in brief Hindi/Hinglish (under 120 chars) fitting the current game state.\nBot Status: HP: ${context.hp || 20}/20, Hunger: ${context.food || 20}/20\nPlayer: ${prompt}`
      }]
    }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 120 }
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) return "Dimaag thoda hang ho raha hai abhi...";
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Samajh nahi aaya boss.";
  } catch (err) {
    return "AI Brain network error.";
  }
}

// ---------------------------------------------------------------------------
// 3. UTILITIES & INVENTORY MANAGEMENT
// ---------------------------------------------------------------------------
async function equipBestTool(bot, targetBlock) {
  if (!targetBlock) return;
  try {
    const tools = bot.inventory.items().filter(item => {
      const n = item.name;
      return n.includes('pickaxe') || n.includes('axe') || n.includes('shovel') || n.includes('sword');
    });

    let bestTool = null;
    let fastestSpeed = 1;

    for (const tool of tools) {
      const speed = targetBlock.material ? (tool.getDigTime ? 1000 / tool.getDigTime(targetBlock) : 1) : 1;
      if (speed > fastestSpeed) {
        fastestSpeed = speed;
        bestTool = tool;
      }
    }

    if (bestTool) {
      await bot.equip(bestTool, 'hand');
    }
  } catch (e) {}
}

async function sortAndCleanInventory(bot) {
  safeChat(bot, "🎒 Inventory sort aur clean kar raha hoon...");
  const trashItems = ['rotten_flesh', 'poisonous_potato', 'dirt', 'diorite', 'granite', 'andesite', 'cobblestone'];

  for (const item of bot.inventory.items()) {
    if (trashItems.includes(item.name) && item.count > 64) {
      try {
        await bot.toss(item.type, null, item.count - 64);
        await bot.waitForTicks(2);
      } catch (err) {}
    }
  }
  safeChat(bot, "🎒 Inventory saaf aur organized ho gayi!");
}

async function dumpToChest(bot) {
  const chestBlock = bot.findBlock({
    matching: ['chest', 'trapped_chest', 'barrel'].map(name => bot.registry.blocksByName[name]?.id).filter(Boolean),
    maxDistance: 6
  });

  if (!chestBlock) return safeChat(bot, "Aas-paas koi chest nahi mili.");

  try {
    const chest = await bot.openChest(chestBlock);
    const valuableKeywords = ['diamond', 'debris', 'iron', 'gold', 'emerald', 'ingot', 'raw_iron', 'raw_gold'];

    for (const item of bot.inventory.items()) {
      if (valuableKeywords.some(k => item.name.includes(k))) {
        await chest.deposit(item.type, null, item.count).catch(() => {});
        await bot.waitForTicks(2);
      }
    }
    chest.close();
    safeChat(bot, "Valuable items safe chest me store kar diye!");
  } catch (e) {
    safeChat(bot, `Chest error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 4. SURVIVAL, COMBAT & AUTOMATION
// ---------------------------------------------------------------------------
function startAntiAfk(bot) {
  if (botState.antiAfk) return;
  botState.antiAfk = true;
  safeChat(bot, "Anti-AFK Protocol Enabled!");

  botState.antiAfkInterval = setInterval(async () => {
    if (!botState.antiAfk) return;
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 250);
    const randomYaw = Math.random() * Math.PI * 2;
    await bot.look(randomYaw, 0, true).catch(() => {});
  }, 10000);
}

function stopAntiAfk(bot) {
  botState.antiAfk = false;
  if (botState.antiAfkInterval) {
    clearInterval(botState.antiAfkInterval);
    botState.antiAfkInterval = null;
  }
  bot.clearControlStates();
}

let defenseInterval = null;
function startMobDefense(bot) {
  if (defenseInterval) return;
  defenseInterval = setInterval(async () => {
    if (botState.isBusyCrafting || !botState.guardMode) return;

    const target = bot.nearestEntity(e => {
      if (e.type !== 'mob' && e.type !== 'hostile') return false;
      return HOSTILE_MOBS.includes(e.name) && bot.entity.position.distanceTo(e.position) <= 8;
    });

    if (target) {
      const weapon = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {});
      await bot.lookAt(target.position.offset(0, target.height * 0.85, 0));
      bot.attack(target);
    }
  }, 550);
}

function stopMobDefense() {
  if (defenseInterval) {
    clearInterval(defenseInterval);
    defenseInterval = null;
  }
}

async function startFishing(bot) {
  if (botState.isFishing) return;
  botState.isFishing = true;
  safeChat(bot, "🎣 Fishing shuru ho rahi hai...");

  async function loop() {
    if (!botState.isFishing) return;
    try {
      const rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
      if (!rod) {
        safeChat(bot, "Fishing rod nahi mili!");
        botState.isFishing = false;
        return;
      }
      await bot.equip(rod, 'hand');
      await bot.fish();
    } catch (e) {
      await bot.waitForTicks(20);
    }
    if (botState.isFishing) setTimeout(loop, 1200);
  }
  loop();
}

function stopFishing() {
  botState.isFishing = false;
}

async function runFarmLoop(bot) {
  if (!botState.autoFarm) return;

  const matureCrop = bot.findBlock({
    matching: block => {
      const name = block.name;
      const isCrop = name === 'wheat' || name === 'carrots' || name === 'potatoes' || name === 'beetroots';
      return isCrop && block.metadata === 7;
    },
    maxDistance: 16
  });

  if (matureCrop) {
    try {
      await bot.collectBlock.collect(matureCrop);
      const seedType = matureCrop.name === 'wheat' ? 'wheat_seeds' : matureCrop.name;
      const seedItem = bot.inventory.items().find(i => i.name === seedType);

      if (seedItem) {
        await bot.equip(seedItem, 'hand');
        const farmland = bot.blockAt(matureCrop.position.offset(0, -1, 0));
        if (farmland && farmland.name === 'farmland') {
          await bot.placeBlock(farmland, new Vec3(0, 1, 0)).catch(() => {});
        }
      }
    } catch (err) {}
  }

  botState.farmingInterval = setTimeout(() => runFarmLoop(bot), 3000);
}

async function runAutoSmelter(bot) {
  if (!botState.autoSmelt) return;

  const furnaceBlock = bot.findBlock({
    matching: ['furnace', 'blast_furnace', 'smoker'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean),
    maxDistance: 5
  });

  if (furnaceBlock) {
    try {
      const furnace = await bot.openFurnace(furnaceBlock);
      const ore = bot.inventory.items().find(i => 
        ['raw_iron', 'raw_gold', 'ancient_debris'].includes(i.name)
      );
      const fuel = bot.inventory.items().find(i => 
        ['coal', 'charcoal', 'blaze_rod', 'oak_planks'].includes(i.name)
      );

      if (ore && !furnace.inputItem()) {
        await furnace.putInput(ore.type, null, Math.min(ore.count, 32));
      }
      if (fuel && !furnace.fuelItem()) {
        await furnace.putFuel(fuel.type, null, Math.min(fuel.count, 16));
      }
      if (furnace.outputItem()) {
        await furnace.takeOutput();
      }
      furnace.close();
    } catch (e) {}
  }

  botState.smeltingInterval = setTimeout(() => runAutoSmelter(bot), 4000);
}

// ---------------------------------------------------------------------------
// 5. CRAFTING & BUILDING LOGIC
// ---------------------------------------------------------------------------
async function smartGatherAndCraft(bot, itemName, count = 1) {
  if (botState.isBusyCrafting) return safeChat(bot, "Main already craft kar raha hoon.");
  botState.isBusyCrafting = true;
  safeChat(bot, `🔨 Crafting routine shuru: ${count}x ${itemName}`);

  try {
    const mcData = require('minecraft-data')(bot.version);
    const itemObj = mcData.itemsByName[itemName];
    if (!itemObj) throw new Error(`Invalid item: ${itemName}`);

    const recipe = bot.recipesFor(itemObj.id, null, 1, null)[0] || bot.recipesFor(itemObj.id, null, 1, true)[0];
    if (!recipe) {
      safeChat(bot, `Mujhe ${itemName} ki recipe nahi mili ya saman missing hai.`);
      botState.isBusyCrafting = false;
      return;
    }

    let craftingTable = null;
    if (recipe.requiresTable) {
      craftingTable = bot.findBlock({
        matching: mcData.blocksByName.crafting_table.id,
        maxDistance: 6
      });

      if (!craftingTable) {
        safeChat(bot, "Crafting table pass me nahi mili.");
        botState.isBusyCrafting = false;
        return;
      }
    }

    await bot.craft(recipe, count, craftingTable);
    safeChat(bot, `Success! ${count}x ${itemName} craft ho gaya.`);
  } catch (err) {
    safeChat(bot, `Crafting error: ${err.message}`);
  } finally {
    botState.isBusyCrafting = false;
  }
}

async function executeHouseBuild(bot) {
  safeChat(bot, "🏡 5x5 Shelter building sequence shuru...");
  const start = bot.entity.position.floored().offset(2, 0, 2);

  const buildingMaterial = bot.inventory.items().find(i => 
    i.name.includes('cobble') || i.name.includes('planks') || i.name.includes('stone')
  );

  if (!buildingMaterial || buildingMaterial.count < 30) {
    return safeChat(bot, "Shelter ke liye kam se kam 30 blocks chahiye inventory me!");
  }

  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 5; x++) {
      for (let z = 0; z < 5; z++) {
        const isWall = (x === 0 || x === 4 || z === 0 || z === 4);
        const isDoorway = (x === 2 && z === 0 && (y === 0 || y === 1));

        if (isWall && !isDoorway) {
          const placePos = start.offset(x, y, z);
          const targetBlock = bot.blockAt(placePos);

          if (targetBlock && targetBlock.name === 'air') {
            await bot.equip(buildingMaterial, 'hand');
            const ref = bot.blockAt(placePos.offset(0, -1, 0));
            if (ref && ref.name !== 'air') {
              await bot.lookAt(placePos);
              await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
              await bot.waitForTicks(3);
            }
          }
        }
      }
    }
  }
  safeChat(bot, "🏡 5x5 Shelter complete!");
}

// ---------------------------------------------------------------------------
// 6. NETHERITE PIPELINE
// ---------------------------------------------------------------------------
async function startNetheritePipeline(bot) {
  if (botState.netherMission.active) {
    return safeChat(bot, "Mission already chal raha hai boss!");
  }

  const obsidianCount = bot.inventory.items()
    .filter(i => i.name === 'obsidian')
    .reduce((acc, cur) => acc + cur.count, 0);

  const hasFlint = bot.inventory.items().some(i => i.name === 'flint_and_steel');
  const pickaxe = bot.inventory.items().find(i => i.name.includes('diamond_pickaxe') || i.name.includes('netherite_pickaxe'));

  if (obsidianCount < 10) {
    return safeChat(bot, `❌ Cancelled: Kam se kam 10 Obsidian chahiye (Mere paas ${obsidianCount} hai).`);
  }
  if (!hasFlint) {
    return safeChat(bot, "❌ Cancelled: Flint and Steel missing hai!");
  }
  if (!pickaxe) {
    return safeChat(bot, "❌ Cancelled: Ancient Debris todne ke liye Diamond ya Netherite Pickaxe chahiye!");
  }

  botState.netherMission.active = true;
  botState.netherMission.stage = 'PORTAL_BUILD';
  botState.netherMission.debrisGathered = 0;
  botState.netherMission.homeCoords = bot.entity.position.clone();

  safeChat(bot, "🟢 Protocol: Netherite Pipeline Active. 4x5 Portal frame banana shuru kar raha hoon...");
  await buildAndIgnitePortal(bot);
}

async function buildAndIgnitePortal(bot) {
  try {
    const obsidian = bot.inventory.items().find(i => i.name === 'obsidian');
    if (!obsidian) throw new Error("Obsidian missing!");

    const base = bot.entity.position.floored().offset(2, 0, 0);
    botState.netherMission.portalCoords = base;

    const frameOffsets = [
      new Vec3(1, 0, 0), new Vec3(2, 0, 0),
      new Vec3(0, 1, 0), new Vec3(0, 2, 0), new Vec3(0, 3, 0),
      new Vec3(3, 1, 0), new Vec3(3, 2, 0), new Vec3(3, 3, 0),
      new Vec3(1, 4, 0), new Vec3(2, 4, 0)
    ];

    for (const offset of frameOffsets) {
      const targetPos = base.plus(offset);
      const current = bot.blockAt(targetPos);

      if (current && current.name !== 'obsidian') {
        if (bot.entity.position.distanceTo(targetPos) > 4) {
          await bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3)).catch(() => {});
        }

        await bot.equip(obsidian, 'hand');

        const neighbors = [
          targetPos.offset(0, -1, 0),
          targetPos.offset(1, 0, 0),
          targetPos.offset(-1, 0, 0),
          targetPos.offset(0, 1, 0)
        ];

        for (const nPos of neighbors) {
          const neighborBlock = bot.blockAt(nPos);
          if (neighborBlock && neighborBlock.name !== 'air') {
            await bot.lookAt(targetPos);
            await bot.placeBlock(neighborBlock, targetPos.minus(nPos)).catch(() => {});
            await bot.waitForTicks(4);
            break;
          }
        }
      }
    }

    const flint = bot.inventory.items().find(i => i.name === 'flint_and_steel');
    if (flint) {
      await bot.equip(flint, 'hand');
      const bottomPortalBlock = bot.blockAt(base.offset(1, 0, 0));
      if (bottomPortalBlock) {
        await bot.lookAt(bottomPortalBlock.position);
        await bot.placeBlock(bottomPortalBlock, new Vec3(0, 1, 0)).catch(() => {});
        await bot.waitForTicks(10);
      }
    }

    safeChat(bot, "🔥 Portal ignite ho gaya! Entering portal frame...");
    bot.pathfinder.setGoal(new goals.GoalBlock(base.x + 1, base.y + 1, base.z));
  } catch (err) {
    safeChat(bot, `❌ Portal build error: ${err.message}`);
    botState.netherMission.active = false;
    botState.netherMission.stage = 'IDLE';
  }
}

async function executeNetherMining(bot) {
  botState.netherMission.stage = 'NETHER_MINING';
  safeChat(bot, "⛏️ Nether pahunch gaya! Y:14 Ancient Debris safe search shuru...");

  const diamondPick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
  if (diamondPick) await bot.equip(diamondPick, 'hand');

  const miningInterval = setInterval(async () => {
    if (botState.netherMission.stage !== 'NETHER_MINING') {
      return clearInterval(miningInterval);
    }

    const curPos = bot.entity.position.floored();

    if (curPos.y > 14) {
      const stepDownBlock = bot.blockAt(curPos.offset(1, -1, 0));
      const headBlock = bot.blockAt(curPos.offset(1, 0, 0));

      if (headBlock && headBlock.name !== 'air' && !HAZARD_BLOCKS.includes(headBlock.name)) {
        await bot.dig(headBlock).catch(() => {});
      }
      if (stepDownBlock && stepDownBlock.name !== 'air' && !HAZARD_BLOCKS.includes(stepDownBlock.name)) {
        await bot.dig(stepDownBlock).catch(() => {});
      }
      bot.setControlState('forward', true);
      setTimeout(() => bot.setControlState('forward', false), 400);
      return;
    }

    const front1 = bot.blockAt(curPos.offset(1, 0, 0));
    const front2 = bot.blockAt(curPos.offset(1, 1, 0));

    const hazardFound = (front1 && HAZARD_BLOCKS.includes(front1.name)) || 
                        (front2 && HAZARD_BLOCKS.includes(front2.name));

    if (hazardFound) {
      const hName = front1?.name || front2?.name;
      safeChat(bot, `⚠️ Danger! Hazard (${hName}) saamne hai. Clutch-sealing...`);
      const sealMat = bot.inventory.items().find(i => 
        i.name.includes('cobble') || i.name.includes('netherrack') || i.name.includes('stone')
      );
      if (sealMat) {
        await bot.equip(sealMat, 'hand');
        await bot.placeBlock(bot.blockAt(curPos), new Vec3(1, 0, 0)).catch(() => {});
      }
      await bot.look(bot.entity.yaw + Math.PI / 2, 0);
      return;
    }

    const debris = bot.findBlock({
      matching: bot.registry.blocksByName.ancient_debris?.id,
      maxDistance: 16
    });

    if (debris) {
      safeChat(bot, "💎 Ancient Debris spot hui! Tod raha hoon...");
      try {
        await equipBestTool(bot, debris);
        await bot.collectBlock.collect(debris);
        botState.netherMission.debrisGathered += 1;
        safeChat(bot, `📦 Ancient Debris progress: ${botState.netherMission.debrisGathered}/${botState.netherMission.targetDebris}`);

        if (botState.netherMission.debrisGathered >= botState.netherMission.targetDebris) {
          clearInterval(miningInterval);
          botState.netherMission.stage = 'RETURNING';
          safeChat(bot, "✅ Target pure ho gaye! Wapas portal par chal raha hoon...");

          if (botState.netherMission.portalCoords) {
            bot.pathfinder.setGoal(new goals.GoalNear(
              botState.netherMission.portalCoords.x,
              botState.netherMission.portalCoords.y,
              botState.netherMission.portalCoords.z,
              2
            ));
          }
        }
      } catch (err) {}
      return;
    }

    if (front1 && front1.name !== 'air') await bot.dig(front1).catch(() => {});
    if (front2 && front2.name !== 'air') await bot.dig(front2).catch(() => {});
    bot.setControlState('forward', true);
    setTimeout(() => bot.setControlState('forward', false), 350);

  }, 1800);
}

// ---------------------------------------------------------------------------
// 7. WEB OPERATIONS CONSOLE (FULL UI & RADAR)
// ---------------------------------------------------------------------------
function webInventoryPlugin(botProvider, options = {}) {
  const port = options.port || WEB_PORT;
  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server, { cors: { origin: "*" } });

  app.use(express.json());

  app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tactical Operations Matrix</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg-dark: #07090e;
      --panel-bg: rgba(18, 22, 34, 0.88);
      --panel-border: #1e2638;
      --accent-cyan: #00d2ff;
      --accent-blue: #3a7bd5;
      --accent-green: #00f260;
      --accent-red: #ff416c;
      --accent-gold: #f7971e;
      --text-main: #e2e8f0;
      --text-sub: #94a3b8;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg-dark);
      color: var(--text-main);
      font-family: 'Segoe UI', sans-serif;
      padding: 24px;
      min-height: 100vh;
    }

    .matrix-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--panel-border);
      margin-bottom: 24px;
    }

    .matrix-title {
      font-size: 1.8rem;
      font-weight: 800;
      letter-spacing: 1px;
      background: linear-gradient(135deg, var(--accent-cyan), var(--accent-blue));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .dashboard-layout {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 20px;
      max-width: 1600px;
      margin: 0 auto;
    }

    .panel {
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .col-4 { grid-column: span 4; }
    .col-8 { grid-column: span 8; }
    .col-12 { grid-column: span 12; }

    .panel-header {
      font-size: 1.15rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid var(--panel-border);
      padding-bottom: 12px;
    }

    .stat-list { display: flex; flex-direction: column; gap: 10px; }
    .stat-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 14px; background: rgba(7, 9, 14, 0.6);
      border: 1px solid var(--panel-border); border-radius: 8px; font-size: 0.95rem;
    }

    .control-actions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    button {
      background: #151a26; border: 1px solid var(--panel-border); color: var(--text-main);
      padding: 12px 16px; border-radius: 8px; font-weight: 600; cursor: pointer;
    }
    button:hover { background: var(--accent-blue); border-color: var(--accent-cyan); color: #fff; }

    #radarCanvas { background: #04060a; border: 2px solid var(--panel-border); border-radius: 10px; width: 100%; height: 280px; }

    .inventory-matrix {
      display: grid; grid-template-columns: repeat(9, 1fr); gap: 8px;
      background: #04060a; padding: 16px; border-radius: 10px; border: 1px solid var(--panel-border);
    }
    .inv-slot {
      aspect-ratio: 1; background: #121722; border: 1px solid #1f2737; border-radius: 6px;
      display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative;
    }
    .inv-slot.hotbar { border: 2px solid var(--accent-cyan); }
    .inv-name { font-size: 0.72rem; color: #fff; text-align: center; }
    .inv-qty { position: absolute; bottom: 3px; right: 5px; font-size: 0.8rem; font-weight: 800; color: #fff; }

    .terminal-logs { height: 180px; background: #04060a; border: 1px solid var(--panel-border); border-radius: 8px; padding: 12px; overflow-y: auto; font-family: monospace; }
    .terminal-input { flex: 1; background: #04060a; border: 1px solid var(--panel-border); border-radius: 8px; color: #fff; padding: 12px; font-family: monospace; }
  </style>
</head>
<body>
  <div class="matrix-header"><div class="matrix-title">⚡ NOKAR MATRIX</div></div>
  <div class="dashboard-layout">
    <div class="panel col-4">
      <div class="panel-header"><span>Diagnostics</span></div>
      <div class="stat-list">
        <div class="stat-row"><span>Unit:</span><strong id="botNameLabel">Nokar</strong></div>
        <div class="stat-row"><span>Coords:</span><strong id="botCoordsLabel">0, 0, 0</strong></div>
        <div class="stat-row"><span>HP:</span><strong id="botHealthLabel" style="color:var(--accent-green);">20 / 20</strong></div>
        <div class="stat-row"><span>Food:</span><strong id="botFoodLabel" style="color:var(--accent-gold);">20 / 20</strong></div>
      </div>
      <div class="control-actions">
        <button onclick="dispatchCmd('stop')">🛑 Stop</button>
        <button onclick="dispatchCmd('afk')">🔄 Anti-AFK</button>
        <button onclick="dispatchCmd('guard')">🛡️ Guard</button>
        <button onclick="dispatchCmd('netherite')">🔥 Netherite</button>
        <button onclick="dispatchCmd('sort')">🎒 Clean Bag</button>
        <button onclick="dispatchCmd('smelt')">🔥 Smelt</button>
      </div>
    </div>
    <div class="panel col-8">
      <div class="panel-header"><span>Radar Engine</span></div>
      <canvas id="radarCanvas" width="500" height="280"></canvas>
    </div>
    <div class="panel col-12">
      <div class="panel-header"><span>Inventory (Slots 0 - 35)</span></div>
      <div class="inventory-matrix" id="inventoryDisplay"></div>
    </div>
    <div class="panel col-12">
      <div class="panel-header"><span>Terminal</span></div>
      <div class="terminal-logs" id="terminalLogs"></div>
      <form style="display:flex; gap:10px; margin-top:10px;" onsubmit="event.preventDefault(); sendTerminal();">
        <input type="text" id="terminalPrompt" class="terminal-input" placeholder="Execute command..." />
        <button type="submit">Transmit</button>
      </form>
    </div>
  </div>

  <script>
    const socket = io();
    const canvas = document.getElementById('radarCanvas');
    const ctx = canvas.getContext('2d');

    socket.on('bot_sync', (state) => {
      document.getElementById('botNameLabel').innerText = state.username;
      document.getElementById('botCoordsLabel').innerText = Math.round(state.coords.x) + ', ' + Math.round(state.coords.y) + ', ' + Math.round(state.coords.z);
      document.getElementById('botHealthLabel').innerText = Math.round(state.health) + ' / 20';
      document.getElementById('botFoodLabel').innerText = Math.round(state.food) + ' / 20';
      paintInventory(state.inventory);
      paintRadar(state.coords, state.yaw, state.entities, state.ores);
    });

    socket.on('chat_feed', (msg) => {
      const logs = document.getElementById('terminalLogs');
      logs.innerHTML += '<div>' + msg + '</div>';
      logs.scrollTop = logs.scrollHeight;
    });

    function paintInventory(items) {
      const grid = document.getElementById('inventoryDisplay');
      grid.innerHTML = '';
      for (let i = 0; i < 36; i++) {
        const slot = document.createElement('div');
        slot.className = 'inv-slot' + (i >= 27 ? ' hotbar' : '');
        const mapped = (i < 9) ? (i + 36) : i;
        const item = items.find(x => x.slot === mapped);
        if (item) {
          slot.innerHTML = '<span class="inv-name">' + item.name.replace(/_/g, ' ') + '</span>';
          if (item.count > 1) slot.innerHTML += '<span class="inv-qty">' + item.count + '</span>';
        }
        grid.appendChild(slot);
      }
    }

    function paintRadar(center, yaw, entities, ores) {
      ctx.fillStyle = '#04060a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2, cy = canvas.height / 2, scale = 3.8;

      ctx.strokeStyle = '#1e2638';
      [30, 60, 90, 120].forEach(r => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); });

      if (ores) ores.forEach(o => { ctx.fillStyle = '#f7971e'; ctx.fillRect(cx + (o.x - center.x) * scale - 2, cy + (o.z - center.z) * scale - 2, 4, 4); });
      if (entities) entities.forEach(e => {
        ctx.fillStyle = e.isPlayer ? '#00d2ff' : (e.isHostile ? '#ff416c' : '#94a3b8');
        ctx.beginPath(); ctx.arc(cx + (e.x - center.x) * scale, cy + (e.z - center.z) * scale, 4, 0, Math.PI * 2); ctx.fill();
      });

      ctx.fillStyle = '#00f260'; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
    }

    function dispatchCmd(cmd) { socket.emit('dispatch_command', { cmd }); }
    function sendTerminal() { const i = document.getElementById('terminalPrompt'); if (i.value.trim()) { dispatchCmd(i.value.trim()); i.value = ''; } }
  </script>
</body>
</html>`);
  });

  function syncState() {
    const active = botProvider();
    if (!active || !active.entity) return;

    const inventoryItems = active.inventory.items().map(i => ({ slot: i.slot, name: i.name, count: i.count }));
    const nearbyEntities = Object.values(active.entities).filter(e => e !== active.entity && e.position && active.entity.position.distanceTo(e.position) <= 32).map(e => ({ x: e.position.x, z: e.position.z, isPlayer: e.type === 'player', isHostile: HOSTILE_MOBS.includes(e.name) }));

    let foundOres = [];
    try {
      const mcData = require('minecraft-data')(active.version || '1.20.1');
      const targetOreIds = ['diamond_ore', 'ancient_debris', 'gold_ore'].map(n => mcData.blocksByName[n]?.id).filter(Boolean);
      foundOres = active.findBlocks({ matching: targetOreIds, maxDistance: 24, count: 20 }).map(pos => ({ x: pos.x, z: pos.z }));
    } catch (e) {}

    io.emit('bot_sync', {
      username: active.username, coords: active.entity.position, yaw: active.entity.yaw,
      health: active.health, food: active.food, dimension: active.game?.dimension || 'Overworld',
      inventory: inventoryItems, entities: nearbyEntities, ores: foundOres
    });
  }

  setInterval(syncState, 1500);

  io.on('connection', (sock) => {
    syncState();
    sock.on('dispatch_command', (data) => {
      const active = botProvider();
      if (active && data && data.cmd) active.emit('messagestr', data.cmd);
    });
  });

  server.listen(port, () => console.log(`[OPERATIONS SERVER ACTIVE] Port: ${port}`));
}

// ---------------------------------------------------------------------------
// 8. MAIN DAEMON PROCESS
// ---------------------------------------------------------------------------
function launchBot() {
  const HOST = process.argv[2] || 'DG_LAND502.aternos.me';
  const PORT = parseInt(process.argv[3], 10) || 62974;
  const NAME = process.argv[4] || 'Nokar';

  const bot = mineflayer.createBot({
    host: HOST, port: PORT, username: NAME, checkTimeoutInterval: 120000, version: false
  });

  currentActiveBot = bot;
  bot.loadPlugin(pathfinder); bot.loadPlugin(collectBlock); bot.loadPlugin(autoEat);

  bot.once('spawn', () => {
    console.log(`[AGENT LIVE] ${bot.username} entered the server.`);
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.allowParkour = false; defaultMove.canDig = true; defaultMove.allow1by1towers = false;
    bot.pathfinder.setMovements(defaultMove);
    bot.autoEat.options = { priority: 'foodPoints', startAt: 14, bannedFood: ['rotten_flesh', 'spider_eye'] };
    startMobDefense(bot);
  });

  bot.on('respawn', () => {
    const dimension = bot.game.dimension;
    if (dimension === 'minecraft:the_nether' && botState.netherMission.stage === 'PORTAL_BUILD') {
      safeChat(bot, "🔥 Nether tunneling shuru."); executeNetherMining(bot);
    } else if (dimension === 'minecraft:overworld' && botState.netherMission.stage === 'RETURNING') {
      safeChat(bot, "🏡 Safe return complete."); botState.netherMission.active = false; botState.netherMission.stage = 'IDLE';
    }
  });

  bot.on('physicsTick', () => {
    if (!botState.followingPlayer || botState.isBusyCrafting) return;
    const target = bot.players[botState.followingPlayer]?.entity;
    if (target) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  });

  if (!discordAttached) {
    discordAttached = true;
    discordClient.on('messageCreate', async (msg) => {
      if (msg.author.bot || (DISCORD_CHANNEL_ID && msg.channel.id !== DISCORD_CHANNEL_ID)) return;
      if (!currentActiveBot) return;

      const content = msg.content.trim();
      if (content.startsWith('!craft ')) { const parts = content.split(' '); smartGatherAndCraft(currentActiveBot, parts[1], parseInt(parts[2], 10) || 1); return msg.reply(`Crafting: ${parts[1]}`); }
      if (content.startsWith('!sort')) { sortAndCleanInventory(currentActiveBot); return msg.reply('Inventory sorted!'); }
      if (content.startsWith('!netherite')) { startNetheritePipeline(currentActiveBot); return msg.reply('Netherite Pipeline Initiated!'); }
      if (content.startsWith('!ai ')) {
        const reply = await askAiBrain(content.slice(4), { hp: currentActiveBot.health, food: currentActiveBot.food });
        safeChat(currentActiveBot, reply); return msg.reply(`🤖 ${reply}`);
      }
      if (content === '!status') return msg.reply(`HP: ${Math.round(currentActiveBot.health)}/20 | Defense: ${botState.guardMode ? 'ON' : 'OFF'}`);
    });
  }

  bot.on('messagestr', async (message) => {
    if (message.startsWith(`[${bot.username}]`) || message.startsWith(`<${bot.username}>`)) return;
    if (discordChannel) discordChannel.send(`💬 ${message}`).catch(() => {});

    const cleanMsg = message.trim();
    const match = cleanMsg.match(/(?:<[^>]+>\s*|\[[^\]]+\]\s*|\w+:\s*)?(.*)/);
    const actualText = match ? match[1].trim() : cleanMsg;
    const args = actualText.split(/\s+/);
    const cmd = args[0]?.toLowerCase();

    if (cmd === 'come' || cmd === 'follow') { stopAntiAfk(bot); botState.followingPlayer = args[1] || ''; safeChat(bot, "Aapke paas aa raha hoon!"); } 
    else if (cmd === 'stop') {
      botState.followingPlayer = null; botState.isBusyCrafting = false; botState.autoSmelt = false; botState.netherMission.active = false;
      stopAntiAfk(bot); stopFishing(); bot.clearControlStates(); bot.pathfinder.stop(); bot.collectBlock.cancelTask();
      safeChat(bot, "Sab stop kar diya!");
    } 
    else if (cmd === 'netherite') startNetheritePipeline(bot);
    else if (cmd === 'craft' && args[1]) smartGatherAndCraft(bot, args[1].toLowerCase(), parseInt(args[2], 10) || 1);
    else if (cmd === 'sort') sortAndCleanInventory(bot);
    else if (cmd === 'smelt') { botState.autoSmelt = !botState.autoSmelt; if (botState.autoSmelt) runAutoSmelter(bot); safeChat(bot, `Auto Smelter: ${botState.autoSmelt ? 'ON' : 'OFF'}`); } 
    else if (cmd === 'guard') { botState.guardMode = !botState.guardMode; if (botState.guardMode) startMobDefense(bot); else stopMobDefense(); safeChat(bot, `Auto Defense: ${botState.guardMode ? 'ON' : 'OFF'}`); } 
    else if (cmd === 'afk') { if (botState.antiAfk) stopAntiAfk(bot); else startAntiAfk(bot); } 
    else if (cmd === 'fish') { if (botState.isFishing) stopFishing(); else startFishing(bot); } 
    else if (cmd === 'farm') { botState.autoFarm = !botState.autoFarm; if (botState.autoFarm) runFarmLoop(bot); safeChat(bot, `Auto Farm: ${botState.autoFarm ? 'ON' : 'OFF'}`); } 
    else if (cmd === 'deposit') dumpToChest(bot);
    else if (cmd === 'build' && args[1] === 'house') executeHouseBuild(bot);
    else if (cmd === 'mine') {
      let blockQuery = args[1]?.toLowerCase();
      let count = parseInt(args[2], 10) || 1;
      const mcData = require('minecraft-data')(bot.version);
      let targetNames = BLOCK_ALIASES[blockQuery] || [blockQuery];
      let targetIds = targetNames.map(name => mcData.blocksByName[name]?.id).filter(Boolean);
      const found = bot.findBlocks({ matching: targetIds, maxDistance: 32, count });
      if (!found.length) return safeChat(bot, `Aas-paas ${blockQuery} nahi mila.`);
      safeChat(bot, `${found.length} ${blockQuery} tod raha hoon...`);
      try { await equipBestTool(bot, bot.blockAt(found[0])); await bot.collectBlock.collect(found.map(pos => bot.blockAt(pos))); safeChat(bot, "Mining complete!"); } catch (e) {}
    } 
    else if (cmd === 'dropall') { for (const item of bot.inventory.items()) { try { await bot.tossStack(item); } catch (e) {} } safeChat(bot, "Inventory dropped!"); } 
    else {
      if (cleanMsg.toLowerCase().includes('nokar') || cleanMsg.toLowerCase().includes('bot') || cleanMsg.startsWith('!ai')) {
        const prompt = actualText.replace(/^(nokar|bot|!ai)\s*/i, '');
        const reply = await askAiBrain(prompt || "hi", { hp: bot.health, food: bot.food });
        safeChat(bot, reply);
      }
    }
  });

  bot.on('end', () => { console.log('[RECONNECT] Connection ended. Reconnecting in 10s...'); setTimeout(launchBot, 10000); });
  bot.on('error', (err) => console.error('[CRITICAL BOT ERROR]', err.message));
}

// ---------------------------------------------------------------------------
// 9. BOOTSTRAP ENGINE
// ---------------------------------------------------------------------------
webInventoryPlugin(() => currentActiveBot, { port: WEB_PORT });
launchBot();
