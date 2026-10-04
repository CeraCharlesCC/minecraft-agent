import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

const require = createRequire(import.meta.url);
const installedGoto = require("mineflayer-pathfinder/lib/goto.js");

class NavigationBot extends EventEmitter {
  username = "AgentBot";
  entity = { position: { x: 0, y: 64, z: 0 } };
  entities = { 7: { id: 7, name: "item", type: "object", position: { x: 6, y: 64, z: 0 } } };
  players = {};
  game = { dimension: "overworld" };
  inventory = { items: () => [] };
  packetWrites = vi.fn();
  _client = { write: this.packetWrites };
  quit = vi.fn(); chat = vi.fn(); lookAt = vi.fn(); setControlState = vi.fn(); clearControlStates = vi.fn();
  digCalls = vi.fn(async () => {}); dig = this.digCalls;
  placeCalls = vi.fn(async () => {}); placeBlock = this.placeCalls;
  equipCalls = vi.fn(async (_item: unknown, _destination: unknown) => {}); equip = this.equipCalls;
  pathfinder = {
    movements: { canDig: true, scafoldingBlocks: [3, 4], allow1by1towers: true, emptyBlocks: new Set([0]) } as never,
    setMovements: vi.fn(), goto: vi.fn(async (goal: { x: number; y: number; z: number }) => { this.entity.position = { x: goal.x, y: goal.y, z: goal.z }; }),
    setGoal: vi.fn(), stop: vi.fn(), isMoving: () => false, isMining: () => false, isBuilding: () => false,
  };
}

function runtime() {
  const events = new EventStore(), bot = new NavigationBot();
  const controller = new BotController({ host: "localhost", port: 25565, username: "AgentBot", auth: "offline" }, events, () => bot);
  controller.start(); bot.emit("spawn");
  return { events, bot, controller };
}

describe("navigation safety and observation context", () => {
  it("disables both digging and scaffolding, preserves explicit opt-ins, and verifies arrival", async () => {
    const { bot, controller } = runtime();
    expect(bot.pathfinder.movements).toMatchObject({ canDig: false, scafoldingBlocks: [], allow1by1towers: false });
    const action = controller.runAction("navigate.goto", ["movement", "look"], () => controller.goto(6, 64, 0, 1));
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", timedOut: false });
    expect(bot.entity.position).toEqual({ x: 6, y: 64, z: 0 });
    expect(controller.configureNavigation({ allowDig: true, allowPlace: true })).toMatchObject({ movements: { canDig: true, canPlace: true } });
    expect(bot.pathfinder.movements).toMatchObject({ scafoldingBlocks: [3, 4], allow1by1towers: true });
    controller.configureNavigation({ allowDig: false, allowPlace: false });
    expect(bot.pathfinder.movements).toMatchObject({ canDig: false, scafoldingBlocks: [], allow1by1towers: false });
    controller.stop();
  });

  it("settles detached arrival evidence without replacing it with a later position", async () => {
    const { bot, controller } = runtime();
    bot.pathfinder.goto.mockImplementation(async () => { bot.entity.position = { x: 5.5, y: 64, z: 0.5 }; });
    const action = controller.runAction("navigate.goto", ["movement", "look"], () => controller.goto(6, 64, 0, 1));
    const settlement = await controller.actions.wait(action.action, 1000);
    expect(settlement).toMatchObject({ state: "completed", timedOut: false, result: {
      completionReason: "within_range", goal: { x: 6, y: 64, z: 0, range: 1 },
      finalPosition: { x: 5.5, y: 64, z: 0.5 }, distanceToGoal: Math.sqrt(0.5),
      goalSatisfied: true, goalMetric: "block_node_euclidean", goalMetricDistance: 1,
      distanceMetric: "euclidean_to_requested_position", goalNode: { x: 5, y: 64, z: 0 }, effectiveGoal: { x: 6, y: 64, z: 0 },
    } });
    bot.entity.position.x = 100;
    expect(controller.actions.get(action.action).result).toEqual(settlement.result);
    expect((settlement.result as any).finalPosition.x).toBe(5.5);
    expect(controller.frame().actions.find((entry: any) => entry.action === action.action)).not.toHaveProperty("result");
    controller.stop();
  });

  it("reports already within range using GoalNear nodes even when straight distance exceeds range", async () => {
    const { bot, controller } = runtime();
    bot.entity.position = { x: 0.9, y: 64, z: 0.9 };
    const action = controller.runAction("navigate.goto", ["movement", "look"], () => controller.goto(0, 64, 0, 0));
    const settlement = await controller.actions.wait(action.action, 1000);
    expect(settlement).toMatchObject({ state: "completed", result: {
      completionReason: "already_within_range", goal: { x: 0, y: 64, z: 0, range: 0 },
      finalPosition: { x: 0.9, y: 64, z: 0.9 }, distanceToGoal: Math.sqrt(1.62),
      goalSatisfied: true, goalMetricDistance: 0, goalNode: { x: 0, y: 64, z: 0 },
    } });
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
    controller.stop();
  });

  it("keeps partial-block GoalNear height correction in the arrival decision", async () => {
    const { bot, controller } = runtime();
    Object.assign(bot.entity, { position: { x: 0, y: 64.5, z: 0 }, onGround: true });
    Object.assign(bot, { blockAt: () => ({ type: 1 }) });
    const settlement = await controller.goto(0, 65, 0, 0);
    expect(settlement).toMatchObject({ completionReason: "already_within_range", finalPosition: { y: 64.5 }, distanceToGoal: 0.5,
      goalSatisfied: true, goalMetricDistance: 0, goalNode: { x: 0, y: 65, z: 0 } });
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
    controller.stop();
  });

  it("exposes the floored fractional goal and vertical node distance from the arrival evaluation", async () => {
    const { bot, controller } = runtime();
    bot.pathfinder.goto.mockImplementation(async () => { bot.entity.position = { x: 10.9, y: 66, z: 5.9 }; });
    const settlement = await controller.goto(10.2, 65.2, 5.2, 1);
    expect(settlement).toMatchObject({ completionReason: "within_range", goalSatisfied: true,
      goal: { x: 10.2, y: 65.2, z: 5.2, range: 1 }, effectiveGoal: { x: 10, y: 65, z: 5 },
      goalNode: { x: 10, y: 66, z: 5 }, goalMetricDistance: 1 });
    expect(settlement.distanceToGoal).toBeGreaterThan(1);
    controller.stop();
  });

  it.each(["noPath", "timeout"])("rejects terminal %s even when the final node is in range", async status => {
    const { bot, controller } = runtime();
    bot.pathfinder.goto.mockImplementation(async () => {
      bot.entity.position = { x: 6, y: 64, z: 0 };
      bot.emit("path_update", { status, path: [] });
    });
    await expect(controller.goto(6, 64, 0, 0)).rejects.toMatchObject({ code: "NAVIGATION_FAILED" });
    controller.stop();
  });

  it.each(["noPath", "timeout"])("does not trust installed goto's empty %s success", async status => {
    const { bot, controller } = runtime();
    bot.pathfinder.goto.mockImplementation((goal) => installedGoto(bot, goal));
    bot.pathfinder.setGoal.mockImplementation((goal: unknown) => {
      if (goal) queueMicrotask(() => bot.emit("path_update", { status, path: [] }));
    });
    const action = controller.runAction("navigate.goto", ["movement", "look"], () => controller.goto(6, 64, 0, 1));
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "failed", error: { code: "NAVIGATION_FAILED", details: { reason: status === "noPath" ? "NO_PATH" : "TIMEOUT", policy: { canDig: false, canPlace: false } } } });
    expect(bot.listenerCount("path_update")).toBe(0);
    expect(bot.digCalls).not.toHaveBeenCalled();
    expect(bot.placeCalls).not.toHaveBeenCalled();
    controller.stop();
  });

  it("verifies item approach and rejects false completion without inventing a terrain diagnosis", async () => {
    const { bot, controller } = runtime();
    bot.pathfinder.goto.mockImplementation(async () => {});
    const track = controller.world.trackFor(bot.entities[7])!;
    const action = controller.runAction("collect.item", ["movement", "look"], () => controller.collectItem(track, 1), track);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "failed", error: { details: { reason: "GOAL_NOT_REACHED" } } });
    controller.stop();
  });

  it.each(["dig", "placeBlock"] as const)("blocks unauthorized pathfinder %s at the physical boundary", async method => {
    const { bot, controller } = runtime();
    const action = controller.runAction("navigate.follow", ["movement", "look"], () => undefined, undefined, true);
    const operation = bot[method] as (...args: unknown[]) => Promise<unknown>;
    await expect(operation({}, {})).rejects.toMatchObject({ code: "NAVIGATION_FAILED", details: { reason: "TERRAIN_MODIFICATION_BLOCKED", operation: method } });
    expect(controller.actions.get(action.action).state).toBe("failed");
    expect(bot.digCalls).not.toHaveBeenCalled(); expect(bot.placeCalls).not.toHaveBeenCalled();
    controller.stop();
  });

  it("keeps explicit dig and placement operations available", async () => {
    const { bot, controller } = runtime();
    const dig = controller.runAction("world.dig", ["movement", "look", "item"], () => (bot.dig as Function)({}));
    expect(await controller.actions.wait(dig.action, 1000)).toMatchObject({ state: "completed" });
    const place = controller.runAction("world.place", ["look", "item"], () => (bot.placeBlock as Function)({}, {}));
    expect(await controller.actions.wait(place.action, 1000)).toMatchObject({ state: "completed" });
    expect(bot.digCalls).toHaveBeenCalledOnce(); expect(bot.placeCalls).toHaveBeenCalledOnce();
    controller.stop();
  });

  it.each(["dig", "placeBlock"] as const)("fences delayed pathfinder equip -> %s after cancellation or replacement", async method => {
    const { bot, controller } = runtime();
    controller.configureNavigation({ allowDig: true, allowPlace: true });
    let resolve!: () => void;
    bot.equipCalls.mockReturnValue(new Promise<void>(done => { resolve = done; }));
    const prior = controller.runAction("navigate.follow", ["movement", "look"], () => undefined, undefined, true);
    // This is how the installed pathfinder attaches terrain work to equipment.
    const delayed = bot.equip({} as never, "hand" as never).then(() => (bot[method] as Function)({}, {}));
    const rejected = expect(delayed).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
    const replacement = controller.runAction("navigate.follow", ["movement", "look"], () => undefined, undefined, true);
    resolve(); await rejected;
    expect(controller.actions.get(prior.action).state).toBe("cancelled");
    expect(controller.actions.get(replacement.action).state).toBe("running");
    expect(bot.digCalls).not.toHaveBeenCalled(); expect(bot.placeCalls).not.toHaveBeenCalled();
    controller.stop();
  });

  it("rejects ambient terrain changes without failing unrelated current work", async () => {
    const { bot, controller } = runtime();
    const action = controller.runAction("control.set", ["movement"], () => undefined, undefined, true);
    await expect((bot.dig as Function)({})).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
    expect(bot.digCalls).not.toHaveBeenCalled();
    expect(controller.actions.get(action.action).state).toBe("running");
    controller.stop();
  });

  it("retired terrain methods cannot fail new connection actions", async () => {
    const oldBot = new NavigationBot(), nextBot = new NavigationBot();
    const bots = [oldBot, nextBot];
    const controller = new BotController({ host: "localhost", port: 25565, username: "AgentBot", auth: "offline" }, new EventStore(), () => bots.shift()!);
    controller.start(); oldBot.emit("spawn");
    oldBot.emit("end", "socketClosed");
    controller.start(); nextBot.emit("spawn");
    const action = controller.runAction("navigate.follow", ["movement", "look"], () => undefined, undefined, true);
    await expect((oldBot.dig as Function)({})).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
    expect(oldBot.digCalls).not.toHaveBeenCalled();
    expect(controller.actions.get(action.action).state).toBe("running");
    controller.stop();
  });

  it("retires the connection even if pathfinder cleanup throws during stop", () => {
    const { bot, controller } = runtime();
    const action = controller.runAction("navigate.follow", ["movement", "look"], () => undefined, undefined, true);
    bot.pathfinder.stop.mockImplementation(() => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); });
    expect(() => controller.stop()).not.toThrow();
    expect(controller.actions.get(action.action).state).toBe("failed");
    expect(controller.connectionStatus()).toMatchObject({ state: "stopping", ready: false });
    expect(bot.quit).toHaveBeenCalledOnce();
    expect(bot.listenerCount("spawn")).toBe(0);
    bot._client.write("block_dig", {});
    expect(bot.packetWrites).not.toHaveBeenCalled();
  });

  it("accepts a retained context after many observations, and includes disconnect evidence on stale context", () => {
    const { bot, controller } = runtime();
    const frame = controller.frame();
    for (let i = 0; i < 40; i++) controller.frame();
    expect(() => controller.validateContext({ context: frame.context })).not.toThrow();
    expect(() => controller.validateContext({ context: frame.context, runtimeId: "other" })).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    bot.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    bot.emit("end", "socketClosed");
    expect(() => controller.validateContext({ context: frame.context })).toThrow(expect.objectContaining({ code: "WORLD_CHANGED", details: expect.objectContaining({ connection: expect.objectContaining({ state: "disconnected", cause: expect.objectContaining({ code: "EPIPE" }) }) }) }));
    expect(() => controller.validateContext({ context: controller.frame().context })).toThrow(expect.objectContaining({ code: "NOT_READY" }));
    controller.stop();
  });
});
