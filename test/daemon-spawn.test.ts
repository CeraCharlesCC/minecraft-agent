import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_VERSION } from "../src/core/protocol.js";

const API_VERSION_HEADER = "X-MC-Agent-API";

async function loadSpawnWithNetMock(address: unknown) {
  vi.resetModules();
  const child = { unref: vi.fn() };
  const server = {
    on: vi.fn(),
    listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
    address: vi.fn(() => address),
    close: vi.fn((callback: () => void) => callback()),
  };
  const mocks = {
    createServer: vi.fn(() => server),
    spawn: vi.fn((_command: string, _args: string[], _options: unknown) => child),
    openSync: vi.fn(() => 123),
    mkdir: vi.fn(),
    getStateDir: vi.fn(() => "C:\\state"),
    readSession: vi.fn(() => ({ controlPort: 12345, token: "token" })),
    daemonRequest: vi.fn(() => Promise.resolve({ connected: true })),
  };

  vi.doMock("node:net", () => ({ createServer: mocks.createServer }));
  vi.doMock("node:child_process", () => ({ spawn: mocks.spawn }));
  vi.doMock("node:fs", () => ({ openSync: mocks.openSync }));
  vi.doMock("node:fs/promises", () => ({ mkdir: mocks.mkdir }));
  vi.doMock("../src/session/store.js", () => ({
    getStateDir: mocks.getStateDir,
    readSession: mocks.readSession,
  }));
  vi.doMock("../src/daemon/client.js", () => ({ daemonRequest: mocks.daemonRequest }));

  const { spawnSessionDaemon } = await import("../src/daemon/spawn.js");
  return { spawnSessionDaemon, mocks, child, server };
}

const input = {
  session: "default",
  host: "localhost",
  port: 25565,
  username: "AgentBot",
  auth: "offline",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const module of ["node:net", "node:child_process", "node:fs", "node:fs/promises", "../src/session/store.js", "../src/daemon/client.js"]) {
    vi.doUnmock(module);
  }
  vi.resetModules();
});

describe("daemon spawn", () => {
  it("spawns with a private token and confirms HTTP readiness through a persisted session", async () => {
    vi.resetModules();
    const stateDir = join(await mkdtemp(join(tmpdir(), "mc-spawn-")), "state");
    vi.stubEnv("MC_AGENT_STATE_DIR", stateDir);
    vi.stubEnv("MC_AGENT_SHARED_STATE", "false");
    const { writeSession, readSession } = await import("../src/session/store.js");
    const child = { unref: vi.fn() };
    let logFd: number | undefined;
    let token: string | undefined;
    let controlPort: number | undefined;
    const requests: { path?: string; authorization?: string; apiVersion?: string | string[] }[] = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url, authorization: request.headers.authorization,
        apiVersion: request.headers[API_VERSION_HEADER.toLowerCase()] });
      response.writeHead(200, { "Content-Type": "application/json", [API_VERSION_HEADER]: API_VERSION });
      // The control endpoint can be ready before Minecraft login/spawn.
      response.end(JSON.stringify({ ready: false, connection: { state: "connecting" } }));
    });
    let finishSetup!: () => void;
    let failSetup!: (error: unknown) => void;
    const setup = new Promise<void>((resolve, reject) => { finishSetup = resolve; failSetup = reject; });
    const spawn = vi.fn((_command: string, args: string[], options: {
      detached: boolean; stdio: [string, number, number]; env: NodeJS.ProcessEnv;
    }) => {
      controlPort = Number(args[args.indexOf("--control-port") + 1]);
      token = options.env.MC_AGENT_CONTROL_TOKEN;
      logFd = options.stdio[1];
      void (async () => {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(controlPort, "127.0.0.1", resolve);
        });
        await writeSession({ ...input, pid: process.pid, controlPort: controlPort!, token: token!,
          startedAt: "2026-10-04T00:00:00Z" }, stateDir);
      })().then(finishSetup, failSetup);
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn }));
    const { spawnSessionDaemon } = await import("../src/daemon/spawn.js");
    try {
      const pending = spawnSessionDaemon({ ...input, version: "1.20.4" }, "entry.js");
      const completion = expect(pending).resolves.toEqual({ controlPort: expect.any(Number) });
      await Promise.all([setup, completion]);
      expect(await pending).toEqual({ controlPort });
      expect(await readSession("default", stateDir)).toMatchObject({ controlPort, token });
      expect((await stat(join(stateDir, "default.log"))).isFile()).toBe(true);
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, expect.any(Array),
        expect.objectContaining({ detached: true, stdio: ["ignore", logFd, logFd] }));
      const args = spawn.mock.calls[0]![1];
      for (const [flag, value] of [["--session", "default"], ["--host", "localhost"],
        ["--port", "25565"], ["--username", "AgentBot"], ["--auth", "offline"], ["--minecraft-version", "1.20.4"]]) {
        expect(args[args.indexOf(flag!) + 1]).toBe(value);
      }
      expect(args).not.toContain(token);
      expect(args).not.toContain("--version");
      expect(child.unref).toHaveBeenCalledOnce();
      expect(requests).toEqual([{ path: "/status", authorization: `Bearer ${token}`, apiVersion: API_VERSION }]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (logFd !== undefined) closeSync(logFd);
      await rm(join(stateDir, ".."), { recursive: true, force: true });
    }
  });

  it("rejects when the OS does not return a TCP port", async () => {
    const { spawnSessionDaemon } = await loadSpawnWithNetMock("pipe");

    await expect(spawnSessionDaemon(input, "entry.js")).rejects.toThrow("Unable to allocate a local port.");
  });

  it("retries daemon readiness checks before succeeding", async () => {
    vi.useFakeTimers();
    const { spawnSessionDaemon, mocks } = await loadSpawnWithNetMock({ port: 34567 });
    mocks.daemonRequest.mockRejectedValueOnce(new Error("not ready")).mockResolvedValueOnce({ connected: true });

    const spawned = spawnSessionDaemon(input, "entry.js");
    await vi.advanceTimersByTimeAsync(100);

    await expect(spawned).resolves.toEqual({ controlPort: 34567 });
    expect(mocks.daemonRequest).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when the startup probe finds an incompatible daemon", async () => {
    const { spawnSessionDaemon, mocks } = await loadSpawnWithNetMock({ port: 34569 });
    const { CliError } = await import("../src/output/errors.js");
    mocks.daemonRequest.mockRejectedValueOnce(new CliError("DAEMON_INCOMPATIBLE", "Old daemon.", "Restart using the current CLI."));
    await expect(spawnSessionDaemon(input, "entry.js")).rejects.toMatchObject({ code: "DAEMON_INCOMPATIBLE" });
    expect(mocks.daemonRequest).toHaveBeenCalledOnce();
  });

  it("retries when the session file is temporarily incomplete", async () => {
    vi.useFakeTimers();
    const { spawnSessionDaemon, mocks } = await loadSpawnWithNetMock({ port: 34568 });
    mocks.readSession.mockImplementationOnce(() => {
      throw new SyntaxError("Unexpected end of JSON input");
    });

    const spawned = spawnSessionDaemon(input, "entry.js");
    await vi.advanceTimersByTimeAsync(100);

    await expect(spawned).resolves.toEqual({ controlPort: 34568 });
    expect(mocks.daemonRequest).toHaveBeenCalledTimes(1);
  });

  it("fails when the daemon never becomes ready", async () => {
    vi.useFakeTimers();
    const { spawnSessionDaemon, mocks } = await loadSpawnWithNetMock({ port: 45678 });
    (mocks.readSession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const spawned = spawnSessionDaemon(input, "entry.js");
    const expectation = expect(spawned).rejects.toMatchObject({
      code: "DAEMON_ERROR",
      message: "Session daemon did not become ready in time.",
    });
    await vi.advanceTimersByTimeAsync(10_100);

    await expectation;
  });
});
