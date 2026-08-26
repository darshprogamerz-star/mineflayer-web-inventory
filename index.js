/**
 * Master Autonomous Minecraft Companion & Web Inventory Agent
 * Version: 6.0.0-Ultimate
 */

const http = require('http');
const express = require('express');
const socketIo = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

// Plugins
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;
const pvp = require('mineflayer-pvp').plugin;

const botState = {
  autoEat: true,
  autoFarm: false,
  farmingInterval: null,
  followingPlayer: null
};

// Resource Aliases
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
 * Auto Equip Functions
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
  if (block.name.includes('ore') || block.name.includes('stone') || block.name.includes('cobble') || block.name.includes('deepslate')) type = 'pickaxe';
  else if (block.name.includes('log') || block.name.includes('wood')) type = 'axe';
  else if (block.name.includes('dirt') || block.name.includes('sand') || block.name.includes('gravel')) type = 'shovel';
  else if (block.name.includes('wheat') || block.name.includes('carrots') || block.name.includes('potatoes')) type = 'hoe';
  if (!type) return;

  const tools = items.filter(i => i.name.includes(type));
  if (tools.length) {
    try { await bot.equip(tools[0], 'hand'); } catch (e) {}
  }
}

/**
 * 4x4 Complete Solid House Builder
 */
async function executeHouseBuild(bot) {
  const getBuildBlock = () => bot.inventory.items().find(i => 
    i.name.includes('plank') || i.name.includes('cobble') || i.name.includes('stone') || i.name.includes('dirt')
  );

  if (!getBuildBlock()) {
    return bot.chat("Ghar banane ke liye inventory me blocks (planks/cobble/dirt) nahi hain!");
  }

  bot.chat("4x4 Complete House banana shuru kar raha hoon...");
  const start = bot.entity.position.floored().offset(1, 0, 1);
  const placeList = [];

  // Walls (Height 3)
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        if (x === 0 || x === 3 || z === 0 || z === 3) {
          if (x === 1 && z === 0 && (y === 0 || y === 1)) continue; // Door passage
          placeList.push(start.offset(x, y, z));
        }
      }
    }
  }

  // Roof
  for (let x = 0; x < 4; x++) {
    for (let z = 0; z < 4; z++) {
      placeList.push(start.offset(x, 3, z));
    }
  }

  for (const pos of placeList) {
    const targetBlock = bot.blockAt(pos);
    if (!targetBlock || targetBlock.name !== 'air') continue;

    const blockItem = getBuildBlock();
    if (!blockItem) {
      bot.chat("Blocks khatam ho gaye! Thode aur blocks do.");
      return;
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
        const refBlock = bot.blockAt(n);
        if (refBlock && refBlock.name !== 'air') {
          const faceVec = pos.minus(n);
          await bot.lookAt(pos);
          await bot.placeBlock(refBlock, faceVec).catch(() => {});
          await bot.waitForTicks(3);
          break;
        }
      }
    } catch (e) {}
  }
  bot.chat("Complete House ban gaya!");
}

/**
 * Auto-Harvest & Auto-Replant Crop Engine
 */
async function runFarmLoop(bot) {
  if (!botState.autoFarm) return;
  const mcData = require('minecraft-data')(bot.version);
  const cropNames = ['wheat', 'carrots', 'potatoes', 'beetroots'];
  const cropIds = cropNames.map(n => mcData.blocksByName[n]?.id).filter(Boolean);

  const matureCrops = bot.findBlocks({
    matching: (block) => cropIds.includes(block.type) && block.metadata === 7,
    maxDistance: 32,
    count: 5
  });

  if (matureCrops.length > 0) {
    try {
      const targets = matureCrops.map(pos => bot.blockAt(pos));
      await bot.collectBlock.collect(targets);

      for (const pos of matureCrops) {
        const soilBlock = bot.blockAt(pos.offset(0, -1, 0));
        const seedItem = bot.inventory.items().find(i => i.name.includes('seeds') || i.name === 'carrot' || i.name === 'potato');
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

/**
 * Web Dashboard Server
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
      <html>
      <head>
        <title>Nokar Bot - Control Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <script src="/socket.io/socket.io.js"></script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #0b0f19; color: #e2e8f0; display: flex; justify-content: center; padding: 20px; }
          .panel { width: 100%; max-width: 650px; background: #151d30; border-radius: 14px; border: 1px solid #24324f; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
          .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
          .title { font-size: 22px; font-weight: bold; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
          .badge { background: #059669; color: #fff; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
          .meters { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
          .meter-card { background: #0b0f19; padding: 12px; border-radius: 8px; border: 1px solid #1e293b; text-align: center; }
          .meter-val { font-size: 20px; font-weight: bold; }
          .health-txt { color: #f43f5e; }
          .food-txt { color: #fbbf24; }
          .grid-title { font-size: 13px; text-transform: uppercase; color: #94a3b8; letter-spacing: 1px; margin: 16px 0 8px; }
          .grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 6px; background: #0b0f19; padding: 12px; border-radius: 10px; border: 1px solid #1e293b; }
          .slot { aspect-ratio: 1; background: #1e293b; border: 1px solid #334155; border-radius: 6px; position: relative; display: flex; align-items: center; justify-content: center; text-align: center; padding: 2px; }
          .slot .item-name { font-size: 8.5px; color: #cbd5e1; word-break: break-all; line-height: 1; }
          .slot .item-count { position: absolute; bottom: 2px; right: 3px; font-size: 11px; font-weight: 800; color: #38bdf8; }
          .controls { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 24px; }
          button { padding: 12px; border: none; border-radius: 8px; font-weight: bold; font-size: 14px; cursor: pointer; color: white; transition: 0.15s; }
          button:active { transform: scale(0.97); }
          .btn-farm { background: #059669; }
          .btn-eat { background: #d97706; }
          .btn-build { background: #2563eb; }
          .btn-drop { background: #475569; }
          .btn-stop { background: #e11d48; grid-column: span 2; margin-top: 4px; }
        </style>
      </head>
      <body>
        <div class="panel">
          <div class="top-bar">
            <div class="title">🤖 Nokar Web Control</div>
            <div class="badge">Connected</div>
          </div>
          <div class="meters">
            <div class="meter-card">
              <div class="meter-val health-txt" id="hp">20 / 20</div>
              <div style="font-size: 12px; color: #64748b;">❤️ Health</div>
            </div>
            <div class="meter-card">
              <div class="meter-val food-txt" id="food">20 / 20</div>
              <div style="font-size: 12px; color: #64748b;">🍖 Food</div>
            </div>
          </div>
          <div class="grid-title">Main Inventory</div>
          <div class="grid" id="mainGrid"></div>
          <div class="grid-title">Hotbar</div>
          <div class="grid" id="hotbarGrid"></div>
          <div class="controls">
            <button class="btn-farm" onclick="send('toggle_farm')" id="farmBtn">🌾 Auto Farm: OFF</button>
            <button class="btn-eat" onclick="send('toggle_eat')">🍖 Auto Eat: ON</button>
            <button class="btn-build" onclick="send('build_house')">🏠 Build House</button>
            <button class="btn-drop" onclick="send('dropall')">📦 Drop All</button>
            <button class="btn-stop" onclick="send('stop')">🛑 Emergency Stop</button>
          </div>
        </div>
        <script>
          const socket = io();
          let farmOn = false;
          const main = document.getElementById('mainGrid');
          const hotbar = document.getElementById('hotbarGrid');
          for (let i = 9; i <= 35; i++) main.innerHTML += '<div class="slot" id="s-' + i + '"></div>';
          for (let i = 36; i <= 44; i++) hotbar.innerHTML += '<div class="slot" id="s-' + i + '"></div>';

          socket.on('sync', data => {
            if (data.hp !== undefined) document.getElementById('hp').innerText = Math.round(data.hp) + ' / 20';
            if (data.food !== undefined) document.getElementById('food').innerText = Math.round(data.food) + ' / 20';

            for (let i = 9; i <= 44; i++) {
              const el = document.getElementById('s-' + i);
              if (!el) continue;
              const item = data.items.find(x => x.slot === i);
              if (item) {
                el.innerHTML = '<span class="item-name">' + item.name.replace(/_/g, ' ') + '</span>' + (item.count > 1 ? '<span class="item-count">' + item.count + '</span>' : '');
                el.style.background = '#24324f';
              } else {
                el.innerHTML = '';
                el.style.background = '#1e293b';
              }
            }
          });

          function send(act) {
            fetch('/api/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: act })
            }).then(r => r.json()).then(d => {
              if (act === 'toggle_farm') {
                farmOn = d.farm;
                document.getElementById('farmBtn').innerText = '🌾 Auto Farm: ' + (farmOn ? 'ON' : 'OFF');
              }
            });
          }
        </script>
      </body>
      </html>
    `);
  });

  app.post('/api/action', async (req, res) => {
    const act = req.body.action;
    if (act === 'toggle_farm') {
      botState.autoFarm = !botState.autoFarm;
      if (botState.autoFarm) runFarmLoop(bot);
      else clearTimeout(botState.farmingInterval);
      return res.json({ success: true, farm: botState.autoFarm });
    }
    if (act === 'toggle_eat') {
      botState.autoEat = !botState.autoEat;
      if (botState.autoEat) bot.autoEat.enable();
      else bot.autoEat.disable();
      return res.json({ success: true, eat: botState.autoEat });
    }
    if (act === 'build_house') {
      executeHouseBuild(bot);
    }
    if (act === 'dropall') {
      for (const item of bot.inventory.items()) {
        try { await bot.tossStack(item); } catch (e) {}
      }
    }
    if (act === 'stop') {
      botState.followingPlayer = null;
      bot.pathfinder.stop();
      bot.pvp.stop();
      bot.collectBlock.cancelTask();
      botState.autoFarm = false;
      clearTimeout(botState.farmingInterval);
      bot.chat("Actions stopped!");
    }
    res.json({ success: true });
  });

  function syncState() {
    const items = bot.inventory.slots
      .map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null)
      .filter(Boolean);
    io.emit('sync', { hp: bot.health, food: bot.food, items });
  }

  io.on('connection', () => syncState());
  bot.inventory.on('updateSlot', () => syncState());
  bot.on('health', () => syncState());

  server.listen(port, () => console.log(`[DASHBOARD READY] Port ${port}`));
}

/**
 * Main Lifecycle Setup
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
      version: '1.20.4'
    });

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(pvp);

    bot.once('spawn', () => {
      console.log(`[AGENT JOINED] ${bot.username} connected.`);
      try { webInventoryPlugin(bot, { port: WEB_PORT }); } catch (e) {}

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);

      // Advanced Obstacle & Climb Handling
      defaultMove.allowParkour = true;
      defaultMove.canDig = true;
      defaultMove.allow1by1towers = true;
      defaultMove.allowFreeMotion = true;
      defaultMove.maxDropDown = 4;
      defaultMove.scaffoldingBlocks = [
        mcData.blocksByName.dirt?.id,
        mcData.blocksByName.cobblestone?.id,
        mcData.blocksByName.oak_planks?.id
      ].filter(Boolean);

      bot.pathfinder.setMovements(defaultMove);
      bot.autoEat.options = { priority: 'foodPoints', startAt: 14, bannedFood: ['rotten_flesh', 'spider_eye'] };
    });

    // Real-Time Continuous Follow Loop
    bot.on('physicsTick', () => {
      if (!botState.followingPlayer) return;
      const target = bot.players[botState.followingPlayer]?.entity;
      if (target) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      }
    });

    bot.on('chat', async (username, message) => {
      if (username === bot.username) return;
      const args = message.trim().split(/\s+/);
      const cmd = args[0].toLowerCase();
      const mcData = require('minecraft-data')(bot.version);

      // 1. Follow
      if (cmd === 'come' || cmd === 'follow') {
        const player = bot.players[username]?.entity;
        botState.followingPlayer = username;
        if (player) {
          bot.chat(`Following @${username}!`);
          bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true);
        } else {
          bot.chat(`Tracking player @${username}...`);
        }
      }

      // 2. Stop
      else if (cmd === 'stop') {
        botState.followingPlayer = null;
        bot.pathfinder.stop();
        bot.pvp.stop();
        bot.collectBlock.cancelTask();
        botState.autoFarm = false;
        clearTimeout(botState.farmingInterval);
        bot.chat("Ruk gaya!");
      }

      // 3. House Builder
      else if (cmd === 'build' && args[1] === 'house') {
        executeHouseBuild(bot);
      }

      // 4. Auto Crafting
      else if (cmd === 'craft' && args[1]) {
        const itemName = args[1].toLowerCase();
        const count = parseInt(args[2]) || 1;
        const itemObj = mcData.itemsByName[itemName];

        if (!itemObj) return bot.chat(`"${itemName}" valid item nahi hai.`);

        const craftingTable = bot.findBlock({
          matching: mcData.blocksByName.crafting_table?.id,
          maxDistance: 4
        });

        const recipes = bot.recipesFor(itemObj.id, null, 1, craftingTable);
        if (!recipes.length) return bot.chat(`Mere paas "${itemName}" craft karne ka saman ya Crafting Table nahi hai.`);

        try {
          await bot.craft(recipes[0], count, craftingTable);
          bot.chat(`${count} ${itemName} craft kar liya!`);
        } catch (err) {
          bot.chat(`Crafting error: ${err.message}`);
        }
      }

      // 5. Mining
      else if (cmd === 'collect' || cmd === 'mine') {
        let blockQuery = args[1]?.toLowerCase();
        let count = parseInt(args[2]) || 1;
        if (!isNaN(args[1]) && args[2]) {
          count = parseInt(args[1]);
          blockQuery = args[2].toLowerCase();
        }

        let targetNames = BLOCK_ALIASES[blockQuery] || [blockQuery];
        let targetIds = targetNames.map(name => mcData.blocksByName[name]?.id).filter(Boolean);

        const found = bot.findBlocks({ matching: targetIds, maxDistance: 32, count });
        if (!found.length) return bot.chat(`Aas-paas ${blockQuery} nahi mila.`);

        bot.chat(`${found.length} ${blockQuery} tod raha hoon...`);
        try {
          const targets = found.map(pos => bot.blockAt(pos));
          await equipBestTool(bot, targets[0]);
          await bot.collectBlock.collect(targets);
          bot.chat("Collection done!");
        } catch (e) {
          bot.chat(`Collection error: ${e.message}`);
        }
      }

      // 6. Drop All
      else if (cmd === 'dropall') {
        for (const item of bot.inventory.items()) {
          try { await bot.tossStack(item); } catch (e) {}
        }
        bot.chat("Sari inventory drop kar di!");
      }
    });

    bot.on('end', () => setTimeout(launchBot, 10000));
    bot.on('error', (err) => console.error('[ERROR]', err.message));
  }

  launchBot();
}
