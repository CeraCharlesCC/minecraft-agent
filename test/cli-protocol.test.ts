import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli/program.js";
import type { CliHandlers } from "../src/cli/handlers.js";
import { encodeActionContext } from "../src/core/context.js";
import { getSkillContent } from "../src/core/skills.js";
import { sessionNotFound } from "../src/output/errors.js";

class MemoryStream extends Writable {
  value = "";

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString();
    callback();
  }
}

function createMockHandlers(): CliHandlers {
  const target: Record<string, unknown> = {};

  return new Proxy(target, {
    get(object, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      object[property] ??= vi.fn(async () => ({}));
      return object[property];
    },
    getOwnPropertyDescriptor(object, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      object[property] ??= vi.fn(async () => ({}));
      return {
        configurable: true,
        enumerable: true,
        value: object[property],
        writable: true,
      };
    },
    has(_object, property) {
      return typeof property === "string";
    },
  }) as unknown as CliHandlers;
}

function makeProgram(version = "0.0.0") {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const handlers = createMockHandlers();
  const program = buildProgram(handlers, { stdout, stderr, isStdoutTty: false }, version);
  program.exitOverride();
  return { program, handlers, stdout, stderr };
}

describe("CLI protocol", () => {

  it("decodes observation context and waits only for the returned action identity", async () => {
    const { program, handlers, stdout } = makeProgram();
    const context = encodeActionContext("r7", 2);
    vi.mocked(handlers.navigateFollow).mockResolvedValue({ action: "r7:a9", state: "running" });
    vi.mocked(handlers.actionWait!).mockResolvedValue({ action: "r7:a9", state: "running", timedOut: true });
    await program.parseAsync(["node", "mc-agent", "navigate", "follow", "--track", "r7:p1", "--context", context, "--wait", "75"]);
    expect(handlers.navigateFollow).toHaveBeenCalledWith({ session: "default", context, runtimeId: "r7", worldEpoch: 2, track: "r7:p1", range: 2 });
    expect(handlers.actionWait).toHaveBeenCalledWith({ session: "default", action: "r7:a9", timeout: 75 });
    expect(JSON.parse(stdout.value)).toEqual({ ok: true, data: { action: "r7:a9", state: "running", timedOut: true } });
    expect(handlers.actionCancel).not.toHaveBeenCalled();
  });

  it.each([
    { state: "completed", result: { block: "minecraft:stone", drops: 1 } },
    { state: "failed", reason: "FAILED", error: { code: "NAVIGATION_FAILED", message: "Goal is unreachable", details: { target: [1, 2, 3] } } },
  ])("preserves terminal action %s details from bounded waits", async terminal => {
    const { program, handlers, stdout } = makeProgram();
    const completed = { action: "r7:a9", runtimeId: "r7", worldEpoch: 2, kind: "world.dig", startedAt: "start", finishedAt: "finish", timedOut: false, ...terminal };
    vi.mocked(handlers.worldDig).mockResolvedValue({ action: "r7:a9", state: "running" });
    vi.mocked(handlers.actionWait!).mockResolvedValue(completed);
    await program.parseAsync(["node", "mc-agent", "world", "dig", "--x", "1", "--y", "2", "--z", "3", "--context", encodeActionContext("r7", 2), "--wait", "150"]);
    expect(handlers.actionWait).toHaveBeenCalledWith({ session: "default", action: "r7:a9", timeout: 150 });
    expect(JSON.parse(stdout.value)).toEqual({ ok: true, data: completed });
    expect(handlers.actionCancel).not.toHaveBeenCalled();
  });

  it("uses the default bounded wait and supports context on cancellation", async () => {
    const { program, handlers } = makeProgram();
    const context = encodeActionContext("r7", 2);
    vi.mocked(handlers.actionCancel!).mockResolvedValue({ action: "r7:a1", state: "cancelled" });
    await program.parseAsync(["node", "mc-agent", "action", "cancel", "--action", "r7:a1", "--context", context, "--runtime", "r7", "--world-epoch", "2", "--wait"]);
    expect(handlers.actionCancel).toHaveBeenCalledWith({ session: "default", context, runtimeId: "r7", worldEpoch: 2, action: "r7:a1" });
    expect(handlers.actionWait).toHaveBeenCalledWith({ session: "default", action: "r7:a1", timeout: 5000 });
  });

  it.each([
    ["world", "wake"],
    ["world", "wake", "--runtime", "r7"],
    ["world", "wake", "--context", "latest"],
    ["world", "wake", "--context", encodeActionContext("r7", 2), "--runtime", "r8"],
    ["world", "wake", "--context", encodeActionContext("r7", 2), "--world-epoch", "3"],
    ["world", "wake", "--context", encodeActionContext("r7", 2), "--wait", "30001"],
    ["action", "wait", "--action", "r7:a1", "--timeout", "-1"],
    ["entity", "find", "--type", "mob", "--types", "minecraft:cow"],
    ["entity", "find", "--types", "cow"],
    ["observe", "events", "--profile", "future"],
    ["observe", "watch", "--track", "r7:p1", "--profile", "agent"],
    ["observe", "frame", "--detail", "raw"],
    ["session", "ensure-ready", "--max-attempts", "0"],
  ])("rejects invalid context and new protocol inputs %j", async (...args) => {
    const { program } = makeProgram();
    await expect(program.parseAsync(["node", "mc-agent", ...args])).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("parses full frames, inclusive species search, agent profiles, recovery and action waiting", async () => {
    const { program, handlers } = makeProgram();
    await program.parseAsync(["node", "mc-agent", "observe", "frame", "--detail", "full", "--max-entities", "0"]);
    expect(handlers.observeFrame).toHaveBeenCalledWith({ session: "default", detail: "full", maxEntities: 0, radius: 64, tracks: [] });
    await program.parseAsync(["node", "mc-agent", "entity", "find", "--types", "minecraft:player,minecraft:cow", "--types", "minecraft:sheep"]);
    expect(handlers.entityFind).toHaveBeenCalledWith({ session: "default", types: ["minecraft:player", "minecraft:cow", "minecraft:sheep"], radius: 32, limit: 50, includePlayers: true, includePassive: true });
    await program.parseAsync(["node", "mc-agent", "observe", "events", "--profile", "agent"]);
    expect(handlers.observeEvents).toHaveBeenCalledWith({ session: "default", profile: "agent", since: 0, limit: 50, types: [] });
    await program.parseAsync(["node", "mc-agent", "session", "diagnose"]);
    expect(handlers.sessionDiagnose).toHaveBeenCalledWith({ session: "default" });
    await program.parseAsync(["node", "mc-agent", "session", "ensure-ready"]);
    expect(handlers.sessionEnsureReady).toHaveBeenCalledWith({ session: "default", timeout: 10000, maxAttempts: 3, backoff: 250 });
    await program.parseAsync(["node", "mc-agent", "action", "wait", "--action", "r7:a1"]);
    expect(handlers.actionWait).toHaveBeenCalledWith({ session: "default", action: "r7:a1", timeout: 5000 });
  });

  it("parses frame projection, scoped deltas, tracked actions, and sample rates", async () => {
    const { program, handlers } = makeProgram();
    await program.parseAsync(["node", "mc-agent", "observe", "frame", "--since", "r7:f2", "--track", "r7:p1,r7:e2", "--track", "r7:e3", "--max-entities", "100", "--radius", "40"]);
    expect(handlers.observeFrame).toHaveBeenCalledWith({ session: "default", since: "r7:f2", detail: "compact", maxEntities: 100, radius: 40, tracks: ["r7:p1", "r7:e2", "r7:e3"] });
    await program.parseAsync(["node", "mc-agent", "observe", "watch", "--track", "r7:p1", "--fields", "position,velocity", "--rate", "3"]);
    expect(handlers.observeWatch).toHaveBeenCalledWith({ session: "default", since: 0, profile: "all", types: [], track: "r7:p1", fields: ["position", "velocity"], rate: 3 });
    await program.parseAsync(["node", "mc-agent", "look", "track", "--track", "r7:p1", "--runtime", "r7", "--world-epoch", "2"]);
    expect(handlers.lookTrack).toHaveBeenCalledWith({ session: "default", track: "r7:p1", runtimeId: "r7", worldEpoch: 2 });
    await program.parseAsync(["node", "mc-agent", "action", "status", "--action", "r7:a1"]);
    expect(handlers.actionStatus).toHaveBeenCalledWith({ session: "default", action: "r7:a1" });
    await program.parseAsync(["node", "mc-agent", "action", "cancel", "--action", "r7:a1", "--runtime", "r7", "--world-epoch", "2"]);
    expect(handlers.actionCancel).toHaveBeenCalledWith({ session: "default", action: "r7:a1", runtimeId: "r7", worldEpoch: 2 });
  });

  it.each([
    ["observe", "events", "--since", "42"],
    ["control", "set", "--state", "forward", "--runtime", "r7", "--world-epoch", "-1"],
    ["navigate", "configure", "--runtime", "r7", "--world-epoch", "-1"],
    ["observe", "frame", "--max-entities", "201"],
    ["observe", "watch", "--track", "r7:p1", "--rate", "11"],
    ["observe", "watch", "--rate", "2"],
    ["observe", "watch", "--track", "r7:p1", "--fields", "raw"],
    ["observe", "watch", "--track", "r7:p1", "--since", "r7:s3"],
  ])("rejects unsafe observation inputs %j", async (...args) => {
    const { program } = makeProgram();
    await expect(program.parseAsync(["node", "mc-agent", ...args])).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("forwards observation context on ordinary coordinate actions", async () => {
    const { program, handlers } = makeProgram();
    await program.parseAsync(["node", "mc-agent", "world", "dig", "--x", "1", "--y", "2", "--z", "3", "--runtime", "r7", "--world-epoch", "4"]);
    expect(handlers.worldDig).toHaveBeenCalledWith({ session: "default", x: 1, y: 2, z: 3, runtimeId: "r7", worldEpoch: 4 });
  });

  it("parses session start defaults and writes JSON success", async () => {
    const { program, handlers, stdout } = makeProgram();
    vi.spyOn(handlers, "startSession").mockResolvedValue({ session: "default" });

    await program.parseAsync(["node", "mc-agent", "session", "start"]);

    expect(handlers.startSession).toHaveBeenCalledWith({
      session: "default",
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
    });
    expect(JSON.parse(stdout.value)).toEqual({ ok: true, data: { session: "default" } });
  });

  it.each([
    ["--minecraft-version", "1.21.1"],
    ["--minecraft-version=1.21.1"],
  ])("forwards Minecraft protocol version from session start %j", async (...args) => {
    const { program, handlers, stdout } = makeProgram("9.8.7");
    vi.mocked(handlers.startSession).mockResolvedValue({ session: "default" });

    await program.parseAsync(["node", "mc-agent", "session", "start", ...args]);

    expect(handlers.startSession).toHaveBeenCalledExactlyOnceWith({
      session: "default", host: "localhost", port: 25565, username: "AgentBot", auth: "offline", version: "1.21.1",
    });
    expect(handlers.daemonRun).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.value)).toEqual({ ok: true, data: { session: "default" } });
  });

  it.each([
    ["--minecraft-version", "1.21.1"],
    ["--minecraft-version=1.21.1"],
  ])("forwards Minecraft protocol version from internal daemon run %j", async (...args) => {
    const { program, handlers, stdout } = makeProgram("9.8.7");

    await program.parseAsync(["node", "mc-agent", "daemon", "run", "--control-port", "4567", ...args]);

    expect(handlers.daemonRun).toHaveBeenCalledExactlyOnceWith({
      session: "default", host: "localhost", port: 25565, username: "AgentBot", auth: "offline", controlPort: 4567, version: "1.21.1",
    });
    expect(JSON.parse(stdout.value)).toEqual({ ok: true, data: {} });
  });

  it.each(["--version", "-V"])("prints the package version for root %s", async flag => {
    const { program, handlers, stdout } = makeProgram("9.8.7");
    program.configureOutput({ writeOut: output => stdout.write(output) });

    await expect(program.parseAsync(["node", "mc-agent", flag])).rejects.toMatchObject({ code: "commander.version", exitCode: 0 });

    expect(stdout.value).toBe("9.8.7\n");
    expect(handlers.startSession).not.toHaveBeenCalled();
    expect(handlers.daemonRun).not.toHaveBeenCalled();
  });

  it("defaults compact frames to 12 projected entities", async () => {
    const { program, handlers } = makeProgram();

    await program.parseAsync(["node", "mc-agent", "observe", "frame"]);

    expect(handlers.observeFrame).toHaveBeenCalledExactlyOnceWith({
      session: "default", detail: "compact", maxEntities: 12, radius: 64, tracks: [],
    });
  });

  it("uses default text formatter fallback for start sessions without names", async () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const handlers = createMockHandlers();
    const program = buildProgram(handlers, { stdout, stderr, isStdoutTty: true });
    program.exitOverride();
    vi.spyOn(handlers, "startSession").mockResolvedValue({});

    await program.parseAsync(["node", "mc-agent", "session", "start"]);

    expect(stdout.value).toBe("Started session default\n");
  });

  it("uses the provided CLI version", () => {
    const { program } = makeProgram("9.8.7");

    expect(program.version()).toBe("9.8.7");
  });

  it("blocks slash commands unless explicitly allowed", async () => {
    const { program, stdout } = makeProgram();

    await expect(program.parseAsync(["node", "mc-agent", "chat", "send", "--message", "/op me"])).rejects.toMatchObject({
      code: "COMMAND_BLOCKED",
      exitCode: 3,
    });

    expect(JSON.parse(stdout.value)).toEqual({
      ok: false,
      error: {
        code: "COMMAND_BLOCKED",
        message: "Refusing to send a server command as chat.",
        remediation: "Pass --allow-command if this command is intentional.",
      },
    });
  });

  it("exposes all planned top-level command groups", () => {
    const { program } = makeProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(["session", "observe", "chat", "bot", "control", "look", "navigate", "collect", "inventory", "world", "window", "entity", "action", "debug", "skills", "daemon"]);
  });

  it("prints bundled skill content directly", async () => {
    const { program, stdout } = makeProgram();

    await program.parseAsync(["node", "mc-agent", "skills", "get", "core"]);

    expect(stdout.value).toBe(`${getSkillContent("core", false)}\n`);
  });

  it("writes structured errors for streaming and raw-output commands", async () => {
    const watch = makeProgram();
    vi.spyOn(watch.handlers, "observeWatch").mockRejectedValue(sessionNotFound("missing"));

    await expect(
      watch.program.parseAsync(["node", "mc-agent", "--output", "json", "observe", "watch", "--session", "missing"]),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", exitCode: 4 });
    expect(JSON.parse(watch.stdout.value)).toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_FOUND", remediation: expect.stringContaining("session start") },
    });

    const skill = makeProgram();
    await expect(skill.program.parseAsync(["node", "mc-agent", "--output", "json", "skills", "get", "missing"])).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
    });
    expect(JSON.parse(skill.stdout.value)).toMatchObject({ ok: false, error: { code: "UNKNOWN_ERROR" } });
  });

  it("writes invalid output mode errors instead of failing silently", async () => {
    const { program, stderr } = makeProgram();

    await expect(program.parseAsync(["node", "mc-agent", "--output", "yaml", "session", "status"])).rejects.toMatchObject({
      code: "BAD_INPUT",
      exitCode: 3,
    });
    expect(stderr.value).toContain("BAD_INPUT: Invalid output mode.");
    expect(stderr.value).toContain("Use --output json or --output text.");
  });

  it("maps negated navigation configuration flags", async () => {
    const { program, handlers } = makeProgram();
    vi.spyOn(handlers, "navigateConfigure").mockResolvedValue({});

    await program.parseAsync([
      "node",
      "mc-agent",
      "navigate",
      "configure",
      "--session",
      "s",
      "--no-dig",
      "--no-sprinting",
      "--no-parkour",
      "--can-open-doors",
      "--max-drop-down",
      "8",
      "--search-radius",
      "64", "--runtime", "r7", "--world-epoch", "1"]);

    expect(handlers.navigateConfigure).toHaveBeenCalledWith({
      session: "s", runtimeId: "r7", worldEpoch: 1,
      allowPlace: undefined,
      allowDig: false,
      allowSprinting: false,
      allowParkour: false,
      canOpenDoors: true,
      maxDropDown: 8,
      searchRadius: 64,
      thinkTimeout: undefined,
      tickTimeout: undefined,
    });
  });

  it("routes every command action through the correct handler", async () => {
    const { program, handlers } = makeProgram();
    vi.spyOn(handlers, "sessionStatus").mockResolvedValue({});
    vi.spyOn(handlers, "listSessions").mockResolvedValue({});
    vi.spyOn(handlers, "stopSession").mockResolvedValue({});
    vi.spyOn(handlers, "observeEvents").mockResolvedValue({});
    vi.spyOn(handlers, "observeWatch").mockResolvedValue(undefined);
    vi.spyOn(handlers, "sendChat").mockResolvedValue({});
    vi.spyOn(handlers, "botPosition").mockResolvedValue({});
    vi.spyOn(handlers, "botInventory").mockResolvedValue({});
    vi.spyOn(handlers, "botPlayers").mockResolvedValue({});
    vi.spyOn(handlers, "botEntities").mockResolvedValue({});
    vi.spyOn(handlers, "controlTap").mockResolvedValue({});
    vi.spyOn(handlers, "lookAt").mockResolvedValue({});
    vi.spyOn(handlers, "worldBlock").mockResolvedValue({});
    vi.spyOn(handlers, "worldFindBlocks").mockResolvedValue({});
    vi.spyOn(handlers, "navigateGoto").mockResolvedValue({});
    vi.spyOn(handlers, "navigateFollow").mockResolvedValue({});
    vi.spyOn(handlers, "navigateStop").mockResolvedValue({});
    vi.spyOn(handlers, "navigateStatus").mockResolvedValue({});
    vi.spyOn(handlers, "inventoryEquip").mockResolvedValue({});
    vi.spyOn(handlers, "worldDig").mockResolvedValue({});
    vi.spyOn(handlers, "worldPlace").mockResolvedValue({});
    vi.spyOn(handlers, "worldActivate").mockResolvedValue({});
    vi.spyOn(handlers, "windowClick").mockResolvedValue({});
    vi.spyOn(handlers, "daemonRun").mockResolvedValue({});

    await program.parseAsync(["node", "mc-agent", "session", "status", "--session", "s"]);
    await program.parseAsync(["node", "mc-agent", "session", "list"]);
    await program.parseAsync(["node", "mc-agent", "session", "stop", "--session", "s"]);
    await program.parseAsync(["node", "mc-agent", "observe", "events", "--session", "s", "--since", "r7:s2", "--limit", "3"]);
    await program.parseAsync(["node", "mc-agent", "observe", "watch", "--session", "s", "--since", "r7:s4"]);
    await program.parseAsync(["node", "mc-agent", "chat", "send", "--session", "s", "--message", "/say hi", "--allow-command"]);
    await program.parseAsync(["node", "mc-agent", "bot", "position", "--session", "s"]);
    await program.parseAsync(["node", "mc-agent", "bot", "inventory", "--session", "s"]);
    await program.parseAsync(["node", "mc-agent", "bot", "players", "--session", "s"]);
    await program.parseAsync(["node", "mc-agent", "bot", "entities", "--session", "s", "--radius", "16", "--limit", "4"]);
    await program.parseAsync(["node", "mc-agent", "control", "tap", "--session", "s", "--state", "jump", "--duration-ms", "25", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "look", "at", "--session", "s", "--x", "1", "--y", "2", "--z", "3", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "world", "block", "--session", "s", "--x", "4", "--y", "5", "--z", "6"]);
    await program.parseAsync(["node", "mc-agent", "world", "find-blocks", "--session", "s", "--name", "farmland", "--radius", "12", "--count", "3"]);
    await program.parseAsync(["node", "mc-agent", "navigate", "goto", "--session", "s", "--x", "7", "--y", "8", "--z", "9", "--range", "2", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "navigate", "follow", "--session", "s", "--track", "r7:p1", "--range", "3", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "navigate", "stop", "--session", "s", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "navigate", "status", "--session", "s"]);
    await program.parseAsync(["node", "mc-agent", "inventory", "equip", "--session", "s", "--item", "dirt", "--destination", "hand", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "world", "dig", "--session", "s", "--x", "10", "--y", "11", "--z", "12", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync([
      "node",
      "mc-agent",
      "world",
      "place",
      "--session",
      "s",
      "--x",
      "13",
      "--y",
      "14",
      "--z",
      "15",
      "--face",
      "east",
      "--item",
      "dirt", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "world", "activate", "--session", "s", "--x", "16", "--y", "17", "--z", "18", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "window", "click", "--session", "s", "--slot", "5", "--mouse-button", "1", "--mode", "0", "--runtime", "r7", "--world-epoch", "1"]);
    await program.parseAsync(["node", "mc-agent", "daemon", "run", "--control-port", "4567"]);

    expect(handlers.sessionStatus).toHaveBeenCalledWith({ session: "s" });
    expect(handlers.listSessions).toHaveBeenCalledWith();
    expect(handlers.stopSession).toHaveBeenCalledWith({ session: "s" });
    expect(handlers.observeEvents).toHaveBeenCalledWith({ session: "s", since: "r7:s2", profile: "all", limit: 3, types: [] });
    expect(handlers.observeWatch).toHaveBeenCalledWith({ session: "s", since: "r7:s4", profile: "all", types: [] });
    expect(handlers.sendChat).toHaveBeenCalledWith({ session: "s", message: "/say hi", allowCommand: true });
    expect(handlers.botPosition).toHaveBeenCalledWith({ session: "s" });
    expect(handlers.botInventory).toHaveBeenCalledWith({ session: "s" });
    expect(handlers.botPlayers).toHaveBeenCalledWith({ session: "s" });
    expect(handlers.botEntities).toHaveBeenCalledWith({ session: "s", radius: 16, limit: 4 });
    expect(handlers.controlTap).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, state: "jump", durationMs: 25 });
    expect(handlers.lookAt).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, x: 1, y: 2, z: 3 });
    expect(handlers.worldBlock).toHaveBeenCalledWith({ session: "s", x: 4, y: 5, z: 6 });
    expect(handlers.worldFindBlocks).toHaveBeenCalledWith({ session: "s", name: "farmland", radius: 12, count: 3 });
    expect(handlers.navigateGoto).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, x: 7, y: 8, z: 9, range: 2 });
    expect(handlers.navigateFollow).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, track: "r7:p1", range: 3 });
    expect(handlers.navigateStop).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1 });
    expect(handlers.navigateStatus).toHaveBeenCalledWith({ session: "s" });
    expect(handlers.inventoryEquip).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, item: "dirt", destination: "hand" });
    expect(handlers.worldDig).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, x: 10, y: 11, z: 12 });
    expect(handlers.worldPlace).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, x: 13, y: 14, z: 15, face: "east", item: "dirt" });
    expect(handlers.worldActivate).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, x: 16, y: 17, z: 18 });
    expect(handlers.windowClick).toHaveBeenCalledWith({ session: "s", runtimeId: "r7", worldEpoch: 1, slot: 5, mouseButton: 1, mode: 0 });
    expect(handlers.daemonRun).toHaveBeenCalledWith({
      session: "default",
      host: "localhost",
      port: 25565,
      username: "AgentBot",
      auth: "offline",
      controlPort: 4567,
    });
  });

  it("parses observe event type filters", async () => {
    const { program, handlers } = makeProgram();
    vi.spyOn(handlers, "observeEvents").mockResolvedValue({});
    vi.spyOn(handlers, "observeWatch").mockResolvedValue(undefined);

    await program.parseAsync([
      "node",
      "mc-agent",
      "observe",
      "events",
      "--type",
      "chat.player,chat.whisper",
      "--type",
      "server.message",
    ]);
    await program.parseAsync(["node", "mc-agent", "observe", "watch", "--type", "chat.player"]);

    expect(handlers.observeEvents).toHaveBeenCalledWith({
      session: "default",
      since: 0,
      limit: 50,
      profile: "all",
      types: ["chat.player", "chat.whisper", "server.message"],
    });
    expect(handlers.observeWatch).toHaveBeenCalledWith({
      session: "default",
      since: 0,
      profile: "all",
      types: ["chat.player"],
    });
  });

  it("writes text output and text errors for tty-style commands", async () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const handlers = createMockHandlers();
    const program = buildProgram(handlers, { stdout, stderr, isStdoutTty: true });
    program.exitOverride();
    vi.spyOn(handlers, "startSession").mockResolvedValue({ session: "named" });
    vi.spyOn(handlers, "sessionStatus").mockRejectedValue(new Error("plain failure"));

    await program.parseAsync(["node", "mc-agent", "session", "start"]);
    await expect(program.parseAsync(["node", "mc-agent", "session", "status"])).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
    });

    expect(stdout.value).toContain("Started session named");
    expect(stderr.value).toContain("UNKNOWN_ERROR: plain failure");
  });
});
