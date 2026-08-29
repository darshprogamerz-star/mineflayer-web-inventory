/**
 * Master Autonomous Minecraft Companion Agent
 * Web Controller (D-Pad, Jump, Sneak, In-Game Chat) + 2D Radar + Web Inventory
 * Version: 8.0.0-FullWebControl
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

// Block aliases for mining
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
 * Auto-Equipment Engine
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
 * 4x4 Solid House Construction Routine
 */
async function executeHouseBuild(bot) {
  const getBuildBlock = () => bot.inventory.items().find(i => 
    i.name.includes('plank') || i.name.includes('cobble') || i.name.includes('stone') || i.name.includes('dirt')
  );

  if (!getBuildBlock()) {
    return bot.chat("Ghar banane ke liye blocks (planks/cobble/dirt) inventory me nahi hain!");
  }

  bot.chat("4x4 Complete House banana shuru kar raha hoon...");
  const start = bot.entity.position.floored().offset(1, 0, 1);
  const placeList = [];

  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        if (x === 0 || x === 3 || z === 0 || z === 3) {
          if (x === 1 && z === 0 && (y === 0 || y === 1)) continue; // Door frame
          placeList.push(start.offset(x, y, z));
        }
      }
    }
  }

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
      bot.chat("Blocks khatam ho gaye!");
      return;
    }

    try {
      await bot.equip(blockItem, 'hand');
      if (bot.entity.position.distanceTo(pos) > 4.5) {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)).catch(() => {});
      }

      const neighbors = [
        pos.offset(0, -1, 0), pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1), pos.offset(0, 0, -1)
      ];

      for (const n of neighbors) {
        const refBlock = bot.blockAt(n);
        if (refBlock && refBlock.name !== 'air') {
          await bot.lookAt(pos);
          await bot.placeBlock(refBlock, pos.minus(n)).catch(() => {});
          await bot.waitForTicks(3);
          break;
        }
      }
    } catch (e) {}
  }
  bot.chat("Complete Starter Base ban gaya!");
}

/**
 * Auto Farm Routine
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
 * Web Dashboard, Controller & Live Radar Server
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
        <title>Nokar Bot - Live Controller & Radar</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        <script src="/socket.io/socket.io.js"></script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
          body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #0b0f19; color: #e2e8f0; display: flex; justify-content: center; padding: 16px; }
          .panel { width: 100%; max-width: 680px; background: #151d30; border-radius: 14px; border: 1px solid #24324f; padding: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
          .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
          .title { font-size: 20px; font-weight: bold; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
          .badge { background: #059669; color: #fff; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; }
          
          /* Radar */
          .radar-container { display: flex; flex-direction: column; align-items: center; background: #080c14; border-radius: 10px; border: 1px solid #1e293b; padding: 12px; margin-bottom: 16px; }
          canvas { background: #050811; border-radius: 8px; border: 1px solid #334155; max-width: 100%; height: auto; }
          .radar-legend { display: flex; gap: 15px; font-size: 11px; margin-top: 8px; color: #94a3b8; }
          .legend-item { display: flex; align-items: center; gap: 4px; }
          .dot { width: 8px; height: 8px; border-radius: 50%; }

          /* Stats */
          .meters { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
          .meter-card { background: #0b0f19; padding: 10px; border-radius: 8px; border: 1px solid #1e293b; text-align: center; }
          .meter-val { font-size: 18px; font-weight: bold; }
          .health-txt { color: #f43f5e; }
          .food-txt { color: #fbbf24; }

          /* In-Game Chat Box */
          .chat-section { display: flex; gap: 8px; margin-bottom: 16px; }
          .chat-input { flex: 1; padding: 10px 14px; background: #0b0f19; border: 1px solid #334155; border-radius: 8px; color: #fff; font-size: 14px; outline: none; }
          .chat-input:focus { border-color: #38bdf8; }
          .chat-btn { background: #0284c7; padding: 10px 18px; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; }

          /* Virtual Game Controller (D-Pad) */
          .controller-wrapper { background: #080c14; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 16px; display: flex; flex-direction: column; align-items: center; }
          .controller-title { font-size: 12px; text-transform: uppercase; color: #94a3b8; letter-spacing: 1px; margin-bottom: 12px; }
          .dpad-grid { display: grid; grid-template-columns: repeat(3, 56px); grid-template-rows: repeat(3, 56px); gap: 6px; justify-content: center; }
          .ctrl-btn { background: #1e293b; border: 2px solid #334155; border-radius: 10px; color: white; font-size: 18px; font-weight: bold; display: flex; align-items: center; justify-content: center; cursor: pointer; touch-action: manipulation; transition: 0.1s; }
          .ctrl-btn:active, .ctrl-btn.active { background: #0284c7; border-color: #38bdf8; transform: scale(0.92); }
          .action-pad { display: flex; gap: 12px; margin-top: 14px; }
          .action-ctrl { padding: 10px 20px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; color: white; font-size: 13px; }
          .btn-jump { background: #16a34a; }
          .btn-sneak { background: #d97706; }

          /* Inventory Slots */
          .grid-title { font-size: 12px; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.8px; margin: 12px 0 6px; }
          .grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 5px; background: #0b0f19; padding: 10px; border-radius: 8px; border: 1px solid #1e293b; }
          .slot { aspect-ratio: 1; background: #1e293b; border: 1px solid #334155; border-radius: 4px; position: relative; display: flex; align-items: center; justify-content: center; text-align: center; padding: 2px; }
          .slot .item-name { font-size: 8px; color: #cbd5e1; word-break: break-all; line-height: 1; }
          .slot .item-count { position: absolute; bottom: 1px; right: 2px; font-size: 10px; font-weight: 800; color: #38bdf8; }

          /* Command Actions */
          .controls { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 18px; }
          button.quick-act { padding: 11px; border: none; border-radius: 6px; font-weight: bold; font-size: 13px; cursor: pointer; color: white; transition: 0.15s; }
          button.quick-act:active { transform: scale(0.97); }
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
            <div class="title">🎮 Nokar Web Control Center</div>
            <div class="badge">Online</div>
          </div>

          <!-- In-Game Chat Bar -->
          <div class="chat-section">
            <input type="text" id="chatMsg" class="chat-input" placeholder="Type message or /command...">
            <button class="chat-btn" onclick="sendChat()">Send</button>
          </div>

          <!-- Virtual D-Pad & Movements -->
          <div class="controller-wrapper">
            <div class="controller-title">🕹️ Movement Controller (Hold to Move)</div>
            <div class="dpad-grid">
              <div></div>
              <button class="ctrl-btn" onpointerdown="startMove('forward')" onpointerup="stopMove('forward')" onpointerleave="stopMove('forward')">⬆️</button>
              <div></div>
              
              <button class="ctrl-btn" onpointerdown="startMove('left')" onpointerup="stopMove('left')" onpointerleave="stopMove('left')">⬅️</button>
              <button class="ctrl-btn" onclick="triggerJump()">🦘</button>
              <button class="ctrl-btn" onpointerdown="startMove('right')" onpointerup="stopMove('right')" onpointerleave="stopMove('right')">➡️</button>
              
              <div></div>
              <button class="ctrl-btn" onpointerdown="startMove('back')" onpointerup="stopMove('back')" onpointerleave="stopMove('back')">⬇️</button>
              <div></div>
            </div>

            <div class="action-pad">
              <button class="action-ctrl btn-jump" onclick="triggerJump()">Jump</button>
              <button class="action-ctrl btn-sneak" id="sneakBtn" onclick="toggleSneak()">Sneak: OFF</button>
            </div>
          </div>

          <!-- 2D Radar Canvas -->
          <div class="radar-container">
            <canvas id="radarCanvas" width="300" height="300"></canvas>
            <div class="radar-legend">
              <div class="legend-item"><span class="dot" style="background:#22c55e;"></span> Bot</div>
              <div class="legend-item"><span class="dot" style="background:#38bdf8;"></span> Players</div>
              <div class="legend-item"><span class="dot" style="background:#ef4444;"></span> Mobs/Zombies</div>
            </div>
          </div>

          <!-- Stats -->
          <div class="meters">
            <div class="meter-card">
              <div class="meter-val health-txt" id="hp">20 / 20</div>
              <div style="font-size: 11px; color: #64748b;">❤️ Health</div>
            </div>
            <div class="meter-card">
              <div class="meter-val food-txt" id="food">20 / 20</div>
              <div style="font-size: 11px; color: #64748b;">🍖 Food</div>
            </div>
          </div>

          <div class="grid-title">Main Inventory</div>
          <div class="grid" id="mainGrid"></div>

          <div class="grid-title">Hotbar</div>
          <div class="grid" id="hotbarGrid"></div>

          <div class="controls">
            <button class="quick-act btn-farm" onclick="send('toggle_farm')" id="farmBtn">🌾 Auto Farm: OFF</button>
            <button class="quick-act btn-eat" onclick="send('toggle_eat')">🍖 Auto Eat</button>
            <button class="quick-act btn-build" onclick="send('build_house')">🏠 Build House</button>
            <button class="quick-act btn-drop" onclick="send('dropall')">📦 Drop All</button>
            <button class="quick-act btn-stop" onclick="send('stop')">🛑 Emergency Stop</button>
          </div>
        </div>

        <script>
          const socket = io();
          const canvas = document.getElementById('radarCanvas');
          const ctx = canvas.getContext('2d');
          const cX = canvas.width / 2;
          const cY = canvas.height / 2;
          const scale = 5;

          let farmOn = false;
          let isSneaking = false;
          const main = document.getElementById('mainGrid');
          const hotbar = document.getElementById('hotbarGrid');

          for (let i = 9; i <= 35; i++) main.innerHTML += '<div class="slot" id="s-' + i + '"></div>';
          for (let i = 36; i <= 44; i++) hotbar.innerHTML += '<div class="slot" id="s-' + i + '"></div>';

          // Movement Controls via Socket
          function startMove(dir) {
            socket.emit('control_move', { direction: dir, state: true });
          }

          function stopMove(dir) {
            socket.emit('control_move', { direction: dir, state: false });
          }

          function triggerJump() {
            socket.emit('control_jump');
          }

          function toggleSneak() {
            isSneaking = !isSneaking;
            document.getElementById('sneakBtn').innerText = 'Sneak: ' + (isSneaking ? 'ON' : 'OFF');
            document.getElementById('sneakBtn').style.background = isSneaking ? '#b45309' : '#d97706';
            socket.emit('control_sneak', { state: isSneaking });
          }

          function sendChat() {
            const input = document.getElementById('chatMsg');
            const msg = input.value.trim();
            if (msg) {
              socket.emit('send_chat', { message: msg });
              input.value = '';
            }
          }

          document.getElementById('chatMsg').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendChat();
          });

          // Render Radar
          socket.on('radar', data => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            [30, 60, 90, 120].forEach(r => {
              ctx.beginPath();
              ctx.arc(cX, cY, r, 0, Math.PI * 2);
              ctx.stroke();
            });

            data.entities.forEach(e => {
              const dx = (e.x - data.bot.x) * scale;
              const dz = (e.z - data.bot.z) * scale;
              const pX = cX + dx;
              const pY = cY + dz;

              if (pX >= 0 && pX <= canvas.width && pY >= 0 && pY <= canvas.height) {
                ctx.fillStyle = e.type === 'player' ? '#38bdf8' : '#ef4444';
                ctx.beginPath();
                ctx.arc(pX, pY, 4, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = '#94a3b8';
                ctx.font = '9px sans-serif';
                ctx.fillText(e.name || e.type, pX + 6, pY + 3);
              }
            });

            // Bot center
            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(cX, cY, 5, 0, Math.PI * 2);
            ctx.fill();

            // Heading pointer
            const headX = cX - Math.sin(data.bot.yaw) * 12;
            const headY = cY + Math.cos(data.bot.yaw) * 12;
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cX, cY);
            ctx.lineTo(headX, headY);
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

  // REST endpoints for autonomous triggers
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
      bot.clearControlStates();
      bot.pathfinder.stop();
      bot.pvp.stop();
      bot.collectBlock.cancelTask();
      botState.autoFarm = false;
      clearTimeout(botState.farmingInterval);
      bot.chat("Stopped all ongoing actions!");
    }
    res.json({ success: true });
  });

  // Real-time socket events for controller & chat
  io.on('connection', (socket) => {
    syncState();

    // Directional Movement Handler
    socket.on('control_move', (data) => {
      bot.setControlState(data.direction, !!data.state);
    });

    // Jump Handler
    socket.on('control_jump', () => {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 350);
    });

    // Sneak (Crouch) Handler
    socket.on('control_sneak', (data) => {
      bot.setControlState('sneak', !!data.state);
    });

    // Send Chat Handler
    socket.on('send_chat', (data) => {
      if (data && data.message) {
        bot.chat(data.message);
      }
    });

    // Reset controls when user leaves page
    socket.on('disconnect', () => {
      bot.clearControlStates();
    });
  });

  function syncState() {
    const items = bot.inventory.slots
      .map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null)
      .filter(Boolean);
    io.emit('sync', { hp: bot.health, food: bot.food, items });
  }

  // Live Radar loop
  setInterval(() => {
    if (!bot.entity) return;
    const nearby = [];
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e === bot.entity) continue;
      if (e.type === 'player' || e.type === 'mob') {
        const dist = bot.entity.position.distanceTo(e.position);
        if (dist <= 30) {
          nearby.push({
            name: e.username || e.displayName || e.name,
            type: e.type,
            x: e.position.x,
            z: e.position.z
          });
        }
      }
    }

    io.emit('radar', {
      bot: {
        x: bot.entity.position.x,
        z: bot.entity.position.z,
        yaw: bot.entity.yaw
      },
      entities: nearby
    });
  }, 500);

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
      console.log(`[AGENT JOINED] ${bot.username} active in world.`);
      try { webInventoryPlugin(bot, { port: WEB_PORT }); } catch (e) {}

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);

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

      if (cmd === 'come' || cmd === 'follow') {
        const player = bot.players[username]?.entity;
        botState.followingPlayer = username;
        if (player) {
          bot.chat(`Following @${username}!`);
          bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true);
        } else {
          bot.chat(`Tracking @${username}...`);
        }
      }
      else if (cmd === 'stop') {
        botState.followingPlayer = null;
        bot.clearControlStates();
        bot.pathfinder.stop();
        bot.pvp.stop();
        bot.collectBlock.cancelTask();
        botState.autoFarm = false;
        clearTimeout(botState.farmingInterval);
        bot.chat("Ruk gaya!");
      }
      else if (cmd === 'build' && args[1] === 'house') {
        executeHouseBuild(bot);
      }
      else if (cmd === 'craft' && args[1]) {
        const itemName = args[1].toLowerCase();
        const count = parseInt(args[2]) || 1;
        const itemObj = mcData.itemsByName[itemName];

        if (!itemObj) return bot.chat(`"${itemName}" valid nahi hai.`);

        const craftingTable = bot.findBlock({
          matching: mcData.blocksByName.crafting_table?.id,
          maxDistance: 4
        });

        const recipes = bot.recipesFor(itemObj.id, null, 1, craftingTable);
        if (!recipes.length) return bot.chat(`Mere paas "${itemName}" banane ka saman ya Crafting Table nahi hai.`);

        try {
          await bot.craft(recipes[0], count, craftingTable);
          bot.chat(`${count} ${itemName} craft kar liya!`);
        } catch (err) {
          bot.chat(`Craft error: ${err.message}`);
        }
      }
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
          bot.chat(`Error: ${e.message}`);
        }
      }
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
