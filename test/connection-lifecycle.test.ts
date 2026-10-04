import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

class Bot extends EventEmitter {
  username = "Agent";
  entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
  entities = {};
  players = {};
  game = { dimension: "overworld" };
  chat = vi.fn();
  quit = vi.fn();
  setControlState = vi.fn();
  clearControlStates = vi.fn();
  lookAt = vi.fn();
  stopDigging = vi.fn();
  deactivateItem = vi.fn();
  currentWindow = null;
}
const options = { host: "localhost", port: 25565, username: "Agent", auth: "offline" };
const subjects: BotController[] = [];
function setup(overrides = {}) {
  const bots: Bot[] = [];
  const create = vi.fn(() => { const bot = new Bot(); bots.push(bot); return bot; });
  const subject = new BotController({ ...options, ...overrides }, new EventStore(), create);
  subjects.push(subject);
  subject.start();
  return { subject, bots, create };
}
afterEach(() => { for (const subject of subjects.splice(0)) subject.stop(); vi.useRealTimers(); });

describe("connection lifecycle", () => {
  it.each([false, true])("omits recovery during healthy startup (autoReconnect=%s)", automatic => {
    const { subject, bots } = setup({ autoReconnect: automatic });
    expect(subject.connectionStatus()).toEqual({ state: "connecting", ready: false });
    bots[0].emit("login");
    expect(subject.connectionStatus()).toEqual({ state: "waiting_for_spawn", ready: false });
    bots[0].emit("spawn");
    expect(subject.connectionStatus()).toEqual({ state: "ready", ready: true });
  });

  it("diagnoses structured errors and bounds history without guessing auth", () => {
    const { subject, bots } = setup();
    expect(subject.diagnose().connection.authentication.state).toBe("unknown");
    for (let i = 0; i < 40; i++) bots[0].emit("error", Object.assign(new Error("write failed"), { code: "EPIPE" }));
    expect(subject.diagnose()).toMatchObject({ ready: false, lastError: { code: "EPIPE", message: "The game connection is unavailable.", generation: 1 }, retry: { enabled: false } });
    expect(subject.diagnose().transitions).toHaveLength(32);
    expect(subject.diagnose().connection.authentication.state).toBe("unknown");
  });

  it("shares simultaneous recovery and waits for spawn after login", async () => {
    const { subject, bots, create } = setup();
    bots[0].emit("end", "socketClosed");
    const first = subject.ensureReady({ timeout: 500, backoff: 0 });
    const second = subject.ensureReady({ timeout: 500, backoff: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(create).toHaveBeenCalledTimes(2);
    bots[1].emit("login");
    expect(subject.diagnose().ready).toBe(false);
    bots[1].emit("spawn");
    expect(await first).toMatchObject({ ready: true, timedOut: false, attempts: 1 });
    expect(await second).toMatchObject({ ready: true, timedOut: false });
    await subject.ensureReady();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fences late retired callbacks and preserves runtime while advancing epoch", async () => {
    const { subject, bots } = setup();
    bots[0].emit("spawn");
    const before = { runtimeId: subject.world.runtimeId, worldEpoch: subject.world.worldEpoch };
    const oldSpawn = bots[0].listeners("spawn")[0];
    const oldEnd = bots[0].listeners("end")[0];
    bots[0].emit("end", "socketClosed");
    const recovery = subject.ensureReady({ timeout: 500, backoff: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    bots[1].emit("spawn");
    await recovery;
    const after = { runtimeId: subject.world.runtimeId, worldEpoch: subject.world.worldEpoch };
    expect(after.runtimeId).toBe(before.runtimeId);
    expect(after.worldEpoch).toBeGreaterThan(before.worldEpoch);
    oldSpawn(); oldEnd("late");
    bots[0].emit("error", new Error("late"));
    bots[0].emit("message", { text: "old chat" });
    expect(subject.status()).toMatchObject({ ready: true });
    expect(subject.world.worldEpoch).toBe(after.worldEpoch);
    expect(bots[0].listenerCount("spawn")).toBe(0);
    expect(bots[0].listenerCount("message")).toBe(0);
    expect(bots[0].quit).toHaveBeenCalledOnce();
  });

  it("does not resume continuous physical actions on recovery", async () => {
    const { subject, bots } = setup();
    bots[0].emit("spawn");
    const run = vi.fn();
    const action = subject.runAction("control.set", ["movement"], run, undefined, true);
    await Promise.resolve();
    bots[0].emit("end", "socketClosed");
    expect(subject.actions.get(action.action).state).toBe("failed");
    const recovery = subject.ensureReady({ timeout: 500, backoff: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    bots[1].emit("spawn");
    await recovery;
    expect(run).toHaveBeenCalledOnce();
    expect(subject.actions.get(action.action).state).toBe("failed");
  });

  it("bounds hung startup attempts and each concurrent caller deadline", async () => {
    vi.useFakeTimers();
    const { subject, create } = setup();
    const long = subject.ensureReady({ timeout: 100, maxAttempts: 2, backoff: 0 });
    const short = subject.ensureReady({ timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await short).toMatchObject({ ready: false, timedOut: true });
    await vi.advanceTimersByTimeAsync(91);
    expect(await long).toMatchObject({ ready: false, timedOut: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(subject.diagnose().retry.active).toBe(false);
  });

  it("keeps a bot that becomes ready during recovery backoff", async () => {
    vi.useFakeTimers();
    const { subject, bots, create } = setup();
    const epoch = subject.world.worldEpoch;
    const recovery = subject.ensureReady({ timeout: 200, maxAttempts: 2, backoff: 70 });
    await vi.advanceTimersByTimeAsync(110);
    bots[0].emit("spawn");
    expect(await recovery).toMatchObject({ ready: true, timedOut: false });
    expect(create).toHaveBeenCalledOnce();
    expect(subject.world.worldEpoch).toBe(epoch);
    expect(bots[0].quit).not.toHaveBeenCalled();
  });

  it("rechecks terminal kick and auth evidence arriving during retry backoff", async () => {
    vi.useFakeTimers();
    const { subject, bots, create } = setup();
    bots[0].emit("error", Object.assign(new Error("pipe closed"), { code: "EPIPE" }));
    const recovery = subject.ensureReady({ timeout: 100, maxAttempts: 2, backoff: 70 });
    await vi.advanceTimersByTimeAsync(10);
    bots[0].emit("kicked", "Banned");
    expect(await recovery).toMatchObject({ ready: false, timedOut: false, connection: { reason: "SERVER_REJECTED", terminalFailure: true }, recommendedOperation: "resolve-terminal-failure" });
    expect(create).toHaveBeenCalledOnce();
    const auth = setup({ autoReconnect: true, reconnectBackoff: 70 });
    auth.bots[0].emit("error", Object.assign(new Error("pipe closed"), { code: "EPIPE" }));
    await vi.advanceTimersByTimeAsync(10);
    auth.bots[0].emit("error", Object.assign(new Error("auth denied"), { code: "EAUTH" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(auth.create).toHaveBeenCalledOnce();
    expect(auth.subject.diagnose().connection.authentication.state).toBe("rejected");
  });

  it("treats kicks and observed auth rejection as terminal", async () => {
    const { subject, bots, create } = setup({ autoReconnect: true });
    bots[0].emit("kicked", "banned");
    expect(await subject.ensureReady({ timeout: 20, backoff: 0 })).toMatchObject({ ready: false, timedOut: false });
    expect(create).toHaveBeenCalledOnce();
    const other = setup({ autoReconnect: true });
    other.bots[0].emit("error", Object.assign(new Error("denied"), { code: "EAUTH" }));
    expect(await other.subject.ensureReady({ timeout: 20, backoff: 0 })).toMatchObject({ connection: { authentication: { state: "rejected" } } });
    expect(other.create).toHaveBeenCalledOnce();
  });

  it("only marks auth intervention on adapter evidence and preserves its in-flight login", async () => {
    const bot = new Bot();
    const create = vi.fn(() => bot);
    const subject = new BotController(options, new EventStore(), create);
    subjects.push(subject);
    subject.start();
    expect(subject.diagnose().connection.authentication.state).toBe("unknown");
    const supplied = create.mock.calls[0] as unknown as [Record<string, any>];
    supplied[0].onMsaCode({});
    expect(subject.diagnose().connection.authentication.state).toBe("intervention_required");
    const ready = subject.ensureReady({ timeout: 100, maxAttempts: 1 });
    bot.emit("spawn");
    expect(await ready).toMatchObject({ ready: true, timedOut: false });
    expect(create).toHaveBeenCalledOnce();
  });

  it("automatically recovers only opted in transient transport and aborts on stop", async () => {
    vi.useFakeTimers();
    const { subject, bots, create } = setup({ autoReconnect: true, reconnectBackoff: 10, reconnectMaxAttempts: 2 });
    bots[0].emit("error", Object.assign(new Error("socket reset"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(11);
    expect(create).toHaveBeenCalledTimes(2);
    const wait = subject.ensureReady({ timeout: 500 });
    subject.stop(); subject.stop();
    expect(await wait).toMatchObject({ ready: false, connection: { state: "stopping" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(create).toHaveBeenCalledTimes(2);
    expect(bots[1].quit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => subject.ensureReady()).toThrow(expect.objectContaining({ code: "COMMAND_BLOCKED" }));
  });

  it("does not retry unknown errors automatically and respects retry limits", async () => {
    vi.useFakeTimers();
    const plain = setup({ autoReconnect: true });
    plain.bots[0].emit("error", new Error("unknown"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(plain.create).toHaveBeenCalledOnce();
    const transient = setup({ autoReconnect: true, reconnectBackoff: 0, reconnectMaxAttempts: 2 });
    transient.bots[0].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    await vi.advanceTimersByTimeAsync(1);
    transient.bots[1].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    await vi.advanceTimersByTimeAsync(1);
    transient.bots[2].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(transient.create).toHaveBeenCalledTimes(3);
  });
  it("carries a finite incident budget through short ready cycles and repeated observations", async () => {
    vi.useFakeTimers();
    const { subject, bots, create } = setup({ autoReconnect: true, reconnectBackoff: 0, reconnectMaxAttempts: 2 });
    for (let attempt = 0; attempt < 2; attempt++) {
      bots[attempt].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
      await vi.advanceTimersByTimeAsync(1);
      bots[attempt + 1].emit("spawn");
      await vi.advanceTimersByTimeAsync(1);
      expect(subject.connectionStatus().ready).toBe(true);
    }
    bots[2].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    for (let i = 0; i < 20; i++) subject.frame();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(create).toHaveBeenCalledTimes(3);
    expect(subject.connectionStatus()).toMatchObject({ ready: false, recovery: { state: "exhausted", attempts: 2, maxAttempts: 2 } });
    const resumed = subject.ensureReady({ timeout: 100, backoff: 0, maxAttempts: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(create).toHaveBeenCalledTimes(4);
    bots[3].emit("spawn");
    expect(await resumed).toMatchObject({ ready: true, attempts: 1 });
  });

  it("rearms automatic recovery after thirty seconds of uninterrupted ready state", async () => {
    vi.useFakeTimers();
    const { subject, bots, create } = setup({ autoReconnect: true, reconnectBackoff: 0, reconnectMaxAttempts: 1 });
    bots[0].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    await vi.advanceTimersByTimeAsync(1);
    bots[1].emit("spawn");
    await vi.advanceTimersByTimeAsync(30_000);
    bots[1].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(create).toHaveBeenCalledTimes(3);
    bots[2].emit("spawn");
    await vi.advanceTimersByTimeAsync(1);
    expect(subject.diagnose().retry.attempts).toBe(1);
  });

  it("carries the incident deadline through a brief successful retry", async () => {
    vi.useFakeTimers();
    const { subject, bots, create } = setup({ autoReconnect: true, reconnectBackoff: 0, reconnectMaxAttempts: 3 });
    bots[0].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);
    bots[1].emit("spawn");
    await vi.advanceTimersByTimeAsync(25_000);
    bots[1].emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(subject.connectionStatus()).toMatchObject({ recovery: { state: "exhausted", attempts: 1 } });
  });

  it("observes an unavailable world when a reconnect factory throws before producing a bot", async () => {
    vi.useFakeTimers();
    const bot = new Bot();
    const create = vi.fn().mockReturnValueOnce(bot).mockImplementation(() => { throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" }); });
    const subject = new BotController(options, new EventStore(), create); subjects.push(subject); subject.start();
    bot.emit("spawn"); bot.emit("end", "closed");
    const recovery = subject.ensureReady({ timeout: 100, maxAttempts: 1, backoff: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(await recovery).toMatchObject({ ready: false, attemptLimitReached: true });
    expect(subject.frame()).toMatchObject({ connection: { ready: false }, self: {}, inventory: { known: false } });
    expect(subject.position()).toEqual({ known: false });
    expect(subject.inventory()).toEqual({ known: false });
    expect(subject.findEntities({})).toMatchObject({ entities: [] });
  });

});
