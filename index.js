/**
 * ============================================================================
 * TITAN AUTONOMOUS MINECRAFT COMPANION & OPERATIONS CONSOLE
 * VERSION: 23.0.0 (MASTER FULL EDITION - NO COMPRESSION)
 * ============================================================================
 * Included Systems:
 * - Direct Raycast Combat & Guard Sentry Routine
 * - 2D Dynamic Compass Radar (N, S, E, W + Distance Tracking)
 * - Container & Valuable Ore Scanner (Diamond, Ancient Debris, Chests)
 * - Web Controller with D-Pad, Manual Combat, and Slot Management
 * - Autonomous Builder (4x4 Shelter), Auto-Farmer, Auto-Fisher
 * - Full Crafting Engine with Crafting Table Interaction
 * - Discord Dual-Way Communication Bridge
 * - Dual-Model Native Gemini AI Engine (2.5-Flash & Latest Fallback)
 * ============================================================================
 */

const http = require('http');
const express = require('express');
const socketIo = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { Client, GatewayIntentBits } = require('discord.js');

// Core Plugins
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;

/**
 * Global State Container
 */
const botState = {
  autoEat: true,
  autoFarm: false,
  farmingInterval: null,
  followingPlayer: null,
  antiAfk: false,
  antiAfkInterval: null,
  guardMode: false,
  guardInterval: null,
  guardOrigin: null,
  isFishing: false
};

/**
 * Comprehensive Block Aliases Table
 */
const BLOCK_ALIASES = {
  'diamond': [
    'diamond_ore', 
    'deepslate_diamond_ore', 
    'diamond_block'
  ],
  'iron': [
    'iron_ore', 
    'deepslate_iron_ore', 
    'raw_iron_block'
  ],
  'gold': [
    'gold_ore', 
    'deepslate_gold_ore', 
    'raw_gold_block'
  ],
  'coal': [
    'coal_ore', 
    'deepslate_coal_ore', 
    'coal_block'
  ],
  'copper': [
    'copper_ore', 
    'deepslate_copper_ore', 
    'raw_copper_block'
  ],
  'lapis': [
    'lapis_ore', 
    'deepslate_lapis_ore', 
    'lapis_block'
  ],
  'redstone': [
    'redstone_ore', 
    'deepslate_redstone_ore', 
    'redstone_block'
  ],
  'wood': [
    'oak_log', 
    'birch_log', 
    'spruce_log', 
    'dark_oak_log', 
    'jungle_log', 
    'acacia_log', 
    'mangrove_log', 
    'cherry_log'
  ],
  'tree': [
    'oak_log', 
    'birch_log', 
    'spruce_log', 
    'dark_oak_log'
  ],
  'stone': [
    'stone', 
    'cobblestone', 
    'deepslate', 
    'cobbled_deepslate', 
    'andesite', 
    'diorite', 
    'granite'
  ],
  'dirt': [
    'dirt', 
    'grass_block', 
    'coarse_dirt'
  ],
  'sand': [
    'sand', 
    'red_sand'
  ]
};

/**
 * ============================================================================
 * ARTIFICIAL INTELLIGENCE CORE (GEMINI 2.5 FLASH + DUAL FALLBACK)
 * ============================================================================
 */
async function askAiBrain(promptText, botStatus) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return "Boss, Render me GEMINI_API_KEY set nahi hai!";
  }

  const cleanKey = apiKey.trim();
  const candidateModels = [
    'gemini-2.5-flash',
    'gemini-flash-latest'
  ];

  for (const model of candidateModels) {
    try {
      const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
      const instructionPrompt = `You are 'Nokar', a witty, smart, and loyal Minecraft companion. Answer strictly in short, natural Hinglish (maximum 20 words). Current Bot Status -> Health: ${botStatus.hp}/20, Food: ${botStatus.food}/20. User says: "${promptText}"`;

      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: instructionPrompt
            }]
          }]
        })
      });

      const responseData = await response.json();

      if (!responseData.error && responseData.candidates && responseData.candidates[0]?.content?.parts?.[0]?.text) {
        return responseData.candidates[0].content.parts[0].text.trim();
      }
    } catch (fetchError) {
      // Continue to next candidate model on network fail
    }
  }

  return "Haan boss, sun raha hoon bolo!";
}

/**
 * ============================================================================
 * DISCORD INTERACTIVE BRIDGE
 * ============================================================================
 */
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
let discordChannel = null;

if (DISCORD_TOKEN) {
  discordClient.login(DISCORD_TOKEN).catch(err => {
    console.error('[DISCORD ERROR] Login Failed:', err.message);
  });

  discordClient.once('ready', async () => {
    console.log(`[DISCORD LIVE] Connected as ${discordClient.user.tag}`);
    if (DISCORD_CHANNEL_ID) {
      discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
      if (discordChannel) {
        discordChannel.send('🟢 **Titan Assistant System Online & World Synchronized!**');
      }
    }
  });
}

/**
 * ============================================================================
 * EQUIPMENT, WEAPON & TOOL LOGIC
 * ============================================================================
 */
async function equipBestWeapon(bot) {
  const weapons = bot.inventory.items().filter(item => 
    item.name.includes('sword') || item.name.includes('axe')
  );
  if (!weapons.length) return false;

  const weaponPriority = [
    'netherite_sword',
    'diamond_sword',
    'iron_sword',
    'netherite_axe',
    'diamond_axe',
    'stone_sword',
    'iron_axe',
    'wooden_sword',
    'stone_axe',
    'wooden_axe'
  ];

  weapons.sort((a, b) => {
    let aRank = weaponPriority.indexOf(a.name);
    let bRank = weaponPriority.indexOf(b.name);
    if (aRank === -1) aRank = 999;
    if (bRank === -1) bRank = 999;
    return aRank - bRank;
  });

  try {
    await bot.equip(weapons[0], 'hand');
    return true;
  } catch (err) {
    return false;
  }
}

async function equipBestTool(bot, targetBlock) {
  if (!targetBlock) return;
  const items = bot.inventory.items();
  let requiredType = '';

  const blockName = targetBlock.name;
  if (blockName.includes('ore') || blockName.includes('stone') || blockName.includes('cobble') || blockName.includes('deepslate')) {
    requiredType = 'pickaxe';
  } else if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('plank')) {
    requiredType = 'axe';
  } else if (blockName.includes('dirt') || blockName.includes('sand') || blockName.includes('gravel') || blockName.includes('clay')) {
    requiredType = 'shovel';
  } else if (blockName.includes('wheat') || blockName.includes('carrots') || blockName.includes('potatoes')) {
    requiredType = 'hoe';
  }

  if (!requiredType) return;

  const matchingTools = items.filter(item => item.name.includes(requiredType));
  if (matchingTools.length > 0) {
    try {
      await bot.equip(matchingTools[0], 'hand');
    } catch (err) {}
  }
}

/**
 * ============================================================================
 * COMBAT & SENTRY (GUARD MODE)
 * ============================================================================
 */
function startGuardMode(bot) {
  botState.guardMode = true;
  botState.guardOrigin = bot.entity.position.clone();
  bot.chat("🛡️ Guard Mode Active! Sabhi dushmano ko khatam karunga.");

  botState.guardInterval = setInterval(async () => {
    if (!botState.guardMode) return;

    const hostiles = [
      'zombie', 'skeleton', 'spider', 'creeper', 'drowned', 
      'husk', 'enderman', 'witch', 'slime', 'phantom', 'pillager'
    ];

    const targetMob = bot.nearestEntity(entity => {
      if (entity.type !== 'mob') return false;
      const name = (entity.name || entity.displayName || '').toLowerCase();
      return hostiles.some(h => name.includes(h)) && bot.entity.position.distanceTo(entity.position) <= 16;
    });

    if (targetMob) {
      await equipBestWeapon(bot);
      const distance = bot.entity.position.distanceTo(targetMob.position);

      // Follow target aggressively
      bot.pathfinder.setGoal(new goals.GoalFollow(targetMob, 2), false);

      // Attack within range
      if (distance <= 3.8) {
        const aimOffset = targetMob.height ? targetMob.height * 0.75 : 1.1;
        await bot.lookAt(targetMob.position.offset(0, aimOffset, 0));
        bot.attack(targetMob);
      }
    } else {
      // Return to guard post
      if (botState.guardOrigin && bot.entity.position.distanceTo(botState.guardOrigin) > 6) {
        bot.pathfinder.setGoal(new goals.GoalNear(botState.guardOrigin.x, botState.guardOrigin.y, botState.guardOrigin.z, 2));
      }
    }
  }, 400);
}

function stopGuardMode(bot) {
  botState.guardMode = false;
  if (botState.guardInterval) {
    clearInterval(botState.guardInterval);
  }
  bot.pathfinder.stop();
}

/**
 * ============================================================================
 * AUTONOMOUS ROUTINES: AFK, FISH, FARM, BUILD, CHEST
 * ============================================================================
 */
function startAntiAfk(bot) {
  botState.antiAfk = true;
  bot.chat("🚶 Anti-AFK Wander ON!");
  const originPos = bot.entity.position.clone();

  botState.antiAfkInterval = setInterval(async () => {
    if (!botState.antiAfk || botState.followingPlayer || botState.guardMode) return;
    try {
      const offsetX = Math.floor(Math.random() * 12) - 6;
      const offsetZ = Math.floor(Math.random() * 12) - 6;

      bot.setControlState('jump', Math.random() > 0.5);
      setTimeout(() => bot.setControlState('jump', false), 300);

      await bot.pathfinder.goto(new goals.GoalNear(originPos.x + offsetX, originPos.y, originPos.z + offsetZ, 1));
    } catch (e) {}
  }, 4500);
}

function stopAntiAfk(bot) {
  botState.antiAfk = false;
  if (botState.antiAfkInterval) {
    clearInterval(botState.antiAfkInterval);
  }
  bot.clearControlStates();
}

async function startFishing(bot) {
  const fishingRod = bot.inventory.items().find(i => i.name === 'fishing_rod');
  if (!fishingRod) {
    bot.chat("Mere paas Fishing Rod nahi hai boss!");
    return;
  }

  botState.isFishing = true;
  bot.chat("🎣 Fishing shuru kar raha hoon...");
  await bot.equip(fishingRod, 'hand');

  async function castLine() {
    if (!botState.isFishing) return;
    try {
      await bot.fish();
      castLine();
    } catch (err) {
      if (botState.isFishing) {
        setTimeout(castLine, 2000);
      }
    }
  }

  castLine();
}

function stopFishing(bot) {
  botState.isFishing = false;
}

async function runFarmLoop(bot) {
  if (!botState.autoFarm) return;
  const mcData = require('minecraft-data')(bot.version);
  const cropTypes = ['wheat', 'carrots', 'potatoes', 'beetroots'].map(name => mcData.blocksByName[name]?.id).filter(Boolean);

  const matureCrops = bot.findBlocks({
    matching: block => cropTypes.includes(block.type) && block.metadata === 7,
    maxDistance: 32,
    count: 6
  });

  if (matureCrops.length > 0) {
    try {
      await bot.collectBlock.collect(matureCrops.map(pos => bot.blockAt(pos)));

      for (const cropPos of matureCrops) {
        const soilBlock = bot.blockAt(cropPos.offset(0, -1, 0));
        const seedItem = bot.inventory.items().find(i => 
          i.name.includes('seeds') || i.name === 'carrot' || i.name === 'potato'
        );

        if (soilBlock && soilBlock.name === 'farmland' && seedItem) {
          await bot.equip(seedItem, 'hand');
          await bot.placeBlock(soilBlock, new Vec3(0, 1, 0)).catch(() => {});
          await bot.waitForTicks(2);
        }
      }
    } catch (err) {}
  }

  if (botState.autoFarm) {
    botState.farmingInterval = setTimeout(() => runFarmLoop(bot), 4000);
  }
}

async function executeHouseBuild(bot) {
  const getStructureBlock = () => bot.inventory.items().find(i =>
    i.name.includes('plank') || i.name.includes('cobble') || i.name.includes('stone') || i.name.includes('dirt')
  );

  if (!getStructureBlock()) {
    return bot.chat("Ghar banane ke liye blocks (planks/cobble/stone) nahi hain!");
  }

  bot.chat("🏠 4x4 Shelter banana shuru kar raha hoon...");
  const basePoint = bot.entity.position.floored().offset(1, 0, 1);
  const blockPlacementList = [];

  // Wall perimeter
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        if (x === 0 || x === 3 || z === 0 || z === 3) {
          if (x === 1 && z === 0 && (y === 0 || y === 1)) {
            continue; // Door gap
          }
          blockPlacementList.push(basePoint.offset(x, y, z));
        }
      }
    }
  }

  // Ceiling
  for (let x = 0; x < 4; x++) {
    for (let z = 0; z < 4; z++) {
      blockPlacementList.push(basePoint.offset(x, 3, z));
    }
  }

  for (const targetPos of blockPlacementList) {
    const currentBlock = bot.blockAt(targetPos);
    if (!currentBlock || currentBlock.name !== 'air') continue;

    const availableBlock = getStructureBlock();
    if (!availableBlock) {
      bot.chat("Blocks khatam ho gaye!");
      return;
    }

    try {
      await bot.equip(availableBlock, 'hand');
      if (bot.entity.position.distanceTo(targetPos) > 4.5) {
        await bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3)).catch(() => {});
      }

      const surrounding = [
        targetPos.offset(0, -1, 0),
        targetPos.offset(1, 0, 0),
        targetPos.offset(-1, 0, 0),
        targetPos.offset(0, 0, 1),
        targetPos.offset(0, 0, -1)
      ];

      for (const neighborPos of surrounding) {
        const neighborBlock = bot.blockAt(neighborPos);
        if (neighborBlock && neighborBlock.name !== 'air') {
          await bot.lookAt(targetPos);
          await bot.placeBlock(neighborBlock, targetPos.minus(neighborPos)).catch(() => {});
          await bot.waitForTicks(3);
          break;
        }
      }
    } catch (placeErr) {}
  }

  bot.chat("Ghar complete ho gaya boss!");
}

async function dumpToChest(bot) {
  const mcData = require('minecraft-data')(bot.version);
  const storageBlock = bot.findBlock({
    matching: [
      mcData.blocksByName.chest?.id,
      mcData.blocksByName.trapped_chest?.id,
      mcData.blocksByName.barrel?.id
    ].filter(Boolean),
    maxDistance: 6
  });

  if (!storageBlock) {
    return bot.chat("Paas me koi Chest ya Barrel nahi mila!");
  }

  bot.chat("📦 Saman chest me deposit kar raha hoon...");
  try {
    const chestWindow = await bot.openChest(storageBlock);
    const allItems = bot.inventory.items();

    for (const item of allItems) {
      if (item.name.includes('sword') || item.name.includes('pickaxe') || item.name.includes('helmet') || item.name.includes('chestplate')) {
        continue;
      }
      try {
        await chestWindow.deposit(item.type, null, item.count);
        await bot.waitForTicks(2);
      } catch (depositErr) {}
    }

    chestWindow.close();
    bot.chat("Sara saman deposit ho gaya!");
  } catch (err) {
    bot.chat(`Chest error: ${err.message}`);
  }
}

/**
 * ============================================================================
 * WEB OPERATIONS CONSOLE (FULL RADAR + COMPASS + DIRECTION HUD)
 * ============================================================================
 */
function webInventoryPlugin(bot, customOptions = {}) {
  const port = customOptions.port || process.env.PORT || 3000;
  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server);

  app.use(express.json());

  app.get('/', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
        <title>Titan Master Console V23</title>
        <script src="/socket.io/socket.io.js"></script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070a13; color: #e2e8f0; display: flex; justify-content: center; padding: 12px; }
          .panel { width: 100%; max-width: 680px; background: #111827; border-radius: 14px; border: 1px solid #1f2937; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); }
          .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
          .title { font-size: 19px; font-weight: 800; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
          
          .chat-box { display: flex; gap: 8px; margin-bottom: 14px; }
          .chat-input { flex: 1; padding: 12px; background: #030712; border: 1px solid #374151; border-radius: 8px; color: #fff; font-size: 14px; outline: none; }
          .chat-input:focus { border-color: #38bdf8; }
          .chat-btn { background: #0284c7; padding: 12px 18px; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; }
          
          .ctrl-wrapper { background: #030712; border: 1px solid #1f2937; border-radius: 12px; padding: 14px; margin-bottom: 14px; display: flex; flex-direction: column; align-items: center; }
          .dpad { display: grid; grid-template-columns: repeat(3, 52px); grid-template-rows: repeat(3, 52px); gap: 6px; margin-bottom: 12px; }
          .ctrl-btn { background: #1f2937; border: 1px solid #374151; border-radius: 8px; color: white; font-size: 18px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
          .ctrl-btn:active { background: #0284c7; transform: scale(0.95); }
          
          .manual-actions { display: flex; gap: 8px; width: 100%; justify-content: center; }
          .manual-btn { padding: 11px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; color: white; flex: 1; font-size: 13px; }
          .manual-btn:active { transform: scale(0.95); }

          .action-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 14px; }
          .act-btn { padding: 11px; border: none; border-radius: 8px; font-weight: bold; color: white; font-size: 12px; cursor: pointer; }
          .act-btn:active { transform: scale(0.97); }
          
          .btn-guard { background: #dc2626; } 
          .btn-afk { background: #6366f1; } 
          .btn-chest { background: #d97706; } 
          .btn-fish { background: #0891b2; }
          .btn-farm { background: #059669; } 
          .btn-build { background: #2563eb; } 
          .btn-drop { background: #e11d48; } 
          .btn-stop { background: #991b1b; grid-column: span 2; padding: 13px; font-size: 14px; }
          
          .radar-card { display: flex; flex-direction: column; align-items: center; background: #030712; border-radius: 12px; border: 1px solid #1f2937; padding: 12px; margin-bottom: 14px; }
          #radarCanvas { background: #050811; border-radius: 8px; border: 1px solid #374151; width: 280px; height: 280px; display: block; }
          
          .radar-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; font-size: 11px; margin-top: 10px; color: #9ca3af; }
          .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
          
          .radar-list { width: 100%; max-height: 125px; overflow-y: auto; background: #0b1120; border-radius: 8px; padding: 8px; margin-top: 10px; font-size: 11px; border: 1px solid #1e293b; }
          .radar-item { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #1e293b; }
          
          .meters { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
          .meter { background: #030712; padding: 10px; border-radius: 8px; text-align: center; border: 1px solid #1f2937; }
          .meter-val { font-size: 17px; font-weight: bold; }
          
          .hint { font-size: 11px; color: #9ca3af; text-align: center; margin: 4px 0 8px; }
          .grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px; background: #030712; padding: 8px; border-radius: 8px; border: 1px solid #1f2937; }
          .slot { aspect-ratio: 1; background: #1f2937; border: 1px solid #374151; border-radius: 4px; position: relative; display: flex; align-items: center; justify-content: center; text-align: center; cursor: pointer; }
          .slot:active { border-color: #38bdf8; background: #1e293b; }
          .item-name { font-size: 7.5px; color: #cbd5e1; word-break: break-all; line-height: 1; }
          .item-count { position: absolute; bottom: 1px; right: 2px; font-size: 9px; font-weight: bold; color: #38bdf8; }
        </style>
      </head>
      <body>
        <div class="panel">
          <div class="top-bar">
            <div class="title">🎮 Titan Operations Console</div>
            <div style="font-size:12px; color:#22c55e; font-weight:bold;">● Live Connected</div>
          </div>
          
          <div class="chat-box">
            <input type="text" id="chatMsg" class="chat-input" placeholder="Chat in game or execute command...">
            <button class="chat-btn" onclick="sendChat()">Send</button>
          </div>

          <div class="ctrl-wrapper">
            <div class="dpad">
              <div></div>
              <button class="ctrl-btn" onpointerdown="startMove('forward')" onpointerup="stopMove('forward')" onpointerleave="stopMove('forward')">⬆️</button>
              <div></div>
              <button class="ctrl-btn" onpointerdown="startMove('left')" onpointerup="stopMove('left')" onpointerleave="stopMove('left')">⬅️</button>
              <button class="ctrl-btn" onclick="jump()">🦘</button>
              <button class="ctrl-btn" onpointerdown="startMove('right')" onpointerup="stopMove('right')" onpointerleave="stopMove('right')">➡️</button>
              <div></div>
              <button class="ctrl-btn" onpointerdown="startMove('back')" onpointerup="stopMove('back')" onpointerleave="stopMove('back')">⬇️</button>
              <div></div>
            </div>
            <div class="manual-actions">
              <button class="manual-btn" style="background:#b91c1c;" onclick="socket.emit('manual_action', 'attack')">⚔️ Attack</button>
              <button class="manual-btn" style="background:#57534e;" onclick="socket.emit('manual_action', 'mine')">⛏️ Mine</button>
              <button class="manual-btn" style="background:#854d0e;" onclick="socket.emit('manual_action', 'place')">🧱 Place</button>
            </div>
          </div>

          <div class="action-grid">
            <button class="act-btn btn-guard" id="guardBtn" onclick="send('toggle_guard')">🛡️ Guard: OFF</button>
            <button class="act-btn btn-afk" id="afkBtn" onclick="send('toggle_afk')">🚶 AFK: OFF</button>
            <button class="act-btn btn-fish" id="fishBtn" onclick="send('toggle_fish')">🎣 Fish: OFF</button>
            <button class="act-btn btn-farm" id="farmBtn" onclick="send('toggle_farm')">🌾 Farm: OFF</button>
            <button class="act-btn btn-build" onclick="send('build_house')">🏠 Build House</button>
            <button class="act-btn btn-chest" onclick="send('dump_chest')">📦 Dump Chest</button>
            <button class="act-btn btn-drop" onclick="send('drop_hand')">🗑️ Drop Hand Item</button>
            <button class="act-btn btn-stop" onclick="send('stop')">🛑 Stop All Actions</button>
          </div>

          <div class="radar-card">
            <canvas id="radarCanvas" width="280" height="280"></canvas>
            <div class="radar-legend">
              <div><span class="dot" style="background:#22c55e;"></span> Bot</div>
              <div><span class="dot" style="background:#38bdf8;"></span> Player</div>
              <div><span class="dot" style="background:#ef4444;"></span> Mob</div>
              <div><span class="dot" style="background:#eab308;"></span> Chest</div>
              <div><span class="dot" style="background:#06b6d4;"></span> Diamond</div>
              <div><span class="dot" style="background:#f97316;"></span> Ore</div>
            </div>
            <div class="radar-list" id="radarList">
              <div style="color:#64748b; text-align:center;">Scanning surroundings...</div>
            </div>
          </div>

          <div class="meters">
            <div class="meter"><div class="meter-val" style="color:#f43f5e;" id="hp">20 / 20</div><div style="font-size:11px;">❤️ Health</div></div>
            <div class="meter"><div class="meter-val" style="color:#fbbf24;" id="food">20 / 20</div><div style="font-size:11px;">🍖 Hunger</div></div>
          </div>

          <div class="hint">👉 <b>Tap</b> slot to Equip | <b>Double Tap</b> slot to Drop</div>
          
          <div style="font-size:11px; margin-bottom:4px; color:#9ca3af; font-weight:bold;">Hotbar</div>
          <div class="grid" id="hotbarGrid"></div>
          
          <div style="font-size:11px; margin: 8px 0 4px; color:#9ca3af; font-weight:bold;">Main Storage</div>
          <div class="grid" id="mainGrid"></div>
        </div>

        <script>
          const socket = io();
          const canvas = document.getElementById('radarCanvas');
          const ctx = canvas.getContext('2d');
          const cX = 140, cY = 140, scale = 5.5;

          const main = document.getElementById('mainGrid');
          const hotbar = document.getElementById('hotbarGrid');

          for (let i = 36; i <= 44; i++) hotbar.innerHTML += '<div class="slot" id="s-' + i + '" onclick="slotClick(' + i + ')" ondblclick="slotDrop(' + i + ')"></div>';
          for (let i = 9; i <= 35; i++) main.innerHTML += '<div class="slot" id="s-' + i + '" onclick="slotClick(' + i + ')" ondblclick="slotDrop(' + i + ')"></div>';

          function slotClick(id) { socket.emit('equip_slot', { slot: id }); }
          function slotDrop(id) { socket.emit('drop_slot', { slot: id }); }
          function startMove(dir) { socket.emit('control_move', { direction: dir, state: true }); }
          function stopMove(dir) { socket.emit('control_move', { direction: dir, state: false }); }
          function jump() { socket.emit('control_jump'); }

          function sendChat() {
            const input = document.getElementById('chatMsg');
            if (input.value.trim()) {
              socket.emit('send_chat', { message: input.value.trim() });
              input.value = '';
            }
          }
          document.getElementById('chatMsg').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendChat();
          });

          socket.on('radar', data => {
            ctx.clearRect(0, 0, 280, 280);

            // Background concentric rings
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            [35, 70, 105].forEach(r => {
              ctx.beginPath();
              ctx.arc(cX, cY, r, 0, Math.PI * 2);
              ctx.stroke();
            });

            // Grid lines
            ctx.strokeStyle = '#0f172a';
            ctx.beginPath(); ctx.moveTo(cX, 0); ctx.lineTo(cX, 280); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, cY); ctx.lineTo(280, cY); ctx.stroke();

            // Compass Markers
            ctx.fillStyle = '#64748b';
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('N', cX, 12);
            ctx.fillText('S', cX, 275);
            ctx.fillText('W', 10, cY + 4);
            ctx.fillText('E', 270, cY + 4);

            let listHTML = '';

            data.entities.forEach(e => {
              const dx = e.x - data.bot.x;
              const dz = e.z - data.bot.z;
              const pX = cX + dx * scale;
              const pY = cY + dz * scale;
              const dist = Math.round(Math.sqrt(dx * dx + dz * dz));

              // Cardinal direction calculation
              let dir = '';
              if (dz < -2) dir += 'North ';
              else if (dz > 2) dir += 'South ';
              if (dx > 2) dir += 'East';
              else if (dx < -2) dir += 'West';
              if (!dir) dir = 'Near';

              // Visual classification
              let color = '#38bdf8';
              if (e.type === 'mob') color = '#ef4444';
              else if (e.type === 'chest') color = '#eab308';
              else if (e.type === 'rare_ore') color = '#06b6d4';
              else if (e.type === 'common_ore') color = '#f97316';

              // Canvas plotting
              if (pX >= 4 && pX <= 276 && pY >= 4 && pY <= 276) {
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(pX, pY, e.type.includes('ore') || e.type === 'chest' ? 3.5 : 4.5, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = '#f8fafc';
                ctx.font = '8px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(e.name + ' [' + dist + 'm]', pX + 5, pY + 3);
              }

              // Build list item
              listHTML += '<div class="radar-item">' +
                '<span style="color:' + color + '">● ' + e.name + '</span>' +
                '<span style="color:#94a3b8">' + dist + ' blocks ' + dir + (e.y !== undefined ? ' (Y:' + Math.round(e.y) + ')' : '') + '</span>' +
                '</div>';
            });

            document.getElementById('radarList').innerHTML = listHTML || '<div style="color:#64748b; text-align:center;">No targets nearby</div>';

            // Center Bot
            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(cX, cY, 5, 0, Math.PI * 2);
            ctx.fill();
          });

          socket.on('sync', data => {
            if (data.hp !== undefined) document.getElementById('hp').innerText = Math.round(data.hp) + ' / 20';
            if (data.food !== undefined) document.getElementById('food').innerText = Math.round(data.food) + ' / 20';
            for (let i = 9; i <= 44; i++) {
              const el = document.getElementById('s-' + i);
              if (!el) continue;
              const item = data.items.find(x => x.slot === i);
              if (item) {
                el.innerHTML = '<span class="item-name">' + item.name.replace(/_/g, ' ') + '</span>' + (item.count > 1 ? '<span class="item-count">' + item.count + '</span>' : '');
                el.style.background = '#1e293b';
              } else {
                el.innerHTML = '';
                el.style.background = '#111827';
              }
            }
          });

          function send(act) {
            fetch('/api/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: act })
            })
            .then(r => r.json())
            .then(d => {
              if (act === 'toggle_afk') document.getElementById('afkBtn').innerText = '🚶 AFK: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_guard') document.getElementById('guardBtn').innerText = '🛡️ Guard: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_fish') document.getElementById('fishBtn').innerText = '🎣 Fish: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_farm') document.getElementById('farmBtn').innerText = '🌾 Farm: ' + (d.state ? 'ON' : 'OFF');
            });
          }
        </script>
      </body>
      </html>
    `);
  });

  app.post('/api/action', async (req, res) => {
    const act = req.body.action;

    if (act === 'toggle_afk') {
      botState.antiAfk ? stopAntiAfk(bot) : startAntiAfk(bot);
      return res.json({ success: true, state: botState.antiAfk });
    }
    if (act === 'toggle_guard') {
      botState.guardMode ? stopGuardMode(bot) : startGuardMode(bot);
      return res.json({ success: true, state: botState.guardMode });
    }
    if (act === 'toggle_fish') {
      botState.isFishing ? stopFishing(bot) : startFishing(bot);
      return res.json({ success: true, state: botState.isFishing });
    }
    if (act === 'toggle_farm') {
      botState.autoFarm = !botState.autoFarm;
      if (botState.autoFarm) runFarmLoop(bot);
      else clearTimeout(botState.farmingInterval);
      return res.json({ success: true, state: botState.autoFarm });
    }
    if (act === 'build_house') {
      executeHouseBuild(bot);
      return res.json({ success: true });
    }
    if (act === 'dump_chest') {
      dumpToChest(bot);
      return res.json({ success: true });
    }
    if (act === 'drop_hand') {
      const held = bot.heldItem;
      if (held) bot.tossStack(held).catch(() => {});
      return res.json({ success: true });
    }
    if (act === 'stop') {
      botState.followingPlayer = null;
      stopAntiAfk(bot);
      stopGuardMode(bot);
      stopFishing(bot);
      botState.autoFarm = false;
      clearTimeout(botState.farmingInterval);

      bot.clearControlStates();
      bot.pathfinder.stop();
      bot.collectBlock.cancelTask();
      bot.chat("Sab stop kar diya!");
      return res.json({ success: true });
    }

    res.json({ success: false });
  });

  io.on('connection', (socket) => {
    syncState();

    socket.on('control_move', data => bot.setControlState(data.direction, !!data.state));
    socket.on('control_jump', () => {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 350);
    });

    socket.on('equip_slot', async data => {
      const item = bot.inventory.slots[data.slot];
      if (item) {
        try { await bot.equip(item, 'hand'); } catch (e) {}
      }
    });

    socket.on('drop_slot', async data => {
      const item = bot.inventory.slots[data.slot];
      if (item) {
        try { await bot.tossStack(item); } catch (e) {}
      }
    });

    socket.on('manual_action', async type => {
      if (type === 'attack') {
        const target = bot.nearestEntity(e => 
          (e.type === 'mob' || e.type === 'player') && bot.entity.position.distanceTo(e.position) <= 4.5
        );
        if (target) {
          await equipBestWeapon(bot);
          await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.75 : 1, 0));
          bot.attack(target);
        } else {
          bot.swingArm();
        }
      } else if (type === 'mine') {
        const targetBlock = bot.blockAtCursor(4.5);
        if (targetBlock && targetBlock.name !== 'air') {
          await equipBestTool(bot, targetBlock);
          try { await bot.dig(targetBlock); } catch (e) {}
        }
      } else if (type === 'place') {
        const refBlock = bot.blockAtCursor(4.5);
        if (refBlock && refBlock.name !== 'air') {
          try { await bot.placeBlock(refBlock, new Vec3(0, 1, 0)); } catch (e) {}
        }
      }
    });

    socket.on('send_chat', async data => {
      if (data && data.message) {
        const msg = data.message.trim();
        if (msg.startsWith('!')) {
          bot.chat(msg);
        } else {
          const reply = await askAiBrain(msg, { hp: bot.health, food: bot.food });
          bot.chat(reply);
        }
      }
    });

    socket.on('disconnect', () => {
      bot.clearControlStates();
    });
  });

  function syncState() {
    const items = bot.inventory.slots.map((item, index) => 
      item ? { slot: index, name: item.name, count: item.count } : null
    ).filter(Boolean);
    io.emit('sync', { hp: bot.health, food: bot.food, items });
  }

  // Active Environment Radar Tick (Entities + Containers + Ores)
  setInterval(() => {
    if (!bot.entity) return;
    const nearby = [];
    const mcData = require('minecraft-data')(bot.version);

    // Scan Players & Mobs
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      if (e.type === 'player' || e.type === 'mob') {
        if (bot.entity.position.distanceTo(e.position) <= 24) {
          nearby.push({
            name: e.username || e.name || e.type,
            type: e.type,
            x: e.position.x,
            y: e.position.y,
            z: e.position.z
          });
        }
      }
    }

    // Scan Chests & Storage
    if (mcData) {
      const containerIds = [
        mcData.blocksByName.chest?.id,
        mcData.blocksByName.trapped_chest?.id,
        mcData.blocksByName.barrel?.id
      ].filter(Boolean);

      const foundChests = bot.findBlocks({ matching: containerIds, maxDistance: 16, count: 6 });
      foundChests.forEach(pos => {
        nearby.push({ name: 'Chest', type: 'chest', x: pos.x, y: pos.y, z: pos.z });
      });

      // Scan Rare & Base Ores
      const oreNames = [
        'diamond_ore', 'deepslate_diamond_ore',
        'iron_ore', 'deepslate_iron_ore',
        'gold_ore', 'deepslate_gold_ore',
        'ancient_debris'
      ];
      const oreIds = oreNames.map(n => mcData.blocksByName[n]?.id).filter(Boolean);

      const foundOres = bot.findBlocks({ matching: oreIds, maxDistance: 16, count: 8 });
      foundOres.forEach(pos => {
        const b = bot.blockAt(pos);
        const isRare = b && (b.name.includes('diamond') || b.name.includes('debris'));
        nearby.push({
          name: isRare ? 'Diamond' : 'Ore',
          type: isRare ? 'rare_ore' : 'common_ore',
          x: pos.x,
          y: pos.y,
          z: pos.z
        });
      });
    }

    io.emit('radar', {
      bot: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      entities: nearby
    });
  }, 400);

  bot.inventory.on('updateSlot', () => syncState());
  bot.on('health', () => syncState());
  server.listen(port, () => console.log(`[DASHBOARD READY] Operations Server active on port ${port}`));
}

/**
 * ============================================================================
 * MAIN DAEMON & GAME EVENT ROUTER
 * ============================================================================
 */
if (require.main === module) {
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

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(autoEat);

    bot.once('spawn', () => {
      console.log(`[AGENT LIVE] ${bot.username} has spawned in the world.`);
      try {
        webInventoryPlugin(bot, { port: WEB_PORT });
      } catch (e) {
        console.error('[DASHBOARD ERROR]', e.message);
      }

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowParkour = true;
      defaultMove.canDig = true;
      defaultMove.allow1by1towers = true;

      bot.pathfinder.setMovements(defaultMove);
      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato']
      };
    });

    // Dynamic Following Loop
    bot.on('physicsTick', () => {
      if (!botState.followingPlayer) return;
      const target = bot.players[botState.followingPlayer]?.entity;
      if (target) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      }
    });

    // Discord Message Routing
    discordClient.on('messageCreate', async (msg) => {
      if (msg.author.bot || (DISCORD_CHANNEL_ID && msg.channel.id !== DISCORD_CHANNEL_ID)) return;
      const content = msg.content.trim();

      if (content.startsWith('!ai ')) {
        const query = content.slice(4);
        const reply = await askAiBrain(query, { hp: bot.health, food: bot.food });
        bot.chat(reply);
        return msg.reply(`🤖 **AI Reply:** ${reply}`);
      }
      if (content === '!status') {
        return msg.reply(`📊 **Status:** HP: ${Math.round(bot.health)}/20 | Food: ${Math.round(bot.food)}/20 | Guard: ${botState.guardMode ? 'ON' : 'OFF'}`);
      }
      if (content.startsWith('!say ')) {
        bot.chat(content.slice(5));
        return msg.react('💬');
      }
    });

    // Minecraft Chat Commands Router
    bot.on('chat', async (username, message) => {
      if (username === bot.username) return;
      if (discordChannel) {
        discordChannel.send(`**<${username}>** ${message}`).catch(() => {});
      }

      const args = message.trim().split(/\s+/);
      const cmd = args[0].toLowerCase();
      const mcData = require('minecraft-data')(bot.version);

      if (cmd === 'come' || cmd === 'follow') {
        stopAntiAfk(bot);
        botState.followingPlayer = username;
        const player = bot.players[username]?.entity;
        if (player) {
          bot.chat(`Aapke paas aa raha hoon @${username}!`);
          const defaultMove = new Movements(bot, mcData);
          bot.pathfinder.setMovements(defaultMove);
          bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true);
        } else {
          bot.chat(`Aapki location scan kar raha hoon @${username}...`);
        }
      }
      else if (cmd === 'stop') {
        botState.followingPlayer = null;
        stopAntiAfk(bot);
        stopGuardMode(bot);
        stopFishing(bot);
        botState.autoFarm = false;
        clearTimeout(botState.farmingInterval);

        bot.clearControlStates();
        bot.pathfinder.stop();
        bot.collectBlock.cancelTask();
        bot.chat("Sab stop kar diya!");
      }
      else if (cmd === 'guard') {
        botState.guardMode ? stopGuardMode(bot) : startGuardMode(bot);
      }
      else if (cmd === 'afk') {
        botState.antiAfk ? stopAntiAfk(bot) : startAntiAfk(bot);
      }
      else if (cmd === 'deposit' || cmd === 'chest') {
        dumpToChest(bot);
      }
      else if (cmd === 'build' && args[1] === 'house') {
        executeHouseBuild(bot);
      }
      else if (cmd === 'fish') {
        botState.isFishing ? stopFishing(bot) : startFishing(bot);
      }
      else if (cmd === 'farm') {
        botState.autoFarm = !botState.autoFarm;
        if (botState.autoFarm) runFarmLoop(bot);
        else clearTimeout(botState.farmingInterval);
      }
      else if (cmd === 'craft' && args[1]) {
        const itemName = args[1].toLowerCase();
        const count = parseInt(args[2], 10) || 1;
        const itemObj = mcData.itemsByName[itemName];

        if (!itemObj) return bot.chat(`"${itemName}" valid item nahi hai.`);

        const craftingTable = bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 4 });
        const recipes = bot.recipesFor(itemObj.id, null, 1, craftingTable);

        if (!recipes.length) {
          return bot.chat(`Mere paas ${itemName} banane ka saman ya crafting table nahi hai.`);
        }

        try {
          await bot.craft(recipes[0], count, craftingTable);
          bot.chat(`${count} ${itemName} craft kar liya!`);
        } catch (err) {
          bot.chat(`Crafting Error: ${err.message}`);
        }
      }
      else if (cmd === 'collect' || cmd === 'mine') {
        let blockQuery = args[1]?.toLowerCase();
        let count = parseInt(args[2], 10) || 1;

        if (!isNaN(args[1]) && args[2]) {
          count = parseInt(args[1], 10);
          blockQuery = args[2].toLowerCase();
        }

        let targetNames = BLOCK_ALIASES[blockQuery] || [blockQuery];
        let targetIds = targetNames.map(name => mcData.blocksByName[name]?.id).filter(Boolean);

        const found = bot.findBlocks({ matching: targetIds, maxDistance: 32, count });
        if (!found.length) {
          return bot.chat(`Aas-paas ${blockQuery} nahi mila.`);
        }

        bot.chat(`${found.length} ${blockQuery} collect kar raha hoon...`);
        try {
          const targets = found.map(pos => bot.blockAt(pos));
          await equipBestTool(bot, targets[0]);
          await bot.collectBlock.collect(targets);
          bot.chat("Mining complete!");
        } catch (e) {
          bot.chat(`Mining Error: ${e.message}`);
        }
      }
      else if (cmd === 'dropall') {
        for (const item of bot.inventory.items()) {
          try { await bot.tossStack(item); } catch (e) {}
        }
        bot.chat("Sari inventory drop kar di!");
      }
      else {
        // AI Conversation Filter
        if (message.toLowerCase().includes('nokar') || message.toLowerCase().includes('bot')) {
          const reply = await askAiBrain(message, { hp: bot.health, food: bot.food });
          bot.chat(reply);
        }
      }
    });

    bot.on('end', () => {
      console.log('[RECONNECT] Connection closed. Restarting in 10s...');
      setTimeout(launchBot, 10000);
    });

    bot.on('error', (err) => {
      console.error('[CRITICAL BOT ERROR]', err.message);
    });
  }

  launchBot();
}
