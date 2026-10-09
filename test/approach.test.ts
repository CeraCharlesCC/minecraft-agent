import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import type { Move, PartiallyComputedPath, goals } from "mineflayer-pathfinder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

const AStar = createRequire(import.meta.url)("mineflayer-pathfinder/lib/astar.js");
const move = (x: number, z: number): Move => ({ x, y: 64, z, cost: 1, remainingBlocks: 0,
  toBreak: [], toPlace: [], parkour: false, hash: `${x},64,${z}` });

class ApproachBot extends EventEmitter {
  username = "AgentBot";
  entity = { position: new Vec3(0.5, 64, 0.5) };
  entities = { 7: { id: 7, name: "villager", type: "mob", position: new Vec3(8.5, 64, 0.5) } };
  players = {}; game = { dimension: "overworld" }; inventory = { items: () => [] };
  chat = vi.fn(); quit = vi.fn(); setControlState = vi.fn(); lookAt = vi.fn();
  movements = {
    canDig: false, emptyBlocks: new Set([0]), scafoldingBlocks: [], allow1by1towers: false,
    getNeighbors: (node: Move) => [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => {
      const x = node.x + dx!, z = node.z + dz!;
      // A loaded, bounded flat world with a closed fence around the villager.
      const fence = ((x === 7 || x === 9) && z >= -1 && z <= 1) || ((z === -1 || z === 1) && x >= 7 && x <= 9);
      return x < 0 || x > 10 || Math.abs(z) > 3 || fence ? [] : [move(x, z)];
    }),
  };
  blockAt = vi.fn((position: Vec3) => ({ name: "air", type: 0, position }));
  pathfinder = {
    movements: this.movements as never, thinkTimeout: 5000, tickTimeout: 40, searchRadius: -1,
    setMovements: vi.fn(), setGoal: vi.fn(), stop: vi.fn(),
    isMoving: () => false, isMining: () => false, isBuilding: () => false,
    getPathFromTo: vi.fn((_movements: unknown, start: Vec3, goal: goals.Goal, options: { timeout: number; tickTimeout: number; searchRadius: number }) => {
      const result: PartiallyComputedPath = new AStar(move(Math.floor(start.x), Math.floor(start.z)), this.movements,
        goal, options.timeout, options.tickTimeout, options.searchRadius).compute();
      return (function* () { yield { result }; })();
    }),
    goto: vi.fn(async (goal: goals.Goal) => {
      const [{ result }] = [...this.pathfinder.getPathFromTo(this.movements, this.entity.position, goal,
        { timeout: 5000, tickTimeout: 40, searchRadius: 64 })];
      this.emit("path_update", result);
      if (result!.status !== "success") throw Object.assign(new Error("No path to goal"), { name: "NoPath" });
      const end = result!.path.at(-1);
      if (end) this.entity.position = new Vec3(end.x + 0.5, end.y, end.z + 0.5);
    }),
  };
}

const subjects: BotController[] = [];
afterEach(() => { for (const controller of subjects.splice(0)) controller.stop(); vi.useRealTimers(); });
function runtime() {
  const bot = new ApproachBot();
  const controller = new BotController({ host: "localhost", port: 25565, username: "AgentBot", auth: "offline" }, new EventStore(), () => bot);
  subjects.push(controller); controller.start(); bot.emit("spawn");
  const track = controller.world.trackFor(bot.entities[7])!;
  const approach = (range: number, bestEffort = false) => controller.runAction("navigate.approach", ["movement", "look"],
    () => controller.approachTrack(track, range, bestEffort), track);
  return { bot, controller, track, approach };
}

describe("entity approach", () => {
  it("reaches the outside of a closed fence without entering or modifying it", async () => {
    const { bot, controller, approach } = runtime();
    const action = approach(2.1);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: {
      completionReason: "within_range", goalSatisfied: true, progress: true, startDistance: 8, distanceToTarget: 2,
      finalPosition: { x: 6.5, y: 64, z: 0.5 },
    } });
    expect(bot.movements).toMatchObject({ canDig: false, scafoldingBlocks: [], allow1by1towers: false });
  });

  it.each(["noPath", "timeout"] as const)("requires opt-in before using a %s route, then reports partial progress honestly", async status => {
    const { bot, controller, approach } = runtime();
    const search = bot.pathfinder.getPathFromTo.getMockImplementation()!;
    bot.pathfinder.getPathFromTo.mockImplementation((...args) => (function* () {
      for (const { result } of search(...args)) yield { result: { ...result, status: result.status === "noPath" ? status : result.status } };
    })());
    const strict = approach(1);
    expect(await controller.actions.wait(strict.action, 1000)).toMatchObject({ state: "failed", error: { details: { reason: status === "noPath" ? "NO_PATH" : "TIMEOUT" } } });
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
    const partial = approach(1, true);
    expect(await controller.actions.wait(partial.action, 1000)).toMatchObject({ state: "completed", result: {
      completionReason: "best_effort", goalSatisfied: false, progress: true, pathStatus: status, startDistance: 8, distanceToTarget: 2,
    } });
    const again = approach(1, true);
    expect(await controller.actions.wait(again.action, 1000)).toMatchObject({ result: { progress: false, attempts: 0 } });
    expect(bot.pathfinder.goto).toHaveBeenCalledTimes(1);
  });

  it("checks observed fractional positions rather than treating a satisfied block node as arrival", async () => {
    const { bot, controller, approach } = runtime();
    bot.entity.position = new Vec3(6.01, 64, 0.5);
    const action = approach(2);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "failed", error: { details: { reason: "GOAL_NOT_REACHED" } } });
    bot.entity.position = new Vec3(6.6, 64, 0.5);
    const near = approach(2);
    expect(await controller.actions.wait(near.action, 1000)).toMatchObject({ state: "completed", result: { completionReason: "already_within_range", goalSatisfied: true } });
  });

  it("replans when the target moves and caps chasing at three movements", async () => {
    const { bot, controller, approach } = runtime();
    const walk = bot.pathfinder.goto.getMockImplementation()!;
    let movements = 0;
    bot.pathfinder.goto.mockImplementation(async goal => {
      await walk(goal);
      bot.entities[7].position.x += ++movements < 3 ? 1 : 3;
    });
    const action = approach(2.1, true);
    expect(await controller.actions.wait(action.action, 1000)).toMatchObject({ state: "completed", result: { goalSatisfied: false, attempts: 3 } });
    expect(bot.pathfinder.goto).toHaveBeenCalledTimes(3);
  });

  it.each(["cancel", "target_lost", "world_reset"])("does not move after %s during a yielded search", async mode => {
    const { bot, controller, approach } = runtime();
    bot.pathfinder.getPathFromTo.mockImplementation(() => (function* () {
      yield { result: { status: "partial", path: [move(6, 0)] } as PartiallyComputedPath };
      yield { result: { status: "noPath", path: [move(6, 0)] } as PartiallyComputedPath };
    })());
    const action = approach(1, true);
    if (mode === "cancel") controller.actions.cancel(action.action);
    else if (mode === "target_lost") bot.emit("entityGone", bot.entities[7]);
    else bot.emit("death");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
    expect(controller.actions.get(action.action).state).toBe(mode === "cancel" ? "cancelled" : "failed");
  });

  it("times out stalled movement instead of leaving an approach running indefinitely", async () => {
    vi.useFakeTimers();
    const { bot, controller, approach } = runtime();
    bot.pathfinder.goto.mockImplementation(() => new Promise<void>(() => {}));
    const action = approach(2.1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.actions.get(action.action)).toMatchObject({ state: "failed", error: { details: { reason: "TIMEOUT" } } });
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(null);
  });
});
