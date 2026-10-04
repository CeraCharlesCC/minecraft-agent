import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";
import { API_VERSION } from "../src/core/protocol.js";
import { runDaemon } from "../src/daemon/server.js";

class StopBot extends EventEmitter {
  entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
  entities = {}; players = {}; game = { dimension: "overworld" };
  inventory = { items: () => [] };
  chat = vi.fn(); quit = vi.fn(); lookAt = vi.fn(); setControlState = vi.fn(); clearControlStates = vi.fn();
  stopDigging = vi.fn(); deactivateItem = vi.fn();
  currentWindow = { close: vi.fn() };
  pathfinder = { setGoal: vi.fn(), stop: vi.fn(), setMovements: vi.fn(), goto: vi.fn(async () => {}),
    isMoving: () => false, isMining: () => false, isBuilding: () => false };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); delete process.env.MC_AGENT_STATE_DIR; });

function runtime() {
  const bot = new StopBot();
  const controller = new BotController({ host: "localhost", port: 25565, username: "Agent", auth: "offline" }, new EventStore(), () => bot);
  controller.start(); bot.emit("spawn");
  cleanups.push(() => controller.stop());
  return { bot, controller };
}

async function server() {
  const dir = await mkdtemp(join(tmpdir(), "mc-agent-stop-"));
  process.env.MC_AGENT_STATE_DIR = dir;
  const allocation = createServer();
  await new Promise<void>(resolve => allocation.listen(0, "127.0.0.1", resolve));
  const port = (allocation.address() as { port: number }).port;
  await new Promise<void>(resolve => allocation.close(() => resolve()));
  const bot = new StopBot(), token = "stop-resources-test-token-123456789";
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "X-MC-Agent-API": API_VERSION, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  const get = async (path: string) => (await request(path)).json() as Promise<any>;
  const post = async (path: string, body: unknown) => (await request(path, body)).json() as Promise<any>;
  await runDaemon({ session: "resource-stop", host: "localhost", port: 25565, username: "Agent", auth: "offline",
    controlPort: port, token, createBotFn: () => bot, exitOnStop: false });
  bot.emit("spawn");
  cleanups.push(async () => {
    await post("/stop", {});
    for (let i = 0; i < 100; i++) {
      if (await request("/status").then(() => false, () => true)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { bot, request, get, post, context: (await get("/frame")).context };
}

describe("stopping action resources", () => {
  it("clears all selected state even when no resource has an owner", () => {
    const { bot, controller } = runtime();
    controller.setControl("forward", true);
    expect(controller.stopActions()).toEqual({ stopped: true, resources: ["movement", "look", "item", "window"] });
    expect(bot.clearControlStates).toHaveBeenCalled();
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(null);
    expect(bot.pathfinder.stop).toHaveBeenCalled();
    expect(bot.stopDigging).toHaveBeenCalled();
    expect(bot.deactivateItem).toHaveBeenCalled();
    expect(bot.currentWindow.close).toHaveBeenCalled();
  });

  it("cancels the whole affected action while preserving unrelated owners", () => {
    const { bot, controller } = runtime();
    const affected = controller.runAction("world.dig", ["movement", "look", "item"], () => new Promise(() => {}));
    const unaffected = controller.runAction("window.test", ["window"], () => new Promise(() => {}));
    bot.currentWindow.close.mockClear();
    controller.stopActions(["item"]);
    expect(controller.actions.get(affected.action)).toMatchObject({ state: "cancelled", reason: "STOPPED" });
    expect(controller.actions.owner("movement")).toBeUndefined();
    expect(controller.actions.owner("look")).toBeUndefined();
    expect(controller.actions.owner("item")).toBeUndefined();
    expect(controller.actions.owner("window")).toBe(unaffected.action);
    expect(bot.currentWindow.close).not.toHaveBeenCalled();
  });

  it("stops selected continuous work immediately through HTTP", async () => {
    const { bot, get, post, context } = await server();
    const action = await post("/control/set", { context, state: "forward", value: true, observe: false });
    expect(await post("/actions/stop", { context, resources: ["movement", "movement"], observe: false }))
      .toEqual({ stopped: true, resources: ["movement"] });
    expect(await get(`/actions/${action.action}`)).toMatchObject({ state: "cancelled", reason: "STOPPED" });
    expect(bot.clearControlStates).toHaveBeenCalled();
    expect(await post("/actions/stop", { context, observe: false })).toEqual({
      stopped: true, resources: ["movement", "look", "item", "window"] });
  });

  it("requires valid context and resource selection", async () => {
    const { request, context } = await server();
    const missing = await request("/actions/stop", { resources: ["item"] });
    expect(await missing.json()).toMatchObject({ code: "CONTEXT_REQUIRED" });
    for (const resources of [null, [], ["invalid"], "movement", [1]]) {
      const response = await request("/actions/stop", { context, resources, observe: false });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "BAD_INPUT" });
    }
  });

  it("can stop resources while the world is temporarily not ready", async () => {
    const { bot, get, post } = await server();
    bot.emit("death");
    const context = (await get("/frame")).context;
    expect(await post("/actions/stop", { context, resources: ["item"], observe: false }))
      .toEqual({ stopped: true, resources: ["item"] });
  });
});
