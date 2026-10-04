import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDaemon } from "../src/daemon/server.js";
import { readSession } from "../src/session/store.js";
import * as sessionStore from "../src/session/store.js";

class Bot extends EventEmitter {
  chat = vi.fn(); quit = vi.fn(); lookAt = vi.fn(); setControlState = vi.fn();
  entity = { id: 1, position: { x: 0, y: 64, z: 0 } }; entities = {}; players = {};
}
const token = "lifecycle-token-aaaaaaaaaaaaaaaaaaaaaaaa";
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mc-lifecycle-"));
  process.env.MC_AGENT_STATE_DIR = dir;
  const port = await unusedPort();
  const bot = new Bot();
  const create = vi.fn(() => bot);
  await runDaemon({ session: "lifecycle", host: "localhost", port: 25565, username: "Agent", auth: "offline",
    controlPort: port, token, createBotFn: create, exitOnStop: false });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    expect(response.headers.get("X-MC-Agent-API")).toBe("3.1");
    return { status: response.status, body: await response.json() as any };
  };
  const cleanup = async () => {
    try { await request("/stop", {}); } catch { /* Already closed. */ }
    for (let i = 0; i < 400 && await readSession("lifecycle", dir); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    delete process.env.MC_AGENT_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
  };
  return { bot, create, request, cleanup, dir };
}

describe("daemon lifecycle routes", () => {
  it("separates HTTP responsiveness, login, spawn, and bounded recovery", async () => {
    const { bot, create, request, cleanup } = await setup();
    try {
      const initial = await request("/diagnose");
      expect(initial.body).toMatchObject({ daemonResponsive: true, ready: false, connection: { authentication: { state: "unknown" } } });
      const recovery = request("/ensure-ready", { timeout: 500, maxAttempts: 1, backoff: 0 });
      bot.emit("login");
      expect((await request("/status")).body).toMatchObject({ ready: false, connection: { state: "waiting_for_spawn" } });
      bot.emit("spawn");
      expect((await recovery).body).toMatchObject({ ready: true, timedOut: false });
      expect(create).toHaveBeenCalledOnce();
      expect((await request("/ensure-ready", { timeout: 10 })).body.ready).toBe(true);
      expect((await request("/ensure-ready", { maxAttempts: 0 })).status).toBe(400);
    } finally { await cleanup(); }
  });

  it("completes teardown even when the stopping marker cannot be persisted", async () => {
    const { bot, request, cleanup, dir } = await setup();
    const persist = vi.spyOn(sessionStore, "writeSession").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stop = await request("/stop", {});
      expect(stop.body).toMatchObject({ stopping: true, stopped: false, persistenceError: { code: "ENOSPC" } });
      expect(bot.quit).toHaveBeenCalledOnce();
      for (let i = 0; i < 400 && await readSession("lifecycle", dir); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await readSession("lifecycle", dir)).toBeUndefined();
      await expect(request("/status")).rejects.toThrow();
    } finally { persist.mockRestore(); log.mockRestore(); await cleanup(); }
  });

  it("accepts truthful stop, aborts recovery, closes daemon and releases matching record", async () => {
    const { request, cleanup, dir } = await setup();
    try {
      const recovery = request("/ensure-ready", { timeout: 120_000, maxAttempts: 1 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stops = await Promise.all([request("/stop", {}), request("/stop", {})]);
      for (const stop of stops)
        expect(stop.body).toEqual({ stopping: true, stopped: false });
      expect((await recovery).body).toMatchObject({ ready: false, connection: { state: "stopping" } });
      for (let i = 0; i < 400 && await readSession("lifecycle", dir); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await readSession("lifecycle", dir)).toBeUndefined();
      await expect(request("/status")).rejects.toThrow();
    } finally { await cleanup(); }
  });
});
