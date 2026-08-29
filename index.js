/**
 * Master Autonomous Minecraft Companion (Interactive Attack, Mine, Place & AI)
 * Version: 17.0.0-Titan-Ultimate
 */

const http = require('http');
const express = require('express');
const socketIo = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { Client, GatewayIntentBits } = require('discord.js');

// Plugins
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;
const pvp = require('mineflayer-pvp').plugin;

// Global Autonomous States
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
 * Native Gemini AI Function
 */
async function askAiBrain(promptText, botStatus) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "Boss, API Key set nahi hai!";

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
    const userPrompt = `You are 'Nokar', an intelligent, casual Minecraft companion. Respond in Hinglish under 20 words. Bot Status -> HP: ${botStatus.hp}/20. Message: "${promptText}"`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: userPrompt }] }] })
    });

    const data = await response.json();
    if (data.error) return `AI Error: ${data.error.message.substring(0, 40)}`;
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return reply ? reply.trim() : "Haan sun raha hoon!";
  } catch (err) {
    return "Network issue aa gaya!";
  }
}

/**
 * Discord Setup
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
  discordClient.login(DISCORD_TOKEN).catch(err => console.error('[DISCORD ERROR]', err.message));
  discordClient.once('ready', async () => {
    if (DISCORD_CHANNEL_ID) {
      discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
      if (discordChannel) discordChannel.send('🟢 **Titan Assistant Online!**');
    }
  });
}

/**
 * Combat & Utilities
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
  if (!type) return;

  const tools = items.filter(i => i.name.includes(type));
  if (tools.length) { try { await bot.equip(tools[0], 'hand'); } catch (e) {} }
}

function startAntiAfk(bot) {
  botState.antiAfk = true;
  bot.chat("Anti-AFK Wander ON!");
  const homePos = bot.entity.position.clone();

  botState.antiAfkInterval = setInterval(async () => {
    if (!botState.antiAfk || botState.followingPlayer || botState.guardMode) return;
    try {
      const dx = Math.floor(Math.random() * 10) - 5;
      const dz = Math.floor(Math.random() * 10) - 5;
      bot.setControlState('jump', Math.random() > 0.5);
      setTimeout(() => bot.setControlState('jump', false), 300);
      await bot.pathfinder.goto(new goals.GoalNear(homePos.x + dx, homePos.y, homePos.z + dz, 1));
    } catch (e) {}
  }, 4500);
}

function stopAntiAfk(bot) {
  botState.antiAfk = false;
  if (botState.antiAfkInterval) clearInterval(botState.antiAfkInterval);
  bot.clearControlStates();
}

function startGuardMode(bot) {
  botState.guardMode = true;
  botState.guardOrigin = bot.entity.position.clone();
  bot.chat("🛡️ Guard Mode Active!");

  botState.guardInterval = setInterval(async () => {
    if (!botState.guardMode) return;
    const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'drowned', 'husk'];
    const target = bot.nearestEntity(e => {
      if (e.type !== 'mob') return false;
      const name = e.name?.toLowerCase() || '';
      return hostiles.some(h => name.includes(h)) && bot.entity.position.distanceTo(e.position) < 16;
    });

    if (target) {
      await equipBestWeapon(bot);
      bot.pvp.attack(target);
    } else {
      if (botState.guardOrigin && bot.entity.position.distanceTo(botState.guardOrigin) > 6) {
        bot.pathfinder.setGoal(new goals.GoalNear(botState.guardOrigin.x, botState.guardOrigin.y, botState.guardOrigin.z, 1));
      }
    }
  }, 800);
}

function stopGuardMode(bot) {
  botState.guardMode = false;
  if (botState.guardInterval) clearInterval(botState.guardInterval);
  bot.pvp.stop();
}

/**
 * Web Operations Center
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
        <title>Nokar Bot Console</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        <script src="/socket.io/socket.io.js"></script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
          body { font-family: sans-serif; background: #070a13; color: #e2e8f0; display: flex; justify-content: center; padding: 12px; }
          .panel { width: 100%; max-width: 680px; background: #111827; border-radius: 12px; border: 1px solid #1f2937; padding: 16px; }
          .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
          .title { font-size: 18px; font-weight: bold; color: #38bdf8; }
          
          .chat-box { display: flex; gap: 6px; margin-bottom: 12px; }
          .chat-input { flex: 1; padding: 10px; background: #030712; border: 1px solid #374151; border-radius: 6px; color: #fff; outline: none; }
          .chat-btn { background: #0284c7; padding: 10px 14px; border: none; border-radius: 6px; color: white; font-weight: bold; cursor: pointer; }
          
          .ctrl-wrapper { background: #030712; border: 1px solid #1f2937; border-radius: 10px; padding: 12px; margin-bottom: 12px; display: flex; flex-direction: column; align-items: center; }
          .dpad { display: grid; grid-template-columns: repeat(3, 48px); grid-template-rows: repeat(3, 48px); gap: 6px; margin-bottom: 12px; }
          .ctrl-btn { background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; font-size: 16px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
          .ctrl-btn:active { background: #0284c7; }
          
          .manual-actions { display: flex; gap: 8px; width: 100%; justify-content: center; margin-bottom: 6px; }
          .action-btn { padding: 10px; border-radius: 6px; border: none; font-weight: bold; cursor: pointer; color: white; flex: 1; font-size: 13px; }
          .action-btn:active { transform: scale(0.95); }

          .action-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 12px; }
          .act-btn { padding: 10px; border: none; border-radius: 6px; font-weight: bold; color: white; font-size: 12px; cursor: pointer; }
          .btn-afk { background: #6366f1; } .btn-guard { background: #dc2626; } .btn-chest { background: #d97706; } .btn-drop { background: #e11d48; }
          .btn-stop { background: #991b1b; grid-column: span 2; }
          
          .radar-card { display: flex; flex-direction: column; align-items: center; background: #030712; border-radius: 8px; border: 1px solid #1f2937; padding: 8px; margin-bottom: 12px; }
          canvas { background: #050811; border-radius: 6px; border: 1px solid #374151; }
          
          .meters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
          .meter { background: #030712; padding: 8px; border-radius: 6px; text-align: center; border: 1px solid #1f2937; }
          .meter-val { font-size: 16px; font-weight: bold; }
          
          .hint { font-size: 11px; color: #9ca3af; margin: 4px 0 6px; text-align: center; }
          .grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px; background: #030712; padding: 8px; border-radius: 8px; }
          .slot { aspect-ratio: 1; background: #1f2937; border: 1px solid #374151; border-radius: 4px; position: relative; display: flex; align-items: center; justify-content: center; text-align: center; cursor: pointer; }
          .slot:active { border-color: #38bdf8; transform: scale(0.96); }
          .slot .item-name { font-size: 7px; color: #cbd5e1; word-break: break-all; line-height: 1; }
          .slot .item-count { position: absolute; bottom: 1px; right: 2px; font-size: 9px; font-weight: bold; color: #38bdf8; }
        </style>
      </head>
      <body>
        <div class="panel">
          <div class="top-bar">
            <div class="title">🎮 Titan Web Operations</div>
            <div style="font-size:12px; color:#22c55e;">● Live Connected</div>
          </div>
          
          <div class="chat-box">
            <input type="text" id="chatMsg" class="chat-input" placeholder="Type chat or command...">
            <button class="chat-btn" onclick="sendChat()">Send</button>
          </div>

          <div class="ctrl-wrapper">
            <div class="dpad">
              <div></div><button class="ctrl-btn" onpointerdown="startMove('forward')" onpointerup="stopMove('forward')">⬆️</button><div></div>
              <button class="ctrl-btn" onpointerdown="startMove('left')" onpointerup="stopMove('left')">⬅️</button>
              <button class="ctrl-btn" onclick="jump()">🦘</button>
              <button class="ctrl-btn" onpointerdown="startMove('right')" onpointerup="stopMove('right')">➡️</button>
              <div></div><button class="ctrl-btn" onpointerdown="startMove('back')" onpointerup="stopMove('back')">⬇️</button><div></div>
            </div>
            
            <div class="manual-actions">
              <button class="action-btn" style="background:#b91c1c;" onclick="socket.emit('manual_action', 'attack')">⚔️ Attack</button>
              <button class="action-btn" style="background:#57534e;" onclick="socket.emit('manual_action', 'mine')">⛏️ Mine</button>
              <button class="action-btn" style="background:#854d0e;" onclick="socket.emit('manual_action', 'place')">🧱 Place</button>
            </div>
          </div>

          <div class="action-grid">
            <button class="act-btn btn-guard" id="guardBtn" onclick="send('toggle_guard')">🛡️ Bodyguard: OFF</button>
            <button class="act-btn btn-afk" id="afkBtn" onclick="send('toggle_afk')">🚶 Anti-AFK: OFF</button>
            <button class="act-btn btn-chest" onclick="send('dump_chest')">📦 Dump to Chest</button>
            <button class="act-btn btn-drop" onclick="send('drop_hand')">🗑️ Drop Hand Item</button>
            <button class="act-btn btn-stop" onclick="send('stop')">🛑 Stop All Actions</button>
          </div>

          <div class="radar-card">
            <canvas id="radarCanvas" width="260" height="260"></canvas>
          </div>

          <div class="meters">
            <div class="meter"><div class="meter-val" style="color:#f43f5e;" id="hp">20 / 20</div><div style="font-size:11px;">❤️ Health</div></div>
            <div class="meter"><div class="meter-val" style="color:#fbbf24;" id="food">20 / 20</div><div style="font-size:11px;">🍖 Hunger</div></div>
          </div>

          <div class="hint">👉 <b>Click slot</b>: Equip in Hand | <b>Double Click</b>: Drop item</div>
          <div style="font-size:11px; margin-bottom:4px; color:#9ca3af;">Hotbar</div>
          <div class="grid" id="hotbarGrid"></div>
          <div style="font-size:11px; margin: 8px 0 4px; color:#9ca3af;">Main Inventory</div>
          <div class="grid" id="mainGrid"></div>
        </div>

        <script>
          const socket = io();
          const canvas = document.getElementById('radarCanvas');
          const ctx = canvas.getContext('2d');
          const cX = canvas.width / 2, cY = canvas.height / 2, scale = 5;

          const main = document.getElementById('mainGrid');
          const hotbar = document.getElementById('hotbarGrid');

          for (let i = 36; i <= 44; i++) hotbar.innerHTML += '<div class="slot" id="s-' + i + '" onclick="slotClick(' + i + ')" ondblclick="slotDrop(' + i + ')"></div>';
          for (let i = 9; i <= 35; i++) main.innerHTML += '<div class="slot" id="s-' + i + '" onclick="slotClick(' + i + ')" ondblclick="slotDrop(' + i + ')"></div>';

          function slotClick(slotId) { socket.emit('equip_slot', { slot: slotId }); }
          function slotDrop(slotId) { socket.emit('drop_slot', { slot: slotId }); }

          function startMove(dir) { socket.emit('control_move', { direction: dir, state: true }); }
          function stopMove(dir) { socket.emit('control_move', { direction: dir, state: false }); }
          function jump() { socket.emit('control_jump'); }

          function sendChat() {
            const input = document.getElementById('chatMsg');
            if (input.value.trim()) { socket.emit('send_chat', { message: input.value.trim() }); input.value = ''; }
          }
          document.getElementById('chatMsg').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });

          socket.on('radar', data => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = '#1f2937';
            [25, 55, 85, 115].forEach(r => { ctx.beginPath(); ctx.arc(cX, cY, r, 0, Math.PI * 2); ctx.stroke(); });

            data.entities.forEach(e => {
              const pX = cX + (e.x - data.bot.x) * scale;
              const pY = cY + (e.z - data.bot.z) * scale;
              if (pX >= 0 && pX <= canvas.width && pY >= 0 && pY <= canvas.height) {
                ctx.fillStyle = e.type === 'player' ? '#38bdf8' : '#ef4444';
                ctx.beginPath(); ctx.arc(pX, pY, 4, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#f8fafc';
                ctx.font = '9px sans-serif';
                ctx.fillText(e.name, pX + 5, pY + 3);
              }
            });

            ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.arc(cX, cY, 5, 0, Math.PI * 2); ctx.fill();
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
            fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act }) })
            .then(r => r.json()).then(d => {
              if (act === 'toggle_afk') document.getElementById('afkBtn').innerText = '🚶 Anti-AFK: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_guard') document.getElementById('guardBtn').innerText = '🛡️ Bodyguard: ' + (d.state ? 'ON' : 'OFF');
            });
          }
        </script>
      </body>
      </html>
    `);
  });

  app.post('/api/action', async (req, res) => {
    const act = req.body.action;
    if (act === 'toggle_afk') { botState.antiAfk ? stopAntiAfk(bot) : startAntiAfk(bot); return res.json({ success: true, state: botState.antiAfk }); }
    if (act === 'toggle_guard') { botState.guardMode ? stopGuardMode(bot) : startGuardMode(bot); return res.json({ success: true, state: botState.guardMode }); }
    if (act === 'dump_chest') {
      const mcData = require('minecraft-data')(bot.version);
      const chest = bot.findBlock({ matching: [mcData.blocksByName.chest?.id, mcData.blocksByName.barrel?.id].filter(Boolean), maxDistance: 6 });
      if (chest) {
        try { const w = await bot.openChest(chest); for (const item of bot.inventory.items()) { await w.deposit(item.type, null, item.count); } w.close(); } catch (e) {}
      }
      return res.json({ success: true });
    }
    if (act === 'drop_hand') { const held = bot.heldItem; if (held) bot.tossStack(held).catch(() => {}); return res.json({ success: true }); }
    if (act === 'stop') {
      botState.followingPlayer = null; stopAntiAfk(bot); stopGuardMode(bot); bot.clearControlStates(); bot.pathfinder.stop(); bot.pvp.stop();
      return res.json({ success: true });
    }
    res.json({ success: false });
  });

  io.on('connection', (socket) => {
    syncState();
    socket.on('control_move', data => bot.setControlState(data.direction, !!data.state));
    socket.on('control_jump', () => { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 350); });
    
    // Web Inventory Interactions
    socket.on('equip_slot', async data => { const item = bot.inventory.slots[data.slot]; if (item) { try { await bot.equip(item, 'hand'); } catch (e) {} } });
    socket.on('drop_slot', async data => { const item = bot.inventory.slots[data.slot]; if (item) { try { await bot.tossStack(item); } catch (e) {} } });
    
    // Manual Combat & Mining Actions
    socket.on('manual_action', async type => {
      if (type === 'attack') {
        const target = bot.nearestEntity(e => (e.type === 'mob' || e.type === 'player') && bot.entity.position.distanceTo(e.position) <= 4);
        if (target) bot.attack(target);
        else bot.swingArm();
      } else if (type === 'mine') {
        const targetBlock = bot.blockAtCursor(4);
        if (targetBlock && targetBlock.name !== 'air') {
          try { await bot.dig(targetBlock); } catch (e) {}
        }
      } else if (type === 'place') {
        const refBlock = bot.blockAtCursor(4);
        if (refBlock && refBlock.name !== 'air') {
          try { await bot.placeBlock(refBlock, new Vec3(0, 1, 0)); } catch (e) {}
        }
      }
    });

    socket.on('send_chat', async data => {
      if (data && data.message) {
        const reply = await askAiBrain(data.message, { hp: bot.health });
        bot.chat(reply);
      }
    });
    socket.on('disconnect', () => bot.clearControlStates());
  });

  function syncState() {
    const items = bot.inventory.slots.map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null).filter(Boolean);
    io.emit('sync', { hp: bot.health, food: bot.food, items });
  }

  setInterval(() => {
    if (!bot.entity) return;
    const nearby = [];
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity) continue;
      if (e.type === 'player' || e.type === 'mob') {
        if (bot.entity.position.distanceTo(e.position) <= 24) { nearby.push({ name: e.username || e.name || e.type, type: e.type, x: e.position.x, z: e.position.z }); }
      }
    }
    io.emit('radar', { bot: { x: bot.entity.position.x, z: bot.entity.position.z }, entities: nearby });
  }, 500);

  bot.inventory.on('updateSlot', () => syncState());
  bot.on('health', () => syncState());
  server.listen(port, () => console.log(`[DASHBOARD READY] Port ${port}`));
}

/**
 * Main Daemon Lifecycle
 */
if (require.main === module) {
  function launchBot() {
    const HOST_ENDPOINT = process.argv[2] || 'DG_LAND502.aternos.me';
    const PORT_ENDPOINT = parseInt(process.argv[3], 10) || 62974;
    const BOT_IDENTITY = process.argv[4] || 'Nokar';
    const WEB_PORT = process.env.PORT || 3000;

    const bot = mineflayer.createBot({
      host: HOST_ENDPOINT, port: PORT_ENDPOINT, username: BOT_IDENTITY, checkTimeoutInterval: 120000, version: false
    });

    bot.loadPlugin(pathfinder); bot.loadPlugin(collectBlock); bot.loadPlugin(autoEat); bot.loadPlugin(pvp);

    bot.once('spawn', () => {
      console.log(`[AGENT LIVE] ${bot.username} entered world.`);
      try { webInventoryPlugin(bot, { port: WEB_PORT }); } catch (e) {}
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowParkour = true; defaultMove.canDig = false; defaultMove.allow1by1towers = false;
      bot.pathfinder.setMovements(defaultMove);
      bot.autoEat.options = { priority: 'foodPoints', startAt: 14 };
    });

    bot.on('physicsTick', () => {
      if (!botState.followingPlayer) return;
      const target = bot.players[botState.followingPlayer]?.entity;
      if (target) { bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); }
    });

    bot.on('chat', async (username, message) => {
      if (username === bot.username) return;
      if (discordChannel) discordChannel.send(`**<${username}>** ${message}`).catch(() => {});

      const args = message.trim().split(/\s+/);
      const cmd = args[0].toLowerCase();
      const mcData = require('minecraft-data')(bot.version);

      if (cmd === 'come' || cmd === 'follow') {
        stopAntiAfk(bot); botState.followingPlayer = username;
        const player = bot.players[username]?.entity;
        if (player) {
          bot.chat(`Aapke paas aa raha hoon @${username}!`);
          const defaultMove = new Movements(bot, mcData);
          bot.pathfinder.setMovements(defaultMove);
          bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true);
        } else { bot.chat(`Aapki location scan kar raha hoon @${username}...`); }
      }
      else if (cmd === 'stop') { botState.followingPlayer = null; stopAntiAfk(bot); stopGuardMode(bot); bot.clearControlStates(); bot.pathfinder.stop(); bot.pvp.stop(); bot.chat("Ruk gaya!"); }
      else if (cmd === 'guard') { botState.guardMode ? stopGuardMode(bot) : startGuardMode(bot); }
      else if (cmd === 'afk') { botState.antiAfk ? stopAntiAfk(bot) : startAntiAfk(bot); }
      else if (cmd === 'dropall') { for (const item of bot.inventory.items()) { try { await bot.tossStack(item); } catch (e) {} } bot.chat("Sari inventory drop kar di!"); }
      else {
        if (message.toLowerCase().includes('nokar') || message.toLowerCase().includes('bot')) {
          const reply = await askAiBrain(message, { hp: bot.health });
          bot.chat(reply);
        }
      }
    });

    bot.on('end', () => setTimeout(launchBot, 10000));
    bot.on('error', (err) => console.error('[ERROR]', err.message));
  }

  launchBot();
}
