/**
 * ============================================================================
 * TACTICAL BOT OPERATIONS MATRIX (STABLE CLEAN EDITION)
 * HOST: Aternos (DG_LAND502.aternos.me:62974)
 * FEATURES: Radar, Clean 36-Slot Grid, D-Pad + Action Controls, Anti-AFK, Terminal
 * ============================================================================
 */

const mineflayer = require('mineflayer');
const http = require('http');
const express = require('express');
const socketIo = require('socket.io');

const WEB_PORT = process.env.PORT || 3000;
let currentActiveBot = null;
let ioInstance = null;

// Global State
const botState = {
  antiAfk: false,
  antiAfkInterval: null
};

// ---------------------------------------------------------------------------
// 1. CORE UTILITIES & ACTIONS
// ---------------------------------------------------------------------------
function toggleAntiAfk(bot) {
  botState.antiAfk = !botState.antiAfk;
  if (botState.antiAfk) {
    bot.chat("Anti-AFK: ON");
    botState.antiAfkInterval = setInterval(async () => {
      if (!botState.antiAfk) return;
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      const randomYaw = Math.random() * Math.PI * 2;
      await bot.look(randomYaw, 0, true).catch(() => {});
    }, 7000);
  } else {
    bot.chat("Anti-AFK: OFF");
    if (botState.antiAfkInterval) {
      clearInterval(botState.antiAfkInterval);
      botState.antiAfkInterval = null;
    }
    bot.clearControlStates();
  }
}

async function dropAllInventory(bot) {
  bot.chat("Dropping all inventory items...");
  const items = bot.inventory.items();
  for (const item of items) {
    try {
      await bot.tossStack(item);
      await bot.waitForTicks(2);
    } catch (e) {}
  }
  bot.chat("Inventory empty!");
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

async function handleAction(bot, actionType) {
  if (!bot || !bot.entity) return;
  try {
    if (actionType === 'break') {
      // Break block directly in front of crosshair (raycast up to 4 blocks)
      const targetBlock = bot.blockAtCursor(4);
      if (targetBlock && targetBlock.name !== 'air') {
        await bot.dig(targetBlock).catch(() => {});
      } else {
        // Fallback: swing arm / punch
        bot.swingArm('right');
      }
    } else if (actionType === 'interact') {
      // Place block / use item in hand / interact with entity
      const targetBlock = bot.blockAtCursor(4);
      if (targetBlock && targetBlock.name !== 'air') {
        await bot.activateBlock(targetBlock).catch(() => {});
      } else {
        bot.activateItem();
      }
    }
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// 2. EXPANDED CLEAN WEB OPERATIONS DASHBOARD
// ---------------------------------------------------------------------------
function startWebConsole() {
  const app = express();
  const server = http.createServer(app);
  ioInstance = socketIo(server, { cors: { origin: "*" } });

  app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tactical Bot Operations Matrix</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #131926;
      --border: #232c3d;
      --accent: #00d2ff;
      --accent-hover: #3a7bd5;
      --green: #00f260;
      --red: #ff416c;
      --gold: #f7971e;
      --text: #e2e8f0;
      --text-muted: #8b9bb4;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 20px;
    }

    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      max-width: 1300px;
      margin: 0 auto 20px auto;
      border-bottom: 1px solid var(--border);
      padding-bottom: 14px;
    }

    .header-bar h1 {
      font-size: 1.4rem;
      color: var(--accent);
      letter-spacing: 0.5px;
    }

    .status-tag {
      background: rgba(0, 242, 96, 0.15);
      border: 1px solid var(--green);
      color: var(--green);
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 600;
    }

    .container {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 16px;
      max-width: 1300px;
      margin: 0 auto;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }

    .card h2 {
      font-size: 1rem;
      color: var(--accent);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
    }

    .col-4 { grid-column: span 4; }
    .col-8 { grid-column: span 8; }
    .col-12 { grid-column: span 12; }

    @media (max-width: 992px) {
      .col-4, .col-8 { grid-column: span 12; }
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 10px;
      background: #0d121c;
      border-radius: 6px;
      margin-bottom: 8px;
      font-size: 0.9rem;
    }

    .info-row span { color: var(--text-muted); }

    button {
      background: #1c2436;
      color: var(--text);
      border: 1px solid var(--border);
      padding: 10px 14px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    button:hover {
      background: var(--accent-hover);
      border-color: var(--accent);
      color: #fff;
    }

    button.btn-danger {
      border-color: rgba(255, 65, 108, 0.4);
      color: var(--red);
    }

    button.btn-danger:hover {
      background: var(--red);
      color: #fff;
    }

    /* CONTROLLER D-PAD */
    .dpad-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      max-width: 200px;
      margin: 0 auto 12px auto;
    }

    .action-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 10px;
    }

    /* RADAR */
    #radarCanvas {
      background: #060910;
      border: 1px solid var(--border);
      border-radius: 6px;
      width: 100%;
      height: 260px;
      display: block;
    }

    .radar-legend {
      display: flex;
      justify-content: space-around;
      font-size: 0.75rem;
      margin-top: 8px;
      color: var(--text-muted);
    }

    /* INVENTORY */
    .inventory-container {
      display: grid;
      grid-template-columns: repeat(9, 1fr);
      gap: 6px;
      background: #060910;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
    }

    .slot {
      aspect-ratio: 1;
      background: #111723;
      border: 1px solid var(--border);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      position: relative;
      text-align: center;
      padding: 2px;
    }

    .slot.hotbar {
      border-color: var(--accent);
      background: rgba(0, 210, 255, 0.05);
    }

    .slot-qty {
      position: absolute;
      bottom: 2px;
      right: 4px;
      font-weight: 800;
      color: #fff;
      font-size: 0.75rem;
      text-shadow: 1px 1px 2px #000;
    }

    /* TERMINAL */
    .log-box {
      height: 140px;
      background: #060910;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .log-line { border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 2px; }

    .input-form {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }

    .input-form input {
      flex: 1;
      background: #060910;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: #fff;
      padding: 10px;
      font-family: monospace;
    }

    .input-form input:focus {
      outline: none;
      border-color: var(--accent);
    }
  </style>
</head>
<body>

  <div class="header-bar">
    <h1>⚡ NOKAR OPERATIONS MATRIX</h1>
    <div class="status-tag" id="statusPill">CONNECTED</div>
  </div>

  <div class="container">

    <!-- VITALS CARD -->
    <div class="card col-4">
      <h2>Bot Vitals</h2>
      <div class="info-row"><span>Identity:</span><strong id="botName">Nokar</strong></div>
      <div class="info-row"><span>Position:</span><strong id="botCoords">0, 0, 0</strong></div>
      <div class="info-row"><span>Health:</span><strong id="botHp" style="color:var(--green)">20 / 20</strong></div>
      <div class="info-row"><span>Food:</span><strong id="botFood" style="color:var(--gold)">20 / 20</strong></div>

      <div style="display:flex; flex-direction:column; gap:8px; margin-top:12px;">
        <button onclick="dispatchCmd('afk')">🔄 Toggle Anti-AFK</button>
        <button class="btn-danger" onclick="dispatchCmd('dropall')">🗑️ Drop All Inventory</button>
      </div>
    </div>

    <!-- RADAR CARD -->
    <div class="card col-8">
      <h2>Perimeter Radar (32m)</h2>
      <canvas id="radarCanvas" width="500" height="260"></canvas>
      <div class="radar-legend">
        <span>🟢 Self Position</span>
        <span>🔵 Players</span>
        <span>🔴 Hostiles</span>
        <span>⚪ Passives</span>
      </div>
    </div>

    <!-- MANUAL CONTROLLER -->
    <div class="card col-4">
      <h2>Locomotion & Action</h2>
      <div class="dpad-grid">
        <div></div>
        <button onclick="sendMove('forward')">⬆️</button>
        <div></div>
        <button onclick="sendMove('left')">⬅️</button>
        <button onclick="sendMove('jump')">🦘</button>
        <button onclick="sendMove('right')">➡️</button>
        <div></div>
        <button onclick="sendMove('back')">⬇️</button>
        <div></div>
      </div>
      <div class="action-row">
        <button onclick="sendAct('break')">⛏️ Left Click (Break)</button>
        <button onclick="sendAct('interact')">✋ Right Click (Use)</button>
      </div>
    </div>

    <!-- IN-GAME TERMINAL -->
    <div class="card col-8">
      <h2>Terminal & In-Game Chat</h2>
      <div class="log-box" id="logs"></div>
      <form class="input-form" onsubmit="event.preventDefault(); transmit();">
        <input type="text" id="termInput" placeholder="Command or in-game message (e.g. hello, afk, dropall)..." />
        <button type="submit">Transmit</button>
      </form>
    </div>

    <!-- 36-SLOT INVENTORY -->
    <div class="card col-12">
      <h2>Live Container Matrix (Slots 0 - 35)</h2>
      <div class="inventory-container" id="invMatrix"></div>
    </div>

  </div>

  <script>
    const socket = io();
    const cvs = document.getElementById('radarCanvas');
    const ctx = cvs.getContext('2d');

    socket.on('bot_sync', (d) => {
      document.getElementById('botName').innerText = d.username || 'Nokar';
      document.getElementById('botCoords').innerText = Math.round(d.coords.x) + ', ' + Math.round(d.coords.y) + ', ' + Math.round(d.coords.z);
      document.getElementById('botHp').innerText = Math.round(d.health) + ' / 20';
      document.getElementById('botFood').innerText = Math.round(d.food) + ' / 20';

      renderInventory(d.inventory);
      renderRadar(d.coords, d.yaw, d.entities);
    });

    socket.on('chat_relay', (text) => {
      const box = document.getElementById('logs');
      const row = document.createElement('div');
      row.className = 'log-line';
      row.innerText = text;
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
    });

    function renderInventory(items) {
      const c = document.getElementById('invMatrix');
      c.innerHTML = '';
      for (let i = 0; i < 36; i++) {
        const slot = document.createElement('div');
        slot.className = 'slot' + (i >= 27 ? ' hotbar' : '');
        const mapped = (i < 9) ? (i + 36) : i;
        const it = items.find(x => x.slot === mapped);
        if (it) {
          slot.innerText = it.name.replace(/_/g, ' ').slice(0, 10);
          if (it.count > 1) {
            const q = document.createElement('span');
            q.className = 'slot-qty';
            q.innerText = it.count;
            slot.appendChild(q);
          }
        }
        c.appendChild(slot);
      }
    }

    function renderRadar(self, yaw, entities) {
      ctx.fillStyle = '#060910';
      ctx.fillRect(0, 0, cvs.width, cvs.height);
      const cx = cvs.width / 2;
      const cy = cvs.height / 2;
      const scale = 3.8;

      ctx.strokeStyle = '#1a2334';
      [30, 60, 90, 120].forEach(r => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Self
      ctx.fillStyle = '#00f260';
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();

      // Heading line
      if (yaw !== undefined) {
        ctx.strokeStyle = '#00f260';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx - Math.sin(yaw) * 16, cy + Math.cos(yaw) * 16);
        ctx.stroke();
      }

      // Entities
      if (entities) {
        entities.forEach(e => {
          const rx = cx + (e.x - self.x) * scale;
          const ry = cy + (e.z - self.z) * scale;
          ctx.fillStyle = e.isPlayer ? '#00d2ff' : (e.isHostile ? '#ff416c' : '#8b9bb4');
          ctx.beginPath();
          ctx.arc(rx, ry, 3.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }

    function dispatchCmd(cmd) { socket.emit('terminal_cmd', cmd); }
    function sendMove(dir) { socket.emit('manual_move', dir); }
    function sendAct(type) { socket.emit('manual_action', type); }

    function transmit() {
      const inp = document.getElementById('termInput');
      if (inp.value.trim()) {
        dispatchCmd(inp.value.trim());
        inp.value = '';
      }
    }
  </script>
</body>
</html>`);
  });

  // State Broadcast interval (1s)
  setInterval(() => {
    if (!currentActiveBot || !currentActiveBot.entity) return;

    const items = currentActiveBot.inventory.items().map(i => ({
      slot: i.slot,
      name: i.name,
      count: i.count
    }));

    const hostileNames = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'drowned', 'husk', 'stray'];
    const entities = Object.values(currentActiveBot.entities)
      .filter(e => e !== currentActiveBot.entity && e.position && currentActiveBot.entity.position.distanceTo(e.position) <= 32)
      .map(e => ({
        x: e.position.x,
        z: e.position.z,
        isPlayer: e.type === 'player',
        isHostile: hostileNames.includes(e.name)
      }));

    ioInstance.emit('bot_sync', {
      username: currentActiveBot.username,
      coords: currentActiveBot.entity.position,
      yaw: currentActiveBot.entity.yaw,
      health: currentActiveBot.health || 20,
      food: currentActiveBot.food || 20,
      inventory: items,
      entities: entities
    });
  }, 1000);

  ioInstance.on('connection', (sock) => {
    sock.on('terminal_cmd', (cmd) => {
      if (currentActiveBot) currentActiveBot.emit('execute_cmd', cmd);
    });
    sock.on('manual_move', (dir) => {
      if (currentActiveBot) handleManualMove(currentActiveBot, dir);
    });
    sock.on('manual_action', (type) => {
      if (currentActiveBot) handleAction(currentActiveBot, type);
    });
  });

  server.listen(WEB_PORT, () => console.log(`[OPERATIONS WEB ACTIVE] Bound to Port: ${WEB_PORT}`));
}

// ---------------------------------------------------------------------------
// 3. MAIN BOT ENGINE
// ---------------------------------------------------------------------------
function launchBot() {
  const HOST = process.argv[2] || 'DG_LAND502.aternos.me';
  const PORT = parseInt(process.argv[3], 10) || 62974;
  const USER = process.argv[4] || 'Nokar';

  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USER,
    checkTimeoutInterval: 120000,
    version: false
  });

  currentActiveBot = bot;

  bot.once('spawn', () => {
    console.log(`[AGENT LIVE] ${bot.username} spawned safely.`);
    bot.chat("Tactical Unit Active. Commands: afk, dropall");
  });

  // Chat message relay to web logs
  bot.on('messagestr', (message) => {
    if (ioInstance) {
      ioInstance.emit('chat_relay', message);
    }
  });

  // Handle command from Web Terminal or In-Game Chat
  bot.on('execute_cmd', (cmdStr) => handleCommand(cmdStr));
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    handleCommand(message);
  });

  function handleCommand(cmdText) {
    const clean = cmdText.trim();
    const lower = clean.toLowerCase();

    if (lower === 'afk') {
      toggleAntiAfk(bot);
    } else if (lower === 'dropall') {
      dropAllInventory(bot);
    } else {
      // Broadcast any custom chat message or server command directly
      if (clean) bot.chat(clean);
    }
  }

  bot.on('end', () => {
    console.log('[RECONNECT] Connection ended. Retrying in 10s...');
    setTimeout(launchBot, 10000);
  });

  bot.on('error', (err) => {
    console.error('[CRITICAL BOT ERROR]', err.message);
  });
}

// Web Server binds instantly so Render port-scan succeeds, then launch Bot
startWebConsole();
launchBot();
