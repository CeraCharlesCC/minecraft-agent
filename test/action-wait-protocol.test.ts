import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeHandle } from "../src/core/handles.js";
import { API_VERSION } from "../src/core/protocol.js";
import { runDaemon } from "../src/daemon/server.js";
import { CliError } from "../src/output/errors.js";

class WaitBot extends EventEmitter {
  username = "AgentBot";
  entity = { position: { x: 0, y: 64, z: 0 } };
  entities = {}; players = {}; game = { dimension: "overworld" };
  inventory = { slots: [null], items: () => [] };
  chat = vi.fn(); quit = vi.fn(); setControlState = vi.fn(); clearControlStates = vi.fn();
  lookAtCalls = vi.fn<() => Promise<void>>().mockResolvedValue(); lookAt = this.lookAtCalls;
  look = vi.fn(async () => {});
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete process.env.MC_AGENT_STATE_DIR;
});

async function server() {
  const dir = await mkdtemp(join(tmpdir(), "mc-agent-wait-"));
  process.env.MC_AGENT_STATE_DIR = dir;
  const allocation = createServer();
  await new Promise<void>(resolve => allocation.listen(0, "127.0.0.1", resolve));
  const port = (allocation.address() as { port: number }).port;
  await new Promise<void>(resolve => allocation.close(() => resolve()));
  const bot = new WaitBot();
  const headers = { "X-MC-Agent-API": API_VERSION, Authorization: "Bearer wait-protocol-test-token-123456789", "Content-Type": "application/json" };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    expect(response.headers.get("X-MC-Agent-API")).toBe(API_VERSION);
    return response;
  };
  const get = async (path: string) => (await request(path)).json() as Promise<any>;
  const post = async (path: string, body: unknown) => (await request(path, { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
  await runDaemon({ session: "wait", host: "localhost", port: 25565, username: "AgentBot", auth: "offline", controlPort: port,
    token: "wait-protocol-test-token-123456789", createBotFn: () => bot, exitOnStop: false });
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

describe("authoritative action waits over HTTP", () => {
  it("allows status and cancellation during a wait, with context-only physical requests", async () => {
    const { bot, get, post, context } = await server();
    let resolve!: () => void;
    bot.lookAtCalls.mockReturnValue(new Promise<void>(done => { resolve = done; }));
    const action = await post("/look/at", { context, x: 6, y: 64, z: 0 });
    expect(Object.keys(action).sort()).toEqual(["action", "kind", "observation", "state"]);
    const waiting = get(`/actions/${action.action}/wait?timeout=1000`);
    expect(await get(`/actions/${action.action}`)).toMatchObject({ state: "running" });
    expect(await post(`/actions/${action.action}/cancel`, { context })).toMatchObject({ state: "cancelled" });
    expect(await waiting).toMatchObject({ state: "cancelled", timedOut: false });
    resolve();
    expect(await get(`/actions/${action.action}`)).toMatchObject({ state: "cancelled" });
  });

  it("returns terminal results and typed failure details, and validates wait inputs", async () => {
    const { bot, request, get, post, context } = await server();
    const completed = await post("/advanced/look", { context, yaw: 1, pitch: 0, force: false });
    expect(await get(`/actions/${completed.action}/wait?timeout=1000`)).toMatchObject({ state: "completed", timedOut: false, result: { looked: true, yaw: 1, pitch: 0 } });
    bot.lookAtCalls.mockRejectedValue(new CliError("TRACK_LOST", "Target disappeared.", "Observe again.", 1, { trackId: "lost-target" }));
    const failed = await post("/look/at", { context, x: 2, y: 64, z: 0 });
    expect(await get(`/actions/${failed.action}/wait?timeout=1000`)).toMatchObject({ state: "failed", timedOut: false,
      error: { code: "TRACK_LOST", details: { trackId: "lost-target" } } });
    const invalid = await request(`/actions/${failed.action}/wait?timeout=-1`);
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "BAD_INPUT" });
    expect(await get(`/actions/${encodeHandle("00000000-0000-0000-0000-000000000007","a",1)}/wait?timeout=0`)).toMatchObject({ code: "RUNTIME_MISMATCH" });
  });

  it("does not cancel continuous work at a deadline or when a waiting client disconnects", async () => {
    const { request, get, post, context } = await server();
    const action = await post("/control/set", { context, state: "forward", value: true });
    expect(await get(`/actions/${action.action}/wait?timeout=10`)).toMatchObject({ state: "running", timedOut: true });
    const abort = new AbortController();
    const waiting = request(`/actions/${action.action}/wait?timeout=30000`, { signal: abort.signal });
    const rejection = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(await get(`/actions/${action.action}`)).toMatchObject({ state: "running" });
    abort.abort(); await rejection;
    expect(await get(`/actions/${action.action}`)).toMatchObject({ state: "running" });
    expect(await post(`/actions/${action.action}/cancel`, { context })).toMatchObject({ state: "cancelled" });
    expect(await get(`/actions/${action.action}/wait?timeout=0`)).toMatchObject({ state: "cancelled", timedOut: false });
  });

  it("disconnects a bounded POST waiter without cancelling the accepted operation", async () => {
    const { bot, request, get, context } = await server();
    let resolve!: () => void, started!: () => void;
    const beginning = new Promise<void>(done => { started = done; });
    bot.lookAtCalls.mockImplementationOnce(() => {
      started();
      return new Promise<void>(done => { resolve = done; });
    });
    const abort = new AbortController();
    const posting = request("/look/at", { method: "POST", signal: abort.signal,
      body: JSON.stringify({ context, x: 6, y: 64, z: 0, wait: 30000 }) });
    const rejection = expect(posting).rejects.toMatchObject({ name: "AbortError" });
    await beginning;
    const frame = await get("/frame");
    const action = frame.actions.find((record: any) => record.kind === "look.at").action;
    abort.abort();
    await rejection;
    expect(await get(`/actions/${action}`)).toMatchObject({ state: "running" });
    resolve();
    expect(await get(`/actions/${action}/wait?timeout=1000`)).toMatchObject({ state: "completed", timedOut: false, observation: { type: "full" } });
  });
});
