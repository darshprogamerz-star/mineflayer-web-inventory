/**
 * TITAN AUTONOMOUS COMPANION - V22.0.0 (X-RAY RADAR + DIRECTION & DISTANCE)
 * Features:
 * - 2D Live Radar with Directions (N, S, E, W) & Distance in Blocks
 * - Ores & Chest Detector (Diamond, Ancient Debris, Iron, Gold, Chests)
 * - Live Text Tracker (Shows nearest items with Block Distance & Y-level)
 * - Gemini 2.5 Flash AI Engine
 * - Interactive Inventory (Equip / Drop) + Manual Combat (Attack, Mine, Place)
 */

const http = require('http');
const express = require('express');
const socketIo = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { Client, GatewayIntentBits } = require('discord.js');

const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;

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
 * AI Brain (Gemini 2.5 Flash with Fallback)
 */
async function askAiBrain(promptText, botStatus) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "Boss, API Key set nahi hai!";

  const cleanKey = apiKey.trim();
  const models = ['gemini-2.5-flash', 'gemini-flash-latest'];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
      const userPrompt = `You are 'Nokar', an intelligent Minecraft companion. Reply in short Hinglish under 20 words. User says: "${promptText}"`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userPrompt }] }]
        })
      });

      const data = await response.json();
      if (!data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text.trim();
      }
    } catch (e) {}
  }

  return "Haan boss, sun raha hoon bolo!";
}

/**
 * Discord Setup
 */
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
let discordChannel = null;

if (DISCORD_TOKEN) {
  discordClient.login(DISCORD_TOKEN).catch(() => {});
  discordClient.once('ready', async () => {
    if (DISCORD_CHANNEL_ID) {
      discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
      if (discordChannel) discordChannel.send('🟢 **Titan Bot Live!**');
    }
  });
}

/**
 * Utilities & Combat
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

function startGuardMode(bot) {
  botState.guardMode = true;
  botState.guardOrigin = bot.entity.position.clone();
  bot.chat("🛡️ Guard Mode Active!");

  botState.guardInterval = setInterval(async () => {
    if (!botState.guardMode) return;
    const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'drowned', 'husk', 'enderman'];
    const target = bot.nearestEntity(e => {
      if (e.type !== 'mob') return false;
      const name = (e.name || '').toLowerCase();
      return hostiles.some(h => name.includes(h)) && bot.entity.position.distanceTo(e.position) <= 16;
    });

    if (target) {
      await equipBestWeapon(bot);
      const dist = bot.entity.position.distanceTo(target.position);
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), false);
      if (dist <= 3.8) {
        await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.75 : 1, 0));
        bot.attack(target);
      }
    } else if (botState.guardOrigin && bot.entity.position.distanceTo(botState.guardOrigin) > 6) {
      bot.pathfinder.setGoal(new goals.GoalNear(botState.guardOrigin.x, botState.guardOrigin.y, botState.guardOrigin.z, 2));
    }
  }, 400);
}

function stopGuardMode(bot) {
  botState.guardMode = false;
  if (botState.guardInterval) clearInterval(botState.guardInterval);
  bot.pathfinder.stop();
}

function startAntiAfk(bot) {
  botState.antiAfk = true;
  bot.chat("🚶 Anti-AFK ON!");
  const homePos = bot.entity.position.clone();

  botState.antiAfkInterval = setInterval(async () => {
    if (!botState.antiAfk || botState.followingPlayer || botState.guardMode) return;
    try {
      const dx = Math.floor(Math.random() * 12) - 6;
      const dz = Math.floor(Math.random() * 12) - 6;
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

async function dumpToChest(bot) {
  const mcData = require('minecraft-data')(bot.version);
  const chestBlock = bot.findBlock({
    matching: [mcData.blocksByName.chest?.id, mcData.blocksByName.trapped_chest?.id, mcData.blocksByName.barrel?.id].filter(Boolean),
    maxDistance: 6
  });
  if (!chestBlock) return bot.chat("Paas me Chest nahi mila!");
  bot.chat("Saman deposit kar raha hoon...");
  try {
    const chest = await bot.openChest(chestBlock);
    for (const item of bot.inventory.items()) {
      if (item.name.includes('sword') || item.name.includes('pickaxe') || item.name.includes('helmet') || item.name.includes('chestplate')) continue;
      try { await chest.deposit(item.type, null, item.count); await bot.waitForTicks(2); } catch (e) {}
    }
    chest.close();
    bot.chat("Deposit complete!");
  } catch (err) { bot.chat(`Chest error: ${err.message}`); }
}

async function executeHouseBuild(bot) {
  const getBuildBlock = () => bot.inventory.items().find(i => i.name.includes('plank') || i.name.includes('cobble') || i.name.includes('stone') || i.name.includes('dirt'));
  if (!getBuildBlock()) return bot.chat("Blocks nahi hain!");
  bot.chat("House banana shuru...");
  const start = bot.entity.position.floored().offset(1, 0, 1);
  const placeList = [];

  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        if (x === 0 || x === 3 || z === 0 || z === 3) {
          if (x === 1 && z === 0 && (y === 0 || y === 1)) continue;
          placeList.push(start.offset(x, y, z));
        }
      }
    }
  }
  for (let x = 0; x < 4; x++) { for (let z = 0; z < 4; z++) placeList.push(start.offset(x, 3, z)); }

  for (const pos of placeList) {
    if (bot.blockAt(pos)?.name !== 'air') continue;
    const blockItem = getBuildBlock();
    if (!blockItem) return bot.chat("Blocks khatam!");
    try {
      await bot.equip(blockItem, 'hand');
      if (bot.entity.position.distanceTo(pos) > 4.5) await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)).catch(() => {});
      const ref = [pos.offset(0,-1,0), pos.offset(1,0,0), pos.offset(-1,0,0), pos.offset(0,0,1), pos.offset(0,0,-1)].map(p => bot.blockAt(p)).find(b => b && b.name !== 'air');
      if (ref) { await bot.lookAt(pos); await bot.placeBlock(ref, pos.minus(ref.position)).catch(() => {}); await bot.waitForTicks(3); }
    } catch (e) {}
  }
  bot.chat("House ready!");
}

async function runFarmLoop(bot) {
  if (!botState.autoFarm) return;
  const mcData = require('minecraft-data')(bot.version);
  const cropIds = ['wheat', 'carrots', 'potatoes', 'beetroots'].map(n => mcData.blocksByName[n]?.id).filter(Boolean);
  const mature = bot.findBlocks({ matching: b => cropIds.includes(b.type) && b.metadata === 7, maxDistance: 32, count: 5 });
  if (mature.length > 0) {
    try {
      await bot.collectBlock.collect(mature.map(p => bot.blockAt(p)));
      for (const p of mature) {
        const soil = bot.blockAt(p.offset(0, -1, 0));
        const seed = bot.inventory.items().find(i => i.name.includes('seeds') || i.name === 'carrot' || i.name === 'potato');
        if (soil?.name === 'farmland' && seed) { await bot.equip(seed, 'hand'); await bot.placeBlock(soil, new Vec3(0, 1, 0)).catch(() => {}); await bot.waitForTicks(2); }
      }
    } catch (e) {}
  }
  if (botState.autoFarm) botState.farmingInterval = setTimeout(() => runFarmLoop(bot), 4000);
}

/**
 * Web Operations Center with Enhanced Radar & Direction HUD
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
        <title>Titan Radar Console</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        <script src="/socket.io/socket.io.js"></script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
          body { font-family: -apple-system, sans-serif; background: #070a13; color: #e2e8f0; display: flex; justify-content: center; padding: 10px; }
          .panel { width: 100%; max-width: 650px; background: #111827; border-radius: 12px; border: 1px solid #1f2937; padding: 14px; }
          .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
          .title { font-size: 18px; font-weight: bold; color: #38bdf8; }
          
          .chat-box { display: flex; gap: 6px; margin-bottom: 12px; }
          .chat-input { flex: 1; padding: 10px; background: #030712; border: 1px solid #374151; border-radius: 6px; color: #fff; outline: none; }
          .chat-btn { background: #0284c7; padding: 10px 14px; border: none; border-radius: 6px; color: white; font-weight: bold; cursor: pointer; }
          
          .ctrl-wrapper { background: #030712; border: 1px solid #1f2937; border-radius: 10px; padding: 12px; margin-bottom: 12px; display: flex; flex-direction: column; align-items: center; }
          .dpad { display: grid; grid-template-columns: repeat(3, 48px); grid-template-rows: repeat(3, 48px); gap: 6px; margin-bottom: 10px; }
          .ctrl-btn { background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: white; font-size: 16px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
          .ctrl-btn:active { background: #0284c7; }
          
          .manual-actions { display: flex; gap: 8px; width: 100%; justify-content: center; margin-bottom: 6px; }
          .manual-btn { padding: 10px; border-radius: 6px; border: none; font-weight: bold; cursor: pointer; color: white; flex: 1; font-size: 13px; }
          
          .action-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 12px; }
          .act-btn { padding: 10px; border: none; border-radius: 6px; font-weight: bold; color: white; font-size: 12px; cursor: pointer; }
          .btn-guard { background: #dc2626; } .btn-afk { background: #6366f1; } .btn-chest { background: #d97706; } .btn-fish { background: #0891b2; } .btn-farm { background: #059669; } .btn-build { background: #2563eb; } .btn-drop { background: #e11d48; } .btn-stop { background: #991b1b; grid-column: span 2; }
          
          .radar-card { display: flex; flex-direction: column; align-items: center; background: #030712; border-radius: 8px; border: 1px solid #1f2937; padding: 10px; margin-bottom: 12px; }
          #radarCanvas { background: #050811; border-radius: 6px; border: 1px solid #374151; width: 280px; height: 280px; display: block; }
          .radar-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; font-size: 11px; margin-top: 8px; color: #9ca3af; }
          .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
          
          .radar-list { width: 100%; max-height: 120px; overflow-y: auto; background: #0f172a; border-radius: 6px; padding: 8px; margin-top: 8px; font-size: 11px; border: 1px solid #1e293b; }
          .radar-item { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #1e293b; }
          
          .meters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
          .meter { background: #030712; padding: 8px; border-radius: 6px; text-align: center; border: 1px solid #1f2937; }
          .meter-val { font-size: 16px; font-weight: bold; }
          
          .grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px; background: #030712; padding: 8px; border-radius: 8px; }
          .slot { aspect-ratio: 1; background: #1f2937; border: 1px solid #374151; border-radius: 4px; position: relative; display: flex; align-items: center; justify-content: center; text-align: center; cursor: pointer; }
          .slot:active { border-color: #38bdf8; background: #1e293b; }
          .item-name { font-size: 7px; color: #cbd5e1; word-break: break-all; line-height: 1; }
          .item-count { position: absolute; bottom: 1px; right: 2px; font-size: 9px; font-weight: bold; color: #38bdf8; }
        </style>
      </head>
      <body>
        <div class="panel">
          <div class="top-bar">
            <div class="title">🎮 Titan Radar Console</div>
            <div style="font-size:12px; color:#22c55e;">● Connected</div>
          </div>
          
          <div class="chat-box">
            <input type="text" id="chatMsg" class="chat-input" placeholder="Chat or command...">
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
            <button class="act-btn btn-drop" onclick="send('drop_hand')">🗑️ Drop Hand</button>
            <button class="act-btn btn-stop" onclick="send('stop')">🛑 Stop All</button>
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
              <div style="color:#64748b; text-align:center;">Scanning nearby area...</div>
            </div>
          </div>

          <div class="meters">
            <div class="meter"><div class="meter-val" style="color:#f43f5e;" id="hp">20 / 20</div><div style="font-size:11px;">❤️ Health</div></div>
            <div class="meter"><div class="meter-val" style="color:#fbbf24;" id="food">20 / 20</div><div style="font-size:11px;">🍖 Hunger</div></div>
          </div>

          <div style="font-size:11px; margin-bottom:4px; color:#9ca3af;">Hotbar</div>
          <div class="grid" id="hotbarGrid"></div>
          <div style="font-size:11px; margin: 8px 0 4px; color:#9ca3af;">Main Inventory</div>
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
            if (input.value.trim()) { socket.emit('send_chat', { message: input.value.trim() }); input.value = ''; }
          }
          document.getElementById('chatMsg').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });

          socket.on('radar', data => {
            ctx.clearRect(0, 0, 280, 280);

            // Radar Background Rings
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            [35, 70, 105].forEach(r => { ctx.beginPath(); ctx.arc(cX, cY, r, 0, Math.PI * 2); ctx.stroke(); });

            // Crosshair
            ctx.strokeStyle = '#0f172a';
            ctx.beginPath(); ctx.moveTo(cX, 0); ctx.lineTo(cX, 280); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, cY); ctx.lineTo(280, cY); ctx.stroke();

            // Cardinal Direction Markers
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

              // Calculate Cardinal Direction
              let dir = '';
              if (dz < -2) dir += 'North ';
              else if (dz > 2) dir += 'South ';
              if (dx > 2) dir += 'East';
              else if (dx < -2) dir += 'West';
              if (!dir) dir = 'Near';

              // Color Logic
              let color = '#38bdf8';
              if (e.type === 'mob') color = '#ef4444';
              else if (e.type === 'chest') color = '#eab308';
              else if (e.type === 'rare_ore') color = '#06b6d4';
              else if (e.type === 'common_ore') color = '#f97316';

              // Canvas Draw
              if (pX >= 4 && pX <= 276 && pY >= 4 && pY <= 276) {
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(pX, pY, e.type.includes('ore') || e.type === 'chest' ? 3.5 : 4.5, 0, Math.PI * 2);
                ctx.fill();

                // Draw Distance Label on Radar
                ctx.fillStyle = '#f8fafc';
                ctx.font = '8px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(e.name + ' [' + dist + 'm]', pX + 5, pY + 3);
              }

              // Build HTML List Item
              listHTML += '<div class="radar-item">' +
                '<span style="color:' + color + '">● ' + e.name + '</span>' +
                '<span style="color:#94a3b8">' + dist + ' blocks ' + dir + (e.y !== undefined ? ' (Y:' + Math.round(e.y) + ')' : '') + '</span>' +
                '</div>';
            });

            document.getElementById('radarList').innerHTML = listHTML || '<div style="color:#64748b; text-align:center;">No targets nearby</div>';

            // Center Bot
            ctx.fillStyle = '#22c55e';
            ctx.beginPath(); ctx.arc(cX, cY, 5, 0, Math.PI * 2); ctx.fill();
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
              } else { el.innerHTML = ''; el.style.background = '#111827'; }
            }
          });

          function send(act) {
            fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act }) })
            .then(r => r.json()).then(d => {
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
    if (act === 'toggle_afk') { botState.antiAfk ? stopAntiAfk(bot) : startAntiAfk(bot); return res.json({ success: true, state: botState.antiAfk }); }
    if (act === 'toggle_guard') { botState.guardMode ? stopGuardMode(bot) : startGuardMode(bot); return res.json({ success: true, state: botState.guardMode }); }
    if (act === 'toggle_fish') { botState.isFishing ? stopFishing(bot) : startFishing(bot); return res.json({ success: true, state: botState.isFishing }); }
    if (act === 'toggle_farm') {
      botState.autoFarm = !botState.autoFarm;
      if (botState.autoFarm) runFarmLoop(bot); else clearTimeout(botState.farmingInterval);
      return res.json({ success: true, state: botState.autoFarm });
    }
    if (act === 'build_house') { executeHouseBuild(bot); return res.json({ success: true }); }
    if (act === 'dump_chest') { dumpToChest(bot); return res.json({ success: true }); }
    if (act === 'drop_hand') { const held = bot.heldItem; if (held) bot.tossStack(held).catch(() => {}); return res.json({ success: true }); }
    if (act === 'stop') {
      botState.followingPlayer = null; stopAntiAfk(bot); stopGuardMode(bot);
      botState.autoFarm = false; clearTimeout(botState.farmingInterval);
      bot.clearControlStates(); bot.pathfinder.stop(); bot.collectBlock.cancelTask();
      bot.chat("Ruk gaya!");
      return res.json({ success: true });
    }
    res.json({ success: false });
  });

  io.on('connection', (socket) => {
    syncState();
    socket.on('control_move', data => bot.setControlState(data.direction, !!data.state));
    socket.on('control_jump', () => { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 350); });
    socket.on('equip_slot', async data => { const item = bot.inventory.slots[data.slot]; if (item) { try { await bot.equip(item, 'hand'); } catch (e) {} } });
    socket.on('drop_slot', async data => { const item = bot.inventory.slots[data.slot]; if (item) { try { await bot.tossStack(item); } catch (e) {} } });
    
    socket.on('manual_action', async type => {
      if (type === 'attack') {
        const target = bot.nearestEntity(e => (e.type === 'mob' || e.type === 'player') && bot.entity.position.distanceTo(e.position) <= 4.5);
        if (target) {
          await equipBestWeapon(bot);
          await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.75 : 1, 0));
          bot.attack(target);
        } else bot.swingArm();
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
        if (msg.startsWith('!')) bot.chat(msg);
        else {
          const reply = await askAiBrain(msg, { hp: bot.health });
          bot.chat(reply);
        }
      }
    });
    socket.on('disconnect', () => bot.clearControlStates());
  });

  function syncState() {
    const items = bot.inventory.slots.map((item, index) => item ? { slot: index, name: item.name, count: item.count } : null).filter(Boolean);
    io.emit('sync', { hp: bot.health, food: bot.food, items });
  }

  // Scan Nearby Entities, Chests, and Ores
  setInterval(() => {
    if (!bot.entity) return;
    const nearby = [];
    const mcData = require('minecraft-data')(bot.version);

    // 1. Entities Scan (Players & Mobs)
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

    // 2. Chests & Barrels Scan (Max 16 blocks radius)
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

      // 3. Rare & Common Ores Scan
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

    io.emit('radar', { bot: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }, entities: nearby });
  }, 400);

  bot.inventory.on('updateSlot', () => syncState());
  bot.on('health', () => syncState());
  server.listen(port, () => console.log(`[DASHBOARD READY] Port ${port}`));
}

/**
 * Main Daemon
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
      console.log(`[AGENT LIVE] ${bot.username} entered world.`);
      try { webInventoryPlugin(bot, { port: WEB_PORT }); } catch (e) {}

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowParkour = true;
      defaultMove.canDig = true;
      defaultMove.allow1by1towers = true;

      bot.pathfinder.setMovements(defaultMove);
      bot.autoEat.options = { priority: 'foodPoints', startAt: 14, bannedFood: ['rotten_flesh', 'spider_eye'] };
    });

    bot.on('physicsTick', () => {
      if (!botState.followingPlayer) return;
      const target = bot.players[botState.followingPlayer]?.entity;
      if (target) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    });

    bot.on('chat', async (username, message) => {
      if (username === bot.username) return;
      if (discordChannel) discordChannel.send(`**<${username}>**${message}`).catch(() => {});

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
        }
      }
      else if (cmd === 'stop') {
        botState.followingPlayer = null;
        stopAntiAfk(bot); stopGuardMode(bot);
        botState.autoFarm = false; clearTimeout(botState.farmingInterval);
        bot.clearControlStates(); bot.pathfinder.stop(); bot.collectBlock.cancelTask();
        bot.chat("Sab stop kar diya!");
      }
      else if (cmd === 'guard') { botState.guardMode ? stopGuardMode(bot) : startGuardMode(bot); }
      else if (cmd === 'afk') { botState.antiAfk ? stopAntiAfk(bot) : startAntiAfk(bot); }
      else if (cmd === 'deposit' || cmd === 'chest') { dumpToChest(bot); }
      else if (cmd === 'build' && args[1] === 'house') { executeHouseBuild(bot); }
      else if (cmd === 'farm') {
        botState.autoFarm = !botState.autoFarm;
        if (botState.autoFarm) runFarmLoop(bot);
        else clearTimeout(botState.farmingInterval);
      }
      else if (cmd === 'collect' || cmd === 'mine') {
        let blockQuery = args[1]?.toLowerCase();
        let count = parseInt(args[2]) || 1;
        if (!isNaN(args[1]) && args[2]) { count = parseInt(args[1]); blockQuery = args[2].toLowerCase(); }
        let targetNames = BLOCK_ALIASES[blockQuery] || [blockQuery];
        let targetIds = targetNames.map(name => mcData.blocksByName[name]?.id).filter(Boolean);
        const found = bot.findBlocks({ matching: targetIds, maxDistance: 32, count });
        if (!found.length) return bot.chat(`Aas-paas ${blockQuery} nahi mila.`);
        bot.chat(`${found.length}${blockQuery} collect kar raha hoon...`);
        try {
          const targets = found.map(pos => bot.blockAt(pos));
          await equipBestTool(bot, targets[0]);
          await bot.collectBlock.collect(targets);
          bot.chat("Mining complete!");
        } catch (e) { bot.chat(`Error: ${e.message}`); }
      }
      else if (cmd === 'dropall') {
        for (const item of bot.inventory.items()) { try { await bot.tossStack(item); } catch (e) {} }
        bot.chat("Sari inventory drop kar di!");
      }
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
