/**
 * ============================================================================
 * PROJECT: TACTICAL MINECRAFT SURVIVAL MATRIX (STABLE CRASH-PROOF CORE)
 * TARGET HOST: DG_LAND502.aternos.me:62974
 * ============================================================================
 */

const mineflayer = require('mineflayer');
const http = require('http');
const express = require('express');
const socketIo = require('socket.io');

const WEB_PORT = process.env.PORT || 3000;
const SERVER_HOST = 'DG_LAND502.aternos.me';
const SERVER_PORT = 62974;
const BOT_NAME = 'Nokar';

let currentActiveBot = null;
let ioInstance = null;

// Base Map Colors Palette for 128x128 decoding
const MAP_BASE_COLORS = [
  [0, 0, 0], [127, 178, 56], [247, 233, 163], [199, 199, 199],
  [255, 0, 0], [160, 160, 255], [167, 167, 167], [0, 124, 0],
  [255, 255, 255], [164, 168, 184], [151, 109, 77], [112, 112, 112],
  [64, 64, 255], [143, 119, 72], [255, 252, 245], [216, 127, 51],
  [178, 76, 216], [102, 153, 216], [229, 229, 51], [127, 204, 25],
  [242, 127, 165], [76, 76, 76], [153, 153, 153], [76, 127, 153],
  [127, 63, 178], [51, 76, 178], [102, 76, 51], [102, 127, 51],
  [153, 51, 51], [25, 25, 25], [250, 238, 77], [92, 219, 213],
  [74, 128, 255], [0, 217, 58], [129, 86, 49], [112, 2, 0]
];

const botState = {
  antiAfk: false,
  antiAfkInterval: null
};

function safeChat(bot, msg) {
  if (bot && typeof bot.chat === 'function') {
    try {
      bot.chat(msg);
    } catch (e) {}
  }
}

function toggleAntiAfk(bot) {
  botState.antiAfk = !botState.antiAfk;
  if (botState.antiAfk) {
    safeChat(bot, "Anti-AFK: ON");
    botState.antiAfkInterval = setInterval(async () => {
      if (!botState.antiAfk || !bot || !bot.entity) return;
      try {
        bot.setControlState('jump', true);
        setTimeout(() => { if (bot && bot.setControlState) bot.setControlState('jump', false); }, 250);
        const randomYaw = Math.random() * Math.PI * 2;
        await bot.look(randomYaw, 0, true).catch(() => {});
      } catch (err) {}
    }, 6500);
  } else {
    safeChat(bot, "Anti-AFK: OFF");
    if (botState.antiAfkInterval) {
      clearInterval(botState.antiAfkInterval);
      botState.antiAfkInterval = null;
    }
    if (bot && bot.clearControlStates) bot.clearControlStates();
  }
}

async function dropAllInventory(bot) {
  if (!bot || !bot.inventory) return;
  safeChat(bot, "Dropping all items...");
  const items = bot.inventory.items();
  for (const item of items) {
    try {
      await bot.tossStack(item);
      await bot.waitForTicks(2);
    } catch (err) {}
  }
  safeChat(bot, "Inventory empty!");
}

function handleManualMove(bot, dir) {
  if (!bot || !bot.entity) return;
  if (dir === 'jump') {
    bot.setControlState('jump', true);
    setTimeout(() => { if (bot && bot.setControlState) bot.setControlState('jump', false); }, 300);
  } else if (['forward', 'back', 'left', 'right'].includes(dir)) {
    bot.setControlState(dir, true);
    setTimeout(() => { if (bot && bot.setControlState) bot.setControlState(dir, false); }, 350);
  }
}

async function handleAction(bot, actionType) {
  if (!bot || !bot.entity) return;
  try {
    if (actionType === 'break') {
      const targetBlock = bot.blockAtCursor(4);
      if (targetBlock && targetBlock.name !== 'air') {
        await bot.dig(targetBlock).catch(() => {});
      } else {
        bot.swingArm('right');
      }
    } else if (actionType === 'interact') {
      const targetBlock = bot.blockAtCursor(4);
      if (targetBlock && targetBlock.name !== 'air') {
        await bot.activateBlock(targetBlock).catch(() => {});
      } else {
        bot.activateItem();
      }
    }
  } catch (err) {}
}

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
  <title>Nokar Tactical Operations Matrix</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg: #07090e;
      --card-bg: rgba(18, 24, 38, 0.95);
      --border: #1f2b42;
      --accent-cyan: #00d2ff;
      --accent-blue: #3a7bd5;
      --accent-green: #00f260;
      --accent-red: #ff416c;
      --accent-gold: #f7971e;
      --text: #e2e8f0;
      --text-muted: #8493a8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      padding: 18px;
      min-height: 100vh;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      max-width: 1400px;
      margin: 0 auto 18px auto;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
    }
    .header-bar h1 {
      font-size: 1.4rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent-cyan), var(--accent-blue));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .status-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(0, 242, 96, 0.12);
      border: 1px solid var(--accent-green);
      color: var(--accent-green);
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 700;
    }
    .pulse {
      width: 7px;
      height: 7px;
      background: var(--accent-green);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent-green);
    }
    .container {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 16px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    }
    .card h2 {
      font-size: 0.95rem;
      color: var(--accent-cyan);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      text-transform: uppercase;
    }
    .col-4 { grid-column: span 4; }
    .col-5 { grid-column: span 5; }
    .col-3 { grid-column: span 3; }
    .col-8 { grid-column: span 8; }
    .col-12 { grid-column: span 12; }
    @media (max-width: 1024px) {
      .col-4, .col-5, .col-3, .col-8 { grid-column: span 12; }
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 10px;
      background: #0b0f17;
      border: 1px solid rgba(255, 255, 255, 0.03);
      border-radius: 6px;
      margin-bottom: 8px;
      font-size: 0.88rem;
    }
    .info-row span { color: var(--text-muted); }
    .info-row strong { font-family: monospace; }
    button {
      background: #141c2c;
      color: var(--text);
      border: 1px solid var(--border);
      padding: 10px 14px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    button:hover { background: var(--accent-blue); border-color: var(--accent-cyan); color: #fff; }
    button.btn-danger { border-color: rgba(255, 65, 108, 0.4); color: var(--accent-red); }
    button.btn-danger:hover { background: var(--accent-red); color: #fff; }
    .dpad-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      max-width: 180px;
      margin: 0 auto 12px auto;
    }
    .action-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 10px;
    }
    #radarCanvas {
      background: #04060a;
      border: 1px solid var(--border);
      border-radius: 6px;
      width: 100%;
      height: 240px;
      display: block;
    }
    #mapCanvas {
      background: #000;
      border: 2px solid var(--accent-gold);
      border-radius: 6px;
      width: 128px;
      height: 128px;
      image-rendering: pixelated;
      display: block;
      margin: 0 auto 10px auto;
    }
    .held-item-display {
      background: #04060a;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      text-align: center;
      font-weight: bold;
      color: #fff;
    }
    .inventory-container {
      display: grid;
      grid-template-columns: repeat(9, 1fr);
      gap: 6px;
      background: #05080e;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .slot {
      aspect-ratio: 1;
      background: #0e1420;
      border: 1px solid var(--border);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.68rem;
      position: relative;
      text-align: center;
      padding: 2px;
    }
    .slot.hotbar { border-color: var(--accent-cyan); background: rgba(0, 210, 255, 0.06); }
    .slot-qty { position: absolute; bottom: 2px; right: 3px; font-weight: 800; font-size: 0.75rem; }
    .log-box {
      height: 150px;
      background: #04060a;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 0.82rem;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .log-line { border-bottom: 1px solid rgba(255, 255, 255, 0.03); padding-bottom: 2px; }
    .input-form { display: flex; gap: 8px; margin-top: 10px; }
    .input-form input {
      flex: 1;
      background: #04060a;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: #fff;
      padding: 10px;
      font-family: monospace;
    }
  </style>
</head>
<body>

  <div class="header-bar">
    <h1>⚡ NOKAR TACTICAL MATRIX</h1>
    <div style="display:flex; gap:10px; align-items:center;">
      <button onclick="toggleFullScreen()">⛶ Fullscreen</button>
      <div class="status-badge"><div class="pulse"></div><span id="statusPill">ONLINE</span></div>
    </div>
  </div>

  <div class="container">
    <div class="card col-4">
      <h2>Bot Diagnostics</h2>
      <div class="info-row"><span>Unit Name:</span><strong id="botName">Nokar</strong></div>
      <div class="info-row"><span>Target Server:</span><strong id="serverInfo">DG_LAND502.aternos.me:62974</strong></div>
      <div class="info-row"><span>Coordinates:</span><strong id="botCoords">0, 0, 0</strong></div>
      <div class="info-row"><span>Armor HP:</span><strong id="botHp" style="color:var(--accent-green)">20 / 20</strong></div>
      <div class="info-row"><span>Food Level:</span><strong id="botFood" style="color:var(--accent-gold)">20 / 20</strong></div>
      <div style="display:flex; flex-direction:column; gap:8px; margin-top:12px;">
        <button onclick="dispatchCmd('afk')">🔄 Toggle Anti-AFK Mode</button>
        <button class="btn-danger" onclick="dispatchCmd('dropall')">🗑️ Dump All Inventory</button>
      </div>
    </div>

    <div class="card col-5">
      <h2>Perimeter 2D Radar</h2>
      <canvas id="radarCanvas" width="400" height="240"></canvas>
    </div>

    <div class="card col-3">
      <h2>Currently In Hand</h2>
      <canvas id="mapCanvas" width="128" height="128"></canvas>
      <div class="held-item-display" id="heldItemDisplay">Held: None</div>
    </div>

    <div class="card col-4">
      <h2>Locomotion & Action</h2>
      <div class="dpad-grid">
        <div></div><button onclick="sendMove('forward')">⬆️</button><div></div>
        <button onclick="sendMove('left')">⬅️</button>
        <button onclick="sendMove('jump')" style="background:#1e293b; border-color:var(--accent-cyan);">🦘</button>
        <button onclick="sendMove('right')">➡️</button>
        <div></div><button onclick="sendMove('back')">⬇️</button><div></div>
      </div>
      <div class="action-row">
        <button onclick="sendAct('break')">⛏️ Left Click</button>
        <button onclick="sendAct('interact')">✋ Right Click</button>
      </div>
    </div>

    <div class="card col-8">
      <h2>In-Game Chat Stream & Terminal</h2>
      <div class="log-box" id="logs"></div>
      <form class="input-form" onsubmit="event.preventDefault(); transmit();">
        <input type="text" id="termInput" placeholder="Command or chat (e.g. /login pass, hello)..." />
        <button type="submit" style="background:var(--accent-blue);">Transmit</button>
      </form>
    </div>

    <div class="card col-12">
      <h2>Live Container Matrix (Slots 0 - 35)</h2>
      <div class="inventory-container" id="invMatrix"></div>
    </div>
  </div>

  <script>
    const socket = io();
    const cvs = document.getElementById('radarCanvas');
    const ctx = cvs.getContext('2d');
    const mapCvs = document.getElementById('mapCanvas');
    const mCtx = mapCvs.getContext('2d');

    mCtx.fillStyle = '#1f2b42';
    mCtx.fillRect(0, 0, 128, 128);

    function toggleFullScreen() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    }

    socket.on('bot_sync', (d) => {
      document.getElementById('botName').innerText = d.username || 'Nokar';
      document.getElementById('botCoords').innerText = Math.round(d.coords.x) + ', ' + Math.round(d.coords.y) + ', ' + Math.round(d.coords.z);
      document.getElementById('botHp').innerText = Math.round(d.health) + ' / 20';
      document.getElementById('botFood').innerText = Math.round(d.food) + ' / 20';
      document.getElementById('heldItemDisplay').innerText = 'Held: ' + (d.heldItem ? d.heldItem.replace(/_/g, ' ') : 'None');
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

    socket.on('captcha_map_render', (pixelData) => {
      if (!pixelData || !pixelData.length) return;
      const imgData = mCtx.createImageData(128, 128);
      for (let i = 0; i < pixelData.length; i++) {
        imgData.data[i * 4] = pixelData[i][0];
        imgData.data[i * 4 + 1] = pixelData[i][1];
        imgData.data[i * 4 + 2] = pixelData[i][2];
        imgData.data[i * 4 + 3] = 255;
      }
      mCtx.putImageData(imgData, 0, 0);
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
      ctx.fillStyle = '#04060a';
      ctx.fillRect(0, 0, cvs.width, cvs.height);
      const cx = cvs.width / 2, cy = cvs.height / 2, scale = 3.6;
      ctx.strokeStyle = '#141c2b';
      [30, 60, 90, 120].forEach(r => {
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      });
      ctx.fillStyle = '#00f260';
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
      if (yaw !== undefined) {
        ctx.strokeStyle = '#00f260';
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx - Math.sin(yaw) * 16, cy + Math.cos(yaw) * 16);
        ctx.stroke();
      }
      if (entities) {
        entities.forEach(e => {
          const rx = cx + (e.x - self.x) * scale;
          const ry = cy + (e.z - self.z) * scale;
          ctx.fillStyle = e.isPlayer ? '#00d2ff' : (e.isHostile ? '#ff416c' : '#8493a8');
          ctx.beginPath(); ctx.arc(rx, ry, 3.5, 0, Math.PI * 2); ctx.fill();
        });
      }
    }

    function dispatchCmd(cmd) { socket.emit('terminal_cmd', cmd); }
    function sendMove(dir) { socket.emit('manual_move', dir); }
    function sendAct(type) { socket.emit('manual_action', type); }
    function transmit() {
      const inp = document.getElementById('termInput');
      if (inp.value.trim()) { dispatchCmd(inp.value.trim()); inp.value = ''; }
    }
  </script>
</body>
</html>`);
  });

  setInterval(() => {
    if (!currentActiveBot || !currentActiveBot.entity) return;
    const items = currentActiveBot.inventory.items().map(i => ({ slot: i.slot, name: i.name, count: i.count }));
    const hostileNames = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'drowned', 'husk', 'stray'];
    const entities = Object.values(currentActiveBot.entities)
      .filter(e => e !== currentActiveBot.entity && e.position && currentActiveBot.entity.position.distanceTo(e.position) <= 32)
      .map(e => ({ x: e.position.x, z: e.position.z, isPlayer: e.type === 'player', isHostile: hostileNames.includes(e.name) }));

    ioInstance.emit('bot_sync', {
      username: currentActiveBot.username,
      coords: currentActiveBot.entity.position,
      yaw: currentActiveBot.entity.yaw,
      health: currentActiveBot.health || 20,
      food: currentActiveBot.food || 20,
      inventory: items,
      entities: entities,
      heldItem: currentActiveBot.heldItem ? currentActiveBot.heldItem.name : null
    });
  }, 1000);

  ioInstance.on('connection', (sock) => {
    sock.on('terminal_cmd', (cmd) => { if (currentActiveBot) currentActiveBot.emit('execute_cmd', cmd); });
    sock.on('manual_move', (dir) => { if (currentActiveBot) handleManualMove(currentActiveBot, dir); });
    sock.on('manual_action', (type) => { if (currentActiveBot) handleAction(currentActiveBot, type); });
  });

  server.listen(WEB_PORT, () => console.log(`[OPERATIONS DASHBOARD ONLINE] Bound to Web Port: ${WEB_PORT}`));
}

function launchBot() {
  console.log(`[CONNECTING] Connecting to ${SERVER_HOST}:${SERVER_PORT}...`);

  const bot = mineflayer.createBot({
    host: SERVER_HOST,
    port: SERVER_PORT,
    username: BOT_NAME,
    checkTimeoutInterval: 120000,
    closeTimeout: 120000,
    noPongTimeout: 120000
  });

  currentActiveBot = bot;

  bot.once('spawn', () => {
    console.log(`[AGENT LIVE] ${bot.username} entered the server successfully!`);
    safeChat(bot, "Tactical Unit Active. Commands: afk, dropall");

    if (bot._client) {
      bot._client.on('map', (packet) => {
        if (!packet || !packet.data || !ioInstance) return;
        try {
          const rawPixels = packet.data;
          const rgbBuffer = [];
          for (let i = 0; i < rawPixels.length; i++) {
            const colorId = rawPixels[i];
            const baseColor = MAP_BASE_COLORS[Math.floor(colorId / 4)] || [0, 0, 0];
            const shade = [180, 220, 255, 135][colorId % 4] || 255;
            const r = Math.floor((baseColor[0] * shade) / 255);
            const g = Math.floor((baseColor[1] * shade) / 255);
            const b = Math.floor((baseColor[2] * shade) / 255);
            rgbBuffer.push([r, g, b]);
          }
          ioInstance.emit('captcha_map_render', rgbBuffer);
        } catch (err) {}
      });
    }
  });

  bot.on('messagestr', (message) => {
    if (ioInstance) ioInstance.emit('chat_relay', message);
  });

  bot.on('execute_cmd', (cmdStr) => handleCommand(cmdStr));
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    handleCommand(message);
  });

  function handleCommand(cmdText) {
    if (!cmdText) return;
    const clean = cmdText.trim();
    const lower = clean.toLowerCase();
    if (lower === 'afk') {
      toggleAntiAfk(bot);
    } else if (lower === 'dropall') {
      dropAllInventory(bot);
    } else {
      safeChat(bot, clean);
    }
  }

  bot.on('kicked', (reason) => {
    console.warn('[SERVER KICK EVENT]', reason);
    if (ioInstance) ioInstance.emit('chat_relay', `[KICKED]: ${JSON.stringify(reason)}`);
  });

  bot.on('end', (reason) => {
    console.log(`[DISCONNECTED] Reason: ${reason}. Retrying in 10s...`);
    setTimeout(launchBot, 10000);
  });

  bot.on('error', (err) => {
    console.error('[CONNECTION ERROR]', err.message);
  });
}

startWebConsole();
launchBot();
