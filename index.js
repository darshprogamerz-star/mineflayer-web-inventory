/**
 * ============================================================================
 * MINEFLAYER AUTONOMOUS SYSTEM - PART 1
 * CORE ENGINE, AI BRAIN, AUTOMATIONS & LOGISTICS
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

// Environment Configurations
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Global State Registry
const botState = {
  followingPlayer: null,
  guardMode: false,
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
    stage: 'IDLE', // IDLE, PORTAL_BUILD, NETHER_MINING, SMELT_AND_UPGRADE
    debrisGathered: 0,
    targetDebris: 4,
    homeCoords: null,
    portalCoords: null
  }
};

// Aliases for user-friendly mining & crafting commands
const BLOCK_ALIASES = {
  wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log'],
  log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log'],
  stone: ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore'],
  debris: ['ancient_debris'],
  ancient_debris: ['ancient_debris']
};

const HAZARD_BLOCKS = ['lava', 'flowing_lava', 'fire', 'magma_block', 'sulfur_cube'];
const HOSTILE_MOBS = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'drowned', 'husk', 'stray', 'hoglin', 'piglin_brute'];

// Discord Client Setup
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let discordChannel = null;

if (DISCORD_BOT_TOKEN) {
  discordClient.on('clientReady', async () => {
    console.log(`[DISCORD LIVE] Connected successfully as ${discordClient.user.tag}`);
    discordClient.user.setActivity('SMP Defense Matrix', { type: ActivityType.Watching });
    if (DISCORD_CHANNEL_ID) {
      discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
    }
  });

  discordClient.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error('[DISCORD ERROR] Login failure:', err.message);
  });
}

function safeChat(bot, message) {
  if (!bot || !bot.chat) return;
  try {
    bot.chat(String(message).slice(0, 256));
  } catch (err) {
    console.error('[CHAT ERROR]', err.message);
  }
}

/**
 * AI BRAIN: Integrated with Google Gemini 3.6 Flash
 */
async function askAiBrain(prompt, context = {}) {
  const cleanKey = (GEMINI_API_KEY || '').trim();
  if (!cleanKey) {
    return "AI brain setup nahi hai (GEMINI_API_KEY environment variable missing hai).";
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${cleanKey}`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: `You are 'Nokar', an intelligent, obedient, and slightly witty autonomous Minecraft survival bot. Respond briefly in Hindi/Hinglish (under 120 chars) fitting the Minecraft context.\nCurrent Bot Context: HP: ${context.hp || 20}, Food: ${context.food || 20}\nUser Prompt: ${prompt}`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 120
    }
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[GEMINI API ERROR]', errBody);
      return "Dimaag kaam nahi kar raha mera abhi...";
    }

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return candidate ? candidate.trim() : "Main samajh nahi paya boss.";
  } catch (err) {
    console.error('[AI ENGINE ERROR]', err.message);
    return "Network issue aa gaya AI call me.";
  }
}

/**
 * INVENTORY & UTILITIES
 */
async function equipBestTool(bot, targetBlock) {
  if (!targetBlock) return;
  try {
    const tools = bot.inventory.items().filter(item => {
      const name = item.name;
      return name.includes('pickaxe') || name.includes('axe') || name.includes('shovel') || name.includes('sword');
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
  } catch (e) {
    // Non-fatal tool equip pass
  }
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
  safeChat(bot, "🎒 Inventory saaf ho gayi!");
}

async function dumpToChest(bot) {
  const chestBlock = bot.findBlock({
    matching: ['chest', 'trapped_chest', 'barrel'].map(name => bot.registry.blocksByName[name]?.id).filter(Boolean),
    maxDistance: 6
  });

  if (!chestBlock) {
    return safeChat(bot, "Aas-paas koi chest nahi mili.");
  }

  try {
    const chest = await bot.openChest(chestBlock);
    const valuableKeywords = ['diamond', 'debris', 'iron', 'gold', 'emerald', 'ingot', 'raw_iron', 'raw_gold'];

    for (const item of bot.inventory.items()) {
      const isValuable = valuableKeywords.some(k => item.name.includes(k));
      if (isValuable) {
        await chest.deposit(item.type, null, item.count).catch(() => {});
        await bot.waitForTicks(2);
      }
    }
    chest.close();
    safeChat(bot, "Valuables chest me rakh diye!");
  } catch (e) {
    safeChat(bot, `Chest access error: ${e.message}`);
  }
}

/**
 * SURVIVAL, ANTI-AFK & COMBAT DEFENSE
 */
function startAntiAfk(bot) {
  if (botState.antiAfk) return;
  botState.antiAfk = true;
  safeChat(bot, "Anti-AFK mode on!");

  botState.antiAfkInterval = setInterval(async () => {
    if (!botState.antiAfk) return;
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 250);
    await bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5), true).catch(() => {});
  }, 12000);
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
    if (botState.isBusyCrafting) return;

    const target = bot.nearestEntity(e => {
      if (e.type !== 'mob' && e.type !== 'hostile') return false;
      const isDangerous = HOSTILE_MOBS.includes(e.name);
      return isDangerous && bot.entity.position.distanceTo(e.position) <= 8;
    });

    if (target) {
      const sword = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));
      if (sword) await bot.equip(sword, 'hand').catch(() => {});

      await bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
      bot.attack(target);
    }
  }, 600);
}

function stopMobDefense() {
  if (defenseInterval) {
    clearInterval(defenseInterval);
    defenseInterval = null;
  }
}

/**
 * RESOURCE AUTOMATIONS: FISHING, FARMING & SMELTING
 */
async function startFishing(bot) {
  if (botState.isFishing) return;
  botState.isFishing = true;
  safeChat(bot, "🎣 Fishing shuru kar raha hoon...");

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
    if (botState.isFishing) setTimeout(loop, 1000);
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
        ['raw_iron', 'raw_gold', 'raw_copper', 'ancient_debris', 'beef', 'porkchop'].includes(i.name)
      );
      const fuel = bot.inventory.items().find(i => 
        ['coal', 'charcoal', 'blaze_rod', 'oak_planks', 'coal_block'].includes(i.name)
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

  botState.smeltingInterval = setTimeout(() => runAutoSmelter(bot), 5000);
}

/**
 * CRAFTING & BUILDING ENGINE
 */
async function smartGatherAndCraft(bot, itemName, count = 1) {
  if (botState.isBusyCrafting) return safeChat(bot, "Main pehle se hi craft kar raha hoon.");
  botState.isBusyCrafting = true;
  safeChat(bot, `🔨 Crafting process initiate kiya: ${count}x ${itemName}`);

  try {
    const mcData = require('minecraft-data')(bot.version);
    const itemObj = mcData.itemsByName[itemName];
    if (!itemObj) throw new Error(`Invalid item: ${itemName}`);

    const recipe = bot.recipesFor(itemObj.id, null, 1, null)[0] || bot.recipesFor(itemObj.id, null, 1, true)[0];
    if (!recipe) {
      safeChat(bot, `Mujhe ${itemName} ki recipe nahi pata ya requirements meet nahi hui.`);
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
    safeChat(bot, `Successfully crafted ${count}x ${itemName}!`);
  } catch (err) {
    safeChat(bot, `Crafting error: ${err.message}`);
  } finally {
    botState.isBusyCrafting = false;
  }
}

async function executeHouseBuild(bot) {
  safeChat(bot, "🏡 5x5 Shelter build sequence shuru kar raha hoon...");
  const mcData = require('minecraft-data')(bot.version);
  const start = bot.entity.position.floored().offset(2, 0, 2);

  const buildingMaterial = bot.inventory.items().find(i => 
    i.name.includes('cobble') || i.name.includes('planks') || i.name.includes('stone')
  );

  if (!buildingMaterial || buildingMaterial.count < 30) {
    return safeChat(bot, "Ghar banane ke liye kam se kam 30 blocks chahiye inventory me!");
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
/**
 * ============================================================================
 * MODULE: WEB OPERATIONS CONSOLE, CANVAS RADAR & REST API (PART 2)
 * FULL EXPANDED DASHBOARD WITH EXPANDED CSS, CANVAS ENGINE & CONTROLS
 * ============================================================================
 */

function webInventoryPlugin(bot, options = {}) {
  const port = options.port || process.env.PORT || 3000;
  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  app.use(express.json());

  // Main HTTP Dashboard Route
  app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bot.username || 'Bot'} | Tactical Command Console</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg-main: #0d1117;
      --bg-card: #161b22;
      --border-color: #30363d;
      --text-main: #c9d1d9;
      --text-muted: #8b949e;
      --accent-blue: #58a6ff;
      --accent-hover: #1f6feb;
      --accent-green: #3fb950;
      --accent-red: #f85149;
      --accent-yellow: #d29922;
      --slot-bg: #21262d;
      --slot-border: #30363d;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-main);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 20px;
      line-height: 1.5;
    }

    .header-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid var(--border-color);
      padding-bottom: 15px;
      margin-bottom: 20px;
    }

    .header-banner h1 {
      font-size: 1.6rem;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .live-pill {
      font-size: 0.8rem;
      background-color: rgba(63, 185, 80, 0.15);
      color: var(--accent-green);
      border: 1px solid var(--accent-green);
      padding: 4px 12px;
      border-radius: 20px;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }

    .card {
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 15px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .card-title {
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--accent-blue);
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .vitals-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .vital-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background-color: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 0.95rem;
    }

    .vital-item span {
      color: var(--text-muted);
    }

    .vital-item strong {
      color: #fff;
      font-family: monospace;
    }

    .btn-toolbar {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-top: 5px;
    }

    button {
      background-color: var(--slot-bg);
      color: var(--text-main);
      border: 1px solid var(--border-color);
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background-color 0.2s, border-color 0.2s, color 0.2s;
    }

    button:hover {
      background-color: var(--accent-hover);
      border-color: var(--accent-blue);
      color: #fff;
    }

    button.btn-danger:hover {
      background-color: var(--accent-red);
      border-color: var(--accent-red);
      color: #fff;
    }

    button.btn-warning:hover {
      background-color: var(--accent-yellow);
      border-color: var(--accent-yellow);
      color: #000;
    }

    .radar-wrapper {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    #radarCanvas {
      background-color: #000000;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      width: 100%;
      height: 260px;
    }

    .radar-legend {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    .inventory-full-card {
      grid-column: 1 / -1;
    }

    .inventory-matrix {
      display: grid;
      grid-template-columns: repeat(9, 1fr);
      gap: 6px;
      background-color: #000000;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px;
    }

    .inv-slot {
      aspect-ratio: 1;
      background-color: var(--slot-bg);
      border: 1px solid var(--slot-border);
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 4px;
      position: relative;
      user-select: none;
    }

    .inv-slot.hotbar-slot {
      border: 2px solid var(--accent-blue);
      background-color: #1a2230;
    }

    .inv-item-name {
      font-size: 0.7rem;
      color: #fff;
      text-align: center;
      word-break: break-word;
      line-height: 1.1;
      max-height: 2.2em;
      overflow: hidden;
    }

    .inv-item-qty {
      position: absolute;
      bottom: 2px;
      right: 4px;
      font-size: 0.75rem;
      font-weight: bold;
      color: #fff;
      text-shadow: 1px 1px 2px #000;
      font-family: monospace;
    }

    .dpad-container {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      max-width: 200px;
      margin: 0 auto;
      padding: 10px 0;
    }

    .terminal-window {
      background-color: #000000;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      height: 180px;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-family: "Courier New", Courier, monospace;
      font-size: 0.85rem;
    }

    .terminal-entry {
      color: var(--text-main);
      border-bottom: 1px solid #161b22;
      padding-bottom: 2px;
    }

    .command-input-row {
      display: flex;
      gap: 10px;
      margin-top: 10px;
    }

    .command-input-row input {
      flex: 1;
      background-color: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      color: #fff;
      padding: 10px 14px;
      font-size: 0.9rem;
      font-family: monospace;
    }

    .command-input-row input:focus {
      outline: none;
      border-color: var(--accent-blue);
    }
  </style>
</head>
<body>

  <div class="header-banner">
    <h1>🛡️ Command Matrix: ${bot.username || 'Bot'}</h1>
    <div class="live-pill" id="agentStatusBadge">CONNECTED</div>
  </div>

  <div class="dashboard-grid">

    <!-- BOT VITALS & METRICS -->
    <div class="card">
      <div class="card-title">
        <span>Unit Diagnostics</span>
        <span id="dimensionLabel" style="font-size: 0.85rem; color: var(--accent-yellow);">Overworld</span>
      </div>
      <div class="vitals-list">
        <div class="vital-item">
          <span>Identity Callout</span>
          <strong id="botUsernameLabel">Acquiring...</strong>
        </div>
        <div class="vital-item">
          <span>World Coordinates</span>
          <strong id="botCoordinatesLabel">X: 0, Y: 0, Z: 0</strong>
        </div>
        <div class="vital-item">
          <span>Armor / HP Level</span>
          <strong id="botHealthLabel" style="color: var(--accent-green);">20 / 20</strong>
        </div>
        <div class="vital-item">
          <span>Food / Stamina</span>
          <strong id="botFoodLabel" style="color: var(--accent-yellow);">20 / 20</strong>
        </div>
      </div>

      <div class="btn-toolbar">
        <button class="btn-danger" onclick="triggerCommand('stop')">🛑 Halt Task</button>
        <button onclick="triggerCommand('afk')">🔄 Anti-AFK</button>
        <button onclick="triggerCommand('guard')">🛡️ Guard Patrol</button>
        <button class="btn-warning" onclick="triggerCommand('netherite')">🔥 Netherite Run</button>
        <button onclick="triggerCommand('sort')">🎒 Clean Bag</button>
        <button onclick="triggerCommand('smelt')">🔥 Smelt Ores</button>
      </div>
    </div>

    <!-- 2D TACTICAL RADAR CANVAS -->
    <div class="card">
      <div class="card-title">
        <span>32-Block Perimeter Radar</span>
      </div>
      <div class="radar-wrapper">
        <canvas id="radarCanvas" width="300" height="260"></canvas>
        <div class="radar-legend">
          <div class="legend-item"><span class="legend-dot" style="background-color: var(--accent-green);"></span> Bot</div>
          <div class="legend-item"><span class="legend-dot" style="background-color: var(--accent-blue);"></span> Players</div>
          <div class="legend-item"><span class="legend-dot" style="background-color: var(--accent-red);"></span> Hostiles</div>
          <div class="legend-item"><span class="legend-dot" style="background-color: var(--accent-yellow);"></span> Key Ores</div>
        </div>
      </div>
    </div>

    <!-- LIVE 36-SLOT INVENTORY GRID -->
    <div class="card inventory-full-card">
      <div class="card-title">
        <span>Realtime Inventory Matrix (Slots 0 - 35)</span>
        <span style="font-size: 0.8rem; color: var(--text-muted);">Slots 27-35 indicate Hotbar</span>
      </div>
      <div class="inventory-matrix" id="inventoryGridContainer"></div>
    </div>

    <!-- MANUAL DPAD NAVIGATION -->
    <div class="card">
      <div class="card-title">
        <span>Locomotion & D-Pad</span>
      </div>
      <div class="dpad-container">
        <div></div>
        <button onclick="sendManualMove('forward')">⬆️ Forward</button>
        <div></div>
        <button onclick="sendManualMove('left')">⬅️ Left</button>
        <button onclick="sendManualMove('jump')" style="background-color: var(--accent-blue); color: #fff;">🦘 Jump</button>
        <button onclick="sendManualMove('right')">➡️ Right</button>
        <div></div>
        <button onclick="sendManualMove('back')">⬇️ Back</button>
        <div></div>
      </div>
    </div>

    <!-- DISPATCH TERMINAL -->
    <div class="card">
      <div class="card-title">
        <span>Terminal Dispatch & Chat Stream</span>
      </div>
      <div class="terminal-window" id="terminalOutput"></div>
      <form class="command-input-row" onsubmit="event.preventDefault(); submitTerminalCommand();">
        <input type="text" id="terminalInput" placeholder="Enter command (e.g. mine diamond 3, come, fish)..." />
        <button type="submit" style="background-color: var(--accent-blue); color: #fff;">Dispatch</button>
      </form>
    </div>

  </div>

  <script>
    const socket = io();
    const canvas = document.getElementById('radarCanvas');
    const ctx = canvas.getContext('2d');

    socket.on('bot_sync', (state) => {
      document.getElementById('botUsernameLabel').innerText = state.username || 'Nokar';
      document.getElementById('botCoordinatesLabel').innerText = 
        \`X: \${Math.round(state.coords.x)}, Y: \${Math.round(state.coords.y)}, Z: \${Math.round(state.coords.z)}\`;
      document.getElementById('botHealthLabel').innerText = \`\${Math.round(state.health)} / 20 HP\`;
      document.getElementById('botFoodLabel').innerText = \`\${Math.round(state.food)} / 20 Hunger\`;
      document.getElementById('dimensionLabel').innerText = state.dimension;

      updateInventoryView(state.inventory);
      paintTacticalRadar(state.coords, state.entities, state.ores);
    });

    socket.on('chat_feed', (text) => {
      const output = document.getElementById('terminalOutput');
      const entry = document.createElement('div');
      entry.className = 'terminal-entry';
      entry.innerText = text;
      output.appendChild(entry);
      output.scrollTop = output.scrollHeight;
    });

    function updateInventoryView(items) {
      const container = document.getElementById('inventoryGridContainer');
      container.innerHTML = '';

      for (let slotIndex = 0; slotIndex < 36; slotIndex++) {
        const slotEl = document.createElement('div');
        slotEl.className = 'inv-slot' + (slotIndex >= 27 ? ' hotbar-slot' : '');

        const mappedIndex = (slotIndex < 9) ? (slotIndex + 36) : slotIndex;
        const matchingItem = items.find(i => i.slot === mappedIndex);

        if (matchingItem) {
          const nameSpan = document.createElement('span');
          nameSpan.className = 'inv-item-name';
          nameSpan.innerText = matchingItem.name.replace(/_/g, ' ');
          slotEl.appendChild(nameSpan);

          if (matchingItem.count > 1) {
            const countSpan = document.createElement('span');
            countSpan.className = 'inv-item-qty';
            countSpan.innerText = matchingItem.count;
            slotEl.appendChild(countSpan);
          }
        }
        container.appendChild(slotEl);
      }
    }

    function paintTacticalRadar(origin, entities, ores) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const scale = 3.5;

      ctx.strokeStyle = '#21262d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(centerX, centerY, 30, 0, Math.PI * 2);
      ctx.arc(centerX, centerY, 60, 0, Math.PI * 2);
      ctx.arc(centerX, centerY, 90, 0, Math.PI * 2);
      ctx.stroke();

      // Draw Self
      ctx.fillStyle = '#3fb950';
      ctx.beginPath();
      ctx.arc(centerX, centerY, 5, 0, Math.PI * 2);
      ctx.fill();

      // Draw Ores
      if (ores && ores.length) {
        ores.forEach(ore => {
          const dx = (ore.x - origin.x) * scale;
          const dz = (ore.z - origin.z) * scale;
          ctx.fillStyle = '#d29922';
          ctx.fillRect(centerX + dx - 2, centerY + dz - 2, 4, 4);
        });
      }

      // Draw Entities
      if (entities && entities.length) {
        entities.forEach(ent => {
          const dx = (ent.x - origin.x) * scale;
          const dz = (ent.z - origin.z) * scale;

          if (ent.isPlayer) {
            ctx.fillStyle = '#58a6ff';
            ctx.beginPath();
            ctx.arc(centerX + dx, centerY + dz, 4, 0, Math.PI * 2);
            ctx.fill();
          } else if (ent.isHostile) {
            ctx.fillStyle = '#f85149';
            ctx.beginPath();
            ctx.arc(centerX + dx, centerY + dz, 4, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = '#8b949e';
            ctx.fillRect(centerX + dx - 2, centerY + dz - 2, 3, 3);
          }
        });
      }
    }

    function triggerCommand(cmd) {
      socket.emit('dispatch_command', { cmd: cmd });
    }

    function sendManualMove(dir) {
      socket.emit('manual_action', { type: 'move', dir: dir });
    }

    function submitTerminalCommand() {
      const input = document.getElementById('terminalInput');
      const text = input.value.trim();
      if (text) {
        socket.emit('dispatch_command', { cmd: text });
        input.value = '';
      }
    }
  </script>
</body>
</html>`);
  });

  // State Synchronization Engine
  function syncState() {
    if (!bot.entity) return;

    const inventoryItems = bot.inventory.items().map(i => ({
      slot: i.slot,
      name: i.name,
      count: i.count
    }));

    const nearbyEntities = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position && bot.entity.position.distanceTo(e.position) <= 32)
      .map(e => ({
        x: e.position.x,
        z: e.position.z,
        isPlayer: e.type === 'player',
        isHostile: HOSTILE_MOBS.includes(e.name)
      }));

    let foundOres = [];
    try {
      const mcData = require('minecraft-data')(bot.version || '1.20.1');
      const targetOreIds = [
        'diamond_ore', 'deepslate_diamond_ore',
        'ancient_debris', 'iron_ore', 'deepslate_iron_ore',
        'gold_ore', 'deepslate_gold_ore'
      ].map(name => mcData.blocksByName[name]?.id).filter(Boolean);

      foundOres = bot.findBlocks({
        matching: targetOreIds,
        maxDistance: 24,
        count: 25
      }).map(pos => ({ x: pos.x, z: pos.z }));
    } catch (err) {}

    io.emit('bot_sync', {
      username: bot.username || 'Bot',
      coords: bot.entity.position,
      health: bot.health || 20,
      food: bot.food || 20,
      dimension: (bot.game && bot.game.dimension) ? bot.game.dimension : 'minecraft:overworld',
      inventory: inventoryItems,
      entities: nearbyEntities,
      ores: foundOres
    });
  }

  // Periodic State Broadcast
  setInterval(syncState, 1500);

  // Client Web Socket Listeners
  io.on('connection', (socket) => {
    syncState();

    socket.on('dispatch_command', (data) => {
      if (data && data.cmd) {
        bot.emit('messagestr', data.cmd);
      }
    });

    socket.on('manual_action', (action) => {
      if (action.type === 'move') {
        if (action.dir === 'jump') {
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 350);
        } else {
          bot.setControlState(action.dir, true);
          setTimeout(() => bot.setControlState(action.dir, false), 400);
        }
      }
    });
  });

  bot.inventory.on('updateSlot', () => syncState());
  bot.on('health', () => syncState());

  server.listen(port, () => {
    console.log(`[OPERATIONS SERVER ACTIVE] Port: ${port}`);
  });
}
/**
 * ============================================================================
 * MODULE: AUTONOMOUS NETHERITE PROGRESSION PIPELINE (PART 3)
 * FULL AUTONOMOUS FRAME BUILDER + STAIR-STEP Y:14 MINER + LAVA CLUTCH
 * ============================================================================
 */

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

    // Base placement anchor in front of the bot
    const base = bot.entity.position.floored().offset(2, 0, 0);
    botState.netherMission.portalCoords = base;

    // 4x5 Vertical Portal Frame Coordinates (Minimal 10 Obsidian)
    const frameOffsets = [
      // Bottom Row (2 blocks)
      new Vec3(1, 0, 0), new Vec3(2, 0, 0),
      // Left Column (3 blocks)
      new Vec3(0, 1, 0), new Vec3(0, 2, 0), new Vec3(0, 3, 0),
      // Right Column (3 blocks)
      new Vec3(3, 1, 0), new Vec3(3, 2, 0), new Vec3(3, 3, 0),
      // Top Row (2 blocks)
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

    // Step 2: Reliable Ignition using placeBlock on the top face
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

    // 1. Safe Staircase Downward to Y:14
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

    // 2. Scan Front Raycast for 26.2 Hazards (Sulfur Cubes, Lava, Magma)
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
      // Turn 90 degrees to bypass hazard wall
      await bot.look(bot.entity.yaw + Math.PI / 2, 0);
      return;
    }

    // 3. Scan for Ancient Debris in 16-block radius
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
          botState.netherMission.stage = 'SMELT_AND_UPGRADE';
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
      } catch (err) {
        console.error("[DEBRIS HARVEST ERROR]", err.message);
      }
      return;
    }

    // 4. Default Tunneling Forward at Y:14
    if (front1 && front1.name !== 'air') await bot.dig(front1).catch(() => {});
    if (front2 && front2.name !== 'air') await bot.dig(front2).catch(() => {});
    bot.setControlState('forward', true);
    setTimeout(() => bot.setControlState('forward', false), 350);

  }, 1800);
}

/**
 * ============================================================================
 * MAIN DAEMON INITIALIZER & EVENT LOOP
 * ============================================================================
 */
if (require.main === module) {
  let webServerStarted = false;

  function launchBot() {
    const HOST_ENDPOINT = process.argv[2] || 'DG_LAND502.aternos.me';
    const PORT_ENDPOINT = parseInt(process.argv[3], 10) || 62974;
    const BOT_IDENTITY = process.argv[4] || 'Nokar';
    const WEB_PORT = process.env.PORT || 3000;

    const bot = mineflayer.createBot({
      host: HOST_ENDPOINT,
      port: PORT_ENDPOINT,
      username: BOT_IDENTITY,
      checkTimeoutInterval: 120000,
      version: false
    });

    // RENDER FIX: Launch Web UI immediately so Render binds port before 30s timeout
    if (!webServerStarted) {
      try {
        webInventoryPlugin(bot, { port: WEB_PORT });
        webServerStarted = true;
      } catch (e) {
        console.error('[DASHBOARD ERROR]', e.message);
      }
    }

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(autoEat);

    bot.once('spawn', () => {
      console.log(`[AGENT LIVE] ${bot.username} entered the server.`);

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowParkour = false;
      defaultMove.canDig = true;
      defaultMove.allow1by1towers = false;

      bot.pathfinder.setMovements(defaultMove);
      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato']
      };

      startMobDefense(bot);
    });

    // Dimension Transition & Respawn Handler
    bot.on('respawn', () => {
      const dimension = bot.game.dimension;
      console.log(`[DIMENSION SHIFT] Transitioned to: ${dimension}`);

      if (dimension === 'minecraft:the_nether' && botState.netherMission.stage === 'PORTAL_BUILD') {
        safeChat(bot, "🔥 Nether me safely pahunch gaya! Y:14 tunneling shuru.");
        executeNetherMining(bot);
      } else if (dimension === 'minecraft:overworld' && botState.netherMission.stage === 'SMELT_AND_UPGRADE') {
        safeChat(bot, "🏡 Overworld safe return complete! Mission accomplished.");
        botState.netherMission.active = false;
        botState.netherMission.stage = 'IDLE';
      }
    });

    bot.on('physicsTick', () => {
      if (!botState.followingPlayer || botState.isBusyCrafting) return;
      const target = bot.players[botState.followingPlayer]?.entity;
      if (target) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      }
    });

    // Discord Synchronization Listener
    discordClient.on('messageCreate', async (msg) => {
      if (msg.author.bot || (DISCORD_CHANNEL_ID && msg.channel.id !== DISCORD_CHANNEL_ID)) return;
      const content = msg.content.trim();

      if (content.startsWith('!craft ')) {
        const parts = content.split(' ');
        smartGatherAndCraft(bot, parts[1], parseInt(parts[2], 10) || 1);
        return msg.reply(`🔨 Crafting routine started for ${parts[1]}`);
      }
      if (content.startsWith('!sort')) {
        sortAndCleanInventory(bot);
        return msg.reply('🎒 Inventory sorted and trash filtered!');
      }
      if (content.startsWith('!netherite')) {
        startNetheritePipeline(bot);
        return msg.reply('🔥 Netherite Autonomous Pipeline Initiated!');
      }
      if (content.startsWith('!ai ')) {
        const reply = await askAiBrain(content.slice(4), { hp: bot.health, food: bot.food });
        safeChat(bot, reply);
        return msg.reply(`🤖 **AI:** ${reply}`);
      }
      if (content === '!status') {
        return msg.reply(
          `📊 HP: ${Math.round(bot.health)}/20 | Auto-Defense: ${botState.guardMode ? 'ON' : 'OFF'} | Smelter: ${botState.autoSmelt ? 'ON' : 'OFF'} | Nether Mission: ${botState.netherMission.stage}`
        );
      }
      if (content.startsWith('!say ')) {
        safeChat(bot, content.slice(5));
        return msg.react('💬');
      }
    });

    // Universal In-Game Chat Listener
    bot.on('messagestr', async (message) => {
      if (message.startsWith(`[${bot.username}]`) || message.startsWith(`<${bot.username}>`)) return;

      if (discordChannel) {
        discordChannel.send(`💬 ${message}`).catch(() => {});
      }

      const cleanMsg = message.trim();
      const lower = cleanMsg.toLowerCase();

      const match = cleanMsg.match(/(?:<[^>]+>\s*|\[[^\]]+\]\s*|\w+:\s*)?(.*)/);
      const actualText = match ? match[1].trim() : cleanMsg;
      const args = actualText.split(/\s+/);
      const cmd = args[0]?.toLowerCase();

      if (cmd === 'come' || cmd === 'follow') {
        stopAntiAfk(bot);
        const sender = actualText.split(' ')[0] || '';
        botState.followingPlayer = sender;
        safeChat(bot, "Aapke paas aa raha hoon!");
      } else if (cmd === 'stop') {
        botState.followingPlayer = null;
        botState.isBusyCrafting = false;
        botState.autoSmelt = false;
        clearTimeout(botState.smeltingInterval);
        stopAntiAfk(bot);
        stopFishing();
        botState.autoFarm = false;
        clearTimeout(botState.farmingInterval);
        botState.netherMission.active = false;
        botState.netherMission.stage = 'IDLE';

        bot.clearControlStates();
        bot.pathfinder.stop();
        bot.collectBlock.cancelTask();
        safeChat(bot, "Sab stop kar diya!");
      } else if (cmd === 'netherite') {
        startNetheritePipeline(bot);
      } else if (cmd === 'craft' && args[1]) {
        const count = parseInt(args[2], 10) || 1;
        smartGatherAndCraft(bot, args[1].toLowerCase(), count);
      } else if (cmd === 'sort') {
        sortAndCleanInventory(bot);
      } else if (cmd === 'smelt') {
        botState.autoSmelt = !botState.autoSmelt;
        if (botState.autoSmelt) runAutoSmelter(bot);
        else clearTimeout(botState.smeltingInterval);
        safeChat(bot, `🔥 Auto Smelter: ${botState.autoSmelt ? 'ON' : 'OFF'}`);
      } else if (cmd === 'guard' || cmd === 'defense') {
        botState.guardMode = !botState.guardMode;
        if (botState.guardMode) {
          startMobDefense(bot);
        } else {
          stopMobDefense();
        }
        safeChat(bot, `🛡️ Auto Mob Defense: ${botState.guardMode ? 'ON' : 'OFF'}`);
      } else if (cmd === 'afk') {
        if (botState.antiAfk) {
          stopAntiAfk(bot);
        } else {
          startAntiAfk(bot);
        }
      } else if (cmd === 'fish') {
        if (botState.isFishing) {
          stopFishing();
        } else {
          startFishing(bot);
        }
      } else if (cmd === 'farm') {
        botState.autoFarm = !botState.autoFarm;
        if (botState.autoFarm) {
          runFarmLoop(bot);
        } else {
          clearTimeout(botState.farmingInterval);
        }
        safeChat(bot, `🌾 Auto Farm: ${botState.autoFarm ? 'ON' : 'OFF'}`);
      } else if (cmd === 'deposit' || cmd === 'chest') {
        dumpToChest(bot);
      } else if (cmd === 'build' && args[1] === 'house') {
        executeHouseBuild(bot);
      } else if (cmd === 'mine' || cmd === 'collect') {
        let blockQuery = args[1]?.toLowerCase();
        let count = parseInt(args[2], 10) || 1;
        const mcData = require('minecraft-data')(bot.version);

        let targetNames = BLOCK_ALIASES[blockQuery] || [blockQuery];
        let targetIds = targetNames.map(name => mcData.blocksByName[name]?.id).filter(Boolean);

        const found = bot.findBlocks({ matching: targetIds, maxDistance: 32, count });
        if (!found.length) {
          return safeChat(bot, `Aas-paas ${blockQuery} nahi mila.`);
        }

        safeChat(bot, `${found.length} ${blockQuery} tod raha hoon...`);
        try {
          const targets = found.map(pos => bot.blockAt(pos));
          await equipBestTool(bot, targets[0]);
          await bot.collectBlock.collect(targets);
          safeChat(bot, "Mining complete!");
        } catch (e) {
          safeChat(bot, `Mining Error: ${e.message}`);
        }
      } else if (cmd === 'dropall') {
        for (const item of bot.inventory.items()) {
          try { await bot.tossStack(item); } catch (e) {}
        }
        safeChat(bot, "Sari inventory drop kar di!");
      } else {
        if (lower.includes('nokar') || lower.includes('bot') || lower.startsWith('!ai')) {
          const prompt = actualText.replace(/^(nokar|bot|!ai)\s*/i, '');
          const reply = await askAiBrain(prompt || "hi", { hp: bot.health, food: bot.food });
          safeChat(bot, reply);
        }
      }
    });

    bot.on('end', () => {
      console.log('[RECONNECT] Connection ended. Reconnecting in 10s...');
      setTimeout(launchBot, 10000);
    });

    bot.on('error', (err) => {
      console.error('[CRITICAL BOT ERROR]', err.message);
    });
  }

  launchBot();
}
