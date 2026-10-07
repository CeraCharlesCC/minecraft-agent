import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

const require = createRequire(import.meta.url);
const controllers: BotController[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function runtime(species = "villager") {
  const registry = require("prismarine-registry")("1.21.4");
  const Entity = require("prismarine-entity")(registry);
  const villager = Object.assign(new Entity(8), {
    name: species, type: "mob", entityType: registry.entitiesByName[species].id,
    position: new Vec3(1, 64, 0),
  });
  const packetWrites = vi.fn();
  const bot: any = Object.assign(new EventEmitter(), {
    registry, version: "1.21.4", supportFeature: registry.supportFeature,
    _client: Object.assign(new EventEmitter(), { write: packetWrites }),
    username: "AgentBot", entity: { id: 42, position: new Vec3(0, 64, 0) },
    entities: { 8: villager }, game: { dimension: "overworld" }, health: 20, food: 20,
    chat: vi.fn(), quit: vi.fn(), lookAt: vi.fn(async () => {}),
    setControlState: vi.fn(), clearControlStates: vi.fn(),
  });
  require("mineflayer/lib/plugins/inventory.js")(bot, {});
  require("mineflayer/lib/plugins/chest.js")(bot);
  require("mineflayer/lib/plugins/villager.js")(bot, {});
  const controller = new BotController({ host: "localhost", port: 25565, username: bot.username, auth: "offline" }, new EventStore(), () => bot);
  controllers.push(controller);
  controller.start(); bot.emit("spawn"); bot.emit("entitySpawn", villager);
  const track = controller.world.trackFor(villager)!;
  const Item = require("prismarine-item")(registry);
  const trades = [{
    inputItem1: Item.toNotch(new Item(registry.itemsByName.emerald.id, 1)),
    inputItem2: Item.toNotch(null), outputItem: Item.toNotch(new Item(registry.itemsByName.bread.id, 6)),
    tradeDisabled: false, nbTradeUses: 0, maximumNbTradeUses: 16,
    demand: 0, specialPrice: 0, priceMultiplier: 0.05,
  }];
  function openWindow(type = "minecraft:merchant") {
    bot._client.emit("open_window", { windowId: 1, inventoryType: type, windowTitle: "Villager", slotCount: 3 });
    bot._client.emit("window_items", { windowId: 1, stateId: 0, items: bot.currentWindow.slots.map(() => Item.toNotch(null)) });
  }
  function sendTrades(windowId = 1) { bot._client.emit("trade_list", { windowId, trades }); }
  function open() {
    return controller.runAction("window.open-entity", ["window", "look"], () => controller.openEntityWindow(track), track);
  }
  return { controller, bot, packetWrites, open, openWindow, sendTrades };
}

describe("villager windows with installed Mineflayer plugins", () => {
  it("completes a merchant open only after receiving its trade list and retains trade updates until close", async () => {
    const { controller, bot, packetWrites, open, openWindow, sendTrades } = runtime();
    const action = open();
    await vi.advanceTimersByTimeAsync(0);
    expect(packetWrites).toHaveBeenCalledWith("use_entity", expect.objectContaining({ target: 8, mouse: 0 }));
    openWindow();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.actions.get(action.action).state).toBe("running");
    sendTrades(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.actions.get(action.action).state).toBe("running");
    sendTrades();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "completed", result: { opened: true, window: { type: "minecraft:merchant" } } });
    expect(controller.frame()).toMatchObject({ window: { type: "minecraft:merchant" } });
    expect(bot.currentWindow.trades[0]).toMatchObject({ inputItem1: { name: "emerald" }, outputItem: { name: "bread" }, realPrice: 1 });
    expect(bot._client.listenerCount("trade_list")).toBe(1);
    bot.currentWindow.trades = [];
    sendTrades();
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.currentWindow.trades).toHaveLength(1);
    controller.closeWindow();
    expect(bot._client.listenerCount("trade_list")).toBe(0);
  });

  it.each([false, true])("removes only its own listeners when cancelled (window already open: %s)", async windowAlreadyOpen => {
    const { controller, bot, open, openWindow } = runtime();
    const existingWindowListener = vi.fn(), existingTradeListener = vi.fn();
    bot.on("windowOpen", existingWindowListener);
    bot._client.on("trade_list", existingTradeListener);
    const baseline = bot.listenerCount("windowOpen");
    const action = open();
    await vi.advanceTimersByTimeAsync(0);
    expect(bot._client.listenerCount("trade_list")).toBe(2);
    if (windowAlreadyOpen) { openWindow(); await vi.advanceTimersByTimeAsync(0); }
    controller.actions.cancel(action.action);
    expect(controller.actions.get(action.action).state).toBe("cancelled");
    expect(bot.listenerCount("windowOpen")).toBe(baseline);
    expect(bot.listeners("windowOpen")).toContain(existingWindowListener);
    expect(bot._client.listeners("trade_list")).toEqual([existingTradeListener]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.actions.get(action.action).state).toBe("cancelled");
  });

  it.each([false, true])("fails without a completed open when the server times out (window already open: %s)", async windowAlreadyOpen => {
    const { controller, bot, open, openWindow } = runtime();
    const baseline = bot.listenerCount("windowOpen");
    const action = open();
    if (windowAlreadyOpen) { openWindow(); await vi.advanceTimersByTimeAsync(0); }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", reason: "DAEMON_ERROR" });
    expect(bot.listenerCount("windowOpen")).toBe(baseline);
    expect(bot._client.listenerCount("trade_list")).toBe(0);
  });

  it("cleans up the trade listener if the server opens an unexpected window type", async () => {
    const { controller, bot, open, openWindow } = runtime();
    const action = open();
    openWindow("minecraft:generic_9x3");
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", reason: "DAEMON_ERROR" });
    expect(bot._client.listenerCount("trade_list")).toBe(0);
  });

  it("still opens ordinary entity containers without waiting for a trade list", async () => {
    const { controller, bot, open, openWindow } = runtime("chest_minecart");
    const action = open();
    openWindow("minecraft:generic_9x3");
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "completed", result: { opened: true, window: { type: "minecraft:generic_9x3" } } });
    expect(bot._client.listenerCount("trade_list")).toBe(0);
  });

  it("blocks a villager open when the dedicated API is unavailable", async () => {
    const { controller, bot, packetWrites, open } = runtime();
    delete bot.openVillager;
    const action = open();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", reason: "COMMAND_BLOCKED" });
    expect(packetWrites).not.toHaveBeenCalled();
    expect(bot._client.listenerCount("trade_list")).toBe(0);
  });
});
