import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli/program.js";
import type { CliHandlers } from "../src/cli/handlers.js";
import { encodeActionContext } from "../src/core/context.js";
import { encodeRuntimeTag } from "../src/core/handles.js";
import { CliError } from "../src/output/errors.js";
import { acquireClientContext, clientContextDirectory, resolveClientId, resolveStrictContext } from "../src/session/client-context.js";

const runtime = "00000000-0000-4000-8000-000000000001";
const context = encodeActionContext(runtime, 1);
const changed = encodeActionContext(runtime, 2);
const ready = (value = context) => ({ type: "full", context: value, connection: { ready: true }, frame: `${encodeRuntimeTag(runtime)}:f1` });
class Output extends Writable {
  text = "";
  _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString(); done(); }
}
function cli(handlers: Partial<CliHandlers> = {}) {
  const stdout = new Output();
  const program = buildProgram(handlers as CliHandlers, { stdout, stderr: new Output(), isStdoutTty: false });
  program.exitOverride();
  return { stdout, run: (...args: string[]) => program.parseAsync(["node", "mc-agent", ...args]) };
}
let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "mc-client-context-"));
  vi.stubEnv("MC_AGENT_SHARED_STATE", "false");
  vi.stubEnv("MC_AGENT_STATE_DIR", stateDir);
  vi.stubEnv("MC_AGENT_CLIENT_ID", "agent-a");
  delete process.env.MC_AGENT_STRICT_CONTEXT;
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(stateDir, { recursive: true, force: true }); });
async function observe(value = context, session = "default", client = "agent-a") {
  return cli({ observeFrame: vi.fn(async () => ready(value)) }).run("--client", client, "observe", "frame", "--session", session);
}

describe("persisted client context", () => {
  it("continues actions from an explicit fresh surroundings observation", async () => {
    await cli({ observeSurroundings: vi.fn(async () => ({ ...ready(), type: "surroundings", fresh: true })) }).run("observe", "surroundings");
    const close = vi.fn(async () => ({ closed: true }));
    await cli({ windowClose: close }).run("window", "close");
    expect(close).toHaveBeenCalledExactlyOnceWith({ session: "default", context, runtimeId: runtime, worldEpoch: 1 });
  });

  it("continues across CLI instances with an atomic private state file, including window close", async () => {
    await observe();
    const close = vi.fn(async () => ({ closed: true, observation: ready() }));
    await cli({ windowClose: close }).run("window", "close");
    expect(close).toHaveBeenCalledExactlyOnceWith({ session: "default", context, runtimeId: runtime, worldEpoch: 1 });
    await cli({ windowClose: close }).run("window", "close", "--no-observe");
    expect(close).toHaveBeenLastCalledWith({ session: "default", context, runtimeId: runtime, worldEpoch: 1, observe: false });
    const files = await readdir(clientContextDirectory("agent-a", "default"));
    expect(files).toEqual(["context.json"]);
  });

  it("shares all context directories and replacement files with the workspace group", async () => {
    vi.stubEnv("MC_AGENT_SHARED_STATE", "true");
    await observe();
    await observe(changed);
    const directory = clientContextDirectory("agent-a", "default");
    const lease = await acquireClientContext("agent-a", "default");
    expect(lease.context).toBe(changed);
    await lease.release();
    if (process.platform !== "win32") {
      for (const dir of [stateDir, join(stateDir, "clients"), directory]) {
        expect((await stat(dir)).mode & 0o7777).toBe(0o2770);
      }
      expect((await stat(join(directory, "context.json"))).mode & 0o777).toBe(0o660);
    }
  });

  it("preserves a foreign namespace lease instead of treating its invisible PID as dead", async () => {
    vi.stubEnv("MC_AGENT_SHARED_STATE", "true");
    const directory = clientContextDirectory("agent-a", "default");
    await mkdir(join(directory, "lease-999999-ns0-foreign"), { recursive: true });
    await expect(acquireClientContext("agent-a", "default")).rejects.toMatchObject({ code: "CLIENT_BUSY" });
    expect(await readdir(directory)).toEqual(["lease-999999-ns0-foreign"]);
  });

  it("keeps clients and sessions separate and requires ID-less commands to be explicit", async () => {
    await observe();
    for (const args of [["--client", "agent-b", "window", "close"], ["window", "close", "--session", "other"]]) {
      const close = vi.fn();
      await expect(cli({ windowClose: close }).run(...args)).rejects.toMatchObject({ code: "CONTEXT_REQUIRED" });
      expect(close).not.toHaveBeenCalled();
    }
    delete process.env.MC_AGENT_CLIENT_ID;
    await expect(cli({ windowClose: vi.fn() }).run("window", "close")).rejects.toMatchObject({ code: "CONTEXT_REQUIRED" });
  });

  it("initializes from ready find and inspect, but never status or unready frames", async () => {
    await cli({ sessionStatus: vi.fn(async () => ready()) }).run("session", "status");
    await cli({ observeFrame: vi.fn(async () => ({ ...ready(), connection: { ready: false } })) }).run("observe", "frame");
    await expect(cli({ windowClose: vi.fn() }).run("window", "close")).rejects.toMatchObject({ code: "CONTEXT_REQUIRED" });
    await cli({ entityFind: vi.fn(async () => ready()) }).run("entity", "find");
    const lease = await acquireClientContext("agent-a", "default");
    expect(lease.context).toBe(context); await lease.release();
    await cli({ entityInspect: vi.fn(async () => ready(changed)) }).run("entity", "inspect", "--track", `${encodeRuntimeTag(runtime)}:e1`);
    const next = await acquireClientContext("agent-a", "default");
    expect(next.context).toBe(changed); await next.release();
  });

  it("prioritizes explicit context and rejects malformed, contradictory, and strict missing input", async () => {
    await observe();
    const close = vi.fn(async () => ({ closed: true }));
    await cli({ windowClose: close }).run("window", "close", "--context", changed);
    expect(close).toHaveBeenLastCalledWith({ session: "default", context: changed, runtimeId: runtime, worldEpoch: 2 });
    for (const args of [["window", "close", "--context", "latest"], ["window", "close", "--context", context, "--world-epoch", "2"]]) {
      await expect(cli({ windowClose: close }).run(...args)).rejects.toMatchObject({ code: "BAD_INPUT" });
    }
    await expect(cli({ windowClose: close }).run("--strict-context", "window", "close")).rejects.toMatchObject({ code: "CONTEXT_REQUIRED" });
    vi.stubEnv("MC_AGENT_STRICT_CONTEXT", "true");
    await expect(cli({ windowClose: close }).run("window", "close")).rejects.toMatchObject({ code: "CONTEXT_REQUIRED" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never switches context from successful actions, explicit wait, or errors with a new-world observation", async () => {
    await observe();
    const error = new CliError("WORLD_CHANGED", "World changed", "Observe again");
    error.observation = ready(changed);
    const reject = vi.fn(async () => { throw error; });
    await expect(cli({ windowClose: reject }).run("window", "close")).rejects.toMatchObject({ code: "WORLD_CHANGED" });
    expect(reject).toHaveBeenCalledTimes(1);
    await cli({ windowClose: vi.fn(async () => ({ observation: ready(changed) })) }).run("window", "close");
    await cli({ actionWait: vi.fn(async () => ({ observation: ready(changed) })) }).run("action", "wait", "--action", `${encodeRuntimeTag(runtime)}:a1`);
    const lease = await acquireClientContext("agent-a", "default");
    expect(lease.context).toBe(context); await lease.release();
    const command = cli({ observeFrame: vi.fn(async () => ready(changed)) });
    await command.run("observe", "frame");
    expect(JSON.parse(command.stdout.text).data.contextReset).toEqual({ reason: "world_changed" });
  });

  it("refuses overlap without queuing and permits explicit actions on the same client", async () => {
    await observe();
    let finish!: (result: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const close = vi.fn(() => { notifyStarted(); return pending; });
    const first = cli({ windowClose: close }).run("window", "close");
    await started;
    await expect(cli({ observeFrame: vi.fn() }).run("observe", "frame")).rejects.toMatchObject({ code: "CLIENT_BUSY" });
    await expect(cli({ windowClose: vi.fn() }).run("window", "close")).rejects.toMatchObject({ code: "CLIENT_BUSY" });
    const explicit = vi.fn(async () => ({}));
    await cli({ windowClose: explicit }).run("window", "close", "--context", context);
    expect(explicit).toHaveBeenCalledOnce();
    finish({ observation: ready() }); await first;
    const lease = await acquireClientContext("agent-a", "default"); await lease.release();
  });

  it("ignores a released lease's late observation and clears dead-process tickets", async () => {
    const dead = clientContextDirectory("agent-a", "default");
    await mkdir(join(dead, "lease-2147483647-dead"), { recursive: true });
    const stale = await acquireClientContext("agent-a", "default");
    await stale.release();
    const fresh = await acquireClientContext("agent-a", "default");
    await fresh.remember(ready(changed)); await fresh.release();
    await stale.remember(ready());
    const check = await acquireClientContext("agent-a", "default");
    expect(check.context).toBe(changed); await check.release();
    expect(await readdir(dead)).toEqual(["context.json"]);
  });

  it("validates stable identities and strict environment settings", () => {
    expect(resolveClientId("../../agent other")).toBe("../../agent other");
    for (const id of ["", "a\n", "a".repeat(129)]) expect(() => resolveClientId(id)).toThrow();
    vi.stubEnv("MC_AGENT_STRICT_CONTEXT", "sometimes");
    expect(() => resolveStrictContext()).toThrow();
  });

  it("switches runtimes only on an explicit ready observation and reports the reset", async () => {
    await observe();
    const newContext = encodeActionContext("00000000-0000-4000-8000-000000000002", 1);
    const command = cli({ observeFrame: vi.fn(async () => ready(newContext)) });
    await command.run("observe", "frame");
    expect(JSON.parse(command.stdout.text).data.contextReset).toEqual({ reason: "runtime_changed" });
    const lease = await acquireClientContext("agent-a", "default");
    expect(lease.context).toBe(newContext); await lease.release();
  });
});
