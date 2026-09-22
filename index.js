/**
 * ============================================================================
 * PROJECT: TACTICAL MINECRAFT SURVIVAL MATRIX (MANUAL CONTROL + UI EDITION)
 * FEATURES: FULL RADAR + 36-SLOT INVENTORY + D-PAD LOCOMOTION + ANTI-AFK + TERMINAL
 * ============================================================================
 */

const mineflayer = require('mineflayer');
const http = require('http');
const express = require('express');
const socketIo = require('socket.io');

const WEB_PORT = process.env.PORT || 3000;
let currentActiveBot = null;

// State Registry
const botState = {
  antiAfk: false,
  antiAfkInterval: null
};

// ---------------------------------------------------------------------------
// 1. CORE BOT COMMANDS & MANUAL MOVEMENT
// ---------------------------------------------------------------------------
function toggleAntiAfk(bot) {
  botState.antiAfk = !botState.antiAfk;
  if (botState.antiAfk) {
    bot.chat("🛡️ Anti-AFK Engine: ACTIVE");
    botState.antiAfkInterval = setInterval(async () => {
      if (!botState.antiAfk) return;
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      const randomYaw = Math.random() * Math.PI * 2;
      const randomPitch = (Math.random() - 0.5) * 0.4;
      await bot.look(randomYaw, randomPitch, true).catch(() => {});
    }, 7000);
  } else {
    bot.chat("🛡️ Anti-AFK Engine: DISABLED");
    if (botState.antiAfkInterval) {
      clearInterval(botState.antiAfkInterval);
      botState.antiAfkInterval = null;
    }
    bot.clearControlStates();
  }
}

async function dropAllInventory(bot) {
  bot.chat("📦 Dropping all items from inventory...");
  const items = bot.inventory.items();
  for (const item of items) {
    try {
      await bot.tossStack(item);
      await bot.waitForTicks(2);
    } catch (e) {}
  }
  bot.chat("✅ Inventory cleared!");
}

function handleManualMove(bot, dir) {
  if (!bot || !bot.entity) return;
  if (dir === 'jump') {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 350);
  } else if (['forward', 'back', 'left', 'right'].includes(dir)) {
    bot.setControlState(dir, true);
    setTimeout(() => bot.setControlState(dir, false), 400);
  }
}

// ---------------------------------------------------------------------------
// 2. EXPANDED WEB INTERFACE, RADAR & D-PAD CONTROLLER
// ---------------------------------------------------------------------------
function startWebConsole() {
  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server, { cors: { origin: "*" } });

  app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tactical Command Matrix</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg-dark: #07090e;
      --panel-bg: rgba(18, 22, 34, 0.9);
      --panel-border: #1e2638;
      --accent-cyan: #00d2ff;
      --accent-blue: #3a7bd5;
      --accent-green: #00f260;
      --accent-red: #ff416c;
      --accent-gold: #f7971e;
      --text-main: #e2e8f0;
      --text-sub: #94a3b8;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg-dark);
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(0, 210, 255, 0.04) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(255, 65, 108, 0.04) 0%, transparent 40%);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      padding: 24px;
      min-height: 100vh;
    }

    .matrix-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--panel-border);
      margin-bottom: 24px;
    }

    .matrix-title {
      font-size: 1.8rem;
      font-weight: 800;
      letter-spacing: 1px;
      background: linear-gradient(135deg, var(--accent-cyan), var(--accent-blue));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(0, 242, 96, 0.1);
      border: 1px solid var(--accent-green);
      color: var(--accent-green);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--accent-green);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--accent-green);
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 242, 96, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(0, 242, 96, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 242, 96, 0); }
    }

    .dashboard-layout {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 20px;
      max-width: 1500px;
      margin: 0 auto;
    }

    .panel {
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      border-radius: 12px;
      padding: 20px;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .col-4 { grid-column: span 4; }
    .col-8 { grid-column: span 8; }
    .col-6 { grid-column: span 6; }
    .col-12 { grid-column: span 12; }

    @media (max-width: 1024px) {
      .col-4, .col-8, .col-6 { grid-column: span 12; }
    }

    .panel-header {
      font-size: 1.15rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid var(--panel-border);
      padding-bottom: 12px;
    }

    .stat-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: rgba(7, 9, 14, 0.6);
      border: 1px solid var(--panel-border);
      border-radius: 8px;
      font-size: 0.95rem;
    }

    .stat-row span { color: var(--text-sub); }
    .stat-row strong { font-family: monospace; font-size: 1.05rem; }

    .control-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 6px;
    }

    button {
      background: #151a26;
      border: 1px solid var(--panel-border);
      color: var(--text-main);
      padding: 12px 16px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.25s ease;
      user-select: none;
    }

    button:hover {
      background: var(--accent-blue);
      color: #fff;
      border-color: var(--accent-cyan);
      box-shadow: 0 0 16px rgba(0, 210, 255, 0.3);
      transform: translateY(-2px);
    }

    button:active {
      transform: translateY(1px);
    }

    button.btn-danger {
      border-color: rgba(255, 65, 108, 0.4);
      color: var(--accent-red);
    }

    button.btn-danger:hover {
      background: var(--accent-red);
      color: #fff;
      box-shadow: 0 0 16px rgba(255, 65, 108, 0.4);
    }

    /* D-PAD LOCOMOTION STYLES */
    .dpad-container {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      max-width: 220px;
      margin: 10px auto;
    }

    .dpad-btn {
      padding: 14px;
      font-size: 1.2rem;
    }

    .dpad-jump {
      background: #1f2737;
      border-color: var(--accent-cyan);
      color: #fff;
    }

    .radar-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }

    #radarCanvas {
      background: #04060a;
      border: 2px solid var(--panel-border);
      border-radius: 10px;
      width: 100%;
      height: 280px;
      box-shadow: inset 0 0 20px rgba(0, 210, 255, 0.05);
    }

    .radar-key {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 0.85rem;
      color: var(--text-sub);
    }

    .radar-key-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .key-circle {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .inventory-matrix {
      display: grid;
      grid-template-columns: repeat(9, 1fr);
      gap: 8px;
      background: #04060a;
      padding: 16px;
      border-radius: 10px;
      border: 1px solid var(--panel-border);
    }

    .inv-slot {
      aspect-ratio: 1;
      background: #121722;
      border: 1px solid #1f2737;
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 6px;
      position: relative;
      user-select: none;
      transition: border-color 0.2s;
    }

    .inv-slot:hover { border-color: var(--accent-cyan); }
    .inv-slot.hotbar {
      border: 2px solid var(--accent-cyan);
      background: rgba(0, 210, 255, 0.06);
    }

    .inv-name {
      font-size: 0.72rem;
      color: #fff;
      text-align: center;
      line-height: 1.15;
      word-break: break-word;
    }

    .inv-qty {
      position: absolute;
      bottom: 3px;
      right: 5px;
      font-size: 0.8rem;
      font-weight: 800;
      color: #fff;
      text-shadow: 1px 1px 2px #000;
      font-family: monospace;
    }

    .terminal-logs {
      height: 160px;
      background: #04060a;
      border: 1px solid var(--panel-border);
      border-radius: 8px;
      padding: 12px;
      overflow-y: auto;
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.88rem;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .terminal-line {
      color: var(--text-main);
      line-height: 1.4;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      padding-bottom: 3px;
    }

    .terminal-form {
      display: flex;
      gap: 10px;
      margin-top: 10px;
    }

    .terminal-input {
      flex: 1;
      background: #04060a;
      border: 1px solid var(--panel-border);
      border-radius: 8px;
      color: #fff;
      padding: 12px 16px;
      font-family: monospace;
      font-size: 0.95rem;
    }

    .terminal-input:focus {
      outline: none;
      border-color: var(--accent-cyan);
      box-shadow: 0 0 10px rgba(0, 210, 255, 0.2);
    }
  </style>
</head>
<body>

  <div class="matrix-header">
    <div class="matrix-title">
      <span>⚡ NOKAR TACTICAL MATRIX</span>
    </div>
    <div class="status-badge">
      <div class="pulse-dot"></div>
      <span id="daemonLabel">CONNECTED</span>
    </div>
  </div>

  <div class="dashboard-layout">

    <!-- VITALS & CORE ACTIONS -->
    <div class="panel col-4">
      <div class="panel-header">
        <span>Unit Diagnostics</span>
      </div>
      <div class="stat-list">
        <div class="stat-row">
          <span>Identity Callout</span>
          <strong id="botName">Nokar</strong>
        </div>
        <div class="stat-row">
          <span>Coordinates</span>
          <strong id="botCoords">0, 0, 0</strong>
        </div>
        <div class="stat-row">
          <span>Armor / HP Level</span>
          <strong id="botHp" style="color:var(--accent-green);">20 / 20</strong>
        </div>
        <div class="stat-row">
          <span>Food Stamina</span>
          <strong id="botFood" style="color:var(--accent-gold);">20 / 20</strong>
        </div>
      </div>

      <div class="control-actions">
        <button onclick="sendAction('afk')">🔄 Toggle Anti-AFK Mode</button>
        <button class="btn-danger" onclick="sendAction('dropall')">🗑️ Dump All Inventory Items</button>
      </div>
    </div>

    <!-- 2D TACTICAL RADAR -->
    <div class="panel col-8">
      <div class="panel-header">
        <span>Perimeter 32-Block Scan Radar</span>
        <span style="font-size:0.85rem; color:var(--text-sub);">Real-time Dynamic Sync</span>
      </div>
      <div class="radar-container">
        <canvas id="radarCanvas" width="500" height="280"></canvas>
        <div class="radar-key">
          <div class="radar-key-item"><span class="key-circle" style="background:var(--accent-green)"></span> Bot Position</div>
          <div class="radar-key-item"><span class="key-circle" style="background:var(--accent-cyan)"></span> Players</div>
          <div class="radar-key-item"><span class="key-circle" style="background:var(--accent-red)"></span> Hostile Entities</div>
          <div class="radar-key-item"><span class="key-circle" style="background:var(--text-sub)"></span> Passive Entities</div>
        </div>
      </div>
    </div>

    <!-- MANUAL LOCOMOTION D-PAD -->
    <div class="panel col-4">
      <div class="panel-header">
        <span>Manual Movement Controls</span>
        <span style="font-size:0.8rem; color:var(--accent-cyan);">D-Pad</span>
      </div>
      <div class="dpad-container">
        <div></div>
        <button class="dpad-btn" onclick="move('forward')">⬆️</button>
        <div></div>
        <button class="dpad-btn" onclick="move('left')">⬅️</button>
        <button class="dpad-btn dpad-jump" onclick="move('jump')">🦘</button>
        <button class="dpad-btn" onclick="move('right')">➡️</button>
        <div></div>
        <button class="dpad-btn" onclick="move('back')">⬇️</button>
        <div></div>
      </div>
      <div style="font-size:0.75rem; text-align:center; color:var(--text-sub);">
        Click arrow buttons to step in direction, center to jump.
      </div>
    </div>

    <!-- IN-GAME COMMAND TERMINAL -->
    <div class="panel col-8">
      <div class="panel-header">
        <span>In-Game Chat Relay & Remote Terminal</span>
      </div>
      <div class="terminal-logs" id="terminalLogs"></div>
      <form class="terminal-form" onsubmit="event.preventDefault(); transmitPrompt();">
        <input type="text" id="terminalInput" class="terminal-input" placeholder="Type a message or command (e.g. afk, dropall, hello)..." />
        <button type="submit" style="background:var(--accent-blue);">Transmit</button>
      </form>
    </div>

    <!-- LIVE 36-SLOT INVENTORY GRID -->
    <div class="panel col-12">
      <div class="panel-header">
        <span>Live Container & Hotbar View (Slots 0 - 35)</span>
        <span style="font-size:0.85rem; color:var(--accent-cyan);">Hotbar Highlighted</span>
      </div>
      <div class="inventory-matrix" id="inventoryDisplay"></div>
    </div>

  </div>

  <script>
    const socket = io();
    const canvas = document.getElementById('radarCanvas');
    const ctx = canvas.getContext('2d');

    socket.on('bot_sync', (state) => {
      document.getElementById('botName').innerText = state.username || 'Nokar';
      document.getElementById('botCoords').innerText = 
        Math.round(state.coords.x) + ', ' + Math.round(state.coords.y) + ', ' + Math.round(state.coords.z);
      document.getElementById('botHp').innerText = Math.round(state.health) + ' / 20 HP';
      document.getElementById('botFood').innerText = Math.round(state.food) + ' / 20 Food';

      paintInventory(state.inventory);
      paintRadar(state.coords, state.yaw, state.entities);
    });

    socket.on('chat_feed', (msg) => {
      const logs = document.getElementById('terminalLogs');
      const row = document.createElement('div');
      row.className = 'terminal-line';
      row.innerText = msg;
      logs.appendChild(row);
      logs.scrollTop = logs.scrollHeight;
    });

    function paintInventory(items) {
      const grid = document.getElementById('inventoryDisplay');
      grid.innerHTML = '';
      for (let i = 0; i < 36; i++) {
        const slot = document.createElement('div');
        slot.className = 'inv-slot' + (i >= 27 ? ' hotbar' : '');
        const mapped = (i < 9) ? (i + 36) : i;
        const item = items.find(x => x.slot === mapped);

        if (item) {
          const nameSpan = document.createElement('span');
          nameSpan.className = 'inv-name';
          nameSpan.innerText = item.name.replace(/_/g, ' ');
          slot.appendChild(nameSpan);

          if (item.count > 1) {
            const qtySpan = document.createElement('span');
            qtySpan.className = 'inv-qty';
            qtySpan.innerText = item.count;
            slot.appendChild(qtySpan);
          }
        }
        grid.appendChild(slot);
      }
    }

    function paintRadar(center, yaw, entities) {
      ctx.fillStyle = '#04060a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const scale = 3.8;

      // Concentric Range Rings
      ctx.strokeStyle = '#1e2638';
      ctx.lineWidth = 1;
      [30, 60, 90, 120].forEach(r => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Crosshairs
      ctx.beginPath();
      ctx.moveTo(cx, cy - 130); ctx.lineTo(cx, cy + 130);
      ctx.moveTo(cx - 130, cy); ctx.lineTo(cx + 130, cy);
      ctx.stroke();

      // Plot Nearby Entities
      if (entities && entities.length) {
        entities.forEach(e => {
          const rx = cx + (e.x - center.x) * scale;
          const ry = cy + (e.z - center.z) * scale;

          if (e.isPlayer) {
            ctx.fillStyle = '#00d2ff';
            ctx.beginPath();
            ctx.arc(rx, ry, 4, 0, Math.PI * 2);
            ctx.fill();
          } else if (e.isHostile) {
            ctx.fillStyle = '#ff416c';
            ctx.beginPath();
            ctx.arc(rx, ry, 4, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = '#94a3b8';
            ctx.fillRect(rx - 2, ry - 2, 3, 3);
          }
        });
      }

      // Bot Self Indicator with Direction Vector
      ctx.fillStyle = '#00f260';
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();

      if (yaw !== undefined) {
        ctx.strokeStyle = '#00f260';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx - Math.sin(yaw) * 16, cy + Math.cos(yaw) * 16);
        ctx.stroke();
      }
    }

    function sendAction(cmd) {
      socket.emit('dispatch', cmd);
    }

    function move(dir) {
      socket.emit('manual_move', dir);
    }

    function transmitPrompt() {
      const input = document.getElementById('terminalInput');
      if (input.value.trim()) {
        sendAction(input.value.trim());
        input.value = '';
      }
    }
  </script>
</body>
</html>`);
  });

  // State Broadcaster
  setInterval(() => {
    if (!currentActiveBot || !currentActiveBot.entity) return;

    const inventoryItems = currentActiveBot.inventory.items().map(i => ({
      slot: i.slot,
      name: i.name,
      count: i.count
    }));

    const hostileList = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'drowned', 'husk', 'stray'];
    const entities = Object.values(currentActiveBot.entities)
      .filter(e => e !== currentActiveBot.entity && e.position && currentActiveBot.entity.position.distanceTo(e.position) <= 32)
      .map(e => ({
        x: e.position.x,
        z: e.position.z,
        isPlayer: e.type === 'player',
        isHostile: hostileList.includes(e.name)
      }));

    io.emit('bot_sync', {
      username: currentActiveBot.username,
      coords: currentActiveBot.entity.position,
      yaw: currentActiveBot.entity.yaw,
      health: currentActiveBot.health,
      food: currentActiveBot.food,
      inventory: inventoryItems,
      entities: entities
    });
  }, 1000);

  io.on('connection', (sock) => {
    sock.on('dispatch', (cmd) => {
      if (currentActiveBot) {
        currentActiveBot.emit('handle_cmd', cmd);
      }
    });

    sock.on('manual_move', (dir) => {
      if (currentActiveBot) {
        handleManualMove(currentActiveBot, dir);
      }
    });
  });

  server.listen(WEB_PORT, () => console.log(`[TACTICAL CONSOLE ACTIVE] Port: ${WEB_PORT}`));
}

// ---------------------------------------------------------------------------
// 3. MAIN DAEMON PROCESS
// ---------------------------------------------------------------------------
function launchBot() {
  const bot = mineflayer.createBot({
    host: process.argv[2] || 'DG_LAND502.aternos.me',
    port: parseInt(process.argv[3], 10) || 62974,
    username: process.argv[4] || 'Nokar',
    checkTimeoutInterval: 120000,
    version: false
  });

  currentActiveBot = bot;

  bot.once('spawn', () => {
    console.log(`[AGENT LIVE] ${bot.username} entered the server.`);
    bot.chat("Tactical Unit Active. Commands: afk, dropall");
  });

  // In-Game Chat Listener
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    executeCommand(message);
  });

  // Terminal Relay
  bot.on('handle_cmd', (cmdStr) => {
    executeCommand(cmdStr);
  });

  function executeCommand(cmdText) {
    const clean = cmdText.trim();
    const lower = clean.toLowerCase();

    if (lower === 'afk') {
      toggleAntiAfk(bot);
    } else if (lower === 'dropall') {
      dropAllInventory(bot);
    } else {
      // General chat broadcast
      if (clean) bot.chat(clean);
    }
  }

  bot.on('end', () => {
    console.log('[RECONNECT] Connection ended. Reconnecting in 10s...');
    setTimeout(launchBot, 10000);
  });

  bot.on('error', (err) => {
    console.error('[CRITICAL BOT ERROR]', err.message);
  });
}

// Start Web Console instantly for Render port binding, then spawn bot
startWebConsole();
launchBot();
