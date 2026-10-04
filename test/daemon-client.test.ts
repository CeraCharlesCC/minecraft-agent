import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_VERSION, API_VERSION_HEADER, daemonRequest, daemonStreamRequest, loadSessionForClient } from "../src/daemon/client.js";
import { CliError } from "../src/output/errors.js";
import { createSessionToken, SessionRecord, writeSession } from "../src/session/store.js";

function apiResponse(body?: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, { ...init, headers: { ...init.headers, [API_VERSION_HEADER]: API_VERSION } });
}

const tempDirs: string[] = [];
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

function stalledFetch() {
  const mock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "mc-agent-client-"));
  tempDirs.push(dir);
  return dir;
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session: "default",
    pid: process.pid,
    controlPort: 39123,
    token: createSessionToken(),
    host: "localhost",
    port: 25565,
    username: "AgentBot",
    auth: "offline",
    startedAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  }));
  delete process.env.MC_AGENT_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("daemon client", () => {
  it("loads an existing session or throws SESSION_NOT_FOUND", async () => {
    const dir = await makeTempDir();
    process.env.MC_AGENT_STATE_DIR = dir;
    const saved = record({ session: "loaded" });
    await writeSession(saved, dir);

    await expect(loadSessionForClient("loaded")).resolves.toMatchObject({ session: "loaded", token: saved.token });
    await expect(loadSessionForClient("missing")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", exitCode: 4 });
  });

  it("sends authorized local daemon requests and parses JSON responses", async () => {
    const saved = record({ controlPort: 39234, token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const fetchMock = vi.fn().mockResolvedValue(apiResponse(JSON.stringify({ connected: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(daemonRequest(saved, "/status", { method: "GET", headers: { "X-Test": "1" } })).resolves.toEqual({
      connected: true,
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:39234/status", {
      method: "GET",
      signal: expect.any(AbortSignal),
      headers: {
        Authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "Content-Type": "application/json",
        "X-Test": "1",
      },
    });
  });

  it("maps daemon HTTP failures to CliError", async () => {
    const saved = record({ token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        apiResponse(JSON.stringify({ error: "boom", code: "NAVIGATION_FAILED", remediation: "try a closer goal" }), { status: 409 }),
      ),
    );

    const request = daemonRequest(saved, "/status");
    await expect(request).rejects.toBeInstanceOf(CliError);
    await expect(request).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
      message: "boom",
      remediation: "try a closer goal",
      exitCode: 1,
    });
  });

  it("reads compact v3 public errors and preserves CONTEXT_REQUIRED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse(JSON.stringify({
      code: "CONTEXT_REQUIRED", message: "Pass context from observe frame or entity find.",
    }), { status: 400 })));
    await expect(daemonRequest(record(), "/look/at", { method: "POST", body: "{}" })).rejects.toMatchObject({
      code: "CONTEXT_REQUIRED", message: "Pass context from observe frame or entity find.", exitCode: 3,
    });
  });

  it("identifies unsupported legacy routes without suggesting an observation retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    await expect(daemonRequest(record(), "/frame?maxEntities=50")).rejects.toMatchObject({
      code: "DAEMON_INCOMPATIBLE",
      remediation: expect.stringContaining("session stop --session default"),
      details: { session: "default", expectedApiVersion: "3.2", path: "/frame", httpStatus: 404, actualApiVersion: null },
    });
  });

  it("rejects successful old, missing, and future protocol headers before reading JSON", async () => {
    for (const version of [undefined, "2", "3", "3.1", "4"]) {
      const response = new Response("not valid JSON", { headers: version ? { [API_VERSION_HEADER]: version } : {} });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(daemonRequest(record(), "/status")).rejects.toMatchObject({
        code: "DAEMON_INCOMPATIBLE", details: { expectedApiVersion: "3.2", actualApiVersion: version ?? null },
      });
      expect(response.bodyUsed).toBe(true);
    }
  });

  it("rejects incompatible stream headers and error bodies before decoding them", async () => {
    for (const status of [200, 401, 503]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("legacy", { status, headers: { [API_VERSION_HEADER]: "2" } })));
      await expect(daemonStreamRequest(record(), "/watch")).rejects.toMatchObject({ code: "DAEMON_INCOMPATIBLE" });
    }
  });

  it("preserves typed resource errors even when their HTTP status is 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse(JSON.stringify({ code: "ACTION_UNKNOWN", error: "Unknown action", remediation: "Inspect actions." }), { status: 404 })));
    await expect(daemonRequest(record(), "/actions/missing")).rejects.toMatchObject({ code: "ACTION_UNKNOWN" });
  });

  it("handles empty success bodies and fallback daemon error messages", async () => {
    const saved = record({ token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse("", { status: 200 })));
    await expect(daemonRequest(saved, "/empty")).resolves.toEqual({});

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse("", { status: 503 })));
    await expect(daemonRequest(saved, "/down")).rejects.toMatchObject({
      code: "DAEMON_ERROR",
      message: "Daemon returned HTTP 503.",
      remediation: expect.stringContaining("daemon log"),
    });
  });
  it("preserves runtime errors and structured details through the client", async () => {
    const saved = record();
    for (const code of ["CONTEXT_REQUIRED", "DAEMON_TIMEOUT", "DAEMON_INCOMPATIBLE", "TRACK_UNKNOWN", "TRACK_LOST", "WORLD_CHANGED", "RUNTIME_MISMATCH", "FRAME_RESET_REQUIRED", "NOT_READY", "ACTION_UNKNOWN", "STREAM_OVERFLOW"]) {
      const details = { runtimeId: "runtime", trackId: "runtime:p1", resetRequired: true };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse(JSON.stringify({ code, error: "stale context", remediation: "observe", details }), {status:409})));
      await expect(daemonRequest(saved, "/action")).rejects.toMatchObject({code, details, remediation:"observe"});
    }
  });

  it("bounds stalled headers and clears the default deadline after timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = stalledFetch();
    const request = daemonRequest(record(), "/frame?detail=compact");
    const failure = expect(request).rejects.toMatchObject({ code: "DAEMON_TIMEOUT", details: {
      path: "/frame?detail=compact", method: "GET", timeoutMs: 5000, responseConfirmed: false,
    } });
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an HTTP body and reports an unknown POST outcome without resending", async () => {
    let requests = 0;
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>(resolve => { resolveDisconnected = resolve; });
    const controlPort = await listen(createServer((request, response) => {
      requests++;
      expect(request.method).toBe("POST");
      response.writeHead(200, { "Content-Type": "application/json", [API_VERSION_HEADER]: API_VERSION });
      response.write('{"accepted":');
      response.once("close", resolveDisconnected);
    }));
    await expect(daemonRequest(record({ controlPort }), "/chat", { method: "POST", body: '{"message":"hello"}' })).rejects.toMatchObject({
      code: "DAEMON_TIMEOUT", details: { path: "/chat", method: "POST", timeoutMs: 5000,
        responseConfirmed: false, outcome: "unknown", mayHaveExecuted: true },
    });
    await disconnected;
    expect(requests).toBe(1);
  }, 10000);

  it("bounds partial HTTP error bodies during stream startup and disconnects", async () => {
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>(resolve => { resolveDisconnected = resolve; });
    const controlPort = await listen(createServer((_request, response) => {
      response.writeHead(503, { "Content-Type": "application/json", [API_VERSION_HEADER]: API_VERSION });
      response.write('{"code":"DAEMON_ERROR",');
      response.once("close", resolveDisconnected);
    }));
    await expect(daemonStreamRequest(record({ controlPort }), "/watch?since=0")).rejects.toMatchObject({
      code: "DAEMON_TIMEOUT", details: { path: "/watch?since=0", timeoutMs: 5000, responseConfirmed: false },
    });
    await disconnected;
  }, 10000);

  it("preserves a caller abort while reading an HTTP body", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Cancelled by caller", "AbortError");
    const controlPort = await listen(createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", [API_VERSION_HEADER]: API_VERSION });
      response.write('{"value":');
      setTimeout(() => controller.abort(reason), 20);
    }));
    await expect(daemonRequest(record({ controlPort }), "/frame", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.reason).toBe(reason);
  });

  it("keeps explicit waits longer than five seconds and their caller signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      setTimeout(() => resolve(apiResponse('{"timedOut":true}')), 5500);
    }));
    vi.stubGlobal("fetch", fetchMock);
    const request = daemonRequest(record(), "/actions/a1/wait?timeout=6000", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5500);
    await expect(request).resolves.toEqual({ timedOut: true });
    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes caller cancellation from a caller deadline", async () => {
    const fetchMock = stalledFetch();
    const controller = new AbortController();
    const reason = new Error("Caller cancelled");
    const cancelled = daemonRequest(record(), "/frame", { signal: controller.signal });
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    await expect(daemonRequest(record(), "/ensure-ready", { method: "POST", signal: AbortSignal.timeout(20) })).rejects.toMatchObject({
      code: "DAEMON_TIMEOUT", details: { timeoutMs: null, outcome: "unknown", mayHaveExecuted: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears successful request timers and limits stream startup without limiting its lifetime", async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = apiResponse(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } }));
    const fetchMock = vi.fn().mockResolvedValueOnce(apiResponse('{"ready":true}')).mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    await daemonRequest(record(), "/status");
    expect(vi.getTimerCount()).toBe(0);
    const stream = await daemonStreamRequest(record(), "/watch?since=0");
    const streamSignal = fetchMock.mock.calls[1]![1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(6000);
    expect(streamSignal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const reader = stream.body!.getReader();
    streamController.enqueue(new TextEncoder().encode("still subscribed"));
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel();
    reader.releaseLock();

    stalledFetch();
    const startup = daemonStreamRequest(record(), "/sample?track=p1");
    const failure = expect(startup).rejects.toMatchObject({ code: "DAEMON_TIMEOUT", details: { timeoutMs: 5000 } });
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

});
