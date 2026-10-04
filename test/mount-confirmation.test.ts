import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

class MountBot extends EventEmitter {
  entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
  target = { id: 7, uuid: "11111111-1111-4111-8111-111111111111", name: "boat", type: "object", position: { x: 2, y: 64, z: 0 } };
  entities: Record<string, typeof this.entity | typeof this.target> = { 1: this.entity, 7: this.target };
  vehicle: typeof this.target | null = null;
  players = {}; game = { dimension: "overworld" }; inventory = { items: () => [] };
  chat = vi.fn(); quit = vi.fn(); lookAt = vi.fn(); setControlState = vi.fn(); clearControlStates = vi.fn();
  mount = vi.fn((_target: typeof this.target) => {});
  activateEntity = vi.fn(async () => {});
  stopDigging = vi.fn(); deactivateItem = vi.fn();
}

const subjects: BotController[] = [];
function runtime() {
  const bot = new MountBot(), events = new EventStore();
  const controller = new BotController({ host: "localhost", port: 25565, username: "Agent", auth: "offline" }, events, () => bot);
  subjects.push(controller);
  controller.start(); bot.emit("spawn");
  const track = controller.world.trackFor(bot.target)!;
  const start = () => controller.runAction("entity.mount", ["movement", "look", "item"], () => controller.mountEntity(track), track);
  const confirm = () => { bot.vehicle = bot.target; bot.emit("mount"); };
  return { bot, controller, start, confirm, track };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
afterEach(() => { for (const controller of subjects.splice(0)) controller.stop(); vi.useRealTimers(); });

describe("confirmed entity mounting", () => {
  it("registers confirmation before dispatch and returns the exact target", async () => {
    const { bot, controller, start, confirm, track } = runtime();
    bot.mount.mockImplementation(confirm);
    const action = start();
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: {
      mounted: true, entity: { trackId: track } } });
    expect(bot.listenerCount("mount")).toBe(0);
  });

  it("holds ownership until the server confirms the vehicle", async () => {
    const { controller, start, confirm } = runtime();
    const action = start(); await flush();
    expect(controller.actions.get(action.action).state).toBe("running");
    for (const resource of ["movement", "look", "item"] as const) expect(controller.actions.owner(resource)).toBe(action.action);
    confirm();
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: { mounted: true } });
  });

  it.each(["no confirmation", "old vehicle", "different target", "copied binding"])("rejects %s with a bounded timeout", async scenario => {
    vi.useFakeTimers();
    const { bot, controller, start } = runtime();
    if (scenario === "old vehicle") bot.vehicle = bot.target;
    const action = start();
    if (scenario === "different target") { bot.vehicle = { ...bot.target, id: 8 }; bot.emit("mount"); }
    if (scenario === "copied binding") { bot.vehicle = { ...bot.target }; bot.emit("mount"); }
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", error: {
      code: "MOUNT_UNCONFIRMED", details: { timeoutMs: 5000 } } });
    expect(controller.actions.get(action.action)).not.toHaveProperty("result");
    expect(bot.listenerCount("mount")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "replace", "reset", "target lost"])("cleans listeners and timers on %s", async mode => {
    vi.useFakeTimers();
    const { bot, controller, start, confirm } = runtime();
    const action = start();
    if (mode === "cancel") controller.actions.cancel(action.action);
    if (mode === "replace") controller.runAction("inventory.test", ["item"], () => new Promise(() => {}));
    if (mode === "reset") controller.world.reset("DEATH");
    if (mode === "target lost") { delete bot.entities[7]; bot.emit("entityGone", bot.target); }
    expect(bot.listenerCount("mount")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    confirm(); await flush();
    expect(controller.actions.get(action.action).state).toBe(["reset", "target lost"].includes(mode) ? "failed" : "cancelled");
    expect(controller.actions.get(action.action)).not.toHaveProperty("result");
  });

  it("checks live dimension before accepting a mount event", async () => {
    const { bot, controller, start, confirm } = runtime();
    const action = start(); bot.game.dimension = "the_nether"; confirm();
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "failed", error: { code: "WORLD_CHANGED" } });
    expect(bot.listenerCount("mount")).toBe(0);
  });

  it("rejects a changed target UUID", async () => {
    const { bot, controller, start, confirm } = runtime();
    const action = start(); bot.target.uuid = "22222222-2222-4222-8222-222222222222"; confirm();
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "failed", error: { code: "TRACK_LOST" } });
  });

  it("releases listeners if mount dispatch throws", async () => {
    vi.useFakeTimers();
    const { bot, controller, start } = runtime();
    bot.mount.mockImplementation(() => { throw new Error("dispatch failed"); });
    const action = start(); await flush();
    expect(controller.actions.get(action.action).state).toBe("failed");
    expect(bot.listenerCount("mount")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "reset"])("handles synchronous %s followed by a dispatch error", async mode => {
    vi.useFakeTimers();
    const { bot, controller, start } = runtime();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      bot.mount.mockImplementation(() => {
        if (mode === "cancel") controller.actions.cancel(controller.actions.owner("movement")!);
        else controller.world.reset("DEATH");
        throw new Error("dispatch failed after interruption");
      });
      const action = start();
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.actions.get(action.action).state).toBe(mode === "cancel" ? "cancelled" : "failed");
      expect(controller.actions.get(action.action)).not.toHaveProperty("result");
      expect(bot.listenerCount("mount")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });
});
