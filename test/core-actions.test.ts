import { describe, expect, it, vi } from "vitest";
import { ActionManager, projectAction } from "../src/core/actions.js";
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
  it("projects public action fields explicitly and keeps frame summaries bounded", async () => {
    const { actions, events } = setup();
    const work = deferred<{ completionReason: string; finalPosition: { x: number; y: number; z: number } }>();
    const record = actions.start("navigate.goto", 1, ["movement"], { target: `${events.runtimeTag}:e1`, run: () => work.promise });
    expect(projectAction(record)).toEqual({ action: record.action, kind: "navigate.goto", state: "running", target: `${events.runtimeTag}:e1` });
    expect(record.action).toBe(`${events.runtimeTag}:a1`);
    work.resolve({ completionReason: "within_range", finalPosition: { x: 1, y: 2, z: 3 } });
    const result = await actions.wait(record.action, 1000);
    expect(projectAction(result)).toEqual({ action: record.action, kind: "navigate.goto", state: "completed", target: record.target,
      timedOut: false, result: { completionReason: "within_range", finalPosition: { x: 1, y: 2, z: 3 } } });
    expect(actions.observation()).toEqual([{ action: record.action, kind: "navigate.goto", state: "completed", target: record.target }]);
    expect(events.query().events.at(-1)?.result).toEqual(result.result);
    expect(projectAction(result, { detail: "full" })).toMatchObject({ runtimeId: events.runtimeId, worldEpoch: 1, startedAt: result.startedAt, finishedAt: result.finishedAt });
    const failure = actions.start("entity.attack", 1, ["item"], { run: () => { throw new CliError("DAEMON_ERROR", "account@example.com at private.example:25565", "retry", 1, { runtimeId: events.runtimeId, bindingGeneration: 4, connection: { username: "secret" }, outcomeUnknown: true }); } });
    const publicFailure = projectAction(failure);
    expect(publicFailure.error).toMatchObject({ code: "DAEMON_ERROR", details: { outcomeUnknown: true } });
    expect(JSON.stringify(publicFailure)).not.toMatch(/private|account|bindingGeneration|runtimeId|startedAt|secret/);
    expect(actions.observation().at(-1)?.error).toEqual({ code: "DAEMON_ERROR" });
    const timedOut = await actions.wait(actions.start("follow", 1, [], { continuous: true }).action, 0);
    expect(projectAction(timedOut).timedOut).toBe(true);
  });

  it("rejects malformed action handles before lookup", () => {
    const { actions, events } = setup();
    for (const id of ["another:a1", `${events.runtimeTag}:a01`, `${events.runtimeTag}:a0`, `${events.runtimeTag}:a1\n`, `${events.runtimeTag}:s1`, `${events.runtimeId}:a1`]) {
      expect(() => actions.get(id)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
    expect(() => actions.get(`${events.runtimeTag}:a1`)).toThrow(expect.objectContaining({ code: "ACTION_UNKNOWN" }));
  });

  it("shows every running action and only the latest terminal action in settlement order", async () => {
    const { actions, events } = setup();
    const oldWork = deferred<string>();
    const old = actions.start("old", 1, [], { run: () => oldWork.promise });
    const running = actions.start("follow", 1, ["movement"], { continuous: true, target: `${events.runtimeTag}:e1` });
    const newer = actions.start("newer", 1, []);
    await tick();
    expect(actions.observation().map(record => record.action)).toEqual([old.action, running.action, newer.action]);
    oldWork.resolve("settled last");
    await tick();
    const expected = [
      { action: running.action, kind: "follow", state: "running", target: `${events.runtimeTag}:e1` },
      { action: old.action, kind: "old", state: "completed" },
    ];
    expect(actions.observation()).toEqual(expected);
    const detached = actions.observation();
    detached[0]!.state = "failed";
    detached.pop();
    expect(actions.observation()).toEqual(expected);
    expect(actions.get(newer.action).state).toBe("completed");
    actions.fail(running.action, new CliError("TRACK_LOST", "Lost", "Observe."));
    expect(actions.observation()).toEqual([{ action: running.action, kind: "follow", state: "failed",
      target: running.target, reason: "TRACK_LOST", error: { code: "TRACK_LOST" } }]);
    expect(actions.list()).toHaveLength(3);
    expect(events.query().events.filter(event => event.type === "action.completed")).toHaveLength(2);
  });

  it("exposes a committed settlement to synchronous event observers", async () => {
    const { actions, events } = setup();
    const snapshots: unknown[] = [];
    events.subscribe(event => { if (event.type === "action.completed") snapshots.push(actions.observation()); });
    const action = actions.start("look.at", 1, []);
    await tick();
    expect(snapshots).toEqual([[{ action: action.action, kind: "look.at", state: "completed" }]]);
  });

  it("waits for settlement and returns detached results", async () => {
    const { actions } = setup();
    const work = deferred<{ value: number }>();
    const action = actions.start("look.at", 1, ["look"], { run: () => work.promise });
    const waiting = actions.wait(action.action, 1000);
    work.resolve({ value: 7 });
    const finished = await waiting;
    expect(finished).toMatchObject({ state: "completed", timedOut: false, result: { value: 7 } });
    (finished.result as { value: number }).value = 9;
    expect(actions.get(action.action).result).toEqual({ value: 7 });
    expect(await actions.wait(action.action, 0)).toMatchObject({ state: "completed", timedOut: false });
  });

  it("reports failed and cancelled settlement to every waiter", async () => {
    const { actions } = setup();
    const action = actions.start("follow", 1, ["movement"], { continuous: true });
    const waits = [actions.wait(action.action, 1000), actions.wait(action.action, 1000)];
    actions.fail(action.action, new CliError("TRACK_LOST", "lost", "Observe.", 1, { trackId: "target" }));
    for (const result of await Promise.all(waits)) expect(result).toMatchObject({ state: "failed", timedOut: false, error: { code: "TRACK_LOST", details: { trackId: "target" } } });
    const next = actions.start("follow", 1, ["movement"], { continuous: true });
    const cancelled = actions.wait(next.action, 1000);
    actions.cancel(next.action);
    expect(await cancelled).toMatchObject({ state: "cancelled", timedOut: false });
  });

  it("times out continuous work without cancelling it", async () => {
    vi.useFakeTimers();
    try {
      const { actions } = setup();
      const stop = vi.fn();
      const action = actions.start("follow", 1, ["movement"], { continuous: true, stop });
      const waiting = actions.wait(action.action, 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await waiting).toMatchObject({ state: "running", timedOut: true });
      expect(actions.owner("movement")).toBe(action.action);
      expect(stop).not.toHaveBeenCalled();
      expect(await actions.wait(action.action, 0)).toMatchObject({ state: "running", timedOut: true });
      actions.cancel(action.action);
    } finally { vi.useRealTimers(); }
  });

  it("aborts only the waiter and rejects malformed deadlines or foreign actions", async () => {
    const { actions } = setup();
    const action = actions.start("follow", 1, ["movement"], { continuous: true });
    const abort = new AbortController();
    const waiting = actions.wait(action.action, 1000, abort.signal);
    const rejection = expect(waiting).rejects.toThrow("stop waiting");
    abort.abort(new Error("stop waiting"));
    await rejection;
    expect(actions.get(action.action).state).toBe("running");
    for (const timeout of [-1, NaN, 30001, 0.5]) expect(() => actions.wait(action.action, timeout)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    expect(() => actions.wait(setup().actions.start("foreign", 1, [], { continuous: true }).action)).toThrow(expect.objectContaining({ code: "RUNTIME_MISMATCH" }));
    actions.cancel(action.action);
  });
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
