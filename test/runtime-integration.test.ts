import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

const UUID = "aabbccdd-1122-3344-5566-778899aabbcc";
const require = createRequire(import.meta.url);
class LiveBot extends EventEmitter {
  packetWrites = vi.fn();
  _client = { write: this.packetWrites };
  username = "AgentBot";
  entity = { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  entities: Record<string, any> = { "7": { id: 7, uuid: UUID, username: "Alex", type: "player", position: { x: 4, y: 64, z: 0 } } };
  players: Record<string, any> = { Alex: { uuid: UUID, entity: this.entities["7"] } };
  game = { dimension: "overworld" };
  health = 20;
  food = 20;
  slots = [{ name: "dirt", count: 3, slot: 36 }];
  inventory = { items: () => this.slots, slots: this.slots };
  currentWindow: any = { id: 1, slots: [{ name: "stone", count: 2 }], close: vi.fn() };
  controlState: Record<string, boolean> = {};
  heldItem = { name: "dirt" };
  setQuickBarSlot = vi.fn();
  setControlState = vi.fn((state: string, value: boolean) => { this.controlState[state] = value; });
  clearControlStates = vi.fn(() => { this.controlState = {}; });
  chat = vi.fn(); quit = vi.fn(); lookAtCalls = vi.fn(); lookAt = this.lookAtCalls; activateEntity = vi.fn(); equipCalls = vi.fn(); equip = this.equipCalls; placeBlockCalls = vi.fn(); placeBlock = this.placeBlockCalls;
  blockAt = vi.fn((position: any) => ({ name: "dirt", type: 3, position }));
  deactivateItem = vi.fn(); stopDigging = vi.fn(); attack = vi.fn();
  pathfinder = { movements: {} as never, setMovements: vi.fn(), setGoal: vi.fn(), stop: vi.fn(),
    goto: vi.fn(), isMoving: () => false, isMining: () => false, isBuilding: () => false };
}
function runtime() {
  const events = new EventStore();
  const bot = new LiveBot();
  const controller = new BotController({ host: "localhost", port: 25565, username: "AgentBot", auth: "offline" }, events, () => bot);
  controller.start(); bot.emit("spawn");
  return { controller, bot, events, track: controller.world.trackFor(bot.entities["7"])! };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("runtime integration", () => {
  it("frames copy eventless live mutations and flush canonical chat before the cursor", () => {
    const { controller, bot, events } = runtime();
    const first = controller.frame({ detail: "full" });
    bot.entity.velocity.x = 2; bot.slots[0].count = 9; bot.currentWindow.slots[0].count = 8;
    const json = { text: "same" };
    bot.emit("message", json, "chat", UUID); bot.emit("chat", "Alex", "same", undefined, json);
    bot.emit("message", json, "chat", UUID); bot.emit("chat", "Alex", "same", undefined, json);
    const second = controller.frame({ detail: "full" });
    expect(first.self.velocity.x).toBe(0); expect(first.inventory.slots[0].count).toBe(3); expect(first.window.slots[0].count).toBe(2);
    expect(second.self.velocity.x).toBe(2); expect(second.inventory.slots[0].count).toBe(9);
    expect(second.eventCursor).toBe(events.getCursor());
    expect(events.query(0, 50, ["chat.player"]).events).toHaveLength(2);
  });

  it("never floods semantic history with routine movement", () => {
    const { controller, bot, events } = runtime();
    const cursor = events.getCursor();
    for (let i = 0; i < 3000; i++) { bot.entities["7"].position.x = 4 + i / 1000; bot.emit("entityMoved", bot.entities["7"]); }
    expect(events.getCursor()).toBe(cursor);
    expect(controller.frame().entities[0].position.x).toBeCloseTo(6.999);
  });

  it("fails follow on loss even if raw entityGone is emitted before dictionary removal, then reacquires by UUID", () => {
    const { controller, bot, track } = runtime();
    const follow = controller.followTrack(track, 2);
    expect(controller.actions.get(follow.action).state).toBe("running");
    bot.emit("entityGone", bot.entities["7"]);
    expect(controller.actions.get(follow.action)).toMatchObject({ state: "failed", reason: "TRACK_LOST" });
    expect(bot.pathfinder.setGoal).toHaveBeenLastCalledWith(null);
    expect(() => controller.followTrack(track, 2)).toThrow(/lost/i);
    bot.entities["7"] = { ...bot.entities["7"], id: 18, position: { x: 6, y: 64, z: 0 } };
    controller.frame();
    expect(controller.world.trackFor(bot.entities["7"])).toBe(track);
    const next = controller.followTrack(track, 2);
    expect(next.action).not.toBe(follow.action);
    expect(bot.pathfinder.setGoal).toHaveBeenLastCalledWith(expect.objectContaining({ entity: bot.entities["7"] }), true);
  });

  it("replacement cancels a pending navigation and late completion cannot resurrect it", async () => {
    const { controller, bot, track } = runtime();
    const pending = deferred(); bot.pathfinder.goto.mockReturnValue(pending.promise);
    const first = controller.runAction("navigate.goto", ["movement", "look"], () => controller.goto(10,64,0,1));
    const second = controller.followTrack(track, 2);
    expect(controller.actions.get(first.action)).toMatchObject({ state: "cancelled", reason: "REPLACED" });
    pending.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(controller.actions.get(first.action).state).toBe("cancelled");
    expect(controller.actions.get(second.action).state).toBe("running");
  });

  it("world reset publishes failed actions and no stale positions/windows in one frame", () => {
    const { controller, bot, track } = runtime();
    const frame = controller.frame(); const follow = controller.followTrack(track, 2);
    bot.emit("death");
    const dead = controller.frame({ tracks: [track] });
    expect(dead.context).not.toBe(frame.context);
    expect(dead.connection.ready).toBe(false); expect(dead.self.position).toBeUndefined(); expect(dead.window).toBeUndefined();
    expect(dead.entities[0].position).toBeUndefined(); expect(dead.entities[0].status).toBe("lost");
    expect(dead.actions.find((a: any) => a.action === follow.action)).toMatchObject({ state: "failed", reason: "WORLD_CHANGED", error: { code: "WORLD_CHANGED" } });
    expect(controller.actions.get(follow.action)).toMatchObject({ error: { details: { reason: "DEATH" } } });
    expect(() => controller.validateContext({ context: frame.context })).toThrow(/World context/);
  });

  it("detects dimension changes before executing an action and waits for readiness", () => {
    const { controller, bot, track } = runtime(); const frame = controller.frame();
    controller.followTrack(track, 2); bot.game.dimension = "the_nether";
    expect(() => controller.validateContext({ context: frame.context })).toThrow(/World context/);
    const next = controller.frame(); expect(next.connection.ready).toBe(false); expect(next.self.position).toBeUndefined();
    bot.emit("spawn"); expect(controller.frame().connection.ready).toBe(true);
  });

  it("rejects old handles after runtime restart and reused numeric entity IDs", () => {
    const old = runtime(), next = runtime();
    expect(next.events.runtimeId).not.toBe(old.events.runtimeId);
    expect(() => next.controller.followTrack(old.track, 2)).toThrow(/runtime/);
    const entity = old.bot.entities["7"]; delete entity.uuid;
    old.bot.emit("entityGone", entity);
    old.bot.entities["7"] = { id: 7, type: "player", position: { x: 4, y:64, z:0 } };
    old.controller.frame();
    expect(old.controller.world.trackFor(old.bot.entities["7"])).not.toBe(old.track);
    expect(() => old.controller.followTrack(old.track, 2)).toThrow(/lost/);
  });

  it("old tap completion cannot release its replacement's control", async () => {
    vi.useFakeTimers();
    try {
      const { controller, bot } = runtime();
      const tap = controller.runAction("control.tap", ["movement"], () => controller.tap("forward",100));
      controller.runAction("control.set", ["movement"], () => controller.setControl("forward",true), undefined, true);
      await vi.advanceTimersByTimeAsync(100);
      expect(controller.actions.get(tap.action).state).toBe("cancelled");
      expect(bot.controlState.forward).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("cancelled placement cannot perform its next physical step after equip resolves", async () => {
    const { controller, bot } = runtime(); const pending = deferred(); bot.equipCalls.mockReturnValue(pending.promise);
    const action = controller.runAction("world.place", ["item", "look"], () => controller.place(1,64,0,"up","dirt"));
    controller.actions.cancel(action.action); pending.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(bot.placeBlockCalls).not.toHaveBeenCalled(); expect(controller.actions.get(action.action).state).toBe("cancelled");
  });

  it("look tracking fails on loss and attack/chat permissions remain enforced", () => {
    const { controller, bot, track } = runtime();
    const look = controller.trackLook(track); bot.emit("entityGone", bot.entities["7"]);
    expect(controller.actions.get(look.action)).toMatchObject({ state: "failed", reason: "TRACK_LOST" });
    expect(() => controller.sendChat("/op AgentBot")).toThrow(/Refusing/);
    expect(bot.chat).not.toHaveBeenCalled();
    const other = runtime(); expect(() => other.controller.attackEntity(other.track)).toThrow(/Refusing/);
    expect(other.bot.attack).not.toHaveBeenCalled();
  });
  it("guards Mineflayer's hidden entity activation wait after target loss", async () => {
    const events = new EventStore(), bot = new LiveBot(), pending = deferred();
    bot.lookAtCalls.mockReturnValue(pending.promise);
    bot.activateEntity.mockImplementation(async (entity: any) => {
      await bot.lookAt(entity.position);
      bot._client.write("use_entity", { target: entity.id });
    });
    const controller = new BotController({host:"localhost",port:25565,username:"AgentBot",auth:"offline"},events,()=>bot);
    controller.start(); bot.emit("spawn"); const track = controller.world.trackFor(bot.entities["7"])!;
    const action = controller.runAction("entity.interact", ["item", "look"], () => controller.interactEntity(track), track);
    bot.emit("entityGone", bot.entities["7"]); pending.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", reason: "TRACK_LOST" });
    expect(bot.packetWrites).not.toHaveBeenCalled();
  });

  it("fences later inventory packets from a cancelled internal async transfer", async () => {
    const { controller, bot } = runtime(), pending = deferred();
    bot.currentWindow.deposit = async () => { await pending.promise; bot._client.write("window_click", {slot:1}); };
    (bot as any).registry = {itemsByName: {dirt: {id:3}}};
    const action = controller.runAction("window.deposit", ["window", "item"], () => controller.windowDeposit("dirt",1));
    controller.actions.cancel(action.action); pending.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(controller.actions.get(action.action).state).toBe("cancelled");
    expect(bot.packetWrites).not.toHaveBeenCalled();
  });

  it("removes cancelled container listeners before a replacement can receive a window", async () => {
    const { controller, bot } = runtime();
    (bot as any).openContainer = () => new Promise(resolve => bot.on("windowOpen", resolve));
    const baseline = bot.listenerCount("windowOpen");
    const action = controller.runAction("window.open-entity", ["window", "look"], () => controller.openEntityWindow(controller.world.trackFor(bot.entities["7"])!), controller.world.trackFor(bot.entities["7"]));
    expect(bot.listenerCount("windowOpen")).toBe(baseline+1);
    controller.actions.cancel(action.action);
    expect(bot.listenerCount("windowOpen")).toBe(baseline);
  });

  it.each(["cancel", "replace", "target-loss", "world-reset"])("observes rejected background turns after %s while awaited turns still reject", async transition => {
    const events = new EventStore(), bot = new LiveBot(), pending = deferred();
    bot.lookAtCalls.mockReturnValue(pending.promise);
    const controller = new BotController({host:"localhost",port:25565,username:"AgentBot",auth:"offline"},events,()=>bot);
    controller.start(); bot.emit("spawn");
    const track = controller.world.trackFor(bot.entities["7"])!;
    const action = controller.runAction("navigate.goto", ["movement", "look"], () => new Promise(() => {}), track);
    // Match pathfinder's unawaited call outside the action's async context.
    void bot.lookAt(bot.entities["7"].position);
    const awaited = bot.lookAt(bot.entities["7"].position);
    if (transition === "cancel") controller.actions.cancel(action.action);
    if (transition === "replace") controller.followTrack(track, 2);
    if (transition === "target-loss") bot.emit("entityGone", bot.entities["7"]);
    if (transition === "world-reset") bot.emit("death");
    const rejection = expect(awaited).rejects.toMatchObject({ code: transition === "world-reset" ? "WORLD_CHANGED" : "COMMAND_BLOCKED" });
    pending.resolve(); await rejection;
    // Let Node detect any unhandled background rejection (Vitest fails on it).
    await new Promise(resolve => setImmediate(resolve));
    expect(controller.actions.get(action.action).state).not.toBe("running");
  });

  it("retains Mineflayer's self binding for effect and metadata packets across death and respawn", () => {
    const bot = new LiveBot() as any, events = new EventStore();
    const registry = require("prismarine-registry")("1.21.4");
    bot.registry = registry; bot.version = "1.21.4"; bot.supportFeature = registry.supportFeature;
    bot._client = Object.assign(new EventEmitter(), { write: bot.packetWrites, username: bot.username });
    require("mineflayer/lib/plugins/entities.js")(bot);
    bot._client.emit("login", { entityId: 42 });
    const self = bot.entity;
    self.position.y = 64;
    bot.entities[7] = { id: 7, type: "player", position: { x: 4, y: 64, z: 0 } };
    const controller = new BotController({host:"localhost",port:25565,username:"AgentBot",auth:"offline"},events,()=>bot);
    controller.start(); bot.emit("spawn");
    expect(controller.frame().entities).toHaveLength(1);
    for (const lifecycle of ["death", "respawn"]) {
      bot.emit(lifecycle);
      expect(bot.entities).toEqual({ 42: self });
      bot._client.emit("entity_effect", { entityId: 42, effectId: 1, amplifier: 2, duration: 100 });
      bot._client.emit("entity_metadata", { entityId: 42, metadata: [{ key: 0, type: "byte", value: 2 }] });
      expect(bot.entity).toBe(self); expect(bot.entities[42]).toBe(self);
      expect(self.effects[1]).toEqual({ id: 1, amplifier: 2, duration: 100 });
      expect(self.metadata[0]).toBe(2);
      bot.emit("spawn");
      expect(controller.frame().entities).toEqual([]);
      bot._client.emit("remove_entity_effect", { entityId: 42, effectId: 1 });
      expect(self.effects[1]).toBeUndefined();
    }
  });

  it("bounds frame action summaries and deltas while preserving running targets and full status results", async () => {
    const { controller, bot, track } = runtime();
    const running = controller.followTrack(track, 2);
    let oldest = "";
    for (let n = 0; n < 256; n++) {
      const action = controller.runAction("inventory.quickbar", ["item"], () => controller.setQuickBarSlot(n % 9));
      oldest ||= action.action;
      await Promise.resolve(); await Promise.resolve();
    }
    const frame = controller.frame({ maxEntities: 0, radius: 0 });
    expect(frame.actions).toHaveLength(2);
    expect(frame.actions.some((a: any) => a.action === running.action)).toBe(true);
    expect(frame.entities.map((e: any) => e.trackId)).toContain(track);
    expect(frame.actions.every((a: any) => !("result" in a))).toBe(true);
    expect(bot.setQuickBarSlot).toHaveBeenCalledTimes(256);
    expect(controller.actions.get(oldest).result).toEqual({ quickBarSlot: 0 });
    expect(JSON.stringify(frame).length).toBeLessThan(6000);
    const next = controller.runAction("inventory.quickbar", ["item"], () => ({ pages: "y".repeat(10000) }));
    await Promise.resolve(); await Promise.resolve();
    const delta = controller.frame({ maxEntities: 0, radius: 0, since: frame.frame });
    expect(delta.delta.changed.actions).toHaveLength(2);
    expect(delta.delta.changed.actions.at(-1).action).toBe(next.action);
    expect(controller.actions.get(next.action).result).toEqual({ pages: "y".repeat(10000) });
    expect(JSON.stringify(delta).length).toBeLessThan(5000);
  });

  it("keeps snapshot and inventory/window reads out of movement, ticks, guards, samples and find", async () => {
    const { controller, bot, events, track } = runtime();
    const reconcile = vi.spyOn(controller.world, "reconcile");
    const inventoryReads = vi.fn(() => bot.slots);
    const windowReads = vi.fn(() => [{ name: "stone", count: 2 }]);
    Object.defineProperty(bot.inventory, "slots", { get: inventoryReads });
    Object.defineProperty(bot.currentWindow, "slots", { get: windowReads });
    const unrelatedPosition = vi.fn(() => ({ x: 100, y: 64, z: 0 }));
    bot.entities[8] = { id: 8, type: "mob", name: "cod", get position() { return unrelatedPosition(); } };
    const cursor = events.getLastEventId();
    for (let n = 0; n < 100; n++) {
      for (let move = 0; move < 10; move++) bot.emit("entityMoved", bot.entities[7]);
      bot.emit("physicsTick");
      controller.sample(track, ["position", "velocity", "status"]);
      controller.validateContext({ runtimeId: controller.world.runtimeId, worldEpoch: 1 });
    }
    expect(unrelatedPosition).not.toHaveBeenCalled();
    expect(events.list(cursor, 1024)).toEqual([]);
    const action = controller.runAction("entity.interact", ["item", "look"], () => bot._client.write("use_entity", {}), track);
    await controller.actions.wait(action.action);
    expect(bot.packetWrites).toHaveBeenCalledWith("use_entity", {});
    expect(controller.findEntities({ radius: 200 }).entities).toHaveLength(2);
    expect(reconcile).not.toHaveBeenCalled();
    expect(inventoryReads).not.toHaveBeenCalled();
    expect(windowReads).not.toHaveBeenCalled();
    controller.frame();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(inventoryReads).toHaveBeenCalled();
    expect(windowReads).toHaveBeenCalled();
  });

  it("records damage/recovery and target loss/reappearance before the next frame", () => {
    const { controller, bot, events, track } = runtime();
    const cursor = events.getLastEventId();
    bot.health = 4; bot.emit("health");
    bot.health = 20; bot.emit("health");
    bot.emit("entityGone", bot.entities[7]);
    bot.entities[7] = { ...bot.entities[7], position: { x: 7, y: 64, z: 0 } };
    bot.emit("entitySpawn", bot.entities[7]);
    expect(controller.world.trackFor(bot.entities[7])).toBe(track);
    const transient = events.list(cursor, 20);
    expect(transient).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "self.damaged", health: 4, amount: 16 }),
      expect.objectContaining({ type: "self.health_critical", health: 4 }),
      expect.objectContaining({ type: "entity.lost", trackId: track }),
      expect.objectContaining({ type: "entity.appeared", trackId: track }),
    ]));
    expect(controller.frame().self.health).toBe(20);
  });

  it("retires replaced object bindings immediately on a spawn event and reacquires verified UUID", () => {
    const { controller, bot, track } = runtime();
    const old = bot.entities[7];
    const action = controller.followTrack(track, 2);
    bot.entities[7] = { ...old, position: { x: 8, y: 64, z: 0 } };
    bot.emit("entitySpawn", bot.entities[7]);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", reason: "TRACK_LOST" });
    expect(controller.world.trackFor(bot.entities[7])).toBe(track);
    expect(controller.world.resolveTrack(track)).toBe(bot.entities[7]);
    bot.emit("entityDead", old);
    expect(controller.world.resolveTrack(track)).toBe(bot.entities[7]);
  });

  it.each(["removal", "replacement", "dimension"])("blocks asynchronous continuation after eventless %s", async change => {
    const { controller, bot, track } = runtime();
    const pending = deferred();
    bot.lookAtCalls.mockReturnValue(pending.promise);
    const action = controller.runAction("entity.interact", ["item", "look"], async () => {
      await bot.lookAt(bot.entities[7].position);
      bot._client.write("use_entity", {});
    }, track);
    if (change === "removal") delete bot.entities[7];
    if (change === "replacement") bot.entities[7] = { ...bot.entities[7] };
    if (change === "dimension") bot.game.dimension = "the_nether";
    pending.resolve();
    const settled = await controller.actions.wait(action.action);
    expect(settled).toMatchObject({ state: "failed", reason: change === "dimension" ? "WORLD_CHANGED" : "TRACK_LOST" });
    expect(bot.packetWrites).not.toHaveBeenCalled();
  });

  it("continues look on physics ticks and fails follow on eventless dictionary removal", async () => {
    const { controller, bot, track } = runtime();
    const look = controller.trackLook(track);
    await Promise.resolve(); await Promise.resolve();
    bot.entities[7].position.x = 9;
    bot.emit("physicsTick");
    expect(bot.lookAtCalls).toHaveBeenLastCalledWith(expect.objectContaining({ x: 9 }));
    expect(controller.actions.get(look.action).state).toBe("running");
    const follow = controller.followTrack(track, 2);
    delete bot.entities[7];
    bot.emit("physicsTick");
    expect(controller.actions.get(follow.action)).toMatchObject({ state: "failed", reason: "TRACK_LOST" });
    expect(bot.pathfinder.setGoal).toHaveBeenLastCalledWith(null);
  });

  it("self motion retires eventless missing tracks before evaluating proximity", () => {
    const { controller, bot, events, track } = runtime();
    bot.entities[7].position.x = 40;
    bot.emit("entityMoved", bot.entities[7]);
    const cursor = events.getLastEventId();
    delete bot.entities[7];
    bot.entity.position.x = 40;
    bot.emit("move");
    expect(events.list(cursor, 20)).toEqual([expect.objectContaining({ type: "entity.lost", trackId: track })]);
    expect(() => controller.sample(track, ["position"])).toThrow(/lost/i);
  });

  it("retries cooldown-suppressed proximity on ticks without another move or frame", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const { controller, bot, events, track } = runtime();
      const reconcile = vi.spyOn(controller.world, "reconcile");
      const otherPosition = vi.fn(() => ({ x: 100, y: 64, z: 0 }));
      bot.entities[8] = { id: 8, type: "mob", name: "cod", get position() { return otherPosition(); } };
      bot.emit("entitySpawn", bot.entities[8]); otherPosition.mockClear();
      const cursor = events.getLastEventId();
      vi.advanceTimersByTime(500);
      bot.entities[7].position.x = 30; bot.emit("entityMoved", bot.entities[7]);
      bot.emit("physicsTick");
      expect(events.list(cursor, 20)).toEqual([]);
      expect((controller.world as any).pendingProximity.size).toBe(1);
      vi.advanceTimersByTime(1100); bot.emit("physicsTick"); bot.emit("physicsTick");
      expect(events.list(cursor, 20)).toEqual([expect.objectContaining({ type: "entity.left_nearby", trackId: track, distance: 30 })]);
      expect((controller.world as any).pendingProximity.size).toBe(0);
      expect(otherPosition).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(["move", "eventless"])("drops a deferred proximity transition when the target returns via %s", change => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const { controller, bot, events } = runtime();
      const cursor = events.getLastEventId();
      vi.advanceTimersByTime(500);
      bot.entities[7].position.x = 30; bot.emit("entityMoved", bot.entities[7]);
      expect((controller.world as any).pendingProximity.size).toBe(1);
      bot.entities[7].position.x = 5;
      if (change === "move") bot.emit("entityMoved", bot.entities[7]);
      vi.advanceTimersByTime(1100); bot.emit("physicsTick");
      expect(events.list(cursor, 20)).toEqual([]);
      expect((controller.world as any).pendingProximity.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["gone", "eventless-removal", "reset"])("clears pending proximity after %s", change => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const { controller, bot, events } = runtime();
      vi.advanceTimersByTime(500);
      bot.entities[7].position.x = 30; bot.emit("entityMoved", bot.entities[7]);
      expect((controller.world as any).pendingProximity.size).toBe(1);
      const cursor = events.getLastEventId();
      if (change === "gone") bot.emit("entityGone", bot.entities[7]);
      if (change === "eventless-removal") delete bot.entities[7];
      if (change === "reset") bot.emit("death");
      vi.advanceTimersByTime(1100); bot.emit("physicsTick");
      expect((controller.world as any).pendingProximity.size).toBe(0);
      expect(events.list(cursor, 20).map(event => event.type)).toContain("entity.lost");
      expect(events.list(cursor, 20).map(event => event.type)).not.toContain("entity.left_nearby");
    } finally { vi.useRealTimers(); }
  });

});
