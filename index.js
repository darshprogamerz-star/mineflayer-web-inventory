/**
 * Advanced Minecraft Web Inventory & Autonomous Agent Core
 * Version: 2.5.0-Production (With Smart Commands)
 */

const http = require('http');
const path = require('path');
const express = require('express');
const socketIo = require('socket.io');
const _ = require('lodash');
const mineflayer = require('mineflayer');

// Smart Plugins Load
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEat = require('mineflayer-auto-eat').plugin;
const pvp = require('mineflayer-pvp').plugin;

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

  if (!options.webPath.startsWith('/')) options.webPath = '/' + options.webPath;

  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server);

  bot.webInventory = { options, isRunning: false, sockets: new Set() };

  const startWebServer = () => {
    return new Promise((resolve, reject) => {
      if (bot.webInventory.isRunning) return reject(new Error('Web inventory already active.'));
      server.listen(options.port, () => {
        bot.webInventory.isRunning = true;
        console.log(`[HTTP ENGINE] Web GUI attached on port ${options.port}`);
        resolve();
      });
    });
  };

  const stopWebServer = () => {
    return new Promise((resolve, reject) => {
      if (!bot.webInventory.isRunning) return reject(new Error('Web inventory not active.'));
      server.close(() => {
        bot.webInventory.isRunning = false;
        resolve();
      });
    });
  };

  let mcData, mcAssets;
  try { mcData = require('minecraft-data')(bot.version); } catch (e) { mcData = require('minecraft-data')(DEFAULT_FALLBACK_VERSION); }
  try { mcAssets = require('minecraft-assets')(bot.version); } catch (e) { mcAssets = require('minecraft-assets')(DEFAULT_FALLBACK_VERSION); }

  app.use(options.webPath, express.static(path.join(__dirname, 'client', 'public')));

  io.on('connection', (socket) => {
    bot.webInventory.sockets.add(socket);

    function broadcastWindow(window) {
      if (!window) return;
      const targetWindow = Object.assign({}, window);
      const windowUpdate = { id: targetWindow.id, type: getWindowName(targetWindow), slots: {} };

      if (!windowUpdate.type) {
        windowUpdate.id = bot.inventory.id;
        windowUpdate.type = getWindowName(bot.inventory);
        windowUpdate.slots = Array(9).fill(null, 0, 9).concat(bot.inventory.slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd));
        windowUpdate.slots.forEach((item) => { if (item) item.slot -= bot.inventory.inventoryStart - 9; });
        windowUpdate.unsupported = true;
        windowUpdate.realId = targetWindow.id;
        windowUpdate.realType = targetWindow.type;
      }

      const rawSlots = Object.assign({}, targetWindow.slots || bot.inventory.slots);
      for (const slotKey in rawSlots) {
        if (rawSlots[slotKey] && mcData && mcAssets) rawSlots[slotKey] = addItemData(mcData, mcAssets, rawSlots[slotKey]);
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
        if (mcData && mcAssets) mutatedNew = addItemData(mcData, mcAssets, mutatedNew);
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
    });
  });

  bot.once('end', stopWebServer);
  if (options.startOnLoad) startWebServer().catch(() => {});
  bot.webInventory = { ...bot.webInventory, start: startWebServer, stop: stopWebServer };
}

module.exports = webInventoryPlugin;

// Production Process Execution Routine
if (require.main === module) {
  function initiateConnectionCycle() {
    const HOST_ENDPOINT = process.argv[2] || 'DG_LAND502.aternos.me';
    const PORT_ENDPOINT = parseInt(process.argv[3], 10) || 62974;
    const BOT_IDENTITY = process.argv[4] || 'Nokar';
    const WEB_PORT = process.env.PORT || 3000;

    const clientInstance = mineflayer.createBot({
      host: HOST_ENDPOINT,
      port: PORT_ENDPOINT,
      username: BOT_IDENTITY,
      checkTimeoutInterval: 90000,
      version: false
    });

    // Load Plugins
    clientInstance.loadPlugin(pathfinder);
    clientInstance.loadPlugin(collectBlock);
    clientInstance.loadPlugin(autoEat);
    clientInstance.loadPlugin(pvp);

    clientInstance.once('spawn', () => {
      console.log(`[GAME EVENT] Bot [${clientInstance.username}] joined!`);
      try { module.exports(clientInstance, { port: WEB_PORT }); } catch (e) {}

      // Setup Movement & Physics
      const mcData = require('minecraft-data')(clientInstance.version);
      const defaultMove = new Movements(clientInstance, mcData);
      defaultMove.allowParkour = true;
      defaultMove.canDig = true;
      clientInstance.pathfinder.setMovements(defaultMove);

      // Setup Auto-Eat
      clientInstance.autoEat.options = { priority: 'foodPoints', startAt: 14, bannedFood: ['rotten_flesh', 'spider_eye'] };
    });

    // Chat Command Engine
    clientInstance.on('chat', async (username, message) => {
      if (username === clientInstance.username) return;
      const args = message.split(' ');
      const cmd = args[0].toLowerCase();
      const mcData = require('minecraft-data')(clientInstance.version);

      if (cmd === 'come') {
        const target = clientInstance.players[username]?.entity;
        if (!target) return clientInstance.chat("Mai aapko scan nahi kar pa raha!");
        clientInstance.chat("Aapke peeche aa raha hoon...");
        clientInstance.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      } 
      else if (cmd === 'stop') {
        clientInstance.pathfinder.stop();
        clientInstance.pvp.stop();
        clientInstance.collectBlock.cancelTask();
        clientInstance.chat("Saare task stop kar diye.");
      }
      else if (cmd === 'kill' && args[1]) {
        const targetEntity = clientInstance.nearestEntity(e => 
          (e.type === 'mob' && e.name?.toLowerCase().includes(args[1].toLowerCase())) ||
          (e.type === 'player' && e.username?.toLowerCase() === args[1].toLowerCase())
        );
        if (!targetEntity) return clientInstance.chat(`${args[1]} nahi mila.`);
        clientInstance.chat(`Target ${args[1]} locked! Attack kar raha hoon.`);
        clientInstance.pvp.attack(targetEntity);
      }
      else if (cmd === 'collect' && args[1]) {
        const blockName = args[1];
        const count = parseInt(args[2]) || 1;
        const blockType = mcData.blocksByName[blockName];

        if (!blockType) return clientInstance.chat(`${blockName} game me exist nahi karta.`);
        const foundBlocks = clientInstance.findBlocks({ matching: blockType.id, maxDistance: 64, count: count });

        if (!foundBlocks.length) return clientInstance.chat(`${blockName} aas-paas nahi mila.`);
        clientInstance.chat(`${foundBlocks.length} ${blockName} todne jaa raha hoon...`);
        try {
          const targets = foundBlocks.map(pos => clientInstance.blockAt(pos));
          await clientInstance.collectBlock.collect(targets);
          clientInstance.chat("Collection complete!");
        } catch (e) {
          clientInstance.chat(`Mining fail: ${e.message}`);
        }
      }
    });

    clientInstance.on('end', () => {
      console.warn(`[NETWORK ALERT] Disconnected. Re-authenticating in 10s...`);
      setTimeout(initiateConnectionCycle, 10000);
    });

    clientInstance.on('error', (err) => console.error(`[ERROR]`, err.message));
  }

  initiateConnectionCycle();
}
