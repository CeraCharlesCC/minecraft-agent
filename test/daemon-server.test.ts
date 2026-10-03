import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDaemon } from "../src/daemon/server.js";

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

afterEach(async () => {
  delete process.env.MC_AGENT_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("daemon server", () => {
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
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

    const missing = await fetch(`http://127.0.0.1:${port}/missing`, { headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found" });

    fakeBot.emit("spawn");
    fakeBot.emit("kicked", { text: "Server maintenance" });
    fakeBot.emit("end", "socketClosed");
    const logEntries = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ session: "errors", type: "connection.ready", connection: expect.objectContaining({ state: "ready" }) }),
      expect.objectContaining({ session: "errors", type: "connection.disconnected", connection: expect.objectContaining({ state: "disconnected", reason: 'KICKED: {"text":"Server maintenance"}', remediation: expect.stringContaining("session stop") }) }),
    ]));
    log.mockRestore();

    fakeBot.chat.mockImplementationOnce(() => {
      throw new Error("chat failed");
    });
    const failed = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_A}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      error: "chat failed",
      code: "DAEMON_ERROR",
      remediation: expect.stringContaining("daemon log"),
    });

    fakeBot.chat.mockImplementationOnce(() => {
      throw "string failure";
    });
    const stringFailure = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_A}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(await stringFailure.json()).toMatchObject({ error: "string failure", code: "DAEMON_ERROR" });

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_A}` } });
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

    const events = await fetch(`http://127.0.0.1:${port}/events`, { headers: { Authorization: `Bearer ${TOKEN_B}` } });
    expect(await events.json()).toMatchObject({ events: [expect.objectContaining({ text: "hello" })] });

    const stop = await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_B}` } });
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

    const status = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(status.ok).toBe(true);
    expect(await status.json()).toMatchObject({
      connected: true,
      username: "AgentBot",
      experience: { level: "1" },
      time: { age: "2" },
      lastEventId: 2,
    });

    const events = await fetch(`http://127.0.0.1:${port}/events?since=0&limit=10`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(await events.json()).toMatchObject({
      profile: "all", types: [], unknownTypes: "included",
      events: [
        expect.objectContaining({ type: "connection.login" }),
        expect.objectContaining({ type: "chat.unverified", candidateSender: "Steve", text: "hello" }),
      ],
    });

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_A}` } });
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
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    const page = await events.json() as { nextCursor: string };
    expect(page).toMatchObject({
      profile: "agent", types: ["chat.unverified"], unknownTypes: "excluded",
      events: [expect.objectContaining({ type: "chat.unverified", text: "keep" })],
      gap: false,
      nextCursor: expect.stringMatching(/:s1$/),
      latestCursor: expect.stringMatching(/:s2$/),
    });
    const headers = { Authorization: `Bearer ${TOKEN_A}` };
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

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_A}` } });
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
      headers: { Authorization: `Bearer ${TOKEN_B}` },
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
      headers: { Authorization: `Bearer ${TOKEN_B}` },
    })).json() as { events: { type: string }[] };
    expect(rawReplay.events.filter(event => event.type === "server.control")).toHaveLength(2);
    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_B}` } });
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
    const context = await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${TOKEN_C}` } })).json() as { runtimeId: string; worldEpoch: number };
    const failed = await fetch(`http://127.0.0.1:${port}/navigate/goto`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, x: 10, y: 64, z: 10, range: 2 }),
    });

    expect(failed.status).toBe(200);
    const started = await failed.json() as { action: string };
    const status = await fetch(`http://127.0.0.1:${port}/actions/${started.action}`, { headers: { Authorization: `Bearer ${TOKEN_C}` } });
    expect(await status.json()).toMatchObject({ state: "failed", error: { code: "NAVIGATION_FAILED", message: "Took to long to decide path to goal!" } });

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_C}` } });
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
    const context = await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${TOKEN_C}` } })).json() as { runtimeId: string; worldEpoch: number };
    const frame = await (await fetch(`http://127.0.0.1:${port}/frame`, { headers: { Authorization: `Bearer ${TOKEN_C}` } })).json() as { entities: { trackId: string; username?: string }[] };
    const playerTrack = frame.entities.find(entity => entity.username === "Steve")!.trackId;
    await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, message: "hello" }),
    });
    expect(fakeBot.chat).toHaveBeenCalledWith("hello");

    await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}` },
    });
    expect(fakeBot.chat).toHaveBeenCalledWith("");

    const position = await fetch(`http://127.0.0.1:${port}/bot/position`, { headers: { Authorization: `Bearer ${TOKEN_C}` } });
    expect(await position.json()).toMatchObject({ position: { x: 1, y: 2, z: 3 }, dimension: "overworld" });

    const inventory = await fetch(`http://127.0.0.1:${port}/bot/inventory`, { headers: { Authorization: `Bearer ${TOKEN_C}` } });
    expect(await inventory.json()).toMatchObject({ items: [expect.objectContaining({ name: "dirt", count: 2 })] });

    await fetch(`http://127.0.0.1:${port}/control/tap`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, state: "forward", durationMs: 1 }),
    });
    expect(fakeBot.setControlState).toHaveBeenCalledWith("forward", true);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(fakeBot.setControlState).toHaveBeenCalledWith("forward", false);

    await fetch(`http://127.0.0.1:${port}/look/at`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, x: 4, y: 5, z: 6 }),
    });
    expect(fakeBot.lookAtCalls).toHaveBeenCalledWith(expect.objectContaining({ x: 4, y: 5, z: 6 }));

    const players = await fetch(`http://127.0.0.1:${port}/bot/players`, { headers: { Authorization: `Bearer ${TOKEN_C}` } });
    expect(await players.json()).toMatchObject({ players: [expect.objectContaining({ username: "Steve", distance: 3 })] });

    const entities = await fetch(`http://127.0.0.1:${port}/bot/entities?radius=10&limit=5`, { headers: { Authorization: `Bearer ${TOKEN_C}` } });
    expect(await entities.json()).toMatchObject({ entities: expect.arrayContaining([expect.objectContaining({ name: "cow", distance: 2 })]) });

    const block = await fetch(`http://127.0.0.1:${port}/world/block?x=7&y=8&z=9`, { headers: { Authorization: `Bearer ${TOKEN_C}` } });
    expect(await block.json()).toMatchObject({ block: { name: "dirt", position: { x: 7, y: 8, z: 9 } } });

    const found = await fetch(`http://127.0.0.1:${port}/world/find-blocks?name=dirt&radius=16&count=2`, {
      headers: { Authorization: `Bearer ${TOKEN_C}` },
    });
    expect(await found.json()).toMatchObject({ blocks: [{ name: "dirt", position: { x: 1, y: 2, z: 3 } }] });

    await fetch(`http://127.0.0.1:${port}/navigate/goto`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, x: 10, y: 64, z: 10, range: 2 }),
    });
    expect(fakeBot.pathfinder.goto).toHaveBeenCalledWith(expect.objectContaining({ x: 10, y: 64, z: 10 }));

    const follow = await fetch(`http://127.0.0.1:${port}/navigate/follow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, track: playerTrack, range: 3 }),
    });
    expect(await follow.json()).toMatchObject({ kind: "navigate.follow", target: playerTrack, state: "running" });
    expect(fakeBot.pathfinder.setGoal).toHaveBeenCalledWith(expect.objectContaining({ entity: fakeBot.players.Steve.entity }), true);

    const navigateStatus = await fetch(`http://127.0.0.1:${port}/navigate/status`, { headers: { Authorization: `Bearer ${TOKEN_C}` } });
    expect(await navigateStatus.json()).toEqual({ moving: true, mining: false, building: false });

    await fetch(`http://127.0.0.1:${port}/navigate/stop`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_C}` }, body: JSON.stringify(context) });
    expect(fakeBot.pathfinder.stop).toHaveBeenCalled();

    await fetch(`http://127.0.0.1:${port}/inventory/equip`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, item: "dirt", destination: "hand" }),
    });
    expect(fakeBot.equipCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), "hand");

    await fetch(`http://127.0.0.1:${port}/world/dig`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, x: 1, y: 2, z: 3 }),
    });
    expect(fakeBot.digCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), true);

    await fetch(`http://127.0.0.1:${port}/world/place`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, x: 1, y: 2, z: 3, face: "up", item: "dirt" }),
    });
    expect(fakeBot.placeBlockCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }), expect.objectContaining({ x: 0, y: 1, z: 0 }));

    await fetch(`http://127.0.0.1:${port}/world/activate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, x: 1, y: 2, z: 3 }),
    });
    expect(fakeBot.activateBlockCalls).toHaveBeenCalledWith(expect.objectContaining({ name: "dirt" }));

    const opened = await fetch(`http://127.0.0.1:${port}/window/open-block`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, x: 1, y: 2, z: 3 }),
    });
    const openAction = await opened.json() as { action: string };
    expect(await (await fetch(`http://127.0.0.1:${port}/actions/${openAction.action}`, { headers: { Authorization: `Bearer ${TOKEN_C}` } })).json()).toMatchObject({ state: "completed", result: { opened: true, window: { id: 1 } } });

    const clicked = await fetch(`http://127.0.0.1:${port}/window/click`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_C}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: context.runtimeId, worldEpoch: context.worldEpoch, slot: 5, mouseButton: 1, mode: 0 }),
    });
    expect(await clicked.json()).toMatchObject({ kind: "window.click", action: expect.stringContaining(":a") });
    expect(fakeBot.clickWindow).toHaveBeenCalledWith(5, 1, 0);

    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_C}` } });
  });
  it("serves frames, typed stale-handle errors and explicit delta reset details", async () => {
    process.env.MC_AGENT_STATE_DIR = await makeTempDir();
    const fakeBot = new FakeBot(), port = 40180 + Math.floor(Math.random()*1000);
    await runDaemon({session:"runtime-api",controlPort:port,token:TOKEN_A,host:"localhost",port:25565,username:"AgentBot",auth:"offline",createBotFn:()=>fakeBot,exitOnStop:false});
    const headers = { Authorization: `Bearer ${TOKEN_A}`, "Content-Type":"application/json" };
    const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`, {headers})).json() as Promise<any>;
    const post = async (path: string, body: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, {headers,method:"POST",body:JSON.stringify(body)})).json() as Promise<any>;
    try {
      fakeBot.emit("spawn");
      const first = await get("/frame"), track = first.entities[0].trackId;
      const context = { runtimeId:first.runtimeId, worldEpoch:first.worldEpoch };
      expect(first).toMatchObject({connection:{ready:true},eventCursor:expect.stringContaining(":s"),frame:expect.stringContaining(":f"),inventory:{ready:true,known:true,slotCount:null,slots:[{name:"dirt",count:2,slot:36}]}});
      expect(await post("/navigate/follow", {track,range:2})).toMatchObject({code:"BAD_INPUT"});
      expect(await post("/navigate/follow", {...context,runtimeId:"previous-runtime",track})).toMatchObject({code:"RUNTIME_MISMATCH",details:{runtimeId:first.runtimeId}});
      expect(await post("/entity/activate", {...context,id:12})).toMatchObject({code:"BAD_INPUT"});
      expect(await post("/entity/activate", {...context,track:`${first.runtimeId}:e999`})).toMatchObject({code:"TRACK_UNKNOWN",details:{trackId:`${first.runtimeId}:e999`}});
      expect(await get("/events?since=previous-runtime:s2")).toMatchObject({code:"RUNTIME_MISMATCH"});
      expect(await get("/events?since=1")).toMatchObject({code:"BAD_INPUT"});
      expect(await get(`/frame?since=${first.frame}&radius=32`)).toMatchObject({code:"FRAME_RESET_REQUIRED",details:{resetRequired:true,reason:"PROJECTION_CHANGED"}});
      fakeBot.inventory.items = () => [{name:"dirt",displayName:"Dirt",count:9,slot:36}];
      const delta = await get(`/frame?since=${first.frame}`);
      expect(delta).toMatchObject({since:first.frame,delta:{changed:{inventory:{slots:[{count:9,slot:36}]}}}});
      const follow = await post("/navigate/follow", {...context,track,range:2});
      fakeBot.emit("entityGone", fakeBot.entities["12"]);
      expect(await get(`/actions/${follow.action}`)).toMatchObject({state:"failed",reason:"TRACK_LOST"});
      expect(await post("/navigate/follow", {...context,track})).toMatchObject({code:"TRACK_LOST"});
      fakeBot.emit("death");
      expect(await post("/navigate/goto", {...context,x:1,y:64,z:1})).toMatchObject({code:"WORLD_CHANGED",details:{expectedWorldEpoch:first.worldEpoch}});
      expect(await get(`/frame?since=${first.frame}`)).toMatchObject({code:"FRAME_RESET_REQUIRED",details:{reason:"WORLD_CHANGED"}});
    } finally { await post("/stop", {}); }
  });

  it("samples a target outside semantic history and reports structured sampling failures", async () => {
    process.env.MC_AGENT_STATE_DIR = await makeTempDir();
    const fakeBot = new FakeBot(), port = 41180 + Math.floor(Math.random()*1000);
    await runDaemon({session:"samples",controlPort:port,token:TOKEN_B,host:"localhost",port:25565,username:"AgentBot",auth:"offline",createBotFn:()=>fakeBot,exitOnStop:false});
    const headers = {Authorization:`Bearer ${TOKEN_B}`};
    try {
      fakeBot.emit("spawn");
      const frame = await (await fetch(`http://127.0.0.1:${port}/frame`,{headers})).json() as any;
      const track = frame.entities[0].trackId;
      const invalid = await fetch(`http://127.0.0.1:${port}/sample?track=${track}&rate=100`,{headers});
      expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({code:"BAD_INPUT"});
      const response = await fetch(`http://127.0.0.1:${port}/sample?track=${track}&fields=position,velocity,status&rate=10`,{headers});
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
    const headers = {Authorization:`Bearer ${TOKEN_C}`};
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
