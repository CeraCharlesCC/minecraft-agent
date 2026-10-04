import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";
import { publicError, CliError } from "../src/output/errors.js";

class CollectionBot extends EventEmitter {
  entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
  item = { id: 7, uuid: "11111111-1111-4111-8111-111111111111", name: "item", type: "object", position: { x: 6, y: 64, z: 0 },
    getDroppedItem: () => ({ name: "diamond", count: 32, slot: 4, nbt: "PRIVATE" }) };
  entities: Record<string, any> = { 1: this.entity, 7: this.item };
  players = {};
  game = { dimension: "overworld" };
  inventory = { items: () => [] };
  packetWrites = vi.fn();
  _client = { write: this.packetWrites };
  lookCalls = vi.fn();
  equipCalls = vi.fn(async (_item: unknown, _destination: string | null) => {});
  equip = this.equipCalls;
  quit = vi.fn(); chat = vi.fn(); lookAt = this.lookCalls; setControlState = vi.fn(); clearControlStates = vi.fn();
  pathfinder = {
    movements: { emptyBlocks: new Set([0]) } as never,
    setMovements: vi.fn(),
    goto: vi.fn(async (goal: { x: number; y: number; z: number }) => { this.entity.position = { x: goal.x, y: goal.y, z: goal.z }; }),
    setGoal: vi.fn(), stop: vi.fn(), isMoving: () => false, isMining: () => false, isBuilding: () => false,
  };
}

const subjects: BotController[] = [];
function runtime() {
  const bot = new CollectionBot(), events = new EventStore();
  const controller = new BotController({ host: "localhost", port: 25565, username: "Agent", auth: "offline" }, events, () => bot);
  subjects.push(controller);
  controller.start(); bot.emit("spawn");
  const track = controller.world.trackFor(bot.item)!;
  const start = () => controller.runAction("collect.item", ["movement", "look"], () => controller.collectItem(track, 1), track);
  const gone = () => { delete bot.entities[7]; bot.emit("entityGone", bot.item); };
  return { bot, events, controller, track, start, gone };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
afterEach(() => { for (const controller of subjects.splice(0)) controller.stop(); vi.useRealTimers(); });

describe("confirmed dropped item collection", () => {
  it("does not complete on arrival or a claimed inventory increase", async () => {
    vi.useFakeTimers();
    const { bot, controller, start } = runtime();
    const action = start(); await flush();
    expect(controller.actions.get(action.action).state).toBe("running");
    bot.inventory.items = () => [{ name: "diamond", count: 32 }] as never;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", error: {
      code: "COMMAND_BLOCKED", details: { reason: "PICKUP_UNCONFIRMED", timeoutMs: 3_000 } } });
    expect(bot.listenerCount("playerCollect")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before", "after"] as const)("confirms exact self pickup with entityGone %s playerCollect", async order => {
    const { bot, controller, track, start, gone } = runtime();
    const action = start();
    if (order === "before") gone();
    bot.emit("playerCollect", bot.entity, bot.item);
    if (order === "after") gone();
    const settled = await controller.actions.wait(action.action, 1000);
    expect(settled).toMatchObject({ state: "completed", target: track, result: {
      pickupConfirmed: true, item: { name: "diamond" }, unknownFields: ["collectedCount"] } });
    expect(settled.result).not.toHaveProperty("inventory");
    expect((settled.result as any).item).not.toHaveProperty("count");
    expect((settled.result as any).item).not.toHaveProperty("slot");
    expect(JSON.stringify(settled.result)).not.toContain("PRIVATE");
    expect(bot.listenerCount("playerCollect")).toBe(0);
  });

  it("registers before movement and accepts partial pickup while the entity remains", async () => {
    const { bot, controller, start } = runtime();
    bot.pathfinder.goto.mockImplementation(async () => { bot.emit("playerCollect", bot.entity, bot.item); });
    const action = start();
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: { pickupConfirmed: true } });
    expect(controller.world.resolveTrack(controller.world.trackFor(bot.item)!)).toBe(bot.item);
  });

  it("reports unavailable stack metadata without withholding server confirmation", async () => {
    const { bot, controller, start } = runtime();
    bot.item.getDroppedItem = () => undefined as never;
    const action = start();
    bot.emit("playerCollect", bot.entity, bot.item);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: {
      pickupConfirmed: true, unknownFields: ["collectedCount", "item"] } });
  });

  it.each(["late", "changed"])("captures %s stack metadata at confirmed pickup", async scenario => {
    const { bot, controller, start } = runtime();
    if (scenario === "late") bot.item.getDroppedItem = () => undefined as never;
    const action = start(); await flush();
    const stack = { name: "emerald", customName: "Late receipt", count: 12, slot: 9, nbt: "PRIVATE" };
    bot.item.getDroppedItem = () => stack;
    bot.emit("playerCollect", bot.entity, bot.item);
    stack.name = "stale mutation";
    stack.customName = "stale mutation";
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: {
      pickupConfirmed: true, item: { name: "emerald", customName: "Late receipt" }, unknownFields: ["collectedCount"] } });
    expect((controller.actions.get(action.action).result as any).item).not.toHaveProperty("count");
  });

  it("marks item unknown if its stack getter becomes unavailable before pickup", async () => {
    const { bot, controller, start } = runtime();
    const action = start(); await flush();
    bot.item.getDroppedItem = () => undefined as never;
    bot.emit("playerCollect", bot.entity, bot.item);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: {
      pickupConfirmed: true, unknownFields: ["collectedCount", "item"] } });
    expect(controller.actions.get(action.action).result).not.toHaveProperty("item");
  });

  it("rejects mobs without moving", async () => {
    const { bot, controller, start } = runtime();
    bot.item.name = "cow";
    const action = start();
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "failed", error: { code: "COMMAND_BLOCKED" } });
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
  });

  it.each(["other collector", "other item", "recreated binding"])("does not infer pickup from %s", async scenario => {
    vi.useFakeTimers();
    const { bot, controller, start, gone } = runtime();
    const action = start(); await flush();
    if (scenario === "recreated binding") gone();
    bot.emit("playerCollect", scenario === "other collector" ? { id: 2 } : bot.entity,
      scenario === "other item" ? { ...bot.item, id: 8 } : scenario === "recreated binding" ? { id: bot.item.id } : bot.item);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", error: { details: { reason: "PICKUP_UNCONFIRMED" } } });
  });

  it("stops movement on target loss and bounds observation even if goto never settles", async () => {
    vi.useFakeTimers();
    const { bot, controller, start, gone } = runtime();
    bot.pathfinder.goto.mockImplementation(() => new Promise<void>(() => {}));
    const action = start(); gone();
    expect(bot.pathfinder.stop).toHaveBeenCalled();
    bot.emit("physicsTick");
    expect(controller.actions.get(action.action).state).toBe("running");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.actions.get(action.action).state).toBe("failed");
    expect(bot.listenerCount("playerCollect")).toBe(0);
  });

  it.each(["UUID mutation", "same-object rebind", "recycled numeric ID"])("rejects pickup from %s", async scenario => {
    vi.useFakeTimers();
    const { bot, controller, start, gone } = runtime();
    const action = start(); await flush();
    if (scenario === "UUID mutation") {
      bot.item.uuid = "22222222-2222-4222-8222-222222222222";
      bot.emit("entityUpdate", bot.item);
    } else {
      gone();
      bot.entities[7] = scenario === "same-object rebind" ? bot.item : { ...bot.item };
      bot.emit("entitySpawn", bot.entities[7]);
    }
    bot.emit("playerCollect", bot.entity, bot.item);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", error: { details: { reason: "PICKUP_UNCONFIRMED" } } });
  });

  it("protects confirmed pickup until action settlement when removal is queued in later microtasks", async () => {
    const { bot, controller, start, gone } = runtime();
    const action = start();
    bot.emit("playerCollect", bot.entity, bot.item);
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(gone)));
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: { pickupConfirmed: true } });
  });

  it.each(["cancel", "replace", "reset"])("cleans pending confirmation on %s", async mode => {
    vi.useFakeTimers();
    const { bot, controller, start } = runtime();
    let arrive!: () => void;
    bot.pathfinder.goto.mockImplementation(() => new Promise<void>(resolve => { arrive = resolve; }));
    const action = start();
    if (mode === "cancel") controller.actions.cancel(action.action);
    if (mode === "replace") controller.runAction("navigate.goto", ["movement", "look"], () => undefined);
    if (mode === "reset") controller.world.reset("DEATH");
    await flush();
    bot.emit("playerCollect", bot.entity, bot.item);
    arrive(); await flush();
    expect(controller.actions.get(action.action).state).toBe(mode === "reset" ? "failed" : "cancelled");
    expect(bot.listenerCount("playerCollect")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks the live dimension before accepting a pickup without a lifecycle event", async () => {
    const { bot, controller, start } = runtime();
    const action = start();
    bot.game.dimension = "the_nether";
    bot.emit("playerCollect", bot.entity, bot.item);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "failed", error: { code: "WORLD_CHANGED" } });
    expect(controller.actions.get(action.action)).not.toHaveProperty("result");
    await flush();
    expect(bot.listenerCount("playerCollect")).toBe(0);
  });

  it("preserves generic loss failures for concurrent actions against the item", async () => {
    const { controller, start, track, gone } = runtime();
    const collection = start();
    const other = controller.runAction("inventory.test", ["item"], () => new Promise(() => {}), track);
    gone();
    expect(controller.actions.get(collection.action).state).toBe("running");
    expect(controller.actions.get(other.action)).toMatchObject({ state: "failed", error: { code: "TRACK_LOST" } });
    controller.actions.cancel(collection.action); await flush();
  });

  it("blocks mutation packets and delayed look continuations while lost target confirmation is pending", async () => {
    const { bot, controller, start, gone } = runtime();
    let turn!: () => void;
    let release!: () => void;
    bot.lookCalls.mockImplementation(() => new Promise<void>(resolve => { turn = resolve; }));
    let approaching!: Promise<void>;
    bot.pathfinder.goto.mockImplementation(() => approaching = (async () => {
      const looking = bot.lookAt({ x: 6, y: 64, z: 0 });
      await new Promise<void>(resolve => { release = resolve; });
      bot._client.write("arm_animation", {});
      await looking;
      bot._client.write("use_entity", {});
    })());
    const action = start(); gone();
    const rejected = expect(approaching).rejects.toMatchObject({ code: "TRACK_LOST" });
    release(); turn(); await rejected;
    expect(bot.packetWrites).not.toHaveBeenCalled();
    expect(controller.actions.get(action.action).state).toBe("running");
    bot.emit("playerCollect", bot.entity, bot.item);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed" });
  });

  it.each(["lost", "picked up"])("blocks outside-ALS equipment preparation when collection target is %s", async phase => {
    const { bot, controller, start, gone } = runtime();
    bot.equipCalls.mockImplementation(async () => { bot._client.write("held_item_slot", {}); });
    const action = start();
    if (phase === "lost") gone();
    else bot.emit("playerCollect", bot.entity, bot.item);
    await expect(bot.equip({}, "hand")).rejects.toMatchObject({ code: "TRACK_LOST" });
    expect(bot.equipCalls).not.toHaveBeenCalled();
    expect(bot.packetWrites).not.toHaveBeenCalled();
    if (phase === "lost") bot.emit("playerCollect", bot.entity, bot.item);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed" });
  });

  it("binds already started outside-ALS equipment so delayed packets cannot escape after target loss", async () => {
    const { bot, controller, start, gone } = runtime();
    let release!: () => void;
    bot.equipCalls.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      bot._client.write("held_item_slot", {});
    });
    const action = start();
    const preparation = bot.equip({}, "hand");
    gone(); release();
    await expect(preparation).rejects.toMatchObject({ code: "TRACK_LOST" });
    expect(bot.packetWrites).not.toHaveBeenCalled();
    expect(controller.actions.get(action.action).state).toBe("running");
    bot.emit("playerCollect", bot.entity, bot.item);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed" });
  });

  it("preserves explicit inventory equipment independently of pending collection confirmation", async () => {
    const { bot, controller, start, gone } = runtime();
    bot.equipCalls.mockImplementation(async () => { bot._client.write("held_item_slot", {}); });
    const collection = start(); gone();
    const equipment = controller.runAction("inventory.equip", ["item", "window"], () => bot.equip({}, "hand"));
    expect(await controller.actions.wait(equipment.action, 1000)).toMatchObject({ state: "completed" });
    expect(bot.packetWrites).toHaveBeenCalledWith("held_item_slot", {});
    expect(controller.actions.get(collection.action).state).toBe("running");
    controller.actions.cancel(collection.action); await flush();
  });

  it("keeps the pickup failure reason in public errors", () => {
    expect(publicError(new CliError("COMMAND_BLOCKED", "Pickup unconfirmed", "Observe", 1,
      { reason: "PICKUP_UNCONFIRMED" }))).toMatchObject({ details: { reason: "PICKUP_UNCONFIRMED" } });
  });
});
