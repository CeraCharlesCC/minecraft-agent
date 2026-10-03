import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

const UUID = "aabbccdd-1122-3344-5566-778899aabbcc";
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
  setControlState = vi.fn((state: string, value: boolean) => { this.controlState[state] = value; });
  clearControlStates = vi.fn(() => { this.controlState = {}; });
  chat = vi.fn(); quit = vi.fn(); lookAtCalls = vi.fn(); lookAt = this.lookAtCalls; activateEntity = vi.fn(); equip = vi.fn(); placeBlock = vi.fn();
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
    const first = controller.frame();
    bot.entity.velocity.x = 2; bot.slots[0].count = 9; bot.currentWindow.slots[0].count = 8;
    const json = { text: "same" };
    bot.emit("message", json, "chat", UUID); bot.emit("chat", "Alex", "same", undefined, json);
    bot.emit("message", json, "chat", UUID); bot.emit("chat", "Alex", "same", undefined, json);
    const second = controller.frame();
    expect(first.self.velocity.x).toBe(0); expect(first.inventory[0].count).toBe(3); expect(first.window.slots[0].count).toBe(2);
    expect(second.self.velocity.x).toBe(2); expect(second.inventory[0].count).toBe(9);
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
    expect(dead.worldEpoch).toBeGreaterThan(frame.worldEpoch);
    expect(dead.connection.ready).toBe(false); expect(dead.self.position).toBeUndefined(); expect(dead.window).toBeNull();
    expect(dead.entities[0].position).toBeUndefined(); expect(dead.entities[0].status).toBe("lost");
    expect(dead.actions.find((a: any) => a.action === follow.action)).toMatchObject({ state: "failed", reason: "WORLD_CHANGED", error: { details: { reason: "DEATH" } } });
    expect(() => controller.validateContext({ runtimeId: frame.runtimeId, worldEpoch: frame.worldEpoch })).toThrow(/World context/);
  });

  it("detects dimension changes before executing an action and waits for readiness", () => {
    const { controller, bot, track } = runtime(); const frame = controller.frame();
    controller.followTrack(track, 2); bot.game.dimension = "the_nether";
    expect(() => controller.validateContext({ runtimeId: frame.runtimeId, worldEpoch: frame.worldEpoch })).toThrow(/World context/);
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
    const { controller, bot } = runtime(); const pending = deferred(); bot.equip.mockReturnValue(pending.promise);
    const action = controller.runAction("world.place", ["item", "look"], () => controller.place(1,64,0,"up","dirt"));
    controller.actions.cancel(action.action); pending.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(bot.placeBlock).not.toHaveBeenCalled(); expect(controller.actions.get(action.action).state).toBe("cancelled");
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
    const action = controller.runAction("entity.activate", ["item", "look"], () => controller.activateEntity(track), track);
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

});
