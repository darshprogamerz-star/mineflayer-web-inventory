/**
 * Master Autonomous Minecraft Companion: Web Dashboard + Advanced Pathing & Builder
 * Version: 5.1.0-FixedVersion
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
  farmingInterval: null
};

// Aliases for Smart Resource Mining
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
 * Smart Auto-Equip Tools & Weapons
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
    } catch (err) {}
  }

  if (botState.autoFarm) {
    botState.farmingInterval = setTimeout(() => runFarmLoop(bot), 5000);
  }
}

/**
 * Starter House Construction Script
 */
async function executeHouseBuild(bot) {
  const buildBlock = bot.inventory.items().find(i => 
    i.name.includes('plank') || i.name.includes('cobble') || i.name.includes('stone') || i.name.includes('dirt')
  );

  if (!buildBlock) {
    return bot.chat("Ghar banane ke liye blocks (planks/cobble/dirt) inventory me nahi hain!");
  }

  bot.chat("Starter House construct karna shuru kar raha hoon...");
  const startPos = bot.entity.position.floored().offset(1, 0, 1);

  try {
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        for (let z = 0; z < 3; z++) {
          if (x === 0 || x === 2 || z === 0 || z === 2) {
            if (x === 1 && z === 0) continue; // Door passage
            
            const targetPos = startPos.offset(x, y, z);
            const currentBlock = bot.blockAt(targetPos);
            
            if (currentBlock && currentBlock.name === 'air') {
              const referenceBlock = bot.blockAt(targetPos.offset(0, -1, 0));
              if (referenceBlock && referenceBlock.name !== 'air') {
                await bot.equip(buildBlock, 'hand');
                await bot.lookAt(targetPos);
                await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0)).catch(() => {});
                await bot.waitForTicks(4);
              }
            }
          }
        }
      }
    }
    bot.chat("Starter House tayar ho gaya!");
  } catch (err) {
    bot.chat(`Building me issue: ${err.message}`);
  }
}

/**
 * Web Dashboard & Live Inventory Server
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
        <title>Nokar Agent - Control Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <script src="/socket.io/socket.io.js"></script>
        <style>
          * { box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; display: flex; justify-content: center; }
          .container { width: 100%; max-width: 600px; background: #1e293b; border-radius: 16px; padding: 20px; border: 1px solid #334155; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 12px; margin-bottom: 16px; }
          .title { font-size: 20px; font-weight: 700; color: #38bdf8; }
          .status { font-size: 13px; background: #064e3b; color: #34d399; padding: 4px 10px; border-radius: 20px; }
          .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
          .stat-box { background: #0f172a; padding: 10px; border-radius: 8px; border: 1px solid #334155; text-align: center; }
          .stat-val { font-size: 18px; font-weight: 700; color: #fbbf24; }
          .stat-lbl { font-size: 12px; color: #94a3b8; }
          .section-title { font-size: 13px; font-weight: 600; color: #94a3b8; margin: 12px 0 6px 0; }
          .inv-grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 5px; background: #0f172a; padding: 10px; border-radius: 8px; border: 1px solid #334155; }
          .slot { aspect-ratio: 1; background: #1e293b; border: 1px solid #475569; border-radius: 4px; display: flex; flex-direction: column; justify-content: center; align-items: center; position: relative; font-size: 9px; text-align: center; padding: 2px; }
          .slot .name { font-size: 8px; line-height: 1; color: #e2e8f0; }
          .slot .count { position: absolute; bottom: 1px; right: 2px; font-size: 9px; font-weight: 700; color: #38bdf8; }
          .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 15px; }
          button { background: #2563eb; border: none; color: white; padding: 10px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; }
          button.farm-btn { background: #059669; }
          button.drop-btn { background: #d97706; }
          button.danger-btn { background: #dc2626; grid-column: span 2; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="title">🤖 Nokar Inventory & Agent</div>
            <div class="status">Online</div>
          </div>
          <div class="stats">
            <div class="stat-box"><div class="stat-val" id="botHealth">20 / 20</div><div class="stat-lbl">❤️ Health</div></div>
            <div class="stat-box"><div class="stat-val" id="botFood">20 / 20</div><div class="stat-lbl">🍗 Food</div></div>
          </div>
          <div class="section-title">Main Inventory (27 Slots)</div>
          <div class="inv-grid" id="mainGrid"></div>
          <div class="section-title">Hotbar (9 Slots)</div>
          <div class="inv-grid" id="hotbarGrid"></div>
          <div class="btn-grid">
            <button class="farm-btn" onclick="sendAction('toggle_farm')" id="farmBtn">🌾 Auto Farm</button>
            <button onclick="sendAction('toggle_eat')">🍖 Auto Eat</button>
            <button class="drop-btn" onclick="sendAction('dropall')">📦 Drop All</button>
            <button onclick="sendAction('build_house')">🏠 Build House</button>
            <button class="danger-btn" onclick="sendAction('stop')">🛑 Emergency Stop</button>
          </div>
        </div>
        <script>
          const socket = io();
          function renderSlots() {
            const main = document.getElementById('mainGrid');
            const hotbar = document.getElementById('hotbarGrid');
            main.innerHTML = ''; hotbar.innerHTML = '';
            for (let i = 9; i <= 35; i++) main.innerHTML += '<div class="slot" id="slot-' + i + '"></div>';
            for (let i = 36; i <= 44; i++) hotbar.innerHTML += '<div class="slot" id="slot-' + i + '"></div>';
          }
          renderSlots();
          socket.on('sync', (data) => {
            if (data.health !== undefined) document.getElementById('botHealth').innerText = Math.round(data.health) + ' / 20';
            if (data.food !== undefined) document.getElementById('botFood').innerText = Math.round(data.food) + ' / 20';
            for (let i = 9; i <= 44; i++) {
              const el = document.getElementById('slot-' + i);
              if (!el) continue;
              const item = data.items.find(it => it.slot === i);
              if (item) {
                el.innerHTML = '<span class="name">' + item.name.replace(/_/g, ' ') + '</span>' + (item.count > 1 ? '<span class="count">' + item.count + '</span>' : '');
                el.style.background = '#334155';
              } else {
                el.innerHTML = '';
                el.style.background = '#1e293b';
              }
            }
          });
          function sendAction(action) {
            fetch('/api/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: action })
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
      if (botState.autoFarm) {
        runFarmLoop(bot);
        bot.chat('Auto-Farm mode ON!');
      } else {
        clearTimeout(botState.farmingInterval);
        bot.chat('Auto-Farm mode OFF!');
      }
      return res.json({ success: true, autoFarm: botState.autoFarm });
    }
    if (act === 'toggle_eat') {
      botState.autoEat = !botState.autoEat;
      if (botState.autoEat) bot.autoEat.enable();
      else bot.autoEat.disable();
      return res.json({ success: true, autoEat: botState.autoEat });
    }
    if (act === 'dropall') {
      const items = bot.inventory.items();
      for (const item of items) { try { await bot.tossStack(item); } catch (e) {} }
      bot.chat('Sari inventory drop kar di!');
    }
    if (act === 'stop') {
      bot.pathfinder.stop();
      bot.pvp.stop();
      bot.collectBlock.cancelTask();
      botState.autoFarm = false;
      clearTimeout(botState.farmingInterval);
      bot.chat('Actions stopped!');
    }
    if (act === 'build_house') {
      executeHouseBuild(bot);
    }
    res.json({ success: true });
  });

  function broadcastBotState() {
    const rawItems = bot.inventory.slots
      .map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null)
      .filter(Boolean);
    io.emit('sync', { health: bot.health, food: bot.food, items: rawItems });
  }

  io.on('connection', () => broadcastBotState());
  bot.inventory.on('updateSlot', () => broadcastBotState());
  bot.on('health', () => broadcastBotState());

  server.listen(port, () => console.log(`[DASHBOARD READY] Web live on port ${port}`));
}

/**
 * Main Process Initialization & Movement Setup
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
      console.log(`[AGENT JOINED] Bot ${bot.username} is active in game.`);
      try { webInventoryPlugin(bot, { port: WEB_PORT }); } catch (e) {}

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);

      // Advanced Climbing & Jump Logic
      defaultMove.allowParkour = true;
      defaultMove.canDig = true;
      defaultMove.allow1by1towers = true;
      defaultMove.allowFreeMotion = true;
      defaultMove.maxDropDown = 4;
      defaultMove.scaffoldingBlocks = [
        mcData.blocksByName.dirt?.id,
        mcData.blocksByName.cobblestone?.id,
        mcData.blocksByName.oak_planks?.id,
        mcData.blocksByName.stone?.id
      ].filter(Boolean);

      bot.pathfinder.setMovements(defaultMove);

      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish']
      };
    });

    bot.on('chat', async (username, message) => {
      if (username === bot.username) return;
      const args = message.trim().split(/\s+/);
      const cmd = args[0].toLowerCase();
      const mcData = require('minecraft-data')(bot.version);

      // 1. Follow / Come
      if (cmd === 'come' || cmd === 'follow') {
        const player = bot.players[username]?.entity;
        if (player) {
          bot.chat(`Aapke paas aa raha hoon @${username}!`);
          bot.pathfinder.setGoal(new goals.GoalFollow(player, 1), true);
        } else {
          const nearestPlayer = bot.nearestEntity(e => e.type === 'player' && e.username === username);
          if (nearestPlayer) {
            bot.chat(`Tracking @${username}...`);
            bot.pathfinder.setGoal(new goals.GoalFollow(nearestPlayer, 1), true);
          } else {
            bot.chat(`@${username} aap scan nahi ho rahe, thoda paas aao.`);
          }
        }
      }

      // 2. Stop
      else if (cmd === 'stop') {
        bot.pathfinder.stop();
        bot.pvp.stop();
        bot.collectBlock.cancelTask();
        botState.autoFarm = false;
        clearTimeout(botState.farmingInterval);
        bot.chat("Ruk gaya!");
      }

      // 3. Farm
      else if (cmd === 'farm') {
        botState.autoFarm = !botState.autoFarm;
        if (botState.autoFarm) {
          bot.chat("Auto-Farm chalu!");
          runFarmLoop(bot);
        } else {
          clearTimeout(botState.farmingInterval);
          bot.chat("Auto-Farm band.");
        }
      }

      // 4. House Builder
      else if (cmd === 'build' && args[1] === 'house') {
        executeHouseBuild(bot);
      }

      // 5. Mining & Resource Collection
      else if (cmd === 'collect' || cmd === 'mine') {
        let blockQuery = args[1]?.toLowerCase();
        let count = parseInt(args[2]) || 1;
        if (!isNaN(args[1]) && args[2]) {
          count = parseInt(args[1]);
          blockQuery = args[2].toLowerCase();
        }

        let targetNames = BLOCK_ALIASES[blockQuery] || [blockQuery];
        let targetIds = targetNames.map(name => mcData.blocksByName[name]?.id).filter(Boolean);

        const foundPositions = bot.findBlocks({ matching: targetIds, maxDistance: 32, count: count });
        if (!foundPositions.length) return bot.chat(`Aas-paas koi ${blockQuery} nahi mila.`);

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

      // 6. Combat / Kill
      else if (cmd === 'kill' || cmd === 'attack') {
        const targetName = args[1]?.toLowerCase();
        if (!targetName) return bot.chat("Kisko marna hai? Example: kill zombie");
        const target = bot.nearestEntity(e => 
          (e.type === 'mob' && e.name?.toLowerCase().includes(targetName)) ||
          (e.type === 'player' && e.username?.toLowerCase() === targetName)
        );
        if (!target) return bot.chat(`"${targetName}" aas-paas nahi mila.`);
        await equipBestWeapon(bot);
        bot.pvp.attack(target);
      }

      // 7. Drop Specific Item
      else if (cmd === 'drop' && args[1]) {
        const query = args[1].toLowerCase();
        const count = parseInt(args[2]) || null;
        const matchedItem = bot.inventory.items().find(i => i.name.toLowerCase().includes(query));
        if (!matchedItem) return bot.chat(`Mere paas "${query}" nahi hai.`);

        if (count) await bot.toss(matchedItem.type, null, count);
        else await bot.tossStack(matchedItem);
        bot.chat(`${matchedItem.name} drop kar diya.`);
      }

      // 8. Drop All Items
      else if (cmd === 'dropall') {
        const items = bot.inventory.items();
        for (const item of items) { try { await bot.tossStack(item); } catch (e) {} }
        bot.chat("Saari inventory drop kar di!");
      }
    });

    bot.on('end', () => setTimeout(launchBot, 10000));
    bot.on('error', (err) => console.error('[ERROR]', err.message));
  }

  launchBot();
}
