import { describe, expect, it, vi, afterEach } from "vitest";
import { CliError } from "../src/output/errors.js";

function startInput() {
  return {
    session: "default",
    host: "localhost",
    port: 25565,
    username: "AgentBot",
    auth: "offline",
  };
}

async function loadActionsWithMocks() {
  vi.resetModules();
  const store = await vi.importActual<typeof import("../src/session/store.js")>("../src/session/store.js");
  const record = { ...startInput(), pid: process.pid, controlPort: 3000, token: "private-token", startedAt: "2026-10-04T00:00:00Z" };
  const mocks = {
    isProcessAlive: vi.fn().mockReturnValue(false),
    daemonRequest: vi.fn(),
    loadSessionForClient: vi.fn().mockResolvedValue(record),
    runDaemon: vi.fn(),
    spawnSessionDaemon: vi.fn(),
    listSessions: vi.fn(),
    readSession: vi.fn(),
    removeSession: vi.fn(),
    toPublicSession: vi.fn(store.toPublicSession),
  };

  vi.doMock("../src/daemon/client.js", async () => ({
    ...await vi.importActual("../src/daemon/client.js"),
    daemonRequest: mocks.daemonRequest,
    loadSessionForClient: mocks.loadSessionForClient,
  }));
  vi.doMock("../src/daemon/server.js", () => ({ runDaemon: mocks.runDaemon }));
  vi.doMock("../src/daemon/spawn.js", () => ({ spawnSessionDaemon: mocks.spawnSessionDaemon }));
  vi.doMock("../src/session/store.js", () => ({
    isProcessAlive: mocks.isProcessAlive,
    listSessions: mocks.listSessions,
    readSession: mocks.readSession,
    removeSession: mocks.removeSession,
    toPublicSession: mocks.toPublicSession,
  }));

  const { createCliHandlers } = await import("../src/cli/actions.js");
  return { handlers: createCliHandlers("entry.js"), mocks };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.MC_AGENT_CONTROL_TOKEN;
});

describe("CLI actions", () => {

  it("waits for the original daemon process even when its session record disappears", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    vi.useFakeTimers();
    const original = { session: "default", pid: 123, token: "original", controlPort: 3000 };
    mocks.loadSessionForClient.mockResolvedValue(original);
    mocks.daemonRequest.mockResolvedValue({ stopping: true, runtimeId: "r7", pid: 123 });
    mocks.readSession.mockResolvedValue(undefined);
    mocks.isProcessAlive.mockReturnValue(true);
    const pending = handlers.stopSession({ session: "default" });
    await vi.advanceTimersByTimeAsync(5100);
    await expect(pending).resolves.toMatchObject({ session: "default", stopping: true, stopped: false, timedOut: true });
    expect(mocks.isProcessAlive).toHaveBeenCalledWith(123);
    expect(mocks.removeSession).not.toHaveBeenCalled();
    mocks.isProcessAlive.mockReturnValueOnce(true).mockReturnValue(false);
    const completed = handlers.stopSession({ session: "default" });
    await vi.advanceTimersByTimeAsync(100);
    await expect(completed).resolves.toMatchObject({ session: "default", stopped: true, timedOut: false });
  });

  it("forwards recovery, compact frame, canonical species, profile, and action wait requests", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const record = { session: "default", token: "token", controlPort: 3000 };
    mocks.loadSessionForClient.mockResolvedValue(record);
    await handlers.sessionDiagnose!({ session: "default" });
    expect(mocks.daemonRequest).toHaveBeenLastCalledWith(record, "/diagnose");
    await handlers.sessionEnsureReady!({ session: "default", timeout: 1000, maxAttempts: 2, backoff: 50 });
    expect(mocks.daemonRequest).toHaveBeenLastCalledWith(record, "/ensure-ready", { method: "POST", body: '{"timeout":1000,"maxAttempts":2,"backoff":50}', signal: expect.any(AbortSignal) });
    await handlers.observeFrame!({ session: "default", detail: "full", maxEntities: 0, radius: 64, tracks: [] });
    expect(mocks.daemonRequest).toHaveBeenLastCalledWith(record, "/frame?maxEntities=0&radius=64&detail=full");
    await handlers.entityFind({ session: "default", types: ["minecraft:player", "minecraft:cow"], radius: 32, limit: 50, includePlayers: true, includePassive: true });
    expect(mocks.daemonRequest).toHaveBeenLastCalledWith(record, "/entity/find?radius=32&limit=50&includePlayers=true&includePassive=true&types=minecraft%3Aplayer&types=minecraft%3Acow");
    await handlers.observeEvents({ session: "default", since: 0, limit: 50, profile: "agent", types: ["chat.player"] });
    expect(mocks.daemonRequest).toHaveBeenLastCalledWith(record, "/events?since=0&limit=50&profile=agent&type=chat.player");
    await handlers.actionWait!({ session: "default", action: "r7:a9", timeout: 100 });
    expect(mocks.daemonRequest).toHaveBeenLastCalledWith(record, "/actions/r7%3Aa9/wait?timeout=100", { signal: expect.any(AbortSignal) });
  });

  it("routes scoped frame/action/debug requests and carries context on physical actions", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const record = { session: "default", token: "token", controlPort: 3000 };
    mocks.loadSessionForClient.mockResolvedValue(record);
    await handlers.observeFrame!({ session: "default", since: "r7:f2", maxEntities: 50, radius: 64, tracks: ["r7:p1", "r7:e2"] });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/frame?maxEntities=50&radius=64&since=r7%3Af2&track=r7%3Ap1&track=r7%3Ae2");
    await handlers.debugEvents!({ session: "default", id: "r7:m1" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/debug/events?id=r7%3Am1");
    await handlers.actionStatus!({ session: "default", action: "r7:a1" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/actions/r7%3Aa1");
    const context = { session: "default", runtimeId: "r7", worldEpoch: 2 };
    await handlers.actionCancel!({ ...context, action: "r7:a1" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/actions/r7%3Aa1/cancel", { method: "POST", body: JSON.stringify({ runtimeId: "r7", worldEpoch: 2 }) });
    await handlers.lookTrack!({ ...context, track: "r7:p1" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/look/track", { method: "POST", body: JSON.stringify({ runtimeId: "r7", worldEpoch: 2, track: "r7:p1" }) });
    await handlers.worldDig({ ...context, x: 1, y: 2, z: 3 });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/dig", { method: "POST", body: JSON.stringify({ runtimeId: "r7", worldEpoch: 2, x: 1, y: 2, z: 3 }) });
  });

  it("samples tracks separately and preserves typed stream startup errors", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    mocks.loadSessionForClient.mockResolvedValue({ token: "secret", controlPort: 3000 });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{\"trackId\":\"r7:p1\"}\n", { headers: { "X-MC-Agent-API": "3.1" } })));
    await handlers.observeWatch({ session: "default", since: 0, types: [], track: "r7:p1", fields: ["position", "velocity"], rate: 3 });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:3000/sample?track=r7%3Ap1&fields=position%2Cvelocity&rate=3", { signal: expect.any(AbortSignal), headers: { Authorization: "Bearer secret", "Content-Type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "RUNTIME_MISMATCH", error: "Old cursor", remediation: "Observe again", details: { runtimeId: "r8" } }), { status: 409, headers: { "X-MC-Agent-API": "3.1" } })));
    await expect(handlers.observeWatch({ session: "default", since: "r7:s2", types: [] })).rejects.toMatchObject({ code: "RUNTIME_MISMATCH", details: { runtimeId: "r8" } });
  });

  it("preserves the original stopping session until its daemon exits", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    mocks.readSession.mockResolvedValue({ session: "default", pid: 123, stopping: true });
    mocks.isProcessAlive.mockReturnValue(true);
    await expect(handlers.startSession(startInput())).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING", message: expect.stringContaining("still stopping") });
    expect(mocks.removeSession).not.toHaveBeenCalled();
    expect(mocks.spawnSessionDaemon).not.toHaveBeenCalled();
  });

  it("starts a session, probes readiness, and returns the observed game username", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const configured = { ...startInput(), username: "account@example.com", host: "private.example.net", pid: process.pid, controlPort: 45678, token: "private-control-token", startedAt: "2026-10-04T00:00:00Z" };
    mocks.readSession.mockResolvedValue(undefined);
    mocks.spawnSessionDaemon.mockResolvedValue(configured);
    mocks.loadSessionForClient.mockResolvedValue(configured);
    mocks.daemonRequest.mockResolvedValue({ ready: true, connection: { state: "ready", ready: true }, username: "InGameBot" });

    await expect(handlers.startSession(startInput())).resolves.toEqual({
      session: "default", alive: true, ready: true,
      connection: { state: "ready", ready: true }, username: "InGameBot",
    });
    expect(mocks.spawnSessionDaemon).toHaveBeenCalledWith(startInput(), "entry.js");
    expect(mocks.daemonRequest).toHaveBeenLastCalledWith(configured, "/status");
  });

  it.each(["compact", "full"] as const)("keeps configured account and secrets private in %s session status", async detail => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const configured = { ...startInput(), username: "account@example.com", host: "private.example.net", pid: process.pid, controlPort: 45678, token: "private-control-token", startedAt: "2026-10-04T00:00:00Z", runtimeId: "private-runtime" };
    mocks.loadSessionForClient.mockResolvedValue(configured);
    mocks.daemonRequest.mockResolvedValue({ ready: false, connection: { state: "connecting", ready: false } });

    const result = await handlers.sessionStatus({ session: "default", detail });
    expect(result).toMatchObject({ session: "default", alive: true, ready: false, connection: { state: "connecting", ready: false } });
    expect(result).not.toHaveProperty("username");
    expect(result).not.toHaveProperty("status");
    const json = JSON.stringify(result);
    for (const secret of [configured.username, configured.token, configured.runtimeId]) expect(json).not.toContain(secret);
    if (detail === "compact") {
      expect(result).toEqual({ session: "default", alive: true, ready: false, connection: { state: "connecting", ready: false } });
    } else {
      expect(result).toMatchObject({ host: configured.host, port: 25565, auth: "offline", pid: process.pid, controlPort: 45678 });
    }
    expect(mocks.daemonRequest).toHaveBeenLastCalledWith(configured, detail === "full" ? "/status?detail=full" : "/status");
  });

  it("rejects already-running sessions and removes records only after their process exits", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    mocks.readSession.mockResolvedValueOnce({ session: "default" });
    mocks.daemonRequest.mockResolvedValueOnce({ ready: true, connection: { state: "ready", ready: true } });

    await expect(handlers.startSession(startInput())).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });

    mocks.readSession.mockResolvedValueOnce({ session: "default", pid: 123 });
    mocks.daemonRequest.mockRejectedValueOnce(new Error("connection refused"));
    mocks.spawnSessionDaemon.mockResolvedValueOnce({ controlPort: 11111 });

    await handlers.startSession(startInput());
    expect(mocks.isProcessAlive).toHaveBeenCalledWith(123);
    expect(mocks.removeSession).toHaveBeenCalledWith("default");
    expect(mocks.spawnSessionDaemon).toHaveBeenCalled();
  });

  it.each([
    new Error("connection refused"),
    new DOMException("Status probe timed out", "TimeoutError"),
  ])("preserves unresolved live daemon records after a failed status probe", async error => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const original = { session: "default", pid: 123, token: "original", controlPort: 3000 };
    mocks.readSession.mockResolvedValue(original);
    mocks.daemonRequest.mockRejectedValue(error);
    mocks.isProcessAlive.mockReturnValue(true);
    await expect(handlers.startSession(startInput())).rejects.toMatchObject({ code: "DAEMON_ERROR", details: { session: "default", pid: 123 } });
    expect(mocks.isProcessAlive).toHaveBeenCalledWith(123);
    expect(mocks.removeSession).not.toHaveBeenCalled();
    expect(mocks.spawnSessionDaemon).not.toHaveBeenCalled();
  });

  it.each([null, "1", "2"])("preserves sessions when the client rejects API header %s", async actualApiVersion => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const record = { session: "default", token: "secret", controlPort: 3000 };
    mocks.readSession.mockResolvedValue(record);
    mocks.loadSessionForClient.mockResolvedValue(record);
    // Compatibility is checked at the HTTP boundary, never by a JSON body field.
    const { daemonIncompatible } = await import("../src/output/errors.js");
    mocks.daemonRequest.mockRejectedValue(daemonIncompatible("default", { actualApiVersion }));
    await expect(handlers.startSession(startInput())).rejects.toMatchObject({ code: "DAEMON_INCOMPATIBLE", details: { actualApiVersion } });
    expect(mocks.removeSession).not.toHaveBeenCalled();
    expect(mocks.spawnSessionDaemon).not.toHaveBeenCalled();
    await expect(handlers.sessionStatus({ session: "default" })).rejects.toMatchObject({ code: "DAEMON_INCOMPATIBLE" });
  });

  it("reports incompatible legacy watch routes", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    mocks.loadSessionForClient.mockResolvedValue({ controlPort: 3000, token: "secret" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "X-MC-Agent-API": "3.1" } })));
    await expect(handlers.observeWatch({ session: "default", since: 0, types: [], track: "r7:p1" })).rejects.toMatchObject({
      code: "DAEMON_INCOMPATIBLE", details: { path: "/sample" },
    });
  });

  it("maps session commands and bot actions to daemon endpoints", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const record = { session: "default", token: "token", controlPort: 3000 };
    mocks.loadSessionForClient.mockResolvedValue(record);
    mocks.daemonRequest.mockResolvedValue({ ok: true });
    mocks.toPublicSession.mockReturnValue({ session: "default", alive: true });

    await handlers.sessionStatus({ session: "default" });
    await handlers.stopSession({ session: "default" });
    await handlers.observeEvents({ session: "default", since: "r7:s3", limit: 10, types: [] });
    await handlers.sendChat({ session: "default", message: "hello", allowCommand: false });
    await handlers.sendWhisper({ session: "default", username: "Steve", message: "hi" });
    await handlers.tabComplete({ session: "default", text: "/gi", assumeCommand: true, sendBlockInSight: false, timeout: 1000 });
    await handlers.botPosition({ session: "default" });
    await handlers.botInventory({ session: "default" });
    await handlers.botPlayers({ session: "default" });
    await handlers.botEntities({ session: "default", radius: 16, limit: 5 });
    await handlers.botTablist({ session: "default" });
    await handlers.botScoreboards({ session: "default" });
    await handlers.botTeams({ session: "default" });
    await handlers.botControls({ session: "default" });
    await handlers.controlTap({ session: "default", state: "forward", durationMs: 500 });
    await handlers.controlSet({ session: "default", state: "sprint", value: true });
    await handlers.controlClear({ session: "default" });
    await handlers.lookAt({ session: "default", x: 1, y: 2, z: 3 });
    await handlers.look({ session: "default", yaw: 1, pitch: 0.5, force: true });
    await handlers.worldBlock({ session: "default", x: 4, y: 5, z: 6 });
    await handlers.worldBlockInfo({ session: "default", x: 4, y: 5, z: 6 });
    await handlers.worldBlockInSight({ session: "default", maxSteps: 256, vectorLength: 5 });
    await handlers.worldBlockAtCursor({ session: "default", maxDistance: 5 });
    await handlers.worldFindBlocks({ session: "default", name: "oak log", radius: 12, count: 2 });
    await handlers.navigateGoto({ session: "default", x: 7, y: 8, z: 9, range: 2 });
    await handlers.navigateFollow({ session: "default", track: "r7:p1", range: 3 });
    await handlers.navigateStop({ session: "default" });
    await handlers.navigateStatus({ session: "default" });
    await handlers.navigateConfigure({ session: "default", allowDig: false, searchRadius: 32 });
    await handlers.collectItem({ session: "default", track: "r7:e10", range: 1 });
    await handlers.inventoryEquip({ session: "default", item: "dirt", destination: "hand" });
    await handlers.inventoryUnequip({ session: "default", destination: "hand" });
    await handlers.inventoryQuickBar({ session: "default", slot: 2 });
    await handlers.inventoryToss({ session: "default", item: "dirt", count: 1 });
    await handlers.inventoryConsume({ session: "default" });
    await handlers.inventoryFish({ session: "default" });
    await handlers.inventoryActivateItem({ session: "default", offhand: false });
    await handlers.inventoryDeactivateItem({ session: "default" });
    await handlers.inventoryRecipes({ session: "default", item: "stick", count: 1 });
    await handlers.inventoryCraft({ session: "default", item: "stick", count: 1, tableX: 1, tableY: 2, tableZ: 3 });
    await handlers.worldDig({ session: "default", x: 10, y: 11, z: 12 });
    await handlers.worldStopDigging({ session: "default" });
    await handlers.worldPlace({ session: "default", x: 13, y: 14, z: 15, face: "up", item: "dirt" });
    await handlers.worldPlaceEntity({ session: "default", x: 13, y: 14, z: 15, face: "up", item: "oak_boat" });
    await handlers.worldActivate({ session: "default", x: 16, y: 17, z: 18 });
    await handlers.worldUpdateSign({ session: "default", x: 1, y: 2, z: 3, text: "hello", back: false });
    await handlers.worldSleep({ session: "default", x: 1, y: 2, z: 3 });
    await handlers.worldWake({ session: "default" });
    await handlers.worldElytraFly({ session: "default" });
    await handlers.windowOpenBlock({ session: "default", x: 1, y: 2, z: 3 });
    await handlers.windowOpenEntity({ session: "default", track: "r7:e10" });
    await handlers.windowStatus({ session: "default" });
    await handlers.windowDeposit({ session: "default", item: "dirt", count: 1 });
    await handlers.windowWithdraw({ session: "default", item: "dirt", count: 1 });
    await handlers.windowClick({ session: "default", slot: 5, mouseButton: 0, mode: 0 });
    await handlers.windowClose({ session: "default" });
    await handlers.entityFind({ session: "default", name: "zombie", radius: 16, limit: 5, includePlayers: false, includePassive: false });
    await handlers.entityActivate({ session: "default", track: "r7:e10" });
    await handlers.entityUseOn({ session: "default", track: "r7:e10" });
    await handlers.entityAttack({ session: "default", track: "r7:e10", allowPlayers: false, allowPassive: true });
    await handlers.entitySwingArm({ session: "default", hand: "right", showHand: true });
    await handlers.entityMount({ session: "default", track: "r7:e10" });
    await handlers.entityDismount({ session: "default" });
    await handlers.entityMoveVehicle({ session: "default", left: 0.5, forward: 1 });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/status");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/stop", { method: "POST", body: "{}", signal: expect.any(AbortSignal) });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/events?since=r7%3As3&limit=10");
    await handlers.observeEvents({ session: "default", since: "r7:s4", limit: 20, types: ["chat", "whisper"] });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/events?since=r7%3As4&limit=20&type=chat&type=whisper");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/chat", { method: "POST", body: JSON.stringify({ message: "hello", allowCommand: false }) });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/chat/whisper", { method: "POST", body: JSON.stringify({ username: "Steve", message: "hi" }) });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/chat/tab-complete", {
      method: "POST",
      body: JSON.stringify({ text: "/gi", assumeCommand: true, sendBlockInSight: false, timeout: 1000 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/bot/position");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/bot/inventory");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/bot/players");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/bot/entities?radius=16&limit=5");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/bot/tablist");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/bot/scoreboards");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/bot/teams");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/bot/controls");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/control/tap", {
      method: "POST",
      body: JSON.stringify({ state: "forward", durationMs: 500 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/control/set", {
      method: "POST",
      body: JSON.stringify({ state: "sprint", value: true }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/control/clear", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/look/at", {
      method: "POST",
      body: JSON.stringify({ x: 1, y: 2, z: 3 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/look/yaw-pitch", {
      method: "POST",
      body: JSON.stringify({ yaw: 1, pitch: 0.5, force: true }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/block?x=4&y=5&z=6");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/block-info?x=4&y=5&z=6");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/block-in-sight?maxSteps=256&vectorLength=5");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/block-at-cursor?maxDistance=5");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/find-blocks?name=oak%20log&radius=12&count=2");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/navigate/goto", {
      method: "POST",
      body: JSON.stringify({ x: 7, y: 8, z: 9, range: 2 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/navigate/follow", {
      method: "POST",
      body: JSON.stringify({ track: "r7:p1", range: 3 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/navigate/stop", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/navigate/status");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/navigate/configure", {
      method: "POST",
      body: JSON.stringify({
        allowDig: false,
        allowSprinting: undefined,
        allowParkour: undefined,
        canOpenDoors: undefined,
        maxDropDown: undefined,
        searchRadius: 32,
        thinkTimeout: undefined,
        tickTimeout: undefined,
      }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/collect/item", {
      method: "POST",
      body: JSON.stringify({ track: "r7:e10", range: 1 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/equip", {
      method: "POST",
      body: JSON.stringify({ item: "dirt", destination: "hand" }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/unequip", {
      method: "POST",
      body: JSON.stringify({ destination: "hand" }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/quickbar", {
      method: "POST",
      body: JSON.stringify({ slot: 2 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/toss", {
      method: "POST",
      body: JSON.stringify({ item: "dirt", count: 1 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/consume", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/fish", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/activate-item", {
      method: "POST",
      body: JSON.stringify({ offhand: false }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/deactivate-item", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/recipes?item=stick&count=1");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/inventory/craft", {
      method: "POST",
      body: JSON.stringify({ item: "stick", count: 1, table: { x: 1, y: 2, z: 3 } }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/dig", {
      method: "POST",
      body: JSON.stringify({ x: 10, y: 11, z: 12 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/stop-digging", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/place", {
      method: "POST",
      body: JSON.stringify({ x: 13, y: 14, z: 15, face: "up", item: "dirt" }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/place-entity", {
      method: "POST",
      body: JSON.stringify({ x: 13, y: 14, z: 15, face: "up", item: "oak_boat" }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/activate", {
      method: "POST",
      body: JSON.stringify({ x: 16, y: 17, z: 18 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/update-sign", {
      method: "POST",
      body: JSON.stringify({ x: 1, y: 2, z: 3, text: "hello", back: false }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/sleep", {
      method: "POST",
      body: JSON.stringify({ x: 1, y: 2, z: 3 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/wake", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/world/elytra-fly", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/window/open-block", {
      method: "POST",
      body: JSON.stringify({ x: 1, y: 2, z: 3 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/window/open-entity", {
      method: "POST",
      body: JSON.stringify({ track: "r7:e10" }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/window/status");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/window/deposit", {
      method: "POST",
      body: JSON.stringify({ item: "dirt", count: 1 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/window/withdraw", {
      method: "POST",
      body: JSON.stringify({ item: "dirt", count: 1 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/window/click", {
      method: "POST",
      body: JSON.stringify({ slot: 5, mouseButton: 0, mode: 0 }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/window/close", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/entity/find?radius=16&limit=5&includePlayers=false&includePassive=false&name=zombie");
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/entity/activate", { method: "POST", body: JSON.stringify({ track: "r7:e10" }) });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/entity/use-on", { method: "POST", body: JSON.stringify({ track: "r7:e10" }) });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/entity/attack", {
      method: "POST",
      body: JSON.stringify({ track: "r7:e10", allowPlayers: false, allowPassive: true }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/entity/swing-arm", {
      method: "POST",
      body: JSON.stringify({ hand: "right", showHand: true }),
    });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/entity/mount", { method: "POST", body: JSON.stringify({ track: "r7:e10" }) });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/entity/dismount", { method: "POST", body: "{}" });
    expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/entity/move-vehicle", {
      method: "POST",
      body: JSON.stringify({ left: 0.5, forward: 1 }),
    });
  });

  it("streams observe watch chunks to stdout and handles watch failures", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const record = { session: "default", token: "secret", controlPort: 3000 };
    mocks.loadSessionForClient.mockResolvedValue(record);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const watchResponse = () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":1}\n'));
          controller.close();
        },
      }), { headers: { "X-MC-Agent-API": "3.1" } });
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(watchResponse())
        .mockResolvedValueOnce(watchResponse()),
    );

    await handlers.observeWatch({ session: "default", since: "r7:s7", types: [] });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:3000/watch?since=r7%3As7", {
      signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    });
    expect(write).toHaveBeenCalledWith(Buffer.from('{"id":1}\n'));

    await handlers.observeWatch({ session: "default", since: "r7:s8", types: ["chat", "message"] });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:3000/watch?since=r7%3As8&type=chat&type=message", {
      signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500, headers: { "X-MC-Agent-API": "3.1" } })));
    await expect(handlers.observeWatch({ session: "default", since: 0, types: [] })).rejects.toMatchObject({ code: "DAEMON_ERROR" });
  });

  it("passes now and self filtering directly to the daemon", async () => {
    const { handlers } = await loadActionsWithMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { headers: { "X-MC-Agent-API": "3.1" } })));
    await expect(handlers.observeWatch({ session: "default", since: "now", profile: "agent", types: ["chat.player", "chat.whisper", "chat.unverified"], excludeSelf: true })).rejects.toMatchObject({ code: "DAEMON_ERROR" });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:3000/watch?since=now&profile=agent&type=chat.player&type=chat.whisper&type=chat.unverified&excludeSelf=true", expect.anything());
  });

  it("keeps a watch alive beyond startup timeout and releases it when stdout fails", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    mocks.loadSessionForClient.mockResolvedValue({ session: "default", token: "secret", controlPort: 3000 });
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }), { headers: { "X-MC-Agent-API": "3.1" } });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const failure = new Error("stdout closed");
    vi.spyOn(process.stdout, "write").mockImplementation(() => { throw failure; });
    const watch = handlers.observeWatch({ session: "default", since: 0, types: [] });
    const rejected = expect(watch).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(6000);
    expect((fetchMock.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(false);
    controller.enqueue(new TextEncoder().encode('{"message":"unfiltered"}\n'));
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires a daemon token before running the daemon command", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    await expect(handlers.daemonRun({ ...startInput(), controlPort: 3000 })).rejects.toMatchObject({ code: "BAD_INPUT" });

    process.env.MC_AGENT_CONTROL_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    mocks.runDaemon.mockResolvedValue(undefined);
    await expect(handlers.daemonRun({ ...startInput(), controlPort: 3000 })).resolves.toEqual({
      session: "default",
      running: true,
    });
    expect(mocks.runDaemon).toHaveBeenCalledWith(expect.objectContaining({ token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
  });

  it("probes listed sessions and distinguishes a live unresponsive process from readiness", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    const records = ["ready", "pending", "unresponsive"].map(session => ({ ...startInput(), session, pid: process.pid, controlPort: 3000, token: "private-token", username: "private-account@example.com", startedAt: "2026-10-04T00:00:00Z" }));
    mocks.listSessions.mockResolvedValue(records);
    mocks.daemonRequest.mockImplementation(async record => {
      if (record.session === "unresponsive") throw new Error("ECONNREFUSED private.example.net private-account@example.com");
      return record.session === "ready"
        ? { ready: true, username: "InGameBot", connection: { state: "ready", ready: true } }
        : { ready: false, connection: { state: "connecting", ready: false } };
    });

    await expect(handlers.listSessions()).resolves.toEqual({ sessions: [
      { session: "ready", alive: true, ready: true, username: "InGameBot", connection: { state: "ready", ready: true } },
      { session: "pending", alive: true, ready: false, connection: { state: "connecting", ready: false } },
      { session: "unresponsive", alive: true, ready: false, connection: { state: "unresponsive", ready: false } },
    ] });
    expect(mocks.daemonRequest).toHaveBeenCalledTimes(3);
    for (const record of records) expect(mocks.daemonRequest).toHaveBeenCalledWith(record, "/status", { signal: expect.any(AbortSignal) });
  });

  it("reports an incompatible listed daemon without exposing connection configuration", async () => {
    const { handlers, mocks } = await loadActionsWithMocks();
    mocks.listSessions.mockResolvedValue([{ ...startInput(), pid: process.pid, controlPort: 3000, token: "secret-token", username: "private-account@example.com", startedAt: "today" }]);
    const { daemonIncompatible } = await import("../src/output/errors.js");
    mocks.daemonRequest.mockRejectedValue(daemonIncompatible("default", { actualApiVersion: "2" }));
    const result = await handlers.listSessions();
    expect(result).toEqual({ sessions: [{ session: "default", alive: true, ready: false, connection: { state: "unresponsive", ready: false }, error: { code: "DAEMON_INCOMPATIBLE", message: expect.stringContaining("API v3.1") } }] });
    expect(JSON.stringify(result)).not.toContain("private-account");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("keeps CliError class import exercised", () => {
    expect(new CliError("BAD_INPUT", "bad", "fix", 3).exitCode).toBe(3);
  });
});
