import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeActionContext } from "../src/core/context.js";
import { decodeHandle, encodeHandle } from "../src/core/handles.js";
import { runDaemon } from "../src/daemon/server.js";
import { BotController } from "../src/daemon/bot.js";

const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_C = "cccccccccccccccccccccccccccccccc";

class FakeBot extends EventEmitter {
  username = "AgentBot";
  entity = { position: { x: 1, y: 2, z: 3 } };
  entities = { "12": { id: 12, name: "cow", type: "mob", position: { x: 3, y: 2, z: 3 } } };
  players = { Steve: { username: "Steve", entity: { id: 13, username: "Steve", type: "player", position: { x: 4, y: 2, z: 3 } } } };
  game = { dimension: "overworld" };
  health = 20;
  food = 20;
  heldItem = { name: "dirt", displayName: "Dirt" };
  inventory = { items: () => [{ name: "dirt", displayName: "Dirt", count: 2, slot: 36 }] };
  registry = { blocksByName: { dirt: { id: 3 } } };
  currentWindow = {
    id: 1,
    type: "minecraft:chest",
    containerItems: () => [{ name: "dirt", displayName: "Dirt", count: 2, slot: 0 }],
    close: vi.fn(),
  };
  chat = vi.fn();
  quit = vi.fn();
  setControlState = vi.fn();
  lookAtCalls = vi.fn();
  lookAt = this.lookAtCalls;
  blockAt = vi.fn((position: Vec3) => ({ name: "dirt", displayName: "Dirt", type: 3, position }));
  findBlocks = vi.fn(() => [new Vec3(1, 2, 3)]);
  equipCalls = vi.fn();
  equip = this.equipCalls;
  digCalls = vi.fn();
  dig = this.digCalls;
  placeBlockCalls = vi.fn();
  placeBlock = this.placeBlockCalls;
  activateBlockCalls = vi.fn();
  activateBlock = this.activateBlockCalls;
  openContainer = vi.fn(async () => this.currentWindow);
  clickWindow = vi.fn();
  pathfinder = {
    setMovements: vi.fn(),
    goto: vi.fn(),
    setGoal: vi.fn(),
    stop: vi.fn(),
    isMoving: vi.fn(() => true),
    isMining: vi.fn(() => false),
    isBuilding: vi.fn(() => false),
  };
}

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "mc-agent-daemon-"));
  tempDirs.push(dir);
  return dir;
}

async function responseDaemon(session: string) {
  process.env.MC_AGENT_STATE_DIR = await makeTempDir();
  const bot = new FakeBot(), port = 54180 + Math.floor(Math.random() * 1000);
  Object.assign(bot, { controlState: {}, clearControlStates: vi.fn() });
  await runDaemon({ session, controlPort: port, token: TOKEN_A, host: "localhost", port: 25565,
    username: "AgentBot", auth: "offline", createBotFn: () => bot, exitOnStop: false });
  const headers = { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` };
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).json() as Promise<any>;
  const post = async (path: string, body: object, extraHeaders: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
  bot.emit("spawn");
  const frame = await get("/frame");
  return { bot, get, post, url: `http://127.0.0.1:${port}`, context: frame.context as string, close: () => post("/stop", {}) };
}

afterEach(async () => {
  delete process.env.MC_AGENT_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("daemon server", () => {
  it("serves fresh surroundings and rejects invalid direct HTTP options", async () => {
    const daemon = await responseDaemon("surroundings");
    Object.assign(daemon.bot.entity, { height: 1.6 });
    Object.assign(daemon.bot, { world: { getBlock: () => ({ name: "air", shapes: [] }) } });
    try {
      const scan = await daemon.get('/surroundings?range=2&detail=true&bounds=%7B%22min%22%3A%5B-1%2C-1%2C-1%5D%2C%22max%22%3A%5B1%2C3%2C1%5D%7D');
      expect(scan).toMatchObject({ type: "surroundings", fresh: true, context: daemon.context, range: 2, representation: "blocks", blocks: [], bounds: { min: [-1, -1, -1], max: [1, 3, 1] } });
      for (const query of ["range=33", "range=Infinity", "range=", "detail=full", "bounds=null", "bounds=not-json", "bounds=%7B%7D"]) {
        const response = await fetch(`${daemon.url}/surroundings?${query}`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` } });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: "BAD_INPUT" });
      }
    } finally { await daemon.close(); }
  });

  it("returns settled actions with fresh observations and preserves their terminal results", async () => {
    const daemon = await responseDaemon("response-settlement");
    const { bot, context, get, post } = daemon;
    try {
      bot.pathfinder.goto.mockImplementationOnce(async () => {
        bot.entity.position = { x: 8, y: 2, z: 3 };
        bot.inventory.items = () => [{ name: "dirt", displayName: "Dirt", count: 7, slot: 36 }];
      });
      const completed = await (await post("/navigate/goto", { context, x: 8, y: 2, z: 3, wait: 1000 })).json() as any;
      expect(completed).toMatchObject({ state: "completed", timedOut: false,
        result: { goalSatisfied: true, finalPosition: { x: 8, y: 2, z: 3 } },
        observation: { type: "full", context, self: { position: { x: 8, y: 2, z: 3 } }, inventory: { slots: [{ count: 7 }] } } });
      expect(completed.observation).not.toHaveProperty("runtimeId");
      bot.entity.position = { x: 9, y: 2, z: 3 };
      const waited = await get(`/actions/${completed.action}/wait?timeout=1000`);
      expect(waited).toMatchObject({ state: "completed", timedOut: false,
        result: { finalPosition: { x: 8, y: 2, z: 3 } }, observation: { self: { position: { x: 9, y: 2, z: 3 } } } });
      expect(await get(`/actions/${completed.action}`)).not.toHaveProperty("observation");
      expect(await get(`/actions/${completed.action}/wait?observe=false`)).not.toHaveProperty("observation");

      bot.pathfinder.goto.mockRejectedValueOnce(new Error("no path to goal"));
      const failed = await (await post("/navigate/goto", { context, x: 20, y: 2, z: 3, wait: 1000 })).json() as any;
      expect(failed).toMatchObject({ state: "failed", timedOut: false, error: { code: "NAVIGATION_FAILED" }, observation: { type: "full", context } });
      const track = completed.observation.entities[0].trackId;
      const followed = await (await post("/navigate/follow", { context, track, wait: 30000 })).json() as any;
      expect(followed).toMatchObject({ state: "running", observation: { type: "full", context } });
      expect(followed).not.toHaveProperty("timedOut");
      const cancelled = await (await post(`/actions/${followed.action}/cancel`, { context })).json() as any;
      expect(cancelled).toMatchObject({ state: "cancelled", observation: { type: "full", context } });
      expect(await get(`/actions/${followed.action}/wait`)).toMatchObject({ state: "cancelled", timedOut: false, observation: { type: "full" } });
      expect(await (await post("/navigate/stop", { context })).json()).toMatchObject({ stopped: true, observation: { type: "full" } });
      expect(await (await post("/navigate/configure", { context, allowDig: false })).json()).toMatchObject({ observation: { type: "full" } });
    } finally { await daemon.close(); }
  });

  it("keeps deadline expiry running and reports observation failure without losing the operation result", async () => {
    const daemon = await responseDaemon("response-timeout");
    const { bot, context, get, post } = daemon;
    try {
      const timedOut = await (await post("/control/tap", { context, state: "forward", durationMs: 100, wait: 1 })).json() as any;
      expect(timedOut).toMatchObject({ state: "running", timedOut: true, observation: { self: { controls: ["forward"] } } });
      const finished = await get(`/actions/${timedOut.action}/wait?timeout=1000`);
      expect(finished).toMatchObject({ state: "completed", timedOut: false, observation: { self: { controls: [] } } });

      const frame = vi.spyOn(BotController.prototype, "frame").mockImplementation(() => { throw new Error("private observation failure"); });
      try {
        const closed = await (await post("/window/close", { context, wait: 1000 })).json() as any;
        expect(closed).toMatchObject({ state: "completed", timedOut: false, result: { closed: true }, observationError: { code: "DAEMON_ERROR" } });
        expect(closed).not.toHaveProperty("observation");
        expect(JSON.stringify(closed)).not.toContain("private observation failure");
        expect(bot.currentWindow.close).toHaveBeenCalledOnce();
        frame.mockClear();
        expect(await (await post("/control/clear", { context, observe: false })).json()).toEqual({ cleared: true });
        expect(frame).not.toHaveBeenCalled();
      } finally { frame.mockRestore(); }
    } finally { await daemon.close(); }
  });

  it("attaches observations to rejected stale context and rejects incompatible APIs and invalid waits before mutation", async () => {
    const daemon = await responseDaemon("response-rejection");
    const { bot, context, post } = daemon;
    try {
      const incompatible = await post("/look/at", { context, x: 1, y: 2, z: 3 }, { "X-MC-Agent-API": "3.2" });
      expect(incompatible.status).toBe(409);
      expect(await incompatible.json()).toMatchObject({ code: "DAEMON_INCOMPATIBLE", details: { expectedApiVersion: "3.3", actualApiVersion: "3.2" } });
      const missingApi = await fetch(`${daemon.url}/look/at`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_A}` },
        body: JSON.stringify({ context, x: 1, y: 2, z: 3 }) });
      expect(missingApi.status).toBe(409);
      expect(await missingApi.json()).toMatchObject({ code: "DAEMON_INCOMPATIBLE", details: { expectedApiVersion: "3.3", actualApiVersion: null } });
      for (const wait of [-1, 30001, 1.5, "5000"]) {
        const invalid = await post("/look/at", { context, x: 1, y: 2, z: 3, wait });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ code: "BAD_INPUT" });
      }
      expect(bot.lookAtCalls).not.toHaveBeenCalled();
      bot.emit("death");
      bot.emit("spawn");
      const rejected = await post("/look/at", { context, x: 1, y: 2, z: 3 });
      expect(rejected.status).toBe(409);
      const error = await rejected.json() as any;
      expect(error).toMatchObject({ code: "WORLD_CHANGED", observation: { type: "full", connection: { ready: true } } });
      expect(error.observation.context).not.toBe(context);
      expect(bot.lookAtCalls).not.toHaveBeenCalled();
      const noObserve = await (await post("/look/at", { context, x: 1, y: 2, z: 3, observe: false })).json();
      expect(noObserve).toMatchObject({ code: "WORLD_CHANGED" });
      expect(noObserve).not.toHaveProperty("observation");
    } finally { await daemon.close(); }
  });

  it("rejects unauthorized requests, unknown routes, and handler errors", async () => {
    const dir = await makeTempDir();
    process.env.MC_AGENT_STATE_DIR = dir;
    const fakeBot = new FakeBot();
    const port = 35180 + Math.floor(Math.random() * 1000);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runDaemon({
      session: "errors",
      controlPort: port,
      token: TOKEN_A,
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
      createBotFn: () => fakeBot,
      exitOnStop: false,
    });

    const unauthorized = await fetch(`http://127.0.0.1:${port}/status`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("X-MC-Agent-API")).toBe("3.3");
    expect(await unauthorized.json()).toEqual({ code: "DAEMON_ERROR", message: "Unauthorized daemon request." });

    const missing = await fetch(`http://127.0.0.1:${port}/missing`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("X-MC-Agent-API")).toBe("3.3");
    expect(await missing.json()).toEqual({ code: "BAD_INPUT", message: "Unknown daemon route." });

    fakeBot.emit("spawn");
    fakeBot.emit("kicked", { text: "Server maintenance" });
    fakeBot.emit("end", "socketClosed");
    const logEntries = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ session: "errors", type: "connection.ready", connection: expect.objectContaining({ state: "ready" }) }),
      expect.objectContaining({ session: "errors", type: "connection.disconnected", reason: 'KICKED: {"text":"Server maintenance"}', connection: expect.objectContaining({ state: "disconnected" }) }),
    ]));
    log.mockRestore();

    fakeBot.chat.mockImplementationOnce(() => {
      throw new Error("chat failed");
    });
    const failed = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      message: "The operation failed. Inspect operational diagnostics for the cause.",
      code: "DAEMON_ERROR",
    });

    fakeBot.chat.mockImplementationOnce(() => {
      throw "string failure";
    });
    const stringFailure = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(await stringFailure.json()).toEqual({ message: "The operation failed. Inspect operational diagnostics for the cause.", code: "DAEMON_ERROR" });

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` } });
  });

  it("uses default event query parameters and exits on stop by default", async () => {
    const dir = await makeTempDir();
    process.env.MC_AGENT_STATE_DIR = dir;
    const fakeBot = new FakeBot();
    const port = 36180 + Math.floor(Math.random() * 1000);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    await runDaemon({
      session: "exit-default",
      controlPort: port,
      token: TOKEN_B,
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
      createBotFn: () => fakeBot,
    });
    fakeBot.emit("chat", "Steve", "hello", undefined, { text: "hello" });

    const events = await fetch(`http://127.0.0.1:${port}/events`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_B}` } });
    expect(await events.json()).toMatchObject({ events: [expect.objectContaining({ text: "hello" })] });

    const stop = await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_B}` } });
    await stop.text();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });

  it("serves status and stored chat events over authorized local HTTP", async () => {
    const dir = await makeTempDir();
    process.env.MC_AGENT_STATE_DIR = dir;
    const fakeBot = new FakeBot();
    const port = 32180 + Math.floor(Math.random() * 1000);

    await runDaemon({
      session: "test",
      controlPort: port,
      token: TOKEN_A,
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
      createBotFn: () => fakeBot,
      exitOnStop: false,
    });

    Object.assign(fakeBot, { experience: { level: 1n }, time: { age: 2n } });
    fakeBot.emit("login");
    fakeBot.emit("chat", "Steve", "hello", undefined, { text: "hello", big: 3n });

    const status = await fetch(`http://127.0.0.1:${port}/status`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` } });
    expect(status.ok).toBe(true);
    expect(status.headers.get("X-MC-Agent-API")).toBe("3.3");
    const compact = await status.json();
    expect(compact).toMatchObject({ ready: false, username: "AgentBot", connection: { state: "waiting_for_spawn" } });
    expect(compact).not.toHaveProperty("runtimeId");
    expect(compact).not.toHaveProperty("host");
    expect(compact).not.toHaveProperty("experience");
    const full = await (await fetch(`http://127.0.0.1:${port}/status?detail=full`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(full).toMatchObject({ host: "localhost", port: 25565, auth: "offline" });

    const events = await fetch(`http://127.0.0.1:${port}/events?since=0&limit=10`, {
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(await events.json()).toMatchObject({
      profile: "all", types: [], unknownTypes: "included",
      events: [
        expect.objectContaining({ type: "connection.login" }),
        expect.objectContaining({ type: "chat.unverified", candidateSender: "Steve", text: "hello" }),
      ],
    });

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` } });
  });

  it("filters stored events before applying the response limit", async () => {
    const dir = await makeTempDir();
    process.env.MC_AGENT_STATE_DIR = dir;
    const fakeBot = new FakeBot();
    const port = 37180 + Math.floor(Math.random() * 1000);

    await runDaemon({
      session: "filtered-events",
      controlPort: port,
      token: TOKEN_A,
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
      createBotFn: () => fakeBot,
      exitOnStop: false,
    });

    fakeBot.emit("entityMoved", fakeBot.entities["12"]);
    fakeBot.emit("chat", "Alex", "keep", undefined, { text: "keep" });
    fakeBot.emit("whisper", "Alex", "also keep", undefined, { text: "also keep" });

    const events = await fetch(`http://127.0.0.1:${port}/events?since=0&limit=1&profile=agent&type=chat.unverified&type=entity.appeared`, {
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` },
    });
    const page = await events.json() as { nextCursor: string };
    expect(page).toMatchObject({
      profile: "agent", types: ["chat.unverified"], unknownTypes: "excluded",
      events: [expect.objectContaining({ type: "chat.unverified", text: "keep" })],
      gap: false,
      nextCursor: expect.stringMatching(/:s1$/),
      latestCursor: expect.stringMatching(/:s2$/),
    });
    const headers = { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` };
    const next = await (await fetch(`http://127.0.0.1:${port}/events?since=${page.nextCursor}&limit=1&profile=agent&type=chat.unverified`, { headers })).json();
    expect(next).toMatchObject({ events: [expect.objectContaining({ text: "also keep", claimedChannel: "whisper" })], nextCursor: expect.stringMatching(/:s2$/) });
    expect(await (await fetch(`http://127.0.0.1:${port}/events?profile=agent&type=entity.appeared`, { headers })).json()).toMatchObject({
      profile: "agent", types: [], unknownTypes: "excluded", events: [], gap: false,
    });
    for (const path of ["events", "watch"]) {
      const invalid = await fetch(`http://127.0.0.1:${port}/${path}?profile=typo`, { headers });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "BAD_INPUT" });
    }

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}` } });
  });

  it("streams watch events as NDJSON", async () => {
    const dir = await makeTempDir();
    process.env.MC_AGENT_STATE_DIR = dir;
    const fakeBot = new FakeBot();
    const port = 33180 + Math.floor(Math.random() * 1000);

    await runDaemon({
      session: "watch",
      controlPort: port,
      token: TOKEN_B,
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
      createBotFn: () => fakeBot,
      exitOnStop: false,
    });
    fakeBot.emit("entityMoved", fakeBot.entities["12"]);
    fakeBot.emit("chat", "Alex", "old", undefined, { text: "old" });

    fakeBot.emit("message", { text: "§f§a§i§r§x§a§e§r§o" }, "system");
    const response = await fetch(`http://127.0.0.1:${port}/watch?profile=agent`, {
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_B}` },
    });
    const reader = response.body!.getReader();

    const { value } = await reader.read();
    let lines = Buffer.from(value!).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "events.replay", gap: false, profile: "agent", unknownTypes: "excluded" });
    expect(lines[0].types).toContain("chat.unverified");
    expect(lines[0].types).not.toContain("server.control");
    if (lines.length === 1) {
      const replay = await reader.read();
      lines = lines.concat(Buffer.from(replay.value!).toString("utf8").trim().split("\n").map(line => JSON.parse(line)));
    }
    expect(lines[1]).toMatchObject({ type: "chat.unverified", candidateSender: "Alex", text: "old" });
    fakeBot.emit("entityMoved", fakeBot.entities["12"]);
    fakeBot.emit("message", { text: "§f§a§i§r§x§a§e§r§o" }, "system");
    fakeBot.emit("chat", "Alex", "ping", undefined, { text: "ping" });
    const next = await reader.read();
    expect(JSON.parse(Buffer.from(next.value!).toString("utf8").trim())).toMatchObject({ text: "ping" });
    await reader.cancel();
    const rawReplay = await (await fetch(`http://127.0.0.1:${port}/events?profile=all`, {
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_B}` },
    })).json() as { events: { type: string }[] };
    expect(rawReplay.events.filter(event => event.type === "server.control")).toHaveLength(2);
    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_B}` } });
  });

  it("starts now on the daemon, skipping history while retaining future events", async () => {
    process.env.MC_AGENT_STATE_DIR = await makeTempDir();
    const fakeBot = new FakeBot(), port = 46180 + Math.floor(Math.random() * 1000);
    await runDaemon({ session: "watch-now", controlPort: port, token: TOKEN_C, host: "localhost", port: 25565, username: "AgentBot", auth: "offline", createBotFn: () => fakeBot, exitOnStop: false });
    const headers = { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Overflow old chat to verify now doesn't report a historical gap either.
      for (let i = 0; i < 1100; i++) fakeBot.emit("chat", "Alex", `old ${i}`, undefined, { text: `old ${i}` });
      const page = await (await fetch(`http://127.0.0.1:${port}/events?since=now&profile=agent`, { headers })).json() as any;
      expect(page).toMatchObject({ events: [], gap: false, expiredTypes: [] });
      expect(page.nextCursor).toBe(page.latestCursor);
      const response = await fetch(`http://127.0.0.1:${port}/watch?since=now&profile=agent&type=chat.unverified`, { headers });
      reader = response.body!.getReader();
      const metadata = JSON.parse(Buffer.from((await reader.read()).value!).toString("utf8").trim());
      expect(metadata).toMatchObject({ type: "events.replay", gap: false, expiredTypes: [] });
      fakeBot.emit("chat", "Alex", "new", undefined, { text: "new" });
      const event = JSON.parse(Buffer.from((await reader.read()).value!).toString("utf8").trim());
      expect(event).toMatchObject({ type: "chat.unverified", candidateSender: "Alex", text: "new" });
      const next = await (await fetch(`http://127.0.0.1:${port}/events?since=${encodeURIComponent(page.nextCursor)}&profile=agent`, { headers })).json() as any;
      expect(next.events).toEqual([event]);
      await reader.cancel(); reader = undefined;
      expect(fakeBot.quit).not.toHaveBeenCalled();
      fakeBot.emit("chat", "Alex", "while disconnected", undefined, { text: "while disconnected" });
      const reattached = await fetch(`http://127.0.0.1:${port}/watch?since=now&profile=agent&type=chat.unverified`, { headers });
      reader = reattached.body!.getReader();
      expect(JSON.parse(Buffer.from((await reader.read()).value!).toString("utf8").trim())).toMatchObject({ type: "events.replay", gap: false });
      fakeBot.emit("chat", "Alex", "after reconnect", undefined, { text: "after reconnect" });
      expect(JSON.parse(Buffer.from((await reader.read()).value!).toString("utf8").trim())).toMatchObject({ type: "chat.unverified", text: "after reconnect" });
    } finally {
      await reader?.cancel();
      await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers });
    }
  });

  it("filters bot echoes from replay and live chat without dropping repeated player messages", async () => {
    process.env.MC_AGENT_STATE_DIR = await makeTempDir();
    const fakeBot = new FakeBot(), port = 47180 + Math.floor(Math.random() * 1000);
    await runDaemon({ session: "chat-self", controlPort: port, token: TOKEN_C, host: "localhost", port: 25565, username: "private-account@example.com", auth: "offline", createBotFn: () => fakeBot, exitOnStop: false });
    const headers = { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      fakeBot.emit("chat", "AgentBot", "self replay", undefined, { text: "self replay" });
      fakeBot.emit("chat", "Alex", "player replay", undefined, { text: "player replay" });
      const response = await fetch(`http://127.0.0.1:${port}/watch?since=0&profile=agent&type=chat.player&type=chat.whisper&type=chat.unverified&excludeSelf=true`, { headers });
      reader = response.body!.getReader();
      let buffer = "";
      const nextEvent = async () => {
        while (!buffer.includes("\n")) {
          const chunk = await reader!.read();
          if (chunk.done) throw new Error("Unexpected stream end");
          buffer += Buffer.from(chunk.value!).toString("utf8");
        }
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        return JSON.parse(line);
      };
      expect(await nextEvent()).toMatchObject({ type: "events.replay", excludeSelf: true });
      expect(await nextEvent()).toMatchObject({ type: "chat.unverified", candidateSender: "Alex", text: "player replay" });
      fakeBot.emit("chat", "agentbot", "self live", undefined, { text: "self live" });
      fakeBot.emit("whisper", "AgentBot", "self whisper", undefined, { text: "self whisper" });
      fakeBot.emit("message", { text: "server notice" }, "system");
      fakeBot.emit("chat", "Alex", "repeat", undefined, { text: "repeat" });
      fakeBot.emit("chat", "Alex", "repeat", undefined, { text: "repeat" });
      for (let i = 0; i < 2; i++) {
        expect(await nextEvent()).toMatchObject({ type: "chat.unverified", candidateSender: "Alex", text: "repeat" });
      }
      await reader.cancel(); reader = undefined;
      // Ordinary event queries still retain self chat for callers that want it.
      const page = await (await fetch(`http://127.0.0.1:${port}/events?since=0&profile=agent`, { headers })).json() as any;
      expect(page.events.map((event: any) => event.text)).toContain("self live");
      const invalid = await fetch(`http://127.0.0.1:${port}/watch?excludeSelf=typo`, { headers });
      expect(invalid.status).toBe(400);
    } finally {
      await reader?.cancel();
      await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers });
    }
  });

  it("returns structured navigation failures", async () => {
    const dir = await makeTempDir();
    process.env.MC_AGENT_STATE_DIR = dir;
    const fakeBot = new FakeBot();
    fakeBot.pathfinder.goto.mockRejectedValueOnce(new Error("Took to long to decide path to goal!"));
    const port = 38180 + Math.floor(Math.random() * 1000);

    await runDaemon({
      session: "navigation-failure",
      controlPort: port,
      token: TOKEN_C,
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
      createBotFn: () => fakeBot,
      exitOnStop: false,
    });

    fakeBot.emit("spawn");
    const context = (await (await fetch(`http://127.0.0.1:${port}/frame`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } })).json() as { context: string }).context;
    const failed = await fetch(`http://127.0.0.1:${port}/navigate/goto`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, x: 10, y: 64, z: 10, range: 2 }),
    });

    expect(failed.status).toBe(200);
    const started = await failed.json() as { action: string };
    const status = await fetch(`http://127.0.0.1:${port}/actions/${started.action}`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
    expect(await status.json()).toMatchObject({ state: "failed", error: { code: "NAVIGATION_FAILED", message: "Navigation did not reach the goal." } });

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
  });

  it("supports chat, position, inventory, control tap, and look at endpoints", async () => {
    const dir = await makeTempDir();
    process.env.MC_AGENT_STATE_DIR = dir;
    const fakeBot = new FakeBot();
    const port = 34180 + Math.floor(Math.random() * 1000);

    await runDaemon({
      session: "actions",
      controlPort: port,
      token: TOKEN_C,
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
      createBotFn: () => fakeBot,
      exitOnStop: false,
    });

    (fakeBot.entities as Record<string, unknown>)["13"] = fakeBot.players.Steve.entity;
    fakeBot.emit("spawn");
    const context = (await (await fetch(`http://127.0.0.1:${port}/frame`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } })).json() as { context: string }).context;
    const frame = await (await fetch(`http://127.0.0.1:${port}/frame`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } })).json() as { entities: { trackId: string; username?: string }[] };
    const playerTrack = frame.entities.find(entity => entity.username === "Steve")!.trackId;
    await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, message: "hello" }),
    });
    expect(fakeBot.chat).toHaveBeenCalledWith("hello");

    await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` },
    });
    expect(fakeBot.chat).toHaveBeenCalledWith("");

    const position = await fetch(`http://127.0.0.1:${port}/bot/position`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
    expect(await position.json()).toMatchObject({ position: { x: 1, y: 2, z: 3 }, dimension: "overworld" });

    const inventory = await fetch(`http://127.0.0.1:${port}/bot/inventory`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
    expect(await inventory.json()).toMatchObject({ items: [expect.objectContaining({ name: "dirt", count: 2 })] });

    await fetch(`http://127.0.0.1:${port}/control/tap`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, state: "forward", durationMs: 1 }),
    });
    expect(fakeBot.setControlState).toHaveBeenCalledWith("forward", true);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(fakeBot.setControlState).toHaveBeenCalledWith("forward", false);

    await fetch(`http://127.0.0.1:${port}/look/at`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, x: 4, y: 5, z: 6 }),
    });
    expect(fakeBot.lookAtCalls).toHaveBeenCalledWith(expect.objectContaining({ x: 4, y: 5, z: 6 }));

    const players = await fetch(`http://127.0.0.1:${port}/bot/players`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
    expect(await players.json()).toMatchObject({ players: [expect.objectContaining({ username: "Steve", distance: 3 })] });

    const entities = await fetch(`http://127.0.0.1:${port}/bot/entities?radius=10&limit=5`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
    expect(await entities.json()).toMatchObject({ entities: expect.arrayContaining([expect.objectContaining({ name: "cow", distance: 2 })]) });

    const block = await fetch(`http://127.0.0.1:${port}/world/block?x=7&y=8&z=9`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
    expect(await block.json()).toMatchObject({ block: { name: "dirt", position: { x: 7, y: 8, z: 9 } } });

    const found = await fetch(`http://127.0.0.1:${port}/world/find-blocks?name=dirt&radius=16&count=2`, {
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` },
    });
    expect(await found.json()).toMatchObject({ blocks: [{ name: "dirt", position: { x: 1, y: 2, z: 3 } }] });

    await fetch(`http://127.0.0.1:${port}/navigate/goto`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, x: 10, y: 64, z: 10, range: 2 }),
    });
    expect(fakeBot.pathfinder.goto).toHaveBeenCalledWith(expect.objectContaining({ x: 10, y: 64, z: 10 }));

    const follow = await fetch(`http://127.0.0.1:${port}/navigate/follow`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, track: playerTrack, range: 3 }),
    });
    expect(await follow.json()).toMatchObject({ kind: "navigate.follow", target: playerTrack, state: "running" });
    expect(fakeBot.pathfinder.setGoal).toHaveBeenCalledWith(expect.objectContaining({ entity: fakeBot.players.Steve.entity }), true);

    const navigateStatus = await fetch(`http://127.0.0.1:${port}/navigate/status`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
    expect(await navigateStatus.json()).toEqual({ moving: true, mining: false, building: false });

    await fetch(`http://127.0.0.1:${port}/navigate/stop`, { method: "POST", headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` }, body: JSON.stringify({ context }) });
    expect(fakeBot.pathfinder.stop).toHaveBeenCalled();

    await fetch(`http://127.0.0.1:${port}/inventory/equip`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, item: "dirt", destination: "hand" }),
    });
    expect(fakeBot.equipCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), "hand");

    await fetch(`http://127.0.0.1:${port}/world/dig`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, x: 1, y: 2, z: 3 }),
    });
    expect(fakeBot.digCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), true);

    await fetch(`http://127.0.0.1:${port}/world/place`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, x: 1, y: 2, z: 3, face: "up", item: "dirt" }),
    });
    expect(fakeBot.placeBlockCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), expect.objectContaining({ x: 0, y: 1, z: 0 }));

    await fetch(`http://127.0.0.1:${port}/world/activate`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, x: 1, y: 2, z: 3 }),
    });
    expect(fakeBot.activateBlockCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }));

    const opened = await fetch(`http://127.0.0.1:${port}/window/open-block`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, x: 1, y: 2, z: 3 }),
    });
    const openAction = await opened.json() as { action: string };
    expect(await (await fetch(`http://127.0.0.1:${port}/actions/${openAction.action}`, { headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } })).json()).toMatchObject({ state: "completed", result: { opened: true, window: { type: "minecraft:chest" } } });

    const clicked = await fetch(`http://127.0.0.1:${port}/window/click`, {
      method: "POST",
      headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ context, slot: 5, mouseButton: 1, mode: 0 }),
    });
    expect(await clicked.json()).toMatchObject({ kind: "window.click", action: expect.any(String) });
    expect(fakeBot.clickWindow).toHaveBeenCalledWith(5, 1, 0);

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_C}` } });
  });
  it("serves frames, typed stale-handle errors and explicit delta reset details", async () => {
    process.env.MC_AGENT_STATE_DIR = await makeTempDir();
    const fakeBot = new FakeBot(), port = 40180 + Math.floor(Math.random()*1000);
    await runDaemon({session:"runtime-api",controlPort:port,token:TOKEN_A,host:"localhost",port:25565,username:"AgentBot",auth:"offline",createBotFn:()=>fakeBot,exitOnStop:false});
    const headers = { "X-MC-Agent-API": "3.3", Authorization: `Bearer ${TOKEN_A}`, "Content-Type":"application/json" };
    const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`, {headers})).json() as Promise<any>;
    const post = async (path: string, body: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, {headers,method:"POST",body:JSON.stringify(body)})).json() as Promise<any>;
    try {
      Object.assign(fakeBot.entities["12"], { name: "armor_stand", metadata: { 2: "Market" }, getCustomName: () => "Market",
        equipment: [null, { name: "diamond_sword", count: 1, nbt: { private: "raw secret" } }] });
      fakeBot.emit("spawn");
      const first = await get("/frame"), track = first.entities[0].trackId;
      const context = { context: first.context };
      expect(first).toMatchObject({connection:{ready:true},eventCursor:expect.any(String),frame:expect.any(String),inventory:{known:true,slots:[{name:"dirt",count:2,slot:36}]}});
      const inspected = await get(`/entity/inspect?track=${encodeURIComponent(track)}`);
      expect(inspected).toMatchObject({ context: first.context, connection: { ready: true }, entity: {
        trackId: track, type: "minecraft:armor_stand", customName: "Market", equipment: { 1: { name: "diamond_sword", count: 1 } },
      } });
      expect(inspected).not.toHaveProperty("entities");
      for (const key of ["uuid", "minecraftEntityId", "bindingGeneration", "worldEpoch", "metadata"]) expect(inspected.entity).not.toHaveProperty(key);
      expect(JSON.stringify(inspected)).not.toContain("raw secret");
      expect(first.entities.find((entity: any) => entity.trackId === track).customName).toBe(inspected.entity.customName);
      const missingInspect = await fetch(`http://127.0.0.1:${port}/entity/inspect`, { headers });
      expect(missingInspect.status).toBe(400);
      expect(await missingInspect.json()).toMatchObject({ code: "BAD_INPUT" });
      expect(await get("/entity/inspect?track=12")).toMatchObject({ code: "BAD_INPUT" });
      expect(await get(`/entity/inspect?track=${encodeHandle(decodeHandle(track).runtimeId,"e",999)}`)).toMatchObject({ code: "TRACK_UNKNOWN" });
      expect(await get(`/entity/inspect?track=${encodeHandle("00000000-0000-0000-0000-000000000007","e",1)}`)).toMatchObject({ code: "RUNTIME_MISMATCH" });
      expect(await post("/navigate/follow", {track,range:2})).toMatchObject({code:"CONTEXT_REQUIRED"});
      expect(await post("/navigate/follow", {context:encodeActionContext("00000000-0000-0000-0000-000000000007",1),track})).toMatchObject({code:"RUNTIME_MISMATCH"});
      expect(await post("/entity/activate", {...context,id:12})).toMatchObject({code:"BAD_INPUT"});
      expect(await post("/entity/activate", {...context,track:encodeHandle(decodeHandle(track).runtimeId,"e",999)})).toMatchObject({code:"TRACK_UNKNOWN",details:{trackId:encodeHandle(decodeHandle(track).runtimeId,"e",999)}});
      expect(await get(`/events?since=${encodeHandle("00000000-0000-0000-0000-000000000007","s",2)}`)).toMatchObject({code:"RUNTIME_MISMATCH"});
      expect(await get("/events?since=1")).toMatchObject({code:"BAD_INPUT"});
      expect(await get(`/frame?since=${first.frame}&radius=32`)).toMatchObject({type:"full",reset:{reason:"PROJECTION_CHANGED"}});
      fakeBot.inventory.items = () => [{name:"dirt",displayName:"Dirt",count:9,slot:36}];
      const delta = await get(`/frame?since=${first.frame}`);
      expect(delta).toMatchObject({since:first.frame,delta:{changed:{inventory:{slots:[{count:9,slot:36}]}}}});
      const follow = await post("/navigate/follow", {...context,track,range:2});
      fakeBot.emit("entityGone", fakeBot.entities["12"]);
      expect(await get(`/entity/inspect?track=${encodeURIComponent(track)}`)).toMatchObject({ code: "TRACK_LOST" });
      expect(await get(`/actions/${follow.action}`)).toMatchObject({state:"failed",reason:"TRACK_LOST"});
      expect(await post("/navigate/follow", {...context,track})).toMatchObject({code:"TRACK_LOST"});
      const dropped = { id: 14, name: "item", type: "object", position: { ...fakeBot.entity.position },
        getDroppedItem: () => ({ name: "diamond", count: 3, nbt: { private: "raw secret" } }) };
      Object.assign(fakeBot.entities, { 14: dropped });
      fakeBot.emit("entitySpawn", dropped);
      const collectionFrame = await get("/frame");
      const itemTrack = collectionFrame.entities.find((entity: any) => entity.type === "minecraft:item").trackId;
      const collecting = await post("/collect/item", { context: collectionFrame.context, track: itemTrack });
      expect(await get(`/actions/${collecting.action}`)).toMatchObject({ state: "running" });
      fakeBot.emit("playerCollect", fakeBot.entity, dropped);
      delete (fakeBot.entities as Record<number, unknown>)[14];
      fakeBot.emit("entityGone", dropped);
      const collected = await get(`/actions/${collecting.action}/wait?timeout=1000`);
      expect(collected).toMatchObject({ state: "completed", target: itemTrack, timedOut: false,
        result: { pickupConfirmed: true, item: { name: "diamond" }, unknownFields: ["collectedCount"] } });
      expect(collected.result.item).not.toHaveProperty("count");
      expect(collected.result).not.toHaveProperty("inventory");
      expect(JSON.stringify(collected)).not.toContain("raw secret");
      fakeBot.emit("death");
      expect(await get(`/entity/inspect?track=${encodeURIComponent(track)}`)).toMatchObject({ code: "WORLD_CHANGED" });
      expect(await post("/navigate/goto", {...context,x:1,y:64,z:1})).toMatchObject({code:"WORLD_CHANGED"});
      expect(await get(`/frame?since=${first.frame}`)).toMatchObject({type:"full",reset:{reason:"WORLD_CHANGED"}});
    } finally { await post("/stop", {}); }
  });

  it("samples a target outside semantic history and reports structured sampling failures", async () => {
    process.env.MC_AGENT_STATE_DIR = await makeTempDir();
    const fakeBot = new FakeBot(), port = 41180 + Math.floor(Math.random()*1000);
    await runDaemon({session:"samples",controlPort:port,token:TOKEN_B,host:"localhost",port:25565,username:"AgentBot",auth:"offline",createBotFn:()=>fakeBot,exitOnStop:false});
    const headers = { "X-MC-Agent-API": "3.3", Authorization:`Bearer ${TOKEN_B}`};
    try {
      fakeBot.emit("spawn");
      const frame = await (await fetch(`http://127.0.0.1:${port}/frame`,{headers})).json() as any;
      const track = frame.entities[0].trackId;
      const invalid = await fetch(`http://127.0.0.1:${port}/sample?track=${track}&rate=100`,{headers});
      expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({code:"BAD_INPUT"});
      const response = await fetch(`http://127.0.0.1:${port}/sample?track=${track}&fields=position,velocity,status&rate=10`,{headers});
      expect(response.headers.get("X-MC-Agent-API")).toBe("3.3");
      const reader = response.body!.getReader();
      const first = JSON.parse(Buffer.from((await reader.read()).value!).toString("utf8").trim());
      expect(first).toMatchObject({type:"track.sample",trackId:track,values:{status:"loaded",position:{x:3,y:2,z:3}}});
      const replay = await (await fetch(`http://127.0.0.1:${port}/events?since=${frame.eventCursor}`,{headers})).json() as any;
      expect(replay.events).toEqual([]); expect(replay.latestCursor).toBe(frame.eventCursor);
      fakeBot.emit("entityGone",fakeBot.entities["12"]);
      const lost = JSON.parse(Buffer.from((await reader.read()).value!).toString("utf8").trim());
      expect(lost).toMatchObject({type:"track.error",code:"TRACK_LOST",details:{trackId:track}});
      await reader.cancel();
    } finally { await fetch(`http://127.0.0.1:${port}/stop`,{method:"POST",headers}); }
  });

  it("replays a retained chat backlog with gap metadata and backpressure before streaming live events", async () => {
    process.env.MC_AGENT_STATE_DIR = await makeTempDir();
    const fakeBot = new FakeBot(), port = 42180 + Math.floor(Math.random()*1000);
    await runDaemon({session:"watch-backlog",controlPort:port,token:TOKEN_C,host:"localhost",port:25565,username:"AgentBot",auth:"offline",createBotFn:()=>fakeBot,exitOnStop:false});
    const headers = { "X-MC-Agent-API": "3.3", Authorization:`Bearer ${TOKEN_C}`};
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      for (let i=0;i<1100;i++) fakeBot.emit("chat","Alex",`message ${i}`,undefined,{text:`message ${i}`});
      const response = await fetch(`http://127.0.0.1:${port}/watch?since=0&profile=agent&type=chat.unverified`,{headers});
      reader = response.body!.getReader();
      let buffer = "", count = 0, previous = 0, metadata: any;
      while (count < 1024) {
        const chunk = await reader.read(); expect(chunk.done).toBe(false);
        buffer += Buffer.from(chunk.value!).toString("utf8");
        const lines = buffer.split("\n"); buffer = lines.pop()!;
        for (const line of lines) {
          const event = JSON.parse(line);
          if (event.type === "events.replay") metadata = event;
          else {
            expect(event.type).toBe("chat.unverified"); expect(event.id).toBeGreaterThan(previous); previous=event.id; count++;
          }
        }
      }
      expect(metadata).toMatchObject({profile:"agent",types:["chat.unverified"],unknownTypes:"excluded",gap:true,expiredTypes:["chat.unverified"]});
      expect(count).toBe(1024); expect(previous).toBe(1100);
      fakeBot.emit("chat","Alex","live",undefined,{text:"live"});
      const live = JSON.parse(Buffer.from((await reader.read()).value!).toString("utf8").trim());
      expect(live).toMatchObject({type:"chat.unverified",text:"live",id:1101});
    } finally { await reader?.cancel(); await fetch(`http://127.0.0.1:${port}/stop`,{method:"POST",headers}); }
  });

});
