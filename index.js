/**
 * Master Minecraft Companion: Web Control Center + Auto-Farm + Builder + Inventory
 * Version: 4.0.0-Ultimate
 */

const http = require('http');
const path = require('path');
const express = require('express');
const socketIo = require('socket.io');
const _ = require('lodash');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

// Plugins
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;
const pvp = require('mineflayer-pvp').plugin;

// Utilities
let getWindowName, addItemData;
try {
  const utils = require('./utils');
  getWindowName = utils.getWindowName;
  addItemData = utils.addItemData;
} catch (e) {
  getWindowName = (w) => w?.type || 'minecraft:inventory';
  addItemData = (mcData, mcAssets, item) => item;
}

const DEFAULT_FALLBACK_VERSION = '1.20.4';

// Bot State Control flags
const botState = {
  autoEat: true,
  autoFarm: false,
  farmingInterval: null
};

// Aliases for smart mining
const BLOCK_ALIASES = {
  'diamond': ['diamond_ore', 'deepslate_diamond_ore', 'diamond_block'],
  'iron': ['iron_ore', 'deepslate_iron_ore', 'raw_iron_block'],
  'gold': ['gold_ore', 'deepslate_gold_ore', 'raw_gold_block'],
  'coal': ['coal_ore', 'deepslate_coal_ore', 'coal_block'],
  'wood': ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'jungle_log', 'acacia_log', 'mangrove_log', 'cherry_log'],
  'tree': ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log'],
  'stone': ['stone', 'cobblestone', 'deepslate', 'andesite', 'diorite', 'granite'],
  'dirt': ['dirt', 'grass_block']
};

/**
 * Auto-Equip Engine
 */
async function equipBestWeapon(bot) {
  const weapons = bot.inventory.items().filter(item => item.name.includes('sword') || item.name.includes('axe'));
  if (!weapons.length) return;
  const tier = ['netherite_sword', 'diamond_sword', 'iron_sword', 'netherite_axe', 'diamond_axe', 'stone_sword', 'iron_axe', 'wooden_sword'];
  weapons.sort((a, b) => (tier.indexOf(a.name) === -1 ? 99 : tier.indexOf(a.name)) - (tier.indexOf(b.name) === -1 ? 99 : tier.indexOf(b.name)));
  try { await bot.equip(weapons[0], 'hand'); } catch (e) {}
}

async function equipBestTool(bot, block) {
  if (!block) return;
  const items = bot.inventory.items();
  let type = '';
  if (block.name.includes('ore') || block.name.includes('stone') || block.name.includes('cobble')) type = 'pickaxe';
  else if (block.name.includes('log') || block.name.includes('wood')) type = 'axe';
  else if (block.name.includes('dirt') || block.name.includes('sand')) type = 'shovel';
  else if (block.name.includes('wheat') || block.name.includes('crops') || block.name.includes('carrots') || block.name.includes('potatoes')) type = 'hoe';
  if (!type) return;

  const tools = items.filter(i => i.name.includes(type));
  if (tools.length) {
    try { await bot.equip(tools[0], 'hand'); } catch (e) {}
  }
}

/**
 * Auto-Harvest & Auto-Replant Crop Engine
 */
async function runFarmLoop(bot) {
  if (!botState.autoFarm) return;
  const mcData = require('minecraft-data')(bot.version);

  // Mature crop block IDs
  const cropNames = ['wheat', 'carrots', 'potatoes', 'beetroots'];
  const cropIds = cropNames.map(n => mcData.blocksByName[n]?.id).filter(Boolean);

  const matureCrops = bot.findBlocks({
    matching: (block) => {
      if (!cropIds.includes(block.type)) return false;
      // In Minecraft metadata 7 = fully grown for wheat/carrots/potatoes
      return block.metadata === 7;
    },
    maxDistance: 32,
    count: 5
  });

  if (matureCrops.length > 0) {
    try {
      const targets = matureCrops.map(pos => bot.blockAt(pos));
      await bot.collectBlock.collect(targets);

      // Replanting seeds
      for (const pos of matureCrops) {
        const soilPos = pos.offset(0, -1, 0);
        const soilBlock = bot.blockAt(soilPos);
        const seedItem = bot.inventory.items().find(i => 
          i.name.includes('seeds') || i.name === 'carrot' || i.name === 'potato'
        );

        if (soilBlock && soilBlock.name === 'farmland' && seedItem) {
          await bot.equip(seedItem, 'hand');
          await bot.placeBlock(soilBlock, new Vec3(0, 1, 0)).catch(() => {});
          await bot.waitForTicks(2);
        }
      }
    } catch (err) {
      // Quiet fail during loop to continue
    }
  }

  // Repeat cycle every 5 seconds if active
  if (botState.autoFarm) {
    botState.farmingInterval = setTimeout(() => runFarmLoop(bot), 5000);
  }
}

/**
 * Web Control Panel & Socket Server
 */
function webInventoryPlugin(bot, customOptions = {}) {
  const options = {
    webPath: customOptions.webPath || '/',
    port: customOptions.port || process.env.PORT || 3000,
    windowUpdateDebounceTime: 100,
    startOnLoad: true
  };

  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server);

  bot.webInventory = { options, isRunning: false, sockets: new Set() };

  // Control Center Web Page
  app.get('/panel', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Nokar Bot Control Panel</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: system-ui, sans-serif; background: #121212; color: #fff; padding: 20px; text-align: center; }
          .card { background: #1e1e1e; max-width: 480px; margin: auto; padding: 24px; border-radius: 12px; border: 1px solid #333; }
          h2 { margin-top: 0; color: #4CAF50; }
          .status { font-size: 14px; margin-bottom: 20px; padding: 8px; border-radius: 6px; background: #2a2a2a; }
          .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; }
          button { background: #2e7d32; border: none; color: white; padding: 12px; font-size: 15px; font-weight: bold; border-radius: 8px; cursor: pointer; transition: 0.2s; }
          button:active { transform: scale(0.98); }
          button.danger { background: #c62828; }
          button.action { background: #0277bd; }
          .link-box { margin-top: 20px; font-size: 13px; }
          a { color: #81c784; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🤖 Nokar Control Center</h2>
          <div class="status" id="statusBox">Bot: Connected</div>

          <div class="btn-grid">
            <button onclick="sendAction('toggle_farm')" id="farmBtn">🌾 Auto Farm: OFF</button>
            <button onclick="sendAction('toggle_eat')" id="eatBtn">🍖 Auto Eat: ON</button>
            <button class="action" onclick="sendAction('dropall')">📦 Drop All</button>
            <button class="action" onclick="sendAction('build_house')">🏠 Build House</button>
            <button class="danger" style="grid-column: span 2;" onclick="sendAction('stop')">🛑 Emergency Stop</button>
          </div>

          <div class="link-box">
            <a href="/" target="_blank">➡️ View Live Graphical Inventory</a>
          </div>
        </div>

        <script>
          let farmActive = false;
          let eatActive = true;

          function sendAction(action) {
            fetch('/api/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: action })
            })
            .then(res => res.json())
            .then(data => {
              if (action === 'toggle_farm') {
                farmActive = data.autoFarm;
                document.getElementById('farmBtn').innerText = '🌾 Auto Farm: ' + (farmActive ? 'ON' : 'OFF');
                document.getElementById('farmBtn').style.background = farmActive ? '#1565c0' : '#2e7d32';
              }
              if (action === 'toggle_eat') {
                eatActive = data.autoEat;
                document.getElementById('eatBtn').innerText = '🍖 Auto Eat: ' + (eatActive ? 'ON' : 'OFF');
                document.getElementById('eatBtn').style.background = eatActive ? '#2e7d32' : '#c62828';
              }
              alert(data.message);
            });
          }
        </script>
      </body>
      </html>
    `);
  });

  // API Endpoint for Buttons
  app.use(express.json());
  app.post('/api/action', async (req, res) => {
    const act = req.body.action;

    if (act === 'toggle_farm') {
      botState.autoFarm = !botState.autoFarm;
      if (botState.autoFarm) {
        runFarmLoop(bot);
        bot.chat('Auto-Farm mode ON kar diya gaya hai.');
      } else {
        clearTimeout(botState.farmingInterval);
        bot.chat('Auto-Farm mode OFF kar diya gaya hai.');
      }
      return res.json({ success: true, autoFarm: botState.autoFarm, message: `Auto Farm: ${botState.autoFarm ? 'ON' : 'OFF'}` });
    }

    if (act === 'toggle_eat') {
      botState.autoEat = !botState.autoEat;
      if (botState.autoEat) {
        bot.autoEat.enable();
      } else {
        bot.autoEat.disable();
      }
      return res.json({ success: true, autoEat: botState.autoEat, message: `Auto Eat: ${botState.autoEat ? 'ON' : 'OFF'}` });
    }

    if (act === 'dropall') {
      const items = bot.inventory.items();
      for (const item of items) {
        try { await bot.tossStack(item); } catch (e) {}
      }
      bot.chat('Web dashboard ke command se sari inventory drop kar di!');
      return res.json({ success: true, message: 'All items dropped!' });
    }

    if (act === 'stop') {
      bot.pathfinder.stop();
      bot.pvp.stop();
      bot.collectBlock.cancelTask();
      botState.autoFarm = false;
      clearTimeout(botState.farmingInterval);
      bot.chat('Emergency stop triggered via Web!');
      return res.json({ success: true, message: 'All tasks stopped!' });
    }

    if (act === 'build_house') {
      executeHouseBuild(bot);
      return res.json({ success: true, message: 'Starter House construction started!' });
    }

    res.json({ success: false, message: 'Invalid action' });
  });

  let mcData, mcAssets;
  try { mcData = require('minecraft-data')(bot.version); } catch (e) { mcData = require('minecraft-data')(DEFAULT_FALLBACK_VERSION); }
  try { mcAssets = require('minecraft-assets')(bot.version); } catch (e) { mcAssets = require('minecraft-assets')(DEFAULT_FALLBACK_VERSION); }

  app.use('/', express.static(path.join(__dirname, 'client', 'public')));

  io.on('connection', (socket) => {
    bot.webInventory.sockets.add(socket);

    function emitWindow(win) {
      if (!win) return;
      const targetWin = Object.assign({}, win);
      const update = { id: targetWin.id, type: getWindowName(targetWin), slots: {} };
      if (!update.type) {
        update.id = bot.inventory.id;
        update.type = getWindowName(bot.inventory);
        update.slots = Array(9).fill(null, 0, 9).concat(bot.inventory.slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd));
        update.slots.forEach(item => { if (item) item.slot -= bot.inventory.inventoryStart - 9; });
        update.unsupported = true;
      }
      const rawSlots = Object.assign({}, targetWin.slots || bot.inventory.slots);
      for (const k in rawSlots) {
        if (rawSlots[k] && mcData && mcAssets) rawSlots[k] = addItemData(mcData, mcAssets, rawSlots[k]);
      }
      update.slots = rawSlots;
      socket.emit('window', update);
    }

    emitWindow(bot.currentWindow || bot.inventory);
    bot.inventory.on('updateSlot', () => emitWindow(bot.currentWindow || bot.inventory));
  });

  server.listen(options.port, () => {
    bot.webInventory.isRunning = true;
    console.log(`[DASHBOARD READY] Web GUI & Controls live on port ${options.port}`);
  });

  bot.webInventory = { ...bot.webInventory, start: () => {}, stop: () => server.close() };
}

/**
 * Starter House Builder Execution
 */
async function executeHouseBuild(bot) {
  const buildBlock = bot.inventory.items().find(i => 
    i.name.includes('plank') || i.name.includes('cobble') || i.name.includes('stone') || i.name.includes('dirt')
  );

  if (!buildBlock) {
    return bot.chat("House banane ke liye blocks (planks, cobble, dirt) nahi hain!");
  }

  bot.chat("4x4 Starter House banana shuru kar raha hoon...");
  try {
    await bot.equip(buildBlock, 'hand');
    const startPos = bot.entity.position.floored();

    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        for (let z = 0; z < 4; z++) {
          if (x === 0 || x === 3 || z === 0 || z === 3) {
            if (x === 1 && z === 0 && y < 2) continue; // Door entry
            const targetPos = startPos.offset(x, y, z);
            const blockAtTarget = bot.blockAt(targetPos);
            if (blockAtTarget && blockAtTarget.name === 'air') {
              const blockBelow = bot.blockAt(targetPos.offset(0, -1, 0));
              if (blockBelow && blockBelow.name !== 'air') {
                await bot.placeBlock(blockBelow, new Vec3(0, 1, 0)).catch(() => {});
                await bot.waitForTicks(3);
              }
            }
          }
        }
      }
    }
    bot.chat("Starter House complete!");
  } catch (err) {
    bot.chat(`Building me rukawat: ${err.message}`);
  }
}

module.exports = webInventoryPlugin;

// Bot Connection Lifecycle
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
    bot.loadPlugin(pvp);

    bot.once('spawn', () => {
      console.log(`[AGENT JOINED] Bot ${bot.username} entered server.`);
      try { module.exports(bot, { port: WEB_PORT }); } catch (e) {}

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowParkour = true;
      defaultMove.canDig = true;
      bot.pathfinder.setMovements(defaultMove);

      // Auto-Eat Setup
      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish']
      };
    });

    // In-game Chat Commands Handler
    bot.on('chat', async (username, message) => {
      if (username === bot.username) return;
      const args = message.trim().split(/\s+/);
      const cmd = args[0].toLowerCase();
      const mcData = require('minecraft-data')(bot.version);

      if (cmd === 'come' || cmd === 'follow') {
        const player = bot.players[username]?.entity;
        if (!player) return bot.chat(`@${username} aap mujhe dikh nahi rahe ho! Paas aao.`);
        bot.chat(`Following @${username}...`);
        bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true);
      }

      else if (cmd === 'stop') {
        bot.pathfinder.stop();
        bot.pvp.stop();
        bot.collectBlock.cancelTask();
        botState.autoFarm = false;
        clearTimeout(botState.farmingInterval);
        bot.chat("Saare ongoing actions ruk gaye!");
      }

      else if (cmd === 'farm') {
        botState.autoFarm = !botState.autoFarm;
        if (botState.autoFarm) {
          bot.chat("Auto-Farm started! Fully grown faslein tod raha hoon...");
          runFarmLoop(bot);
        } else {
          clearTimeout(botState.farmingInterval);
          bot.chat("Auto-Farm stopped.");
        }
      }

      else if (cmd === 'eat') {
        bot.autoEat.eat().then(() => {
          bot.chat("Khana kha liya!");
        }).catch(e => bot.chat(`Khana nahi kha paya: ${e.message}`));
      }

      else if (cmd === 'build' && args[1] === 'house') {
        executeHouseBuild(bot);
      }

      else if (cmd === 'kill' || cmd === 'attack') {
        const targetName = args[1]?.toLowerCase();
        if (!targetName) return bot.chat("Target batayein. Example: kill zombie");
        const target = bot.nearestEntity(e => 
          (e.type === 'mob' && e.name?.toLowerCase().includes(targetName)) ||
          (e.type === 'player' && e.username?.toLowerCase() === targetName)
        );
        if (!target) return bot.chat(`"${targetName}" aas-paas nahi mila.`);
        await equipBestWeapon(bot);
        bot.pvp.attack(target);
      }

      else if (cmd === 'collect' || cmd === 'mine') {
        let blockQuery, count;
        if (!isNaN(args[1]) && args[2]) {
          count = parseInt(args[1]);
          blockQuery = args[2].toLowerCase();
        } else {
          blockQuery = args[1]?.toLowerCase();
          count = parseInt(args[2]) || 1;
        }

        if (!blockQuery) return bot.chat("Example: collect wood 5 ya collect stone 10");

        let targetNames = BLOCK_ALIASES[blockQuery] || [blockQuery];
        let targetIds = targetNames.map(name => mcData.blocksByName[name]?.id).filter(Boolean);

        if (!targetIds.length) return bot.chat(`Block "${blockQuery}" nahi mila.`);

        const foundPositions = bot.findBlocks({ matching: targetIds, maxDistance: 64, count: count });
        if (!foundPositions.length) return bot.chat(`64 blocks me koi "${blockQuery}" nahi mila.`);

        bot.chat(`${foundPositions.length} ${blockQuery} todne jaa raha hoon...`);
        try {
          const targets = foundPositions.map(pos => bot.blockAt(pos));
          await equipBestTool(bot, targets[0]);
          await bot.collectBlock.collect(targets);
          bot.chat("Mining complete!");
        } catch (err) {
          bot.chat(`Mining fail: ${err.message}`);
        }
      }

      else if (cmd === 'dropall') {
        const items = bot.inventory.items();
        for (const item of items) {
          try { await bot.tossStack(item); } catch (e) {}
        }
        bot.chat("Sari inventory drop kar di!");
      }

      else if (cmd === 'drop' && args[1]) {
        const query = args[1].toLowerCase();
        const count = parseInt(args[2]) || null;
        const matchedItem = bot.inventory.items().find(i => i.name.toLowerCase().includes(query));
        if (!matchedItem) return bot.chat(`Mere paas "${query}" nahi hai.`);

        if (count) await bot.toss(matchedItem.type, null, count);
        else await bot.tossStack(matchedItem);
        bot.chat(`${matchedItem.name} drop kar diya.`);
      }
    });

    bot.on('end', () => {
      console.warn('[ALERT] Disconnected. Reconnecting in 10s...');
      setTimeout(launchBot, 10000);
    });

    bot.on('error', (err) => console.error('[ERROR]', err.message));
  }

  launchBot();
}
