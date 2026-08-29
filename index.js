/**
 * Master Autonomous Minecraft Companion & AI Brain (Gemini Integration)
 * Version: 11.0.0-Titan-AI
 */

const http = require('http');
const express = require('express');
const socketIo = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');

// Initialize Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

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
 * AI Brain Function (Gemini Response Generator)
 */
async function askAiBrain(promptText, botStatus) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: `You are 'Nokar', an intelligent, loyal, and witty AI Minecraft assistant playing on a server. Keep your responses short (under 20 words), casual, engaging, and in Hinglish. Current Bot Status -> Health: ${botStatus.hp}/20, Food: ${botStatus.food}/20, GuardMode: ${botStatus.guard}, AntiAFK: ${botStatus.afk}. User says: "${promptText}"` }]
        }
      ]
    });
    return response.text ? response.text.trim() : "Haan boss, batao kya karna hai?";
  } catch (err) {
    console.error('[AI ERROR]', err.message);
    return "Haan sun raha hoon!";
  }
}

/**
 * Discord Bot Setup
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
    console.log(`[DISCORD LIVE] Logged in as ${discordClient.user.tag}`);
    if (DISCORD_CHANNEL_ID) {
      discordChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
      if (discordChannel) discordChannel.send('🟢 **Titan AI Agent online & connected!**');
    }
  });
}

/**
 * Combat & Tool Utilities
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
  if (tools.length) { try { await bot.equip(tools[0], 'hand'); } catch (e) {} }
}

function startAntiAfk(bot) {
  botState.antiAfk = true;
  bot.chat("Anti-AFK Wander mode ON!");
  const homePos = bot.entity.position.clone();
  botState.antiAfkInterval = setInterval(async () => {
    if (!botState.antiAfk || botState.followingPlayer || botState.guardMode) return;
    try {
      const dx = Math.floor(Math.random() * 12) - 6;
      const dz = Math.floor(Math.random() * 12) - 6;
      const targetPos = homePos.offset(dx, 0, dz);
      bot.setControlState('jump', Math.random() > 0.5);
      setTimeout(() => bot.setControlState('jump', false), 300);
      await bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
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
  bot.chat("🛡️ Guard Mode ON! Area protected.");
  botState.guardInterval = setInterval(async () => {
    if (!botState.guardMode) return;
    const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'drowned', 'husk'];
    const target = bot.nearestEntity(e => {
      if (e.type !== 'mob') return false;
      const name = e.name?.toLowerCase() || '';
      return hostiles.some(h => name.includes(h)) && bot.entity.position.distanceTo(e.position) < 14;
    });
    if (target) {
      await equipBestWeapon(bot);
      bot.pvp.attack(target);
    } else if (botState.guardOrigin && bot.entity.position.distanceTo(botState.guardOrigin) > 10) {
      bot.pathfinder.setGoal(new goals.GoalNear(botState.guardOrigin.x, botState.guardOrigin.y, botState.guardOrigin.z, 2));
    }
  }, 1000);
}

function stopGuardMode(bot) {
  botState.guardMode = false;
  if (botState.guardInterval) clearInterval(botState.guardInterval);
  bot.pvp.stop();
}

async function dumpToChest(bot) {
  const mcData = require('minecraft-data')(bot.version);
  const chestBlock = bot.findBlock({
    matching: [mcData.blocksByName.chest?.id, mcData.blocksByName.trapped_chest?.id, mcData.blocksByName.barrel?.id].filter(Boolean),
    maxDistance: 6
  });
  if (!chestBlock) return bot.chat("Paas me koi Chest nahi mila!");
  bot.chat("Chest me saman deposit kar raha hoon...");
  try {
    const chest = await bot.openChest(chestBlock);
    for (const item of bot.inventory.items()) {
      if (item.name.includes('sword') || item.name.includes('pickaxe') || item.name.includes('helmet')) continue;
      try { await chest.deposit(item.type, null, item.count); await bot.waitForTicks(2); } catch (e) {}
    }
    chest.close();
    bot.chat("Deposit complete!");
  } catch (err) { bot.chat(`Error: ${err.message}`); }
}

async function startFishing(bot) {
  const rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
  if (!rod) return bot.chat("Fishing rod nahi hai!");
  botState.isFishing = true;
  bot.chat("Fishing shuru!");
  await bot.equip(rod, 'hand');
  async function cast() {
    if (!botState.isFishing) return;
    try { await bot.fish(); cast(); } catch (err) { if (botState.isFishing) setTimeout(cast, 2000); }
  }
  cast();
}

function stopFishing(bot) { botState.isFishing = false; }

async function executeHouseBuild(bot) {
  const getBuildBlock = () => bot.inventory.items().find(i => 
    i.name.includes('plank') || i.name.includes('cobble') || i.name.includes('stone') || i.name.includes('dirt')
  );
  if (!getBuildBlock()) return bot.chat("Ghar banane ke liye blocks nahi hain!");
  bot.chat("4x4 House banana shuru...");
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
      if (bot.entity.position.distanceTo(pos) > 4.5) {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)).catch(() => {});
      }
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
 * Web Control Center Server
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
        <title>Titan AI Agent Command Center</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        <script src="/socket.io/socket.io.js"></script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070a13; color: #e2e8f0; display: flex; justify-content: center; padding: 14px; }
          .panel { width: 100%; max-width: 700px; background: #111827; border-radius: 14px; border: 1px solid #1f2937; padding: 18px; box-shadow: 0 20px 40px rgba(0,0,0,0.7); }
          .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
          .title { font-size: 19px; font-weight: bold; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
          .badge { background: #8b5cf6; color: #fff; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; }
          .chat-box { display: flex; gap: 8px; margin-bottom: 14px; }
          .chat-input { flex: 1; padding: 10px 14px; background: #030712; border: 1px solid #374151; border-radius: 8px; color: #fff; font-size: 13px; outline: none; }
          .chat-input:focus { border-color: #38bdf8; }
          .chat-btn { background: #0284c7; padding: 10px 16px; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; }
          .ctrl-wrapper { background: #030712; border: 1px solid #1f2937; border-radius: 12px; padding: 14px; margin-bottom: 14px; display: flex; flex-direction: column; align-items: center; }
          .ctrl-title { font-size: 11px; text-transform: uppercase; color: #9ca3af; letter-spacing: 1px; margin-bottom: 10px; }
          .dpad { display: grid; grid-template-columns: repeat(3, 52px); grid-template-rows: repeat(3, 52px); gap: 6px; justify-content: center; }
          .ctrl-btn { background: #1f2937; border: 2px solid #374151; border-radius: 8px; color: white; font-size: 18px; font-weight: bold; display: flex; align-items: center; justify-content: center; cursor: pointer; }
          .ctrl-btn:active { background: #0284c7; border-color: #38bdf8; transform: scale(0.92); }
          .actions-row { display: flex; gap: 10px; margin-top: 12px; }
          .action-btn { padding: 9px 18px; border-radius: 6px; border: none; font-weight: bold; cursor: pointer; color: white; font-size: 12px; }
          .radar-card { display: flex; flex-direction: column; align-items: center; background: #030712; border-radius: 10px; border: 1px solid #1f2937; padding: 10px; margin-bottom: 14px; }
          canvas { background: #050811; border-radius: 8px; border: 1px solid #374151; max-width: 100%; }
          .radar-legend { display: flex; gap: 12px; font-size: 11px; margin-top: 6px; color: #9ca3af; }
          .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 4px; }
          .meters { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
          .meter { background: #030712; padding: 8px; border-radius: 8px; border: 1px solid #1f2937; text-align: center; }
          .meter-val { font-size: 17px; font-weight: bold; }
          .hp-col { color: #f43f5e; }
          .fd-col { color: #fbbf24; }
          .action-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 14px; }
          .act-btn { padding: 11px; border: none; border-radius: 6px; font-weight: bold; font-size: 12.5px; cursor: pointer; color: white; }
          .act-btn:active { transform: scale(0.97); }
          .btn-afk { background: #6366f1; } .btn-guard { background: #dc2626; } .btn-chest { background: #d97706; } .btn-fish { background: #0891b2; } .btn-farm { background: #059669; } .btn-build { background: #2563eb; } .btn-stop { background: #be123c; grid-column: span 2; }
          .grid-title { font-size: 11px; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.8px; margin: 10px 0 5px; }
          .grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 5px; background: #030712; padding: 10px; border-radius: 8px; border: 1px solid #1f2937; }
          .slot { aspect-ratio: 1; background: #1f2937; border: 1px solid #374151; border-radius: 4px; position: relative; display: flex; align-items: center; justify-content: center; text-align: center; padding: 2px; }
          .slot .item-name { font-size: 7.5px; color: #cbd5e1; word-break: break-all; line-height: 1; }
          .slot .item-count { position: absolute; bottom: 1px; right: 2px; font-size: 10px; font-weight: 800; color: #38bdf8; }
        </style>
      </head>
      <body>
        <div class="panel">
          <div class="top-bar">
            <div class="title">🤖 Titan Agent + Gemini AI</div>
            <div class="badge">AI Connected</div>
          </div>
          <div class="chat-box">
            <input type="text" id="chatMsg" class="chat-input" placeholder="Talk with AI or type /command...">
            <button class="chat-btn" onclick="sendChat()">Send</button>
          </div>
          <div class="ctrl-wrapper">
            <div class="ctrl-title">Manual Controller</div>
            <div class="dpad">
              <div></div><button class="ctrl-btn" onpointerdown="startMove('forward')" onpointerup="stopMove('forward')">⬆️</button><div></div>
              <button class="ctrl-btn" onpointerdown="startMove('left')" onpointerup="stopMove('left')">⬅️</button>
              <button class="ctrl-btn" onclick="jump()">🦘</button>
              <button class="ctrl-btn" onpointerdown="startMove('right')" onpointerup="stopMove('right')">➡️</button>
              <div></div><button class="ctrl-btn" onpointerdown="startMove('back')" onpointerup="stopMove('back')">⬇️</button><div></div>
            </div>
            <div class="actions-row">
              <button class="action-btn" style="background:#16a34a;" onclick="jump()">Jump</button>
              <button class="action-btn" style="background:#b45309;" id="sneakBtn" onclick="toggleSneak()">Sneak: OFF</button>
            </div>
          </div>
          <div class="action-grid">
            <button class="act-btn btn-afk" id="afkBtn" onclick="send('toggle_afk')">🚶 Move Around: OFF</button>
            <button class="act-btn btn-guard" id="guardBtn" onclick="send('toggle_guard')">🛡️ Bodyguard: OFF</button>
            <button class="act-btn btn-chest" onclick="send('dump_chest')">📦 Dump to Chest</button>
            <button class="act-btn btn-fish" id="fishBtn" onclick="send('toggle_fish')">🎣 Auto Fish: OFF</button>
            <button class="act-btn btn-farm" id="farmBtn" onclick="send('toggle_farm')">🌾 Auto Farm: OFF</button>
            <button class="act-btn btn-build" onclick="send('build_house')">🏠 Build House</button>
            <button class="act-btn btn-stop" onclick="send('stop')">🛑 Stop All</button>
          </div>
          <div class="radar-card">
            <canvas id="radarCanvas" width="280" height="280"></canvas>
            <div class="radar-legend">
              <div><span class="dot" style="background:#22c55e;"></span> Bot</div>
              <div><span class="dot" style="background:#38bdf8;"></span> Players</div>
              <div><span class="dot" style="background:#ef4444;"></span> Hostile Mobs</div>
            </div>
          </div>
          <div class="meters">
            <div class="meter"><div class="meter-val hp-col" id="hp">20 / 20</div><div style="font-size:11px;color:#6b7280;">❤️ Health</div></div>
            <div class="meter"><div class="meter-val fd-col" id="food">20 / 20</div><div style="font-size:11px;color:#6b7280;">🍖 Hunger</div></div>
          </div>
          <div class="grid-title">Main Inventory</div>
          <div class="grid" id="mainGrid"></div>
          <div class="grid-title">Hotbar</div>
          <div class="grid" id="hotbarGrid"></div>
        </div>
        <script>
          const socket = io();
          const canvas = document.getElementById('radarCanvas');
          const ctx = canvas.getContext('2d');
          const cX = canvas.width / 2, cY = canvas.height / 2, scale = 5;
          let isSneaking = false;
          const main = document.getElementById('mainGrid'), hotbar = document.getElementById('hotbarGrid');
          for (let i = 9; i <= 35; i++) main.innerHTML += '<div class="slot" id="s-' + i + '"></div>';
          for (let i = 36; i <= 44; i++) hotbar.innerHTML += '<div class="slot" id="s-' + i + '"></div>';

          function startMove(dir) { socket.emit('control_move', { direction: dir, state: true }); }
          function stopMove(dir) { socket.emit('control_move', { direction: dir, state: false }); }
          function jump() { socket.emit('control_jump'); }
          function toggleSneak() {
            isSneaking = !isSneaking;
            document.getElementById('sneakBtn').innerText = 'Sneak: ' + (isSneaking ? 'ON' : 'OFF');
            socket.emit('control_sneak', { state: isSneaking });
          }
          function sendChat() {
            const input = document.getElementById('chatMsg');
            const msg = input.value.trim();
            if (msg) { socket.emit('send_chat', { message: msg }); input.value = ''; }
          }
          document.getElementById('chatMsg').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });

          socket.on('radar', data => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = '#1f2937';
            [25, 55, 85, 115].forEach(r => { ctx.beginPath(); ctx.arc(cX, cY, r, 0, Math.PI * 2); ctx.stroke(); });
            data.entities.forEach(e => {
              const pX = cX + (e.x - data.bot.x) * scale, pY = cY + (e.z - data.bot.z) * scale;
              if (pX >= 0 && pX <= canvas.width && pY >= 0 && pY <= canvas.height) {
                ctx.fillStyle = e.type === 'player' ? '#38bdf8' : '#ef4444';
                ctx.beginPath(); ctx.arc(pX, pY, 4, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#f8fafc'; ctx.font = 'bold 9.5px sans-serif'; ctx.fillText(e.name, pX + 6, pY + 3);
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
              } else { el.innerHTML = ''; el.style.background = '#111827'; }
            }
          });

          function send(act) {
            fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act }) })
            .then(r => r.json()).then(d => {
              if (act === 'toggle_afk') document.getElementById('afkBtn').innerText = '🚶 Move Around: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_guard') document.getElementById('guardBtn').innerText = '🛡️ Bodyguard: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_farm') document.getElementById('farmBtn').innerText = '🌾 Auto Farm: ' + (d.state ? 'ON' : 'OFF');
              if (act === 'toggle_fish') document.getElementById('fishBtn').innerText = '🎣 Auto Fish: ' + (d.state ? 'ON' : 'OFF');
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
    if (act === 'dump_chest') { dumpToChest(bot); return res.json({ success: true }); }
    if (act === 'toggle_fish') { botState.isFishing ? stopFishing(bot) : startFishing(bot); return res.json({ success: true, state: botState.isFishing }); }
    if (act === 'toggle_farm') {
      botState.autoFarm = !botState.autoFarm;
      if (botState.autoFarm) runFarmLoop(bot); else clearTimeout(botState.farmingInterval);
      return res.json({ success: true, state: botState.autoFarm });
    }
    if (act === 'build_house') { executeHouseBuild(bot); return res.json({ success: true }); }
    if (act === 'stop') {
      botState.followingPlayer = null; stopAntiAfk(bot); stopGuardMode(bot); stopFishing(bot);
      bot.clearControlStates(); bot.pathfinder.stop(); bot.pvp.stop(); bot.collectBlock.cancelTask();
      botState.autoFarm = false; clearTimeout(botState.farmingInterval);
      bot.chat("Ruk gaya!");
      return res.json({ success: true });
    }
    res.json({ success: false });
  });

  io.on('connection', (socket) => {
    syncState();
    socket.on('control_move', data => bot.setControlState(data.direction, !!data.state));
    socket.on('control_jump', () => { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 350); });
    socket.on('control_sneak', data => bot.setControlState('sneak', !!data.state));
    socket.on('send_chat', async data => {
      if (data && data.message) {
        const reply = await askAiBrain(data.message, { hp: bot.health, food: bot.food, guard: botState.guardMode, afk: botState.antiAfk });
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
        if (bot.entity.position.distanceTo(e.position) <= 28) {
          nearby.push({ name: e.username || e.name || e.type, type: e.type, x: e.position.x, z: e.position.z });
        }
      }
    }
    io.emit('radar', { bot: { x: bot.entity.position.x, z: bot.entity.position.z, yaw: bot.entity.yaw }, entities: nearby });
  }, 500);

  bot.inventory.on('updateSlot', () => syncState());
  bot.on('health', () => syncState());
  server.listen(port, () => console.log(`[AI DASHBOARD READY] Port ${port}`));
}

/**
 * Main Launcher
 */
if (require.main === module) {
  function launchBot() {
    const HOST_ENDPOINT = process.argv[2] || 'DG_LAND502.aternos.me';
    const PORT_ENDPOINT = parseInt(process.argv[3], 10) || 62974;
    const BOT_IDENTITY = process.argv[4] || 'Nokar';
    const WEB_PORT = process.env.PORT || 3000;

    const bot = mineflayer.createBot({
      host: HOST_ENDPOINT, port: PORT_ENDPOINT, username: BOT_IDENTITY,
      checkTimeoutInterval: 120000, version: '1.20.4'
    });

    bot.loadPlugin(pathfinder); bot.loadPlugin(collectBlock); bot.loadPlugin(autoEat); bot.loadPlugin(pvp);

    bot.once('spawn', () => {
      console.log(`[AGENT JOINED] ${bot.username} connected with Gemini AI Brain.`);
      try { webInventoryPlugin(bot, { port: WEB_PORT }); } catch (e) {}
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowParkour = true; defaultMove.canDig = true; defaultMove.allow1by1towers = true;
      bot.pathfinder.setMovements(defaultMove);
      bot.autoEat.options = { priority: 'foodPoints', startAt: 14, bannedFood: ['rotten_flesh', 'spider_eye'] };
    });

    bot.on('physicsTick', () => {
      if (!botState.followingPlayer) return;
      const target = bot.players[botState.followingPlayer]?.entity;
      if (target) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    });

    // Chat / Discord / AI Brain Handler
    discordClient.on('messageCreate', async (msg) => {
      if (msg.author.bot || (DISCORD_CHANNEL_ID && msg.channel.id !== DISCORD_CHANNEL_ID)) return;
      const content = msg.content.trim();

      if (content.startsWith('!ai ')) {
        const prompt = content.slice(4);
        const reply = await askAiBrain(prompt, { hp: bot.health, food: bot.food, guard: botState.guardMode, afk: botState.antiAfk });
        bot.chat(reply);
        return msg.reply(`🤖 **AI Reply:** ${reply}`);
      }
      if (content === '!status') {
        return msg.reply(`📊 HP: ${Math.round(bot.health)}/20 | Food: ${Math.round(bot.food)}/20 | Guard: ${botState.guardMode ? 'ON' : 'OFF'}`);
      }
      if (content.startsWith('!say ')) { bot.chat(content.slice(5)); return msg.react('💬'); }
    });

    bot.on('chat', async (username, message) => {
      if (username === bot.username) return;
      if (discordChannel) discordChannel.send(`**<${username}>** ${message}`).catch(() => {});

      const args = message.trim().split(/\s+/);
      const cmd = args[0].toLowerCase();
      const mcData = require('minecraft-data')(bot.version);

      if (cmd === 'come' || cmd === 'follow') {
        stopAntiAfk(bot);
        const player = bot.players[username]?.entity;
        botState.followingPlayer = username;
        if (player) { bot.chat(`Aapke paas aa raha hoon @${username}!`); bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true); }
      }
      else if (cmd === 'stop') {
        botState.followingPlayer = null; stopAntiAfk(bot); stopGuardMode(bot); stopFishing(bot);
        bot.clearControlStates(); bot.pathfinder.stop(); bot.pvp.stop(); bot.collectBlock.cancelTask();
        bot.chat("Ruk gaya!");
      }
      else if (cmd === 'guard') { botState.guardMode ? stopGuardMode(bot) : startGuardMode(bot); }
      else if (cmd === 'afk') { botState.antiAfk ? stopAntiAfk(bot) : startAntiAfk(bot); }
      else if (cmd === 'build' && args[1] === 'house') { executeHouseBuild(bot); }
      else if (cmd === 'deposit' || cmd === 'chest') { dumpToChest(bot); }
      else if (cmd === 'fish') { botState.isFishing ? stopFishing(bot) : startFishing(bot); }
      else {
        // If someone talks to the bot normally in game chat, Gemini AI responds back!
        if (message.toLowerCase().includes('nokar') || message.toLowerCase().includes('bot')) {
          const reply = await askAiBrain(message, { hp: bot.health, food: bot.food, guard: botState.guardMode, afk: botState.antiAfk });
          bot.chat(reply);
        }
      }
    });

    bot.on('end', () => setTimeout(launchBot, 10000));
    bot.on('error', (err) => console.error('[ERROR]', err.message));
  }

  launchBot();
}
