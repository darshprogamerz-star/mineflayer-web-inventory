/**
 * Advanced Minecraft Web Inventory & Autonomous Agent Core
 * Version: 2.4.0-Production
 * Protocols: Dynamic Minecraft Socket Engine + Web Sockets
 */

const http = require('http');
const path = require('path');
const express = require('express');
const socketIo = require('socket.io');
const _ = require('lodash');
const mineflayer = require('mineflayer');

// Internal Utilities Reference
let getWindowName, addItemData;
try {
  const utils = require('./utils');
  getWindowName = utils.getWindowName;
  addItemData = utils.addItemData;
} catch (e) {
  getWindowName = (w) => w?.type || 'minecraft:inventory';
  addItemData = (mcData, mcAssets, item) => item;
}

const DEFAULT_FALLBACK_VERSION = '1.20.4';

/**
 * Web Inventory Server Plugin Implementation
 */
function webInventoryPlugin(bot, customOptions = {}) {
  const options = {
    webPath: customOptions.webPath || customOptions.path || '/',
    port: customOptions.port || process.env.PORT || 3000,
    windowUpdateDebounceTime: customOptions.windowUpdateDebounceTime || customOptions.debounceTime || 100,
    startOnLoad: customOptions.startOnLoad !== false
  };

  if (!options.webPath.startsWith('/')) {
    options.webPath = '/' + options.webPath;
  }

  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server);

  bot.webInventory = {
    options,
    isRunning: false,
    sockets: new Set()
  };

  const startWebServer = () => {
    return new Promise((resolve, reject) => {
      if (bot.webInventory.isRunning) {
        return reject(new Error('[SYSTEM WARNING] Web inventory daemon is already active.'));
      }

      server.listen(options.port, () => {
        bot.webInventory.isRunning = true;
        console.log(`[HTTP ENGINE] Web GUI successfully attached on port ${options.port}`);
        resolve();
      });
    });
  };

  const stopWebServer = () => {
    return new Promise((resolve, reject) => {
      if (!bot.webInventory.isRunning) {
        return reject(new Error('[SYSTEM WARNING] Web inventory daemon is not active.'));
      }

      server.close(() => {
        bot.webInventory.isRunning = false;
        console.log('[HTTP ENGINE] Web GUI daemon safely unmounted.');
        resolve();
      });
    });
  };

  // Safe Data Resolvers
  let mcData;
  try {
    mcData = require('minecraft-data')(bot.version);
  } catch (err) {
    try {
      mcData = require('minecraft-data')(DEFAULT_FALLBACK_VERSION);
    } catch (e) {}
  }

  let mcAssets;
  try {
    mcAssets = require('minecraft-assets')(bot.version);
  } catch (err) {
    try {
      mcAssets = require('minecraft-assets')(DEFAULT_FALLBACK_VERSION);
    } catch (e) {}
  }

  // Static Assets Pipeline
  app.use(options.webPath, express.static(path.join(__dirname, 'client', 'public')));

  // Socket Pipeline for Live Inventory Synchronization
  io.on('connection', (socket) => {
    bot.webInventory.sockets.add(socket);
    console.log(`[NETWORK CLIENT] Handshake established. Total active clients: ${bot.webInventory.sockets.size}`);

    function broadcastWindow(window) {
      if (!window) return;
      const targetWindow = Object.assign({}, window);
      const windowUpdate = {
        id: targetWindow.id,
        type: getWindowName(targetWindow),
        slots: {}
      };

      if (!windowUpdate.type) {
        windowUpdate.id = bot.inventory.id;
        windowUpdate.type = getWindowName(bot.inventory);
        windowUpdate.slots = Array(9)
          .fill(null, 0, 9)
          .concat(bot.inventory.slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd));
        
        windowUpdate.slots.forEach((item) => {
          if (item) item.slot -= bot.inventory.inventoryStart - 9;
        });

        windowUpdate.unsupported = true;
        windowUpdate.realId = targetWindow.id;
        windowUpdate.realType = targetWindow.type;
      }

      const rawSlots = Object.assign({}, targetWindow.slots || bot.inventory.slots);
      for (const slotKey in rawSlots) {
        if (rawSlots[slotKey] && mcData && mcAssets) {
          rawSlots[slotKey] = addItemData(mcData, mcAssets, rawSlots[slotKey]);
        }
      }

      windowUpdate.slots = rawSlots;
      socket.emit('window', windowUpdate);
    }

    broadcastWindow(bot.currentWindow || bot.inventory);

    let queuedUpdates = { id: null, type: null, slots: {} };

    const dispatchDebouncedUpdate = _.debounce(() => {
      socket.emit('windowUpdate', queuedUpdates);
      queuedUpdates = { id: null, type: null, slots: {} };
    }, bot.webInventory.options.windowUpdateDebounceTime);

    function handleSlotMutation(slot, oldItem, newItem, windowContext) {
      const targetSlot = slot;
      const mutatedOld = oldItem ? Object.assign({}, oldItem) : null;
      let mutatedNew = newItem ? Object.assign({}, newItem) : null;

      if (!getWindowName(windowContext)) {
        queuedUpdates.id = bot.inventory.id;
        queuedUpdates.type = getWindowName(bot.inventory);
        if (mutatedNew) mutatedNew.slot = targetSlot - (bot.inventory.inventoryStart - 9);
      } else {
        if (bot.currentWindow && windowContext.id !== bot.currentWindow.id) return;
        if ((bot.currentWindow || bot.inventory).id !== queuedUpdates.id) {
          queuedUpdates.id = windowContext.id;
          queuedUpdates.type = getWindowName(windowContext);
          queuedUpdates.slots = {};
        }
      }

      if (mutatedNew) {
        mutatedNew.durabilityUsed = windowContext.slots[targetSlot]?.durabilityUsed;
        if (mcData && mcAssets) {
          mutatedNew = addItemData(mcData, mcAssets, mutatedNew);
        }
      }

      queuedUpdates.slots[targetSlot] = mutatedNew;
      dispatchDebouncedUpdate();
    }

    const slotListener = (s, o, n) => handleSlotMutation(s, o, n, bot.inventory);
    bot.inventory.on('updateSlot', slotListener);

    let dynamicWindowTracker;
    const windowOpenRoutine = (windowInstance) => {
      const windowSlotHandler = (s, o, n) => handleSlotMutation(s, o, n, windowInstance);
      const windowCloseHandler = () => {
        broadcastWindow(bot.inventory);
        windowInstance.removeListener('updateSlot', windowSlotHandler);
      };

      if (dynamicWindowTracker && dynamicWindowTracker.id !== bot.inventory.id) {
        dynamicWindowTracker.removeListener('updateSlot', windowSlotHandler);
        dynamicWindowTracker.removeListener('close', windowCloseHandler);
      }
      dynamicWindowTracker = windowInstance;

      broadcastWindow(windowInstance);
      windowInstance.on('updateSlot', windowSlotHandler);
      windowInstance.once('close', windowCloseHandler);
    };

    bot.on('windowOpen', windowOpenRoutine);

    socket.once('disconnect', () => {
      bot.webInventory.sockets.delete(socket);
      dispatchDebouncedUpdate.cancel();
      bot.inventory.removeListener('updateSlot', slotListener);
      bot.removeListener('windowOpen', windowOpenRoutine);
      console.log(`[NETWORK CLIENT] Connection closed. Remaining clients: ${bot.webInventory.sockets.size}`);
    });
  });

  bot.once('end', stopWebServer);

  if (options.startOnLoad) {
    startWebServer().catch((err) => console.error('[HTTP ERROR]', err.message));
  }

  bot.webInventory = {
    ...bot.webInventory,
    start: startWebServer,
    stop: stopWebServer
  };
}

module.exports = webInventoryPlugin;

// Production Process Execution Routine
if (require.main === module) {
  console.log('====================================================');
  console.log('  MINECRAFT CLOUD AGENT WITH VISUAL INTERFACE CORE  ');
  console.log('====================================================');

  function initiateConnectionCycle() {
    const HOST_ENDPOINT = process.argv[2] || 'DG_LAND502.aternos.me';
    const PORT_ENDPOINT = parseInt(process.argv[3], 10) || 62974;
    const BOT_IDENTITY = process.argv[4] || 'Nokar';
    const WEB_PORT = process.env.PORT || 3000;

    console.log(`[CONFIG] Target Node: ${HOST_ENDPOINT}:${PORT_ENDPOINT}`);
    console.log(`[CONFIG] Agent Identifier: ${BOT_IDENTITY}`);
    console.log(`[CONFIG] Local Dynamic Port: ${WEB_PORT}`);

    const clientInstance = mineflayer.createBot({
      host: HOST_ENDPOINT,
      port: PORT_ENDPOINT,
      username: BOT_IDENTITY,
      checkTimeoutInterval: 90000,
      version: false,
      hideErrors: false
    });

    clientInstance.once('spawn', () => {
      console.log(`[GAME EVENT] Connection verified. Bot [${clientInstance.username}] is inside the chunk boundaries.`);
      try {
        module.exports(clientInstance, { port: WEB_PORT });
      } catch (err) {
        console.error('[ATTACHMENT ERROR] Failed to bind inventory:', err.message);
      }
    });

    clientInstance.on('chat', (username, message) => {
      if (username === clientInstance.username) return;
      console.log(`[CHAT INCOMING] <${username}> ${message}`);
    });

    clientInstance.on('kicked', (reason) => {
      console.warn(`[KICK EVENT] Agent was disconnected by server:`, reason);
    });

    clientInstance.on('end', (reason) => {
      console.warn(`[NETWORK ALERT] Stream disconnected (${reason || 'Connection Reset'}). Re-authenticating in 10 seconds...`);
      setTimeout(initiateConnectionCycle, 10000);
    });

    clientInstance.on('error', (fatalError) => {
      console.error(`[EXCEPTION CAUGHT] Socket Layer Fault:`, fatalError.message);
    });
  }

  initiateConnectionCycle();
}
