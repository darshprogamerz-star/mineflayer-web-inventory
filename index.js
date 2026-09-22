/**
 * ============================================================================
 * LIGHTWEIGHT TACTICAL BOT (ESSENTIALS ONLY)
 * Features: Web Dashboard, Canvas Radar, Live Inventory, Drop Items, Anti-AFK
 * ============================================================================
 */

const mineflayer = require('mineflayer');
const http = require('http');
const express = require('express');
const socketIo = require('socket.io');

const WEB_PORT = process.env.PORT || 3000;
let currentActiveBot = null;

// Bot State
const botState = {
  antiAfk: false,
  antiAfkInterval: null
};

// ---------------------------------------------------------------------------
// 1. CORE BOT FUNCTIONS (ANTI-AFK & INVENTORY DROP)
// ---------------------------------------------------------------------------
function toggleAntiAfk(bot) {
  botState.antiAfk = !botState.antiAfk;
  if (botState.antiAfk) {
    bot.chat("Anti-AFK System: ON");
    botState.antiAfkInterval = setInterval(async () => {
      if (!botState.antiAfk) return;
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      await bot.look(Math.random() * Math.PI * 2, 0, true).catch(() => {});
    }, 8000);
  } else {
    bot.chat("Anti-AFK System: OFF");
    clearInterval(botState.antiAfkInterval);
    botState.antiAfkInterval = null;
    bot.clearControlStates();
  }
}

async function dropAllItems(bot) {
  bot.chat("Dropping all inventory items...");
  const items = bot.inventory.items();
  for (const item of items) {
    try {
      await bot.tossStack(item);
      await bot.waitForTicks(2); // Small delay to prevent anti-spam kick
    } catch (err) {
      // Ignore toss errors
    }
  }
  bot.chat("Inventory is now empty!");
}

// ---------------------------------------------------------------------------
// 2. WEB DASHBOARD & RADAR SERVER
// ---------------------------------------------------------------------------
function startWebDashboard() {
  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server, { cors: { origin: "*" } });

  app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nokar Tactical Lite</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(22, 27, 34, 0.9);
      --border: #30363d;
      --accent: #00d2ff;
      --text: #c9d1d9;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: monospace; padding: 20px; }
    .grid-layout { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; max-width: 1200px; margin: auto; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 15px; }
    .card h3 { color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; }
    .vital-row { display: flex; justify-content: space-between; margin-bottom: 8px; }
    button { background: #21262d; color: #fff; border: 1px solid var(--border); padding: 10px; border-radius: 4px; cursor: pointer; width: 100%; margin-bottom: 8px; font-weight: bold; }
    button:hover { background: var(--accent); color: #000; }
    #radarCanvas { background: #000; border: 1px solid var(--border); border-radius: 6px; width: 100%; height: 250px; }
    .inventory-grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px; background: #000; padding: 8px; border-radius: 6px; }
    .slot { aspect-ratio: 1; background: #121722; border: 1px solid #1f2737; display: flex; align-items: center; justify-content: center; font-size: 10px; position: relative; text-align: center; word-wrap: break-word; }
    .slot.hotbar { border-color: var(--accent); }
    .qty { position: absolute; bottom: 2px; right: 2px; font-weight: bold; color: #fff; }
    .terminal-logs { height: 120px; background: #000; border: 1px solid var(--border); padding: 8px; overflow-y: auto; margin-bottom: 8px; font-size: 12px; }
    input[type="text"] { width: calc(100% - 80px); padding: 10px; background: #000; border: 1px solid var(--border); color: #fff; }
    .send-btn { width: 70px; display: inline-block; }
  </style>
</head>
<body>
  <div class="grid-layout">
    
    <!-- Controls & Vitals -->
    <div class="card">
      <h3>System Controls</h3>
      <div class="vital-row"><span>Status:</span><strong id="uName">Connecting...</strong></div>
      <div class="vital-row"><span>XYZ:</span><strong id="coords">0, 0, 0</strong></div>
      <div class="vital-row"><span>HP / Food:</span><strong id="hpfood">20 / 20</strong></div>
      <br>
      <button onclick="dispatch('afk')">🔄 Toggle Anti-AFK</button>
      <button onclick="dispatch('dropall')" style="border-color: #ff416c; color: #ff416c;">🗑️ Drop All Inventory</button>
    </div>

    <!-- Radar -->
    <div class="card">
      <h3>Perimeter Radar</h3>
      <canvas id="radarCanvas" width="300" height="250"></canvas>
    </div>

    <!-- Terminal -->
    <div class="card" style="grid-column: 1 / -1;">
      <h3>In-Game Terminal</h3>
      <div class="terminal-logs" id="logs"></div>
      <form onsubmit="event.preventDefault(); sendCmd();">
        <input type="text" id="cmdInput" placeholder="Enter command (e.g., hello, dropall, afk)..." />
        <button type="submit" class="send-btn">Send</button>
      </form>
    </div>

    <!-- Inventory -->
    <div class="card" style="grid-column: 1 / -1;">
      <h3>Live Inventory</h3>
      <div class="inventory-grid" id="invGrid"></div>
    </div>

  </div>

  <script>
    const socket = io();
    const cvs = document.getElementById('radarCanvas');
    const ctx = cvs.getContext('2d');

    socket.on('bot_sync', (d) => {
      document.getElementById('uName').innerText = d.username;
      document.getElementById('coords').innerText = Math.round(d.coords.x) + ', ' + Math.round(d.coords.y) + ', ' + Math.round(d.coords.z);
      document.getElementById('hpfood').innerText = Math.round(d.health) + ' / ' + Math.round(d.food);

      // Render Inventory
      const grid = document.getElementById('invGrid');
      grid.innerHTML = '';
      for (let i = 0; i < 36; i++) {
        const slot = document.createElement('div');
        slot.className = 'slot' + (i >= 27 ? ' hotbar' : '');
        const mapped = (i < 9) ? (i + 36) : i;
        const it = d.inventory.find(x => x.slot === mapped);
        if (it) {
          slot.innerText = it.name.replace(/_/g, '').slice(0, 8);
          if (it.count > 1) slot.innerHTML += '<span class="qty">' + it.count + '</span>';
        }
        grid.appendChild(slot);
      }

      // Render Radar
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cvs.width, cvs.height);
      const cx = cvs.width / 2, cy = cvs.height / 2;
      
      ctx.strokeStyle = '#1e2638';
      [30, 60, 90].forEach(r => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke(); });
      
      ctx.fillStyle = '#00f260'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI*2); ctx.fill(); // Self

      if (d.entities) {
        d.entities.forEach(e => {
          ctx.fillStyle = e.isPlayer ? '#00d2ff' : '#ff416c';
          ctx.beginPath(); ctx.arc(cx + (e.x - d.coords.x)*3, cy + (e.z - d.coords.z)*3, 3, 0, Math.PI*2); ctx.fill();
        });
      }
    });

    socket.on('chat_feed', (msg) => {
      const logs = document.getElementById('logs');
      logs.innerHTML += '<div>' + msg + '</div>';
      logs.scrollTop = logs.scrollHeight;
    });

    function dispatch(cmd) { socket.emit('dispatch', cmd); }
    function sendCmd() {
      const input = document.getElementById('cmdInput');
      if (input.value.trim()) { dispatch(input.value.trim()); input.value = ''; }
    }
  </script>
</body>
</html>`);
  });

  // Sync Loop
  setInterval(() => {
    if (!currentActiveBot || !currentActiveBot.entity) return;
    const inv = currentActiveBot.inventory.items().map(i => ({ slot: i.slot, name: i.name, count: i.count }));
    const ents = Object.values(currentActiveBot.entities)
      .filter(e => e !== currentActiveBot.entity && e.position && currentActiveBot.entity.position.distanceTo(e.position) <= 32)
      .map(e => ({ x: e.position.x, z: e.position.z, isPlayer: e.type === 'player' }));

    io.emit('bot_sync', {
      username: currentActiveBot.username,
      coords: currentActiveBot.entity.position,
      health: currentActiveBot.health,
      food: currentActiveBot.food,
      inventory: inv,
      entities: ents
    });
  }, 1000);

  io.on('connection', (sock) => {
    sock.on('dispatch', (cmd) => {
      if (currentActiveBot) currentActiveBot.emit('custom_cmd', cmd);
    });
  });

  server.listen(WEB_PORT, () => console.log(`[WEB SERVER ACTIVE] Port: ${WEB_PORT}`));
}

// ---------------------------------------------------------------------------
// 3. MAIN BOT PROCESS
// ---------------------------------------------------------------------------
function launchBot() {
  const bot = mineflayer.createBot({
    host: process.argv[2] || 'DG_LAND502.aternos.me',
    port: parseInt(process.argv[3], 10) || 62974,
    username: process.argv[4] || 'Nokar',
    version: false
  });

  currentActiveBot = bot;

  bot.once('spawn', () => {
    console.log(`[AGENT LIVE] ${bot.username} entered the server.`);
    bot.chat("System online. Terminal commands ready.");
  });

  // Handle Commands from In-Game Chat AND Web Dashboard
  bot.on('custom_cmd', (cmd) => handleCommand(cmd));
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    handleCommand(message);
  });

  function handleCommand(cmdStr) {
    const args = cmdStr.trim().split(' ');
    const command = args[0].toLowerCase();

    if (command === 'afk') {
      toggleAntiAfk(bot);
    } else if (command === 'dropall') {
      dropAllItems(bot);
    } else {
      // If it's not a built-in command, just say it in chat
      if (cmdStr) bot.chat(cmdStr);
    }
  }

  bot.on('end', () => {
    console.log('[RECONNECT] Connection ended. Retrying in 10s...');
    setTimeout(launchBot, 10000);
  });

  bot.on('error', (err) => {
    console.log('[ERROR]', err.message);
  });
}

// Start Web Server instantly to clear Render Port Binding, then start Bot
startWebDashboard();
launchBot();
