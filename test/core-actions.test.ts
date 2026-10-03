import { describe, expect, it, vi } from "vitest";
import { ActionManager } from "../src/core/actions.js";
import { EventStore } from "../src/core/events.js";
import { CliError } from "../src/output/errors.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
async function tick() { await Promise.resolve(); await Promise.resolve(); }

function setup(history = 256) {
  const events = new EventStore();
  return { events, actions: new ActionManager(events, history) };
}

describe("runtime action ownership", () => {
  it("returns promptly then reports detached completion results", async () => {
    const { events, actions } = setup();
    const work = deferred<{ done: boolean }>();
    const record = actions.start("navigate.goto", 3, ["movement"], { run: () => work.promise });
    expect(record).toMatchObject({ state: "running", runtimeId: events.runtimeId, worldEpoch: 3 });
    expect(actions.owner("movement")).toBe(record.action);
    const result = { done: true };
    work.resolve(result);
    await tick();
    result.done = false;
    expect(actions.get(record.action)).toMatchObject({ state: "completed", result: { done: true } });
    expect(actions.owner("movement")).toBeUndefined();
    expect(events.query().events.map(event => event.type)).toEqual(["action.started", "action.completed"]);
  });

  it("explicitly replaces predecessors before new physical work begins", () => {
    const { events, actions } = setup();
    const order: string[] = [];
    const first = actions.start("navigate.follow", 1, ["movement", "look"], { continuous: true, stop: () => order.push("stop-old") });
    const next = actions.start("look.track", 1, ["look"], { continuous: true, run: () => order.push("start-new") });
    expect(order).toEqual(["stop-old", "start-new"]);
    expect(actions.get(first.action)).toMatchObject({ state: "cancelled", reason: "REPLACED" });
    expect(actions.owner("movement")).toBeUndefined();
    expect(actions.owner("look")).toBe(next.action);
    expect(events.query().events.map(event => event.type)).toEqual(["action.started", "action.cancelled", "action.started"]);
  });

  it("ignores late fulfillment and rejection after cancellation", async () => {
    const { actions } = setup();
    const work = deferred<string>();
    const stop = vi.fn();
    const first = actions.start("navigate.goto", 1, ["movement"], { run: () => work.promise, stop });
    actions.cancel(first.action);
    work.resolve("late");
    await tick();
    expect(actions.get(first.action)).toMatchObject({ state: "cancelled", reason: "CANCELLED" });
    expect(actions.get(first.action).result).toBeUndefined();
    const secondWork = deferred<string>();
    const second = actions.start("navigate.goto", 1, ["movement"], { run: () => secondWork.promise, stop });
    actions.cancel(second.action);
    secondWork.reject(new Error("late failure"));
    await tick();
    expect(actions.get(second.action)).toMatchObject({ state: "cancelled" });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("keeps continuous follow running after its initial work settles", async () => {
    const { actions } = setup();
    const record = actions.start("navigate.follow", 1, ["movement"], { continuous: true, run: () => ({ range: 2 }) });
    await tick();
    expect(actions.get(record.action).state).toBe("running");
    expect(actions.owner("movement")).toBe(record.action);
  });

  it("fails lost targets, stops them once, and leaves fresh actions authoritative", async () => {
    const { actions } = setup();
    const stop = vi.fn();
    const old = actions.start("navigate.follow", 1, ["movement"], { target: "track", continuous: true, stop });
    actions.failTarget("track");
    expect(actions.get(old.action)).toMatchObject({ state: "failed", reason: "TRACK_LOST", error: { code: "TRACK_LOST", details: { trackId: "track" } } });
    const fresh = actions.start("navigate.follow", 1, ["movement"], { target: "track", continuous: true });
    await tick();
    expect(actions.get(old.action).state).toBe("failed");
    expect(actions.get(fresh.action).state).toBe("running");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("fails every running resource action when the world resets", () => {
    const { actions } = setup();
    const movement = actions.start("navigate.follow", 1, ["movement"], { continuous: true });
    const item = actions.start("inventory.activate-item", 1, ["item"], { continuous: true });
    actions.failAll("DEATH");
    for (const action of [movement, item]) expect(actions.get(action.action)).toMatchObject({ state: "failed", reason: "WORLD_CHANGED", error: { details: { reason: "DEATH" } } });
    expect(actions.owner("movement")).toBeUndefined();
    expect(actions.owner("item")).toBeUndefined();
  });

  it("preserves typed errors and detaches mutable details", () => {
    const { actions } = setup();
    const detail = { bindingGeneration: 2 };
    const action = actions.start("entity.attack", 1, ["item"], { run: () => { throw new CliError("TRACK_LOST", "lost", "observe", 1, detail); } });
    detail.bindingGeneration = 9;
    expect(action).toMatchObject({ state: "failed", reason: "TRACK_LOST", error: { details: { bindingGeneration: 2 } } });
  });

  it("rejects cross-runtime handles and never reuses IDs", () => {
    const { actions } = setup();
    const first = actions.start("look.track", 1, ["look"], { continuous: true });
    actions.cancel(first.action);
    const second = actions.start("look.track", 1, ["look"], { continuous: true });
    expect(first.action).not.toBe(second.action);
    const restarted = setup().actions;
    expect(() => restarted.get(first.action)).toThrow(expect.objectContaining({ code: "RUNTIME_MISMATCH" }));
    expect(() => restarted.cancel(first.action)).toThrow(expect.objectContaining({ code: "RUNTIME_MISMATCH" }));
  });

  it("bounds terminal history by settlement order and preserves running actions", async () => {
    const { actions } = setup(1);
    const oldRunning = actions.start("navigate.follow", 1, ["movement"], { continuous: true });
    const newer = actions.start("look.at", 1, ["look"]);
    await tick();
    expect(actions.get(oldRunning.action).state).toBe("running");
    expect(actions.get(newer.action).state).toBe("completed");
    expect(actions.cancel(oldRunning.action)).toMatchObject({ state: "cancelled" });
    expect(actions.get(oldRunning.action).state).toBe("cancelled");
    expect(() => actions.get(newer.action)).toThrow(expect.objectContaining({ code: "ACTION_UNKNOWN" }));
    expect(actions.list()).toHaveLength(1);
  });

  it("supports zero retained terminal history without corrupting return values", () => {
    const { actions } = setup(0);
    const continuous = actions.start("look.track", 1, ["look"], { continuous: true });
    expect(actions.cancel(continuous.action)).toMatchObject({ state: "cancelled" });
    expect(actions.list()).toEqual([]);
    const failed = actions.start("look.at", 1, ["look"], { run: () => { throw new Error("failed"); } });
    expect(failed.state).toBe("failed");
    expect(actions.list()).toEqual([]);
  });

  it("serializes bigint and circular results while releasing ownership", async () => {
    const { actions } = setup();
    const result: { count: bigint; self?: unknown } = { count: 1n };
    result.self = result;
    const action = actions.start("result", 1, ["item"], { run: () => result });
    await tick();
    expect(actions.get(action.action)).toMatchObject({ state: "completed", result: { count: "1", self: "[Circular]" } });
    expect(actions.owner("item")).toBeUndefined();
    expect(() => JSON.stringify(actions.list())).not.toThrow();
  });

  it("fails cleanly if a result getter throws during snapshot copying", async () => {
    const { actions } = setup();
    const result = Object.defineProperty({}, "broken", { enumerable: true, get: () => { throw new Error("unreadable result"); } });
    const stop = vi.fn();
    const action = actions.start("result", 1, ["item"], { run: () => result, stop });
    await tick();
    expect(actions.get(action.action)).toMatchObject({ state: "failed", reason: "DAEMON_ERROR" });
    expect(actions.owner("item")).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not let a cleanup transport error prevent replacement", () => {
    const { actions } = setup();
    const prior = actions.start("follow", 1, ["movement"], { continuous: true, stop: () => { throw new Error("disconnected"); } });
    const next = actions.start("follow", 1, ["movement"], { continuous: true });
    expect(actions.get(prior.action)).toMatchObject({ state: "cancelled" });
    expect(actions.owner("movement")).toBe(next.action);
  });
});
