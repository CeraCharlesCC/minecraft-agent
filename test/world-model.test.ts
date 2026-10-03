import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "../src/core/events.js";
import { WorldModel } from "../src/core/world.js";

const ready = { connected: true, spawned: true };
const UUID = "12345678-1234-1234-1234-123456789abc";
function entity(id = 1, x = 5, uuid?: string) {
  return { id, type: "player", username: "Alex", name: "player", uuid, position: { x, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
}
function bot(target = entity()) {
  return { username: "Agent", game: { dimension: "overworld" }, health: 20, food: 20,
    entity: { id: 0, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
    entities: { "1": target } as Record<string, ReturnType<typeof entity>>,
    players: { Alex: { username: "Alex", uuid: target.uuid, entity: target } },
    inventory: { slots: [{ name: "stone", count: 1, nbt: { tag: "old" } }] },
    currentWindow: { id: 1, type: "chest", slots: [{ name: "dirt", count: 2 }] },
  };
}
function code(run: () => unknown, expected: string) {
  try { run(); throw new Error("Expected error"); } catch (error) { expect(error).toMatchObject({ code: expected }); }
}

afterEach(() => vi.useRealTimers());

describe("observed world model", () => {
  it("detaches full frames and captures eventless inventory and velocity mutations", () => {
    const events = new EventStore(); const world = new WorldModel(events); const live = bot();
    const first = world.frame(live, ready);
    const cursor = first.eventCursor;
    live.entities[1].position.x = 6; live.entities[1].velocity.x = 0.75;
    live.inventory.slots[0].nbt.tag = "new"; live.currentWindow.slots[0].count = 9;
    const second = world.frame(live, ready);
    expect(first.entities[0].position.x).toBe(5); expect(first.inventory[0].nbt.tag).toBe("old");
    expect(first.window.slots[0].count).toBe(2);
    expect(second.entities[0].velocity.x).toBe(0.75); expect(second.inventory[0].nbt.tag).toBe("new");
    expect(second.eventCursor).toBe(cursor); expect(second.stateRevision).toBeGreaterThan(first.stateRevision);
    const third = world.frame(live, ready); expect(third.stateRevision).toBe(second.stateRevision);
    first.inventory[0].count = 999;
    const delta = world.frame(live, ready, { since: first.frame });
    expect(delta.delta.changed.inventory[0].count).toBe(1);
  });

  it("does not reconnect reused numeric IDs or proximity without UUID identity", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    const first = world.frame(live, ready).entities[0].trackId;
    live.entities = {}; world.frame(live, ready); code(() => world.resolveTrack(first), "TRACK_LOST");
    live.entities[1] = entity(1, 5);
    const second = world.frame(live, ready).entities[0].trackId;
    expect(second).not.toBe(first); code(() => world.resolveTrack(first), "TRACK_LOST");
    const restarted = new WorldModel(new EventStore());
    expect(restarted.runtimeId).not.toBe(world.runtimeId);
    code(() => restarted.resolveTrack(second), "RUNTIME_MISMATCH");
  });

  it("reconnects a verified UUID to a fresh live object with a new binding generation", () => {
    const world = new WorldModel(new EventStore()); const live = bot(entity(1, 5, UUID));
    const first = world.frame(live, ready).entities[0]; const lost = vi.fn(); world.onTrackLost = lost;
    live.entities = {}; world.frame(live, ready);
    expect(lost).toHaveBeenCalledWith(first.trackId);
    const replacement = entity(17, 7, UUID); live.entities[17] = replacement;
    const second = world.frame(live, ready).entities[0];
    expect(second.trackId).toBe(first.trackId); expect(second.bindingGeneration).toBeGreaterThan(first.bindingGeneration);
    expect(world.resolveTrack(second.trackId)).toBe(replacement);
  });

  it("reconciles direct object replacement through verified UUID in one observation", () => {
    const world = new WorldModel(new EventStore()); const live = bot(entity(1, 5, UUID));
    const first = world.frame(live, ready).entities[0].trackId;
    live.entities[1] = entity(1, 6, UUID);
    expect(world.frame(live, ready).entities[0].trackId).toBe(first);
  });

  it("tombstones raw gone and dead events before Mineflayer removes its dictionary entry", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    const first = world.frame(live, ready).entities[0].trackId;
    world.invalidate(live.entities[1], "dead");
    const frame = world.frame(live, ready, { tracks: [first] });
    expect(frame.entities[0]).toMatchObject({ trackId: first, status: "dead" });
    expect(frame.entities[0].position).toBeUndefined(); code(() => world.resolveTrack(first), "TRACK_LOST");
  });

  it("keeps unloaded online player identity separate from visible positions", () => {
    const world = new WorldModel(new EventStore()); const live = bot(entity(1, 5, UUID));
    const first = world.frame(live, ready); live.entities = {};
    const frame = world.frame(live, ready);
    expect(frame.players[0]).toMatchObject({ username: "Alex", online: true });
    expect(frame.players[0].trackId).toBeUndefined(); expect(frame.players[0].position).toBeUndefined();
    expect(world.playerIdentity(UUID)).toMatchObject({ username: "Alex" });
    expect(world.playerIdentity(UUID)?.trackId).toBeUndefined();
    expect(world.playerIdentity("Alex", "ffffffff-ffff-ffff-ffff-ffffffffffff")).toBeUndefined();
    expect(frame.entities).toEqual([]); expect(first.entities[0].status).toBe("loaded");
  });

  it("invalidates old world handles, baselines and stale live objects on resets", () => {
    const world = new WorldModel(new EventStore()); const live = bot(entity(1, 5, UUID));
    const first = world.frame(live, ready); const reset = vi.fn(); world.onWorldReset = reset;
    world.reset("disconnect");
    code(() => world.resolveTrack(first.entities[0].trackId), "WORLD_CHANGED");
    const disconnected = world.frame(live, { connected: false, spawned: false });
    expect(disconnected.entities).toEqual([]); expect(disconnected.window).toBeNull(); expect(disconnected.self.position).toBeUndefined();
    expect(world.frame(live, ready).entities).toEqual([]);
    code(() => world.frame(live, ready, { since: first.frame }), "FRAME_RESET_REQUIRED");
    expect(reset).toHaveBeenCalledWith("disconnect");
  });

  it("detects a dimension transition and clears stale bindings", () => {
    const world = new WorldModel(new EventStore()); const live = bot(); const first = world.frame(live, ready);
    live.game.dimension = "the_nether";
    const next = world.frame(live, ready);
    expect(next.worldEpoch).toBe(first.worldEpoch + 1); expect(next.dimension).toBe("the_nether"); expect(next.entities).toEqual([]);
    expect(next.connection.ready).toBe(false); expect(next.self.position).toBeUndefined(); expect(next.window).toBeNull();
  });

  it("evaluates proximity from self motion using hysteresis and cooldown", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const events = new EventStore(); const world = new WorldModel(events); const live = bot(entity(1, 30));
    world.frame(live, ready); const start = events.getLastEventId();
    live.entity.position.x = 16; world.frame(live, ready);
    expect(events.list(start, 20).map((event) => event.type)).toEqual(["entity.entered_nearby"]);
    live.entity.position.x = 12; world.frame(live, ready); // distance18: still nearby
    live.entity.position.x = 0; world.frame(live, ready); // cooldown suppresses exit
    expect(events.list(start, 20).filter((event) => event.type === "entity.left_nearby")).toHaveLength(0);
    vi.advanceTimersByTime(1001); world.frame(live, ready);
    expect(events.list(start, 20).filter((event) => event.type === "entity.left_nearby")).toHaveLength(1);
  });

  it("projects deterministically, aggregates omissions and preserves requested/action targets", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    live.entities[2] = entity(2, 100); live.entities[3] = entity(3, 10);
    const all = world.frame(live, ready, { maxEntities: 3, radius: 200 });
    const far = all.entities.find((item: any) => item.minecraftEntityId === 2).trackId;
    const chosen = all.entities.find((item: any) => item.minecraftEntityId === 3).trackId;
    const projected = world.frame(live, { ...ready, actions: [{ target: far, state: "running" }] }, { maxEntities: 0, radius: 0, tracks: [chosen] });
    expect(projected.entities.map((item: any) => item.trackId).sort()).toEqual([far, chosen].sort());
    expect(projected.projection).toMatchObject({ omitted: 1, truncated: true, aggregates: { player: 1 } });
  });

  it("returns deltas for changed state and classifies removal as loss or projection omission", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    const first = world.frame(live, ready); const id = first.entities[0].trackId;
    const unchanged = world.frame(live, ready, { since: first.frame }); expect(unchanged.delta.changed.entities).toEqual([]);
    live.entities[1].position.x = 100;
    const omitted = world.frame(live, ready, { since: first.frame });
    expect(omitted.delta.removed).toEqual([{ trackId: id, status: "omitted" }]);
    live.entities = {};
    const lost = world.frame(live, ready, { since: first.frame }); expect(lost.delta.removed).toEqual([{ trackId: id, status: "lost" }]);
    live.health = 5;
    const health = world.frame(live, ready, { since: lost.frame }); expect(health.delta.changed.self.health).toBe(5);
  });

  it("bounds baseline retention and rejects expired or incompatible projection baselines", () => {
    const world = new WorldModel(new EventStore()); const live = bot(); const first = world.frame(live, ready);
    code(() => world.frame(live, ready, { since: first.frame, radius: 20 }), "FRAME_RESET_REQUIRED");
    for (let n = 0; n < 33; n++) world.frame(live, ready);
    code(() => world.frame(live, ready, { since: first.frame }), "FRAME_RESET_REQUIRED");
    code(() => world.frame(live, ready, { since: "foreign:f1" }), "RUNTIME_MISMATCH");
  });

  it("captures authoritative action failures at the same observation boundary", () => {
    const events = new EventStore(); const world = new WorldModel(events); const live = bot();
    world.frame(live, ready); let state = "running";
    world.onTrackLost = () => { state = "failed"; };
    live.entities = {};
    const frame = world.frame(live, { ...ready, actions: [{ state: "running" }], getActions: () => [{ state }] });
    expect(frame.actions).toEqual([{ state: "failed" }]);
  });

  it("refreshes readiness after synchronous dimension reset callbacks", () => {
    const world = new WorldModel(new EventStore()); const live = bot(); world.frame(live, ready);
    let spawned = true;
    world.onWorldReset = () => { spawned = false; };
    live.game.dimension = "the_end";
    const frame = world.frame(live, { ...ready, getReadiness: () => ({ connected: true, spawned }) });
    expect(frame.connection).toEqual({ connected: true, spawned: false, ready: false });
    expect(frame.self.position).toBeUndefined(); expect(frame.inventory).toEqual([]); expect(frame.window).toBeNull();
  });

  it("accepts the first respawn in a new dimension without resetting that fresh spawn", () => {
    const world = new WorldModel(new EventStore()); const live = bot(); world.frame(live, ready);
    world.reset("respawn"); live.game.dimension = "the_nether";
    live.entities = { "2": entity(2, 7) };
    const frame = world.frame(live, ready);
    expect(frame.worldEpoch).toBe(2); expect(frame.connection.ready).toBe(true);
    expect(frame.entities).toHaveLength(1); expect(frame.self.position).toEqual(live.entity.position);
  });

  it("detaches fallback window item methods when slots are unavailable", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    const items = [{ name: "apple", count: 3 }];
    const frame = world.frame({ ...live, currentWindow: { id: 2, items: () => items } }, ready);
    items[0].count = 9;
    expect(frame.window.slots).toEqual([{ name: "apple", count: 3 }]);
  });

  it("reports reset reasons and retains only bounded, unusable prior-world baselines", () => {
    const events = new EventStore(); const world = new WorldModel(events); const live = bot();
    const first = world.frame(live, ready);
    world.reset("respawn");
    expect(events.list(0, 100).find((event) => event.type === "world.reset")).toMatchObject({ reason: "respawn", worldEpoch: 2 });
    try { world.frame(live, ready, { since: first.frame }); throw new Error("Expected error"); }
    catch (error) { expect(error).toMatchObject({ code: "FRAME_RESET_REQUIRED", details: { resetRequired: true, reason: "WORLD_CHANGED" } }); }
  });

  it("bounds lost-track retention and never reuses an evicted handle", () => {
    const world = new WorldModel(new EventStore()); const live = bot(); const first = world.frame(live, ready).entities[0].trackId;
    for (let n = 2; n < 520; n++) { live.entities = { [n]: entity(n, 5) }; world.frame(live, ready); }
    code(() => world.resolveTrack(first), "TRACK_UNKNOWN");
    expect(world.frame(live, ready).entities[0].trackId).not.toBe(first);
  });

  it("validates projection budgets and current-runtime unknown tracks", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    code(() => world.frame(live, ready, { maxEntities: -1 }), "BAD_INPUT");
    code(() => world.frame(live, ready, { radius: Infinity }), "BAD_INPUT");
    code(() => world.resolveTrack(`${world.runtimeId}:e999`), "TRACK_UNKNOWN");
  });
  it("ignores delayed callbacks from a retired object after UUID reacquisition", () => {
    const world = new WorldModel(new EventStore()), original = entity(1, 5, UUID), live = bot(original);
    const first = world.frame(live, ready).entities[0].trackId;
    world.invalidate(original, "lost");
    const replacement = entity(17, 7, UUID); live.entities = { "17": replacement };
    world.frame(live, ready);
    world.invalidate(original, "dead"); world.invalidate(original, "lost");
    expect(world.resolveTrack(first)).toBe(replacement);
    expect(world.frame(live, ready).entities[0].status).toBe("loaded");
  });

});
