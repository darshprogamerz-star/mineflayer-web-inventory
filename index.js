/**
 * ============================================================================
 * TITAN AUTONOMOUS MINECRAFT COMPANION & OPERATIONS CONSOLE
 * VERSION: 31.0.0 (ULTIMATE MASTER EDITION - AUTO SMELTER & INVENTORY SORTER)
 * ============================================================================
 * Included Systems:
 * - Direct Raycast Combat & Auto Mob Defense Engine
 * - Smart Multi-Step Gather & Crafting System (Wood to Tools)
 * - Auto-Smelter Integration (Automatic Furnace Ore Smelting Routine)
 * - Advanced Inventory Sorter & Garbage Filter (Auto-Deposit & Trash Clean)
 * - 2D Dynamic Compass Radar (N, S, E, W + Live Distance Tracking)
 * - X-Ray Filter Toggle (Show All vs Mobs/Players Only)
 * - Bot Live Exact Position (X, Y, Z) HUD Badge
 * - Container Scanner (Chests, Trapped Chests, Barrels, Furnaces)
 * - Full Ore Classifier (Diamond, Ancient Debris, Gold, Iron, Copper, Lapis, Coal)
 * - Complete Interactive Web Dashboard with Fixed Square Inventory Grid
 * - Manual Combat Buttons (Attack, Mine, Place) & Responsive D-Pad Controls
 * - Autonomous Routines: Guard Mode, Auto-Farm, Auto-Fish, 4x4 House Builder
 * - Dual-Way Discord Synchronizer (!ai, !status, !say, !craft)
 * - Universal Server Message Listener (Aternos / Geyser / Java Supported)
 * - Gemini 2.5 Flash Native AI Engine with Direct Endpoint Authentication
 * ============================================================================
 */

const http = require('http');
const express = require('express');
const socketIo = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { Client, GatewayIntentBits } = require('discord.js');

// Core Mineflayer Navigation & Autonomous Plugins
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;

/**
 * ============================================================================
 * GLOBAL STATE MACHINE
 * ============================================================================
 */
const botState = {
  autoEat: true,
  autoFarm: false,
  farmingInterval: null,
  followingPlayer: null,
  antiAfk: false,
  antiAfkInterval: null,
  guardMode: true,
  guardInterval: null,
  guardOrigin: null,
  isFishing: false,
  isBusyCrafting: false,
  autoSmelt: false,
  smeltingInterval: null
};

/**
 * ============================================================================
 * HOSTILE MOBS REGISTRY
 * ============================================================================
 */
const HOSTILE_MOBS = [
  'zombie',
  'skeleton',
  'spider',
  'creeper',
  'drowned',
  'husk',
  'enderman',
  'witch',
  'slime',
  'phantom',
  'pillager',
  'cave_spider',
  'zombified_piglin',
  'piglin_brute',
  'stray',
  'wither_skeleton'
];

/**
 * ============================================================================
 * MINING BLOCK ALIASES DATABASE
 * ============================================================================
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
    'nether_gold_ore',
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
  'debris': [
    'ancient_debris'
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
 * GEMINI 2.5 FLASH NATIVE AI ENGINE
 * ============================================================================
 */
async function askAiBrain(promptText, botStatus) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[AI CONFIG] GEMINI_API_KEY environment variable is not defined.');
    return "Boss, Render me GEMINI_API_KEY set nahi hai!";
  }

  const cleanKey = apiKey.trim();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${cleanKey}`;

  try {
    const userPrompt = `You are 'Nokar', an intelligent, humorous, and loyal Minecraft companion. Reply strictly in short natural Hinglish under 20 words. Current Status -> Health: ${botStatus.hp}/20, Food: ${botStatus.food}/20. User says: "${promptText}"`;
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: userPrompt
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('[GEMINI API ERROR]', data.error.message);
      return `Google Error: ${data.error.message.substring(0, 30)}`;
    }

    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }

    return "Haan boss, sun raha hoon bolo!";
  } catch (err) {
    console.error('[GEMINI NETWORK ERROR]', err.message);
    return `Net Error: ${err.message.substring(0, 20)}`;
  }
}

/**
 * ============================================================================
 * DISCORD REAL-TIME BRIDGE
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
    console.log(`[DISCORD LIVE] Connected successfully as ${discordClient.user.tag}`);
    if (DISCORD_CHANNEL_ID) {
      discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
      if (discordChannel) {
        discordChannel.send('🟢 **Titan Autonomous System V31 (Smelter & Sorter) Online!**');
      }
    }
  });
}

/**
 * ============================================================================
 * WEAPONS & EQUIPMENT MANAGEMENT
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
    'stone_sword',
    'wooden_sword',
    'netherite_axe',
    'diamond_axe',
    'iron_axe',
    'stone_axe',
    'wooden_axe'
  ];

  weapons.sort((a, b) => {
    let aIndex = weaponPriority.indexOf(a.name);
    let bIndex = weaponPriority.indexOf(b.name);
    if (aIndex === -1) aIndex = 999;
    if (bIndex === -1) bIndex = 999;
    return aIndex - bIndex;
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
  let requiredToolType = '';

  const blockName = targetBlock.name;
  if (blockName.includes('ore') || blockName.includes('stone') || blockName.includes('cobble') || blockName.includes('deepslate')) {
    requiredToolType = 'pickaxe';
  } else if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('plank')) {
    requiredToolType = 'axe';
  } else if (blockName.includes('dirt') || blockName.includes('sand') || blockName.includes('gravel') || blockName.includes('clay')) {
    requiredToolType = 'shovel';
  } else if (blockName.includes('wheat') || blockName.includes('carrots') || blockName.includes('potatoes')) {
    requiredToolType = 'hoe';
  }

  if (!requiredToolType) return;

  const tools = items.filter(item => item.name.includes(requiredToolType));
  if (tools.length > 0) {
    try {
      await bot.equip(tools[0], 'hand');
    } catch (err) {}
  }
}

/**
 * ============================================================================
 * AUTO MOB DEFENSE & SENTINEL ENGINE
 * ============================================================================
 */
function startMobDefense(bot) {
  if (botState.guardInterval) {
    clearInterval(botState.guardInterval);
  }

  botState.guardInterval = setInterval(async () => {
    if (botState.isBusyCrafting || !bot.entity) return;

    const targetMob = bot.nearestEntity(entity => {
      if (!entity || entity.type !== 'mob') return false;
      const entityName = (entity.name || entity.displayName || '').toLowerCase();
      const isHostile = HOSTILE_MOBS.some(h => entityName.includes(h));
      return isHostile && bot.entity.position.distanceTo(entity.position) <= 10;
    });

    if (targetMob) {
      await equipBestWeapon(bot);
      const distance = bot.entity.position.distanceTo(targetMob.position);

      if (distance > 3.2) {
        bot.pathfinder.setGoal(new goals.GoalFollow(targetMob, 2.5), false);
      } else {
        const aimOffset = targetMob.height ? targetMob.height * 0.75 : 1.2;
        await bot.lookAt(targetMob.position.offset(0, aimOffset, 0));
        bot.attack(targetMob);
      }
    }
  }, 350);
}

function stopMobDefense() {
  if (botState.guardInterval) {
    clearInterval(botState.guardInterval);
  }
}

/**
 * ============================================================================
 * NEW IDEA 1: AUTO-SMELTER SYSTEM (FURNACE AUTOMATION)
 * ============================================================================
 */
async function runAutoSmelter(bot) {
  if (!botState.autoSmelt) return;
  const mcData = require('minecraft-data')(bot.version);

  const rawOres = bot.inventory.items().filter(i => 
    i.name.includes('raw_iron') || i.name.includes('raw_gold') || i.name.includes('raw_copper') || i.name.includes('_ore')
  );

  if (rawOres.length === 0) return;

  const fuel = bot.inventory.items().filter(i => 
    i.name.includes('coal') || i.name.includes('charcoal') || i.name.includes('_log') || i.name.includes('_planks')
  );

  if (fuel.length === 0) return;

  let furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 5 });
  
  if (!furnaceBlock) {
    const cobblestone = bot.inventory.items().filter(i => i.name === 'cobblestone');
    const totalCobble = cobblestone.reduce((acc, cur) => acc + cur.count, 0);

    if (totalCobble >= 8) {
      const furnaceRecipe = bot.recipesAll(mcData.itemsByName.furnace.id, null, 1)[0];
      if (furnaceRecipe) {
        try {
          await bot.craft(furnaceRecipe, 1, null);
          bot.chat("🔥 Furnace craft kar liya!");
          await bot.waitForTicks(10);
        } catch (e) {}
      }
    }

    const furnaceItem = bot.inventory.items().find(i => i.name === 'furnace');
    const ground = bot.findBlock({ matching: b => b.name !== 'air', maxDistance: 4 });

    if (furnaceItem && ground) {
      try {
        await bot.equip(furnaceItem, 'hand');
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        await bot.waitForTicks(10);
        furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 5 });
      } catch (e) {}
    }
  }

  if (furnaceBlock) {
    try {
      const furnace = await bot.openFurnace(furnaceBlock);
      const targetOre = rawOres[0];
      const targetFuel = fuel[0];

      if (furnace.inputItem() === null && targetOre) {
        await furnace.putInput(targetOre.type, null, Math.min(targetOre.count, 16));
        bot.chat(`🔥 Pighlane ke liye ${targetOre.name} daala furnace me.`);
      }

      if (furnace.fuelItem() === null && targetFuel) {
        await furnace.putFuel(targetFuel.type, null, Math.min(targetFuel.count, 8));
      }

      furnace.close();
    } catch (err) {}
  }

  if (botState.autoSmelt) {
    botState.smeltingInterval = setTimeout(() => runAutoSmelter(bot), 8000);
  }
}

/**
 * ============================================================================
 * NEW IDEA 2: ADVANCED INVENTORY SORTER & GARBAGE FILTER
 * ============================================================================
 */
async function sortAndCleanInventory(bot) {
  const junkItems = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'dirt', 'cobblestone', 'gravel'];
  const trashFound = bot.inventory.items().filter(i => junkItems.includes(i.name));

  if (trashFound.length > 0) {
    bot.chat("🗑️ Inventory clean kar raha hoon (kachra hata raha hoon)...");
    for (const item of trashFound) {
      try {
        if (item.count >= 16) {
          await bot.tossStack(item);
          await bot.waitForTicks(2);
        }
      } catch (e) {}
    }
  }

  const mcData = require('minecraft-data')(bot.version);
  const chestBlock = bot.findBlock({
    matching: [mcData.blocksByName.chest?.id, mcData.blocksByName.barrel?.id].filter(Boolean),
    maxDistance: 6
  });

  if (chestBlock) {
    try {
      const chestWindow = await bot.openChest(chestBlock);
      const valuables = bot.inventory.items().filter(i => 
        i.name.includes('diamond') || i.name.includes('gold') || i.name.includes('iron') || i.name.includes('emerald') || i.name.includes('debris')
      );

      for (const valItem of valuables) {
        if (valItem.count > 32) {
          await chestWindow.deposit(valItem.type, null, 16);
          await bot.waitForTicks(2);
        }
      }
      chestWindow.close();
    } catch (e) {}
  }
  bot.chat("✨ Inventory sorted and optimized!");
}

/**
 * ============================================================================
 * SMART MULTI-STEP GATHER & CRAFTING SYSTEM
 * ============================================================================
 */
async function smartGatherAndCraft(bot, targetItemName, count = 1) {
  if (botState.isBusyCrafting) {
    return bot.chat("Pehle se ek crafting task chal raha hai boss!");
  }

  botState.isBusyCrafting = true;
  const mcData = require('minecraft-data')(bot.version);
  const targetItem = mcData.itemsByName[targetItemName];

  if (!targetItem) {
    botState.isBusyCrafting = false;
    return bot.chat(`"${targetItemName}" koi valid Minecraft item nahi hai.`);
  }

  bot.chat(`🛠️ Checking materials for ${count}x ${targetItemName}...`);

  async function ensureLogsAvailable(minLogs = 3) {
    const currentLogs = bot.inventory.items().filter(i => i.name.includes('_log'));
    const totalLogs = currentLogs.reduce((acc, cur) => acc + cur.count, 0);

    if (totalLogs < minLogs) {
      bot.chat(`🌲 Lakdi kam hai, ped dhoondh raha hoon...`);
      const logIds = BLOCK_ALIASES['wood'].map(n => mcData.blocksByName[n]?.id).filter(Boolean);
      const woodBlocks = bot.findBlocks({ matching: logIds, maxDistance: 32, count: 6 });

      if (!woodBlocks.length) {
        bot.chat("Aas-paas koi ped nahi mila!");
        return false;
      }

      const blockTargets = woodBlocks.map(p => bot.blockAt(p));
      await equipBestTool(bot, blockTargets[0]);
      try {
        await bot.collectBlock.collect(blockTargets);
        bot.chat("Lakdi ikattha kar li!");
      } catch (err) {
        return false;
      }
    }
    return true;
  }

  async function craftPlanksIfRequired() {
    const planks = bot.inventory.items().filter(i => i.name.includes('_planks'));
    const totalPlanks = planks.reduce((acc, cur) => acc + cur.count, 0);

    if (totalPlanks < 4) {
      const logs = bot.inventory.items().find(i => i.name.includes('_log'));
      if (logs) {
        const plankRecipe = bot.recipesAll(mcData.itemsByName[`${logs.name.replace('_log', '')}_planks`]?.id || mcData.itemsByName['oak_planks'].id, null, 1)[0];
        if (plankRecipe) {
          try {
            await bot.craft(plankRecipe, 2, null);
            await bot.waitForTicks(5);
          } catch (e) {}
        }
      }
    }
  }

  async function ensureCraftingTable() {
    let tableBlock = bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 5 });
    if (tableBlock) return tableBlock;

    const tableInInv = bot.inventory.items().find(i => i.name === 'crafting_table');
    if (!tableInInv) {
      await ensureLogsAvailable(1);
      await craftPlanksIfRequired();
      const tableRecipe = bot.recipesAll(mcData.itemsByName.crafting_table.id, null, 1)[0];
      if (tableRecipe) {
        await bot.craft(tableRecipe, 1, null);
        await bot.waitForTicks(5);
      }
    }

    const ground = bot.findBlock({
      matching: (b) => b.name !== 'air' && b.name !== 'water' && b.name !== 'lava',
      maxDistance: 4
    });

    if (ground) {
      const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
      if (tableItem) {
        await bot.equip(tableItem, 'hand');
        await bot.placeBlock(ground, new Vec3(0, 1, 0)).catch(() => {});
        await bot.waitForTicks(10);
        return bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 5 });
      }
    }
    return null;
  }

  try {
    if (
      targetItemName.includes('wood') ||
      targetItemName.includes('plank') ||
      targetItemName.includes('stick') ||
      targetItemName.includes('chest') ||
      targetItemName.includes('crafting_table') ||
      targetItemName.includes('pickaxe') ||
      targetItemName.includes('sword') ||
      targetItemName.includes('axe')
    ) {
      await ensureLogsAvailable(3);
      await craftPlanksIfRequired();
    }

    let craftingTable = bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 5 });
    let recipes = bot.recipesFor(targetItem.id, null, 1, craftingTable);

    if (!recipes.length) {
      craftingTable = await ensureCraftingTable();
      recipes = bot.recipesFor(targetItem.id, null, 1, craftingTable);
    }

    if (!recipes.length) {
      bot.chat(`Recipe nahi mili ya ingredients kam hain ${targetItemName} ke liye.`);
      botState.isBusyCrafting = false;
      return;
    }

    await bot.craft(recipes[0], count, craftingTable);
    bot.chat(`✅ Success! ${count}x ${targetItemName} craft ho gaya.`);
  } catch (err) {
    bot.chat(`Crafting error: ${err.message}`);
  } finally {
    botState.isBusyCrafting = false;
  }
}

/**
 * ============================================================================
 * AUTONOMOUS SUB-ROUTINES (AFK, FISH, FARM, BUILD, CHEST DUMP)
 * ============================================================================
 */
function startAntiAfk(bot) {
  botState.antiAfk = true;
  bot.chat("🚶 Anti-AFK Wander ON!");
  const origin = bot.entity.position.clone();

  botState.antiAfkInterval = setInterval(async () => {
    if (!botState.antiAfk || botState.followingPlayer || botState.isBusyCrafting) return;
    try {
      const offX = Math.floor(Math.random() * 12) - 6;
      const offZ = Math.floor(Math.random() * 12) - 6;
      bot.setControlState('jump', Math.random() > 0.5);
      setTimeout(() => bot.setControlState('jump', false), 300);
      await bot.pathfinder.goto(new goals.GoalNear(origin.x + offX, origin.y, origin.z + offZ, 1));
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
  const rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
  if (!rod) {
    return bot.chat("Mere paas Fishing Rod nahi hai boss!");
  }

  botState.isFishing = true;
  bot.chat("🎣 Fishing shuru kar raha hoon...");
  await bot.equip(rod, 'hand');

  async function cast() {
    if (!botState.isFishing) return;
    try {
      await bot.fish();
      cast();
    } catch (err) {
      if (botState.isFishing) {
        setTimeout(cast, 2000);
      }
    }
  }

  cast();
}

function stopFishing() {
  botState.isFishing = false;
}

async function runFarmLoop(bot) {
  if (!botState.autoFarm) return;
  const mcData = require('minecraft-data')(bot.version);
  const cropIds = ['wheat', 'carrots', 'potatoes', 'beetroots'].map(n => mcData.blocksByName[n]?.id).filter(Boolean);

  const matureCrops = bot.findBlocks({
    matching: block => cropIds.includes(block.type) && block.metadata === 7,
    maxDistance: 24,
    count: 6
  });

  if (matureCrops.length > 0) {
    try {
      await bot.collectBlock.collect(matureCrops.map(pos => bot.blockAt(pos)));
      for (const pos of matureCrops) {
        const soil = bot.blockAt(pos.offset(0, -1, 0));
        const seed = bot.inventory.items().find(i => 
          i.name.includes('seeds') || i.name === 'carrot' || i.name === 'potato'
        );
        if (soil && soil.name === 'farmland' && seed) {
          await bot.equip(seed, 'hand');
          await bot.placeBlock(soil, new Vec3(0, 1, 0)).catch(() => {});
          await bot.waitForTicks(2);
        }
      }
    } catch (e) {}
  }

  if (botState.autoFarm) {
    botState.farmingInterval = setTimeout(() => runFarmLoop(bot), 4000);
  }
}

async function executeHouseBuild(bot) {
  const getMat = () => bot.inventory.items().find(i => 
    i.name.includes('plank') || i.name.includes('cobble') || i.name.includes('stone') || i.name.includes('dirt')
  );
  if (!getMat()) {
    return bot.chat("Ghar banane ke liye blocks nahi hain!");
  }

  bot.chat("🏠 Shelter banana shuru kar raha hoon...");
  const base = bot.entity.position.floored().offset(1, 0, 1);
  const layout = [];

  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        if (x === 0 || x === 3 || z === 0 || z === 3) {
          if (x === 1 && z === 0 && (y === 0 || y === 1)) continue;
          layout.push(base.offset(x, y, z));
        }
      }
    }
  }

  for (let x = 0; x < 4; x++) {
    for (let z = 0; z < 4; z++) {
      layout.push(base.offset(x, 3, z));
    }
  }

  for (const pos of layout) {
    const cur = bot.blockAt(pos);
    if (!cur || cur.name !== 'air') continue;
    const blockItem = getMat();
    if (!blockItem) {
      return bot.chat("Blocks khatam ho gaye!");
    }

    try {
      await bot.equip(blockItem, 'hand');
      if (bot.entity.position.distanceTo(pos) > 4.5) {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)).catch(() => {});
      }
      const neighbors = [
        pos.offset(0, -1, 0),
        pos.offset(1, 0, 0),
        pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1),
        pos.offset(0, 0, -1)
      ];
      for (const n of neighbors) {
        const nb = bot.blockAt(n);
        if (nb && nb.name !== 'air') {
          await bot.lookAt(pos);
          await bot.placeBlock(nb, pos.minus(n)).catch(() => {});
          await bot.waitForTicks(3);
          break;
        }
      }
    } catch (e) {}
  }
  bot.chat("Ghar ready ho gaya boss!");
}

async function dumpToChest(bot) {
  const mcData = require('minecraft-data')(bot.version);
  const container = bot.findBlock({
    matching: [
      mcData.blocksByName.chest?.id,
      mcData.blocksByName.trapped_chest?.id,
      mcData.blocksByName.barrel?.id
    ].filter(Boolean),
    maxDistance: 6
  });

  if (!container) {
    return bot.chat("Paas me Chest ya Barrel nahi hai!");
  }

  bot.chat("📦 Saman chest me rakh raha hoon...");
  try {
    const window = await bot.openChest(container);
    for (const item of bot.inventory.items()) {
      if (item.name.includes('sword') || item.name.includes('pickaxe') || item.name.includes('helmet') || item.name.includes('chestplate')) {
        continue;
      }
      try {
        await window.deposit(item.type, null, item.count);
        await bot.waitForTicks(2);
      } catch (e) {}
    }
    window.close();
    bot.chat("Deposit ho gaya!");
  } catch (err) {
    bot.chat(`Chest error: ${err.message}`);
  }
}

/**
 * ============================================================================
 * WEB OPERATIONS CONSOLE (FULL HTML, CSS & JAVASCRIPT UI)
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
        <title>Titan Master Console V31</title>
        <script src="/socket.io/socket.io.js"></script>
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            user-select: none;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #070a13;
            color: #e2e8f0;
            display: flex;
            justify-content: center;
            padding: 10px;
          }
          .panel {
            width: 100%;
            max-width: 520px;
            background: #111827;
            border-radius: 14px;
            border: 1px solid #1f2937;
            padding: 14px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.7);
          }
          .top-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
          }
          .title {
            font-size: 17px;
            font-weight: 800;
            color: #38bdf8;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          
          .chat-box {
            display: flex;
            gap: 6px;
            margin-bottom: 12px;
          }
          .chat-input {
            flex: 1;
            padding: 10px 12px;
            background: #030712;
            border: 1px solid #374151;
            border-radius: 8px;
            color: #fff;
            font-size: 13px;
            outline: none;
          }
          .chat-input:focus {
            border-color: #38bdf8;
          }
          .chat-btn {
            background: #0284c7;
            padding: 10px 16px;
            border: none;
            border-radius: 8px;
            color: white;
            font-weight: bold;
            cursor: pointer;
            font-size: 13px;
          }
          
          .ctrl-wrapper {
            background: #030712;
            border: 1px solid #1f2937;
            border-radius: 10px;
            padding: 10px;
            margin-bottom: 12px;
            display: flex;
            flex-direction: column;
            align-items: center;
          }
          .dpad {
            display: grid;
            grid-template-columns: repeat(3, 46px);
            grid-template-rows: repeat(3, 46px);
            gap: 5px;
            margin-bottom: 10px;
          }
          .ctrl-btn {
            background: #1f2937;
            border: 1px solid #374151;
            border-radius: 8px;
            color: white;
            font-size: 17px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
          }
          .ctrl-btn:active {
            background: #0284c7;
            transform: scale(0.95);
          }
          
          .manual-actions {
            display: flex;
            gap: 6px;
            width: 100%;
            max-width: 270px;
          }
          .manual-btn {
            padding: 9px;
            border-radius: 8px;
            border: none;
            font-weight: bold;
            cursor: pointer;
            color: white;
            flex: 1;
            font-size: 12px;
          }
          .manual-btn:active {
            transform: scale(0.95);
          }

          .action-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 6px;
            margin-bottom: 12px;
          }
          .act-btn {
            padding: 10px;
            border: none;
            border-radius: 8px;
            font-weight: bold;
            color: white;
            font-size: 11px;
            cursor: pointer;
          }
          .act-btn:active {
            transform: scale(0.97);
          }
          
          .btn-guard { background: #dc2626; } 
          .btn-afk { background: #6366f1; } 
          .btn-chest { background: #d97706; } 
          .btn-fish { background: #0891b2; }
          .btn-farm { background: #059669; } 
          .btn-build { background: #2563eb; } 
          .btn-drop { background: #e11d48; } 
          .btn-smelt { background: #ea580c; }
          .btn-sort { background: #7c3aed; }
          .btn-stop { background: #991b1b; grid-column: span 2; padding: 12px; font-size: 13px; }
          
          .bot-pos-bar {
            width: 100%;
            background: #030712;
            border: 1px solid #1e293b;
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            color: #38bdf8;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
          }

          .radar-card {
            display: flex;
            flex-direction: column;
            align-items: center;
            background: #030712;
            border-radius: 10px;
            border: 1px solid #1f2937;
            padding: 10px;
            margin-bottom: 12px;
          }
          #radarCanvas {
            background: #050811;
            border-radius: 8px;
            border: 1px solid #374151;
            width: 280px;
            height: 280px;
            display: block;
          }
          
          .radar-filter-btn {
            width: 100%;
            margin-top: 8px;
            padding: 8px;
            background: #0f172a;
            border: 1px solid #334155;
            border-radius: 6px;
            color: #38bdf8;
            font-size: 11px;
            font-weight: bold;
            cursor: pointer;
            transition: 0.2s;
          }
          .radar-filter-btn:active {
            transform: scale(0.98);
          }
          
          .radar-legend {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 8px;
            font-size: 10px;
            margin-top: 8px;
            color: #9ca3af;
          }
          .dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            display: inline-block;
            margin-right: 3px;
            vertical-align: middle;
          }
          
          .radar-list {
            width: 100%;
            max-height: 120px;
            overflow-y: auto;
            background: #0b1120;
            border-radius: 6px;
            padding: 6px 8px;
            margin-top: 8px;
            font-size: 11px;
            border: 1px solid #1e293b;
          }
          .radar-item {
            display: flex;
            justify-content: space-between;
            padding: 3px 0;
            border-bottom: 1px solid #1e293b;
          }
          
          .meters {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            margin-bottom: 12px;
          }
          .meter {
            background: #030712;
            padding: 8px;
            border-radius: 8px;
            text-align: center;
            border: 1px solid #1f2937;
          }
          .meter-val {
            font-size: 16px;
            font-weight: bold;
          }
          
          .section-title {
            font-size: 11px;
            font-weight: bold;
            color: #94a3b8;
            margin: 8px 0 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(9, 1fr);
            gap: 4px;
            background: #030712;
            padding: 6px;
            border-radius: 8px;
            border: 1px solid #1f2937;
            margin-bottom: 8px;
          }
          .slot {
            width: 100%;
            aspect-ratio: 1 / 1;
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 4px;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            cursor: pointer;
          }
          .slot:active {
            border-color: #38bdf8;
            background: #0f172a;
            transform: scale(0.95);
          }
          .item-name {
            font-size: 8px;
            color: #f1f5f9;
            text-align: center;
            line-height: 1.1;
            padding: 2px;
            word-break: break-word;
            font-weight: 500;
          }
          .item-count {
            position: absolute;
            bottom: 1px;
            right: 2px;
            font-size: 9px;
            font-weight: 900;
            color: #38bdf8;
            background: rgba(0,0,0,0.7);
            border-radius: 2px;
            padding: 0 2px;
          }
        </style>
      </head>
      <body>
        <div class="panel">
          <div class="top-bar">
            <div class="title">🎮 Titan Master Console</div>
            <div style="font-size:11px; color:#22c55e; font-weight:bold;">● Live Connected</div>
          </div>
          
          <div class="chat-box">
            <input type="text" id="chatMsg" class="chat-input" placeholder="Chat in game or type craft/mine commands...">
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
            <button class="act-btn btn-guard" id="guardBtn" onclick="send('toggle_guard')">🛡️ Auto-Defense: ON</button>
            <button class="act-btn btn-afk" id="afkBtn" onclick="send('toggle_afk')">🚶 AFK: OFF</button>
            <button class="act-btn btn-fish" id="fishBtn" onclick="send('toggle_fish')">🎣 Fish: OFF</button>
            <button class="act-btn btn-farm" id="farmBtn" onclick="send('toggle_farm')">🌾 Farm: OFF</button>
            <button class="act-btn btn-smelt" id="smeltBtn" onclick="send('toggle_smelt')">🔥 Smelter: OFF</button>
            <button class="act-btn btn-sort" onclick="send('sort_inv')">🎒 Sort Inventory</button>
            <button class="act-btn btn-build" onclick="send('build_house')">🏠 Build House</button>
            <button class="act-btn btn-chest" onclick="send('dump_chest')">📦 Dump Chest</button>
            <button class="act-btn btn-drop" onclick="send('drop_hand')">🗑️ Drop Hand</button>
            <button class="act-btn btn-stop" onclick="send('stop')">🛑 Stop All</button>
          </div>

          <!-- Bot Live Position Badge -->
          <div class="bot-pos-bar">
            <span>📍 My Position:</span>
            <span id="botCoords">X: 0 | Y: 0 | Z: 0</span>
          </div>

          <div class="radar-card">
            <canvas id="radarCanvas" width="280" height="280"></canvas>
            
            <!-- X-Ray Filter Toggle Button -->
            <button class="radar-filter-btn" id="xrayToggleBtn" onclick="toggleXray()">🔍 Ores & Chests: ON</button>
            
            <div class="radar-legend">
              <div><span class="dot" style="background:#22c55e;"></span>Bot</div>
              <div><span class="dot" style="background:#38bdf8;"></span>Player</div>
              <div><span class="dot" style="background:#ef4444;"></span>Mob</div>
              <span id="legendOres">
                <div><span class="dot" style="background:#eab308;"></span>Chest</div>
                <div><span class="dot" style="background:#06b6d4;"></span>Diamond</div>
                <div><span class="dot" style="background:#f97316;"></span>Iron</div>
                <div><span class="dot" style="background:#fbbf24;"></span>Gold</div>
                <div><span class="dot" style="background:#8b5cf6;"></span>Debris</div>
              </span>
            </div>
            
            <div class="radar-list" id="radarList">
              <div style="color:#64748b; text-align:center;">Scanning surroundings...</div>
            </div>
          </div>

          <div class="meters">
            <div class="meter"><div class="meter-val" style="color:#f43f5e;" id="hp">20 / 20</div><div style="font-size:10px;">❤️ Health</div></div>
            <div class="meter"><div class="meter-val" style="color:#fbbf24;" id="food">20 / 20</div><div style="font-size:10px;">🍖 Hunger</div></div>
          </div>

          <div class="section-title">Hotbar (Tap: Equip | Double Tap: Drop)</div>
          <div class="grid" id="hotbarGrid"></div>
          
          <div class="section-title">Main Inventory Storage</div>
          <div class="grid" id="mainGrid"></div>
        </div>

        <script>
          const socket = io();
          const canvas = document.getElementById('radarCanvas');
          const ctx = canvas.getContext('2d');
          const cX = 140, cY = 140, scale = 5.5;

          let showOresAndChests = true;

          const main = document.getElementById('mainGrid');
          const hotbar = document.getElementById('hotbarGrid');

          for (let i = 36; i <= 44; i++) {
            hotbar.innerHTML += '<div class="slot" id="s-' + i + '" onclick="slotClick(' + i + ')" ondblclick="slotDrop(' + i + ')"></div>';
          }
          for (let i = 9; i <= 35; i++) {
            main.innerHTML += '<div class="slot" id="s-' + i + '" onclick="slotClick(' + i + ')" ondblclick="slotDrop(' + i + ')"></div>';
          }

          function slotClick(id) { socket.emit('equip_slot', { slot: id }); }
          function slotDrop(id) { socket.emit('drop_slot', { slot: id }); }
          function startMove(dir) { socket.emit('control_move', { direction: dir, state: true }); }
          function stopMove(dir) { socket.emit('control_move', { direction: dir, state: false }); }
          function jump() { socket.emit('control_jump'); }

          function toggleXray() {
            showOresAndChests = !showOresAndChests;
            const btn = document.getElementById('xrayToggleBtn');
            const legendOres = document.getElementById('legendOres');
            if (showOresAndChests) {
              btn.innerText = '🔍 Ores & Chests: ON';
              btn.style.color = '#38bdf8';
              legendOres.style.display = 'inline';
            } else {
              btn.innerText = '🚫 Ores & Chests: OFF (Only Players & Mobs)';
              btn.style.color = '#94a3b8';
              legendOres.style.display = 'none';
            }
          }

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

            // Update Bot Coordinates
            if (data.bot) {
              document.getElementById('botCoords').innerText = 'X: ' + Math.round(data.bot.x) + ' | Y: ' + Math.round(data.bot.y) + ' | Z: ' + Math.round(data.bot.z);
            }

            // Concentric Rings
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            [35, 70, 105].forEach(r => {
              ctx.beginPath();
              ctx.arc(cX, cY, r, 0, Math.PI * 2);
              ctx.stroke();
            });

            // Grid Crosshairs
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
              const isOreOrChest = (e.type !== 'player' && e.type !== 'mob');
              if (!showOresAndChests && isOreOrChest) {
                return;
              }

              const dx = e.x - data.bot.x;
              const dz = e.z - data.bot.z;
              const pX = cX + dx * scale;
              const pY = cY + dz * scale;
              const dist = Math.round(Math.sqrt(dx * dx + dz * dz));

              let dir = '';
              if (dz < -2) dir += 'North ';
              else if (dz > 2) dir += 'South ';
              if (dx > 2) dir += 'East';
              else if (dx < -2) dir += 'West';
              if (!dir) dir = 'Near';

              // Color Mapping
              let color = '#38bdf8';
              if (e.type === 'mob') color = '#ef4444';
              else if (e.type === 'chest') color = '#eab308';
              else if (e.type === 'diamond') color = '#06b6d4';
              else if (e.type === 'debris') color = '#8b5cf6';
              else if (e.type === 'gold') color = '#fbbf24';
              else if (e.type === 'iron') color = '#f97316';
              else if (e.type === 'copper') color = '#ea580c';
              else if (e.type === 'lapis') color = '#2563eb';
              else if (e.type === 'coal') color = '#64748b';

              // Clean Glowing Dots on Canvas
              if (pX >= 4 && pX <= 276 && pY >= 4 && pY <= 276) {
                ctx.fillStyle = color;
                ctx.beginPath();
                const radius = (e.type === 'player' || e.type === 'mob') ? 5 : 3.5;
                ctx.arc(pX, pY, radius, 0, Math.PI * 2);
                ctx.fill();

                if (e.type === 'diamond' || e.type === 'debris' || e.type === 'player') {
                  ctx.strokeStyle = color;
                  ctx.lineWidth = 1;
                  ctx.beginPath();
                  ctx.arc(pX, pY, radius + 2, 0, Math.PI * 2);
                  ctx.stroke();
                }
              }

              // Build Exact Coordinates HUD Item
              let exactCoords = '[X:' + Math.round(e.x) + ' Y:' + (e.y !== undefined ? Math.round(e.y) : '?') + ' Z:' + Math.round(e.z) + ']';
              
              listHTML += '<div class="radar-item">' +
                '<span style="color:' + color + '; font-weight:600;">● ' + e.name + '</span>' +
                '<span style="color:#94a3b8;">' + dist + 'm ' + dir + ' ' + exactCoords + '</span>' +
                '</div>';
            });

            document.getElementById('radarList').innerHTML = listHTML || '<div style="color:#64748b; text-align:center;">No targets nearby</div>';

            // Center Bot Marker
            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(cX, cY, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          });

          socket.on('sync', data => {
            if (data.hp !== undefined) document.getElementById('hp').innerText = Math.round(data.hp) + ' / 20';
            if (data.food !== undefined) document.getElementById('food').innerText = Math.round(data.food) + ' / 20';
            for (let i = 9; i <= 44; i++) {
              const el = document.getElementById('s-' + i);
              if (!el) continue;
              const item = data.items.find(x => x.slot === i);
              if (item) {
                let cleanName = item.name.replace(/_/g, ' ');
                el.innerHTML = '<span class="item-name">' + cleanName + '</span>' + (item.count > 1 ? '<span class="item-count">' + item.count + '</span>' : '');
                el.style.background = '#1e293b';
              } else {
                el.innerHTML = '';
                el.style.background = '#0f172a';
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
              if (act === 'toggle_guard') document.getElementById('guardBtn').innerText = '🛡️ Auto-Defense: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_fish') document.getElementById('fishBtn').innerText = '🎣 Fish: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_farm') document.getElementById('farmBtn').innerText = '🌾 Farm: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_smelt') document.getElementById('smeltBtn').innerText = '🔥 Smelter: ' + (d.state ? 'ON' : 'OFF');
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
      botState.guardMode = !botState.guardMode;
      if (botState.guardMode) {
        startMobDefense(bot);
      } else {
        stopMobDefense();
      }
      return res.json({ success: true, state: botState.guardMode });
    }
    if (act === 'toggle_fish') {
      botState.isFishing ? stopFishing() : startFishing(bot);
      return res.json({ success: true, state: botState.isFishing });
    }
    if (act === 'toggle_farm') {
      botState.autoFarm = !botState.autoFarm;
      if (botState.autoFarm) {
        runFarmLoop(bot);
      } else {
        clearTimeout(botState.farmingInterval);
      }
      return res.json({ success: true, state: botState.autoFarm });
    }
    if (act === 'toggle_smelt') {
      botState.autoSmelt = !botState.autoSmelt;
      if (botState.autoSmelt) {
        runAutoSmelter(bot);
      } else {
        clearTimeout(botState.smeltingInterval);
      }
      return res.json({ success: true, state: botState.autoSmelt });
    }
    if (act === 'sort_inv') {
      sortAndCleanInventory(bot);
      return res.json({ success: true });
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
      botState.isBusyCrafting = false;
      botState.autoSmelt = false;
      clearTimeout(botState.smeltingInterval);
      stopAntiAfk(bot);
      stopFishing();
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
        if (msg.startsWith('craft ')) {
          const parts = msg.split(' ');
          smartGatherAndCraft(bot, parts[1], parseInt(parts[2], 10) || 1);
        } else if (msg.startsWith('!')) {
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

  // Active Radar Tick (De-duplicated Ore & Entity Classifier)
  setInterval(() => {
    if (!bot.entity) return;
    const nearby = [];
    const mcData = require('minecraft-data')(bot.version);

    // 1. Scan Players & Mobs
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

    // 2. Scan Containers
    if (mcData) {
      const containerIds = [
        mcData.blocksByName.chest?.id,
        mcData.blocksByName.trapped_chest?.id,
        mcData.blocksByName.barrel?.id
      ].filter(Boolean);

      const foundChests = bot.findBlocks({ matching: containerIds, maxDistance: 16, count: 8 });
      const addedChests = [];

      foundChests.forEach(pos => {
        const isCloseToExisting = addedChests.some(cPos => cPos.distanceTo(pos) < 2);
        if (!isCloseToExisting) {
          addedChests.push(pos);
          nearby.push({ name: 'Chest', type: 'chest', x: pos.x, y: pos.y, z: pos.z });
        }
      });

      // 3. Scan Specific Ores with Clustering Logic
      const oreList = [
        { key: 'diamond', name: 'Diamond Ore', ids: [mcData.blocksByName.diamond_ore?.id, mcData.blocksByName.deepslate_diamond_ore?.id] },
        { key: 'debris', name: 'Ancient Debris', ids: [mcData.blocksByName.ancient_debris?.id] },
        { key: 'gold', name: 'Gold Ore', ids: [mcData.blocksByName.gold_ore?.id, mcData.blocksByName.deepslate_gold_ore?.id, mcData.blocksByName.nether_gold_ore?.id] },
        { key: 'iron', name: 'Iron Ore', ids: [mcData.blocksByName.iron_ore?.id, mcData.blocksByName.deepslate_iron_ore?.id] },
        { key: 'copper', name: 'Copper Ore', ids: [mcData.blocksByName.copper_ore?.id, mcData.blocksByName.deepslate_copper_ore?.id] },
        { key: 'lapis', name: 'Lapis Ore', ids: [mcData.blocksByName.lapis_ore?.id, mcData.blocksByName.deepslate_lapis_ore?.id] },
        { key: 'coal', name: 'Coal Ore', ids: [mcData.blocksByName.coal_ore?.id, mcData.blocksByName.deepslate_coal_ore?.id] }
      ];

      oreList.forEach(oreGroup => {
        const validIds = oreGroup.ids.filter(Boolean);
        if (validIds.length > 0) {
          const blocks = bot.findBlocks({ matching: validIds, maxDistance: 16, count: 12 });
          const trackedVeins = [];

          blocks.forEach(pos => {
            const isNearVein = trackedVeins.some(vPos => vPos.distanceTo(pos) < 2.5);
            if (!isNearVein) {
              trackedVeins.push(pos);
              nearby.push({
                name: oreGroup.name,
                type: oreGroup.key,
                x: pos.x,
                y: pos.y,
                z: pos.z
              });
            }
          });
        }
      });
    }

    io.emit('radar', {
      bot: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      entities: nearby
    });
  }, 400);

  bot.inventory.on('updateSlot', () => syncState());
  bot.on('health', () => syncState());
  server.listen(port, () => console.log(`[OPERATIONS SERVER ACTIVE] Port: ${port}`));
}

/**
 * ============================================================================
 * MAIN DAEMON INITIALIZER & EVENT LOOP
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
      console.log(`[AGENT LIVE] ${bot.username} entered the server.`);
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

      // Start Automatic Mob Defense immediately
      startMobDefense(bot);
    });

    bot.on('physicsTick', () => {
      if (!botState.followingPlayer || botState.isBusyCrafting) return;
      const target = bot.players[botState.followingPlayer]?.entity;
      if (target) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      }
    });

    // Discord Synchronization
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
      if (content.startsWith('!ai ')) {
        const reply = await askAiBrain(content.slice(4), { hp: bot.health, food: bot.food });
        bot.chat(reply);
        return msg.reply(`🤖 **AI:** ${reply}`);
      }
      if (content === '!status') {
        return msg.reply(`📊 HP: ${Math.round(bot.health)}/20 | Auto-Defense: ${botState.guardMode ? 'ON' : 'OFF'} | Smelter: ${botState.autoSmelt ? 'ON' : 'OFF'}`);
      }
      if (content.startsWith('!say ')) {
        bot.chat(content.slice(5));
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

      // Extract command text
      const match = cleanMsg.match(/(?:<[^>]+>\s*|\[[^\]]+\]\s*|\w+:\s*)?(.*)/);
      const actualText = match ? match[1].trim() : cleanMsg;
      const args = actualText.split(/\s+/);
      const cmd = args[0]?.toLowerCase();

      if (cmd === 'come' || cmd === 'follow') {
        stopAntiAfk(bot);
        const sender = actualText.split(' ')[0] || '';
        botState.followingPlayer = sender;
        bot.chat("Aapke paas aa raha hoon!");
      }
      else if (cmd === 'stop') {
        botState.followingPlayer = null;
        botState.isBusyCrafting = false;
        botState.autoSmelt = false;
        clearTimeout(botState.smeltingInterval);
        stopAntiAfk(bot);
        stopFishing();
        botState.autoFarm = false;
        clearTimeout(botState.farmingInterval);

        bot.clearControlStates();
        bot.pathfinder.stop();
        bot.collectBlock.cancelTask();
        bot.chat("Sab stop kar diya!");
      }
      else if (cmd === 'craft' && args[1]) {
        const count = parseInt(args[2], 10) || 1;
        smartGatherAndCraft(bot, args[1].toLowerCase(), count);
      }
      else if (cmd === 'sort') {
        sortAndCleanInventory(bot);
      }
      else if (cmd === 'smelt') {
        botState.autoSmelt = !botState.autoSmelt;
        if (botState.autoSmelt) runAutoSmelter(bot);
        else clearTimeout(botState.smeltingInterval);
        bot.chat(`🔥 Auto Smelter: ${botState.autoSmelt ? 'ON' : 'OFF'}`);
      }
      else if (cmd === 'guard' || cmd === 'defense') {
        botState.guardMode = !botState.guardMode;
        if (botState.guardMode) {
          startMobDefense(bot);
        } else {
          stopMobDefense();
        }
        bot.chat(`🛡️ Auto Mob Defense: ${botState.guardMode ? 'ON' : 'OFF'}`);
      }
      else if (cmd === 'afk') {
        botState.antiAfk ? stopAntiAfk(bot) : startAntiAfk(bot);
      }
      else if (cmd === 'fish') {
        botState.isFishing ? stopFishing() : startFishing(bot);
      }
      else if (cmd === 'farm') {
        botState.autoFarm = !botState.autoFarm;
        if (botState.autoFarm) {
          runFarmLoop(bot);
        } else {
          clearTimeout(botState.farmingInterval);
        }
        bot.chat(`🌾 Auto Farm: ${botState.autoFarm ? 'ON' : 'OFF'}`);
      }
      else if (cmd === 'deposit' || cmd === 'chest') {
        dumpToChest(bot);
      }
      else if (cmd === 'build' && args[1] === 'house') {
        executeHouseBuild(bot);
      }
      else if (cmd === 'mine' || cmd === 'collect') {
        let blockQuery = args[1]?.toLowerCase();
        let count = parseInt(args[2], 10) || 1;
        const mcData = require('minecraft-data')(bot.version);

        let targetNames = BLOCK_ALIASES[blockQuery] || [blockQuery];
        let targetIds = targetNames.map(name => mcData.blocksByName[name]?.id).filter(Boolean);

        const found = bot.findBlocks({ matching: targetIds, maxDistance: 32, count });
        if (!found.length) {
          return bot.chat(`Aas-paas ${blockQuery} nahi mila.`);
        }

        bot.chat(`${found.length} ${blockQuery} tod raha hoon...`);
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
        if (lower.includes('nokar') || lower.includes('bot') || lower.startsWith('!ai')) {
          const prompt = actualText.replace(/^(nokar|bot|!ai)\s*/i, '');
          const reply = await askAiBrain(prompt || "hi", { hp: bot.health, food: bot.food });
          bot.chat(reply);
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
