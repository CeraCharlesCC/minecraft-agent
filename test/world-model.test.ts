import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "../src/core/events.js";
import { encodeActionContext, decodeActionContext } from "../src/core/context.js";
import { encodeHandle } from "../src/core/handles.js";
import { WorldModel } from "../src/core/world.js";
import { ActionManager } from "../src/core/actions.js";
import { goals } from "mineflayer-pathfinder";

const ready = { connected: true, spawned: true };
const UUID = "12345678-1234-1234-1234-123456789abc";
function entity(id = 1, x = 5, uuid?: string) {
  return { id, type: "player", username: "Alex", name: "player", uuid, position: { x, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
}
function bot(target = entity()) {
  return { username: "Agent", game: { dimension: "overworld" }, health: 20, food: 20, oxygenLevel: 20, quickBarSlot: 0, heldItem: null, vehicle: null, controlState: {},
    entity: { id: 0, yaw: 0, pitch: 0, onGround: true, equipment: [] as unknown[], position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
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
  it("keeps compact projections detached and sparse while full detail preserves internal observations", () => {
    const world = new WorldModel(new EventStore());
    const live = bot();
    live.inventory.slots = Array(46).fill(null) as any;
    live.inventory.slots[36] = { name: "stone", count: 1, slot: 99, nbt: { tag: "old" } } as any;
    live.currentWindow = { id: 1, type: "chest", inventoryStart: 27, inventoryEnd: 63, hotbarStart: 54, hotbarEnd: 63,
      slots: [null, { name: "dirt", count: 2, nbt: { huge: "raw" } }, null] } as any;
    Object.assign(live, { heldItem: { name: "book", count: 1, nbt: { pages: ["huge"] } } });
    Object.assign(live.entity, { equipment: [{ name: "helmet", count: 1, nbt: { enchantments: ["huge"] } }] });
    const first = world.frame(live, ready);
    expect(first.type).toBe("full");
    expect(first.projection).toEqual({ included: 1, omitted: 0 });
    expect(first.entities[0]).toEqual({ trackId: expect.any(String), status: "loaded", type: "minecraft:player", name: "player", username: "Alex", position: { x: 5, y: 64, z: 0 }, distance: 5, unknownFields: ["customName"] });
    expect(first.inventory).toEqual({ known: true, slotCount: 46, slots: [{ name: "stone", count: 1, slot: 36 }] });
    expect(first.window).toMatchObject({ id: 1, known: true, inventoryStart: 27, inventoryEnd: 63, hotbarStart: 54, hotbarEnd: 63, slotCount: 3, slots: [{ name: "dirt", count: 2, slot: 1 }] });
    expect(first.self.heldItem).toEqual({ name: "book", count: 1 });
    expect(first.self.equipment).toEqual({ "0": { name: "helmet", count: 1 } });
    live.inventory.slots[36].nbt.tag = "new";
    live.entities[1].velocity.x = 2;
    const delta = world.frame(live, ready, { since: first.frame });
    expect(delta).not.toHaveProperty("stateRevision");
    expect(delta.delta.changed).toEqual({ entities: [] });
    expect(delta.context).toBe(first.context);
    const full = world.frame(live, ready, { detail: "full" });
    expect(full.entities[0].velocity.x).toBe(2);
    expect(full.inventory.slots).toEqual([{ name: "stone", count: 1, slot: 36 }]);
    expect(full.window.slots[0]).toEqual({ name: "dirt", count: 2, slot: 1 });
    expect(full.self.heldItem).toEqual({ name: "book", count: 1 });
    live.entities[1].position.x = 9;
    live.inventory.slots[36] = null as any;
    const cleared = world.frame(live, ready, { since: first.frame });
    expect(cleared.delta.changed.inventory).toEqual({ known: true, slotCount: 46, slots: [] });
    expect(first.inventory.slots[0].count).toBe(1);
    expect(first.entities[0].position.x).toBe(5);
    expect(world.frame(live, ready, { since: first.frame, detail: "full" })).toMatchObject({ type: "full", reset: { reason: "PROJECTION_CHANGED" } });
  });

  it("distinguishes unavailable and observed-empty slots without inventing fallback indices", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    live.inventory.slots = [];
    expect(world.frame(live, ready).inventory).toEqual({ known: true, slotCount: 0, slots: [] });
    expect(world.frame({ ...live, inventory: undefined }, ready).inventory).toEqual({ known: false });
    expect(world.frame(live, { connected: false, spawned: false }).inventory).toEqual({ known: false });
    const fallback = world.frame({ ...live, inventory: { items: () => [{ name: "apple", count: 1, slot: 37 }] }, currentWindow: { id: 2, items: () => [{ name: "stone" }] } }, ready);
    expect(fallback.inventory).toEqual({ known: true, slots: [{ name: "apple", count: 1, slot: 37 }] });
    expect(fallback.window).toMatchObject({ known: false });
  });

  it("searches omitted loaded tracks without consuming baselines or mixing online identities", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    for (let n = 2; n <= 80; n++) live.entities[n] = entity(n, n);
    Object.assign(live.players, { Unloaded: { username: "Unloaded" } });
    const frame = world.frame(live, ready);
    expect(frame.entities).toHaveLength(12);
    for (let n = 0; n < 40; n++) world.searchLoaded(live, ready, { radius: 200, limit: 512 });
    const search = world.searchLoaded(live, ready, { radius: 200, limit: 512, types: ["minecraft:player"] });
    expect(search.entities).toHaveLength(80);
    expect(search.entities.some((item: any) => item.username === "Unloaded")).toBe(false);
    expect(search.context).toBe(frame.context);
    expect(decodeActionContext(search.context)).toEqual({ runtimeId: world.runtimeId, worldEpoch: 1 });
    expect(world.frame(live, ready, { since: frame.frame }).delta.changed.entities).toEqual([]);
    const target = search.entities[79];
    expect(world.resolveTrack(target.trackId)).toBe(live.entities[80]);
    world.invalidate(live.entities[80], "dead");
    expect(world.searchLoaded(live, ready, { radius: 200, limit: 512 }).entities).toHaveLength(79);
    expect(world.searchLoaded(live, { connected: false, spawned: false }, { radius: 200 }).entities).toEqual([]);
    code(() => world.resolveTrack(target.trackId), "TRACK_LOST");
  });

  it("validates canonical species against the server registry", () => {
    const world = new WorldModel(new EventStore());
    const cow = { id: 1, name: "cow", type: "mob", position: { x: 2, y: 64, z: 0 } };
    const live = { ...bot(), entities: { "1": cow }, registry: { entitiesByName: { cow: {} } } };
    expect(world.searchLoaded(live, ready, { types: ["minecraft:cow"] }).entities[0]).toMatchObject({ type: "minecraft:cow" });
    code(() => world.searchLoaded(live, ready, { types: ["minecraft:unknown"] }), "BAD_INPUT");
    expect(world.searchLoaded(live, ready, { types: ["cow"] }).entities).toEqual(world.searchLoaded(live, ready, { types: ["minecraft:cow"] }).entities);
    code(() => world.searchLoaded(live, ready, { types: ["mod:cow"] }), "BAD_INPUT");
  });

  it("encodes action contexts independently of frame lifetime and rejects malformed tokens", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    const first = world.frame(live, ready);
    for (let n = 0; n < 33; n++) world.frame(live, ready);
    expect(decodeActionContext(first.context)).toEqual({ runtimeId: world.runtimeId, worldEpoch: 1 });
    expect(encodeActionContext(world.runtimeId, 1)).toBe(first.context);
    world.reset("respawn");
    expect(world.frame(live, ready).context).not.toBe(first.context);
    for (const invalid of ["bad", "mcctx1.!!!!", "mcctx1.W10", first.context + "="]) code(() => decodeActionContext(invalid), "BAD_INPUT");
    code(() => encodeActionContext("runtime", 0), "BAD_INPUT");
  });

  it("detaches full frames and captures eventless inventory and velocity mutations", () => {
    const events = new EventStore(); const world = new WorldModel(events); const live = bot();
    const first = world.frame(live, ready, { detail: "full" });
    const cursor = first.eventCursor;
    live.entities[1].position.x = 6; live.entities[1].velocity.x = 0.75;
    live.inventory.slots[0].count = 3; live.currentWindow.slots[0].count = 9;
    const second = world.frame(live, ready, { detail: "full" });
    expect(first.entities[0].position.x).toBe(5); expect(first.inventory.slots[0].count).toBe(1);
    expect(first.window.slots[0].count).toBe(2);
    expect(second.entities[0].velocity.x).toBe(0.75); expect(second.inventory.slots[0].count).toBe(3);
    expect(second.eventCursor).toBe(cursor); expect(second.stateRevision).toBeGreaterThan(first.stateRevision);
    const third = world.frame(live, ready, { detail: "full" }); expect(third.stateRevision).toBe(second.stateRevision);
    first.inventory.slots[0].count = 999;
    const delta = world.frame(live, ready, { detail: "full", since: first.frame });
    expect(delta.delta.changed.inventory.slots[0].count).toBe(3);
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
    const first = world.frame(live, ready, { detail: "full" }).entities[0]; const lost = vi.fn(); world.onTrackLost = lost;
    live.entities = {}; world.frame(live, ready, { detail: "full" });
    expect(lost).toHaveBeenCalledWith(first.trackId);
    const replacement = entity(17, 7, UUID); live.entities[17] = replacement;
    const second = world.frame(live, ready, { detail: "full" }).entities[0];
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
    const frame = world.frame(live, ready, { detail: "full" });
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
    expect(disconnected.entities).toEqual([]); expect(disconnected.window).toBeUndefined(); expect(disconnected.self.position).toBeUndefined();
    expect(world.frame(live, ready).entities).toEqual([]);
    expect(world.frame(live, ready, { since: first.frame })).toMatchObject({ type: "full", reset: { reason: "WORLD_CHANGED" } });
    expect(reset).toHaveBeenCalledWith("disconnect");
  });

  it("detects a dimension transition and clears stale bindings", () => {
    const world = new WorldModel(new EventStore()); const live = bot(); const first = world.frame(live, ready);
    live.game.dimension = "the_nether";
    const next = world.frame(live, ready);
    expect(decodeActionContext(next.context).worldEpoch).toBe(decodeActionContext(first.context).worldEpoch + 1); expect(next.dimension).toBe("the_nether"); expect(next.entities).toEqual([]);
    expect(next.connection.ready).toBe(false); expect(next.self.position).toBeUndefined(); expect(next.window).toBeUndefined();
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
    const all = world.frame(live, ready, { maxEntities: 3, radius: 200, detail: "full" });
    const far = all.entities.find((item: any) => item.minecraftEntityId === 2).trackId;
    const chosen = all.entities.find((item: any) => item.minecraftEntityId === 3).trackId;
    const projected = world.frame(live, { ...ready, actions: [{ target: far, state: "running" }] }, { maxEntities: 0, radius: 0, tracks: [chosen] });
    expect(projected.entities.map((item: any) => item.trackId).sort()).toEqual([far, chosen].sort());
    expect(projected.projection).toMatchObject({ included: 2, omitted: 1, aggregates: { "minecraft:player": 1 } });
  });

  it("projects follow goals to compact track references and detects only public navigation changes", () => {
    const world = new WorldModel(new EventStore());
    const target = Object.assign(entity(), { equipment: [{ name: "written_book", nbt: { pages: Array(100).fill("x".repeat(1024)) } }], metadata: { secret: "raw" }, passengers: [{ id: 99 }] });
    const live = Object.assign(bot(target), { pathfinder: { goal: new goals.GoalFollow(target as never, 2), isMoving: () => true } });
    const first = world.frame(live, ready, { maxEntities: 0, detail: "full" });
    const track = world.trackFor(target);
    expect(first.entities).toEqual([]);
    expect(first.navigation).toEqual({ moving: true, mining: false, building: false, goal: { kind: "GoalFollow", parameters: { x: 5, y: 64, z: 0, rangeSq: 4 }, target: track } });
    expect(JSON.stringify(first.navigation).length).toBeLessThan(300);
    target.equipment[0].nbt.pages[0] = "new raw NBT";
    const unchanged = world.frame(live, ready, { maxEntities: 0, since: first.frame, detail: "full" });
    expect(unchanged.delta.changed).not.toHaveProperty("navigation");
    expect(unchanged.stateRevision).toBe(first.stateRevision);
    live.pathfinder.goal.rangeSq = 9;
    const changed = world.frame(live, ready, { maxEntities: 0, since: first.frame, detail: "full" });
    expect(changed.delta.changed.navigation.goal.parameters.rangeSq).toBe(9);
    expect(first.navigation.goal.parameters.rangeSq).toBe(4);
    const near = world.frame({ ...live, pathfinder: { goal: new goals.GoalNear(10, 65, 3, 1) } }, ready, { maxEntities: 0, detail: "full" });
    expect(near.navigation.goal).toEqual({ kind: "GoalNear", parameters: { x: 10, y: 65, z: 3, rangeSq: 1 } });
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
    expect(world.frame(live, ready, { since: first.frame, radius: 20 })).toMatchObject({ type: "full", reset: { reason: "PROJECTION_CHANGED" } });
    for (let n = 0; n < 33; n++) world.frame(live, ready);
    expect(world.frame(live, ready, { since: first.frame })).toMatchObject({ type: "full", reset: { reason: "BASELINE_EXPIRED" } });
    code(() => world.frame(live, ready, { since: encodeHandle("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "f", 1) }), "RUNTIME_MISMATCH");
  });

  it("captures authoritative action failures at the same observation boundary", () => {
    const events = new EventStore(); const world = new WorldModel(events); const actions = new ActionManager(events); const live = bot();
    const track = world.frame(live, ready).entities[0].trackId;
    world.onTrackLost = target => actions.failTarget(target);
    const action = actions.start("navigate.follow", 1, ["movement"], { target: track, continuous: true });
    const staleActions = actions.observation();
    live.entities = {};
    const frame = world.frame(live, { ...ready, actions: staleActions, getActions: () => actions.observation() });
    expect(frame.actions).toEqual([{ action: action.action, kind: "navigate.follow", target: track,
      state: "failed", reason: "TRACK_LOST", error: { code: "TRACK_LOST" } }]);
    expect(actions.owner("movement")).toBeUndefined();
  });

  it("refreshes readiness after synchronous dimension reset callbacks", () => {
    const world = new WorldModel(new EventStore()); const live = bot(); world.frame(live, ready);
    let spawned = true;
    world.onWorldReset = () => { spawned = false; };
    live.game.dimension = "the_end";
    const frame = world.frame(live, { ...ready, getReadiness: () => ({ connected: true, spawned }) });
    expect(frame.connection).toEqual({ state: "connecting", ready: false });
    expect(frame.self.position).toBeUndefined(); expect(frame.inventory).toEqual({ known: false }); expect(frame.window).toBeUndefined();
  });

  it("accepts the first respawn in a new dimension without resetting that fresh spawn", () => {
    const world = new WorldModel(new EventStore()); const live = bot(); world.frame(live, ready);
    world.reset("respawn"); live.game.dimension = "the_nether";
    live.entities = { "2": entity(2, 7) };
    const frame = world.frame(live, ready);
    expect(decodeActionContext(frame.context).worldEpoch).toBe(2); expect(frame.connection.ready).toBe(true);
    expect(frame.entities).toHaveLength(1); expect(frame.self.position).toEqual(live.entity.position);
  });

  it("detaches fallback window item methods when slots are unavailable", () => {
    const world = new WorldModel(new EventStore()); const live = bot();
    const items = [{ name: "apple", count: 3, slot: 2 }];
    const frame = world.frame({ ...live, currentWindow: { id: 2, items: () => items } }, ready, { detail: "full" });
    items[0].count = 9;
    expect(frame.window.slots).toEqual([{ name: "apple", count: 3, slot: 2 }]);
  });

  it("reports reset reasons and retains only bounded, unusable prior-world baselines", () => {
    const events = new EventStore(); const world = new WorldModel(events); const live = bot();
    const first = world.frame(live, ready);
    world.reset("respawn");
    expect(events.list(0, 100).find((event) => event.type === "world.reset")).toMatchObject({ reason: "respawn", worldEpoch: 2 });
    expect(world.frame(live, ready, { since: first.frame })).toMatchObject({ type: "full", reset: { reason: "WORLD_CHANGED" } });
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
    code(() => world.resolveTrack(encodeHandle(world.runtimeId, "e", 999)), "TRACK_UNKNOWN");
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

  it("defaults to twelve ordinary entities with bounded nearby player/item reserves", () => {
    const world = new WorldModel(new EventStore());
    const live = { ...bot(), entities: {} as Record<string, any> };
    for (let n = 1; n <= 100; n++) live.entities[n] = { id: n, type: "mob", name: "cod", position: { x: n / 100, y: 64, z: 0 } };
    for (let n = 101; n <= 110; n++) live.entities[n] = { id: n, type: "player", username: `Player${n}`, position: { x: 20 + (n - 101), y: 64, z: 0 } };
    for (let n = 111; n <= 120; n++) live.entities[n] = { id: n, type: "object", name: "item", position: { x: 10 + (n - 111) / 10, y: 64, z: 0 } };
    live.entities[121] = { id: 121, type: "player", username: "FarPlayer", position: { x: 60, y: 64, z: 0 } };
    live.entities[122] = { id: 122, type: "object", name: "item", position: { x: 50, y: 64, z: 0 } };
    const frame = world.frame(live, ready);
    expect(frame.entities).toHaveLength(12);
    expect(frame.projection).toMatchObject({ included: 12, omitted: 110 });
    expect(frame.entities.filter((e: any) => e.type === "minecraft:player").map((e: any) => e.username)).toEqual(["Player101", "Player102"]);
    expect(frame.entities.filter((e: any) => e.type === "minecraft:item")).toHaveLength(2);
    expect(frame.entities.filter((e: any) => e.type === "minecraft:cod")).toHaveLength(8);
    const far = world.trackFor(live.entities[121])!;
    const kept = world.frame(live, { ...ready, actions: [{ state: "running", target: far }] });
    expect(kept.entities).toHaveLength(13);
    expect(kept.projection).toMatchObject({ included: 13, omitted: 109 });
    expect(world.frame(live, ready, { maxEntities: 1 }).entities).toHaveLength(1);
    expect(world.frame(live, ready, { maxEntities: 0 }).entities).toEqual([]);
    expect(world.frame(live, ready, { radius: 2 }).entities.every((e: any) => e.type === "minecraft:cod")).toBe(true);
  });

  it("changes revision only when frame content is observed and preserves transient health events", () => {
    const events = new EventStore(), world = new WorldModel(events), live = bot();
    const first = world.frame(live, ready);
    live.health = 5; world.observeHealth(live, ready);
    live.health = 20; world.observeHealth(live, ready);
    live.entities[1].position.x = 7; world.updateEntity(live, ready, live.entities[1]);
    live.entities[1].position.x = 5; world.updateEntity(live, ready, live.entities[1]);
    expect(world.searchLoaded(live, ready).entities[0].position).toEqual(live.entities[1].position);
    const second = world.frame(live, ready, { since: first.frame });
    expect(second).not.toHaveProperty("stateRevision");
    expect(second.eventCursor).not.toBe(first.eventCursor);
    expect(events.list(0, 20)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "self.damaged", health: 5, amount: 15 })]));
  });

  it("bounds dictionary bindings and preserves live tracks across key changes and replacement churn", () => {
    const world = new WorldModel(new EventStore()), original = entity(1, 5), live = bot(original);
    world.syncBindings(live, ready);
    const originalTrack = world.trackFor(original)!;
    for (let n = 2; n <= 20; n++) {
      live.entities = { [n]: original };
      world.syncBindings(live, ready);
      expect(world.resolveTrack(originalTrack)).toBe(original);
    }
    // This resource bound needs internal inspection: correct public results
    // alone cannot reveal leaked dictionary entries retaining entity objects.
    expect((world as any).dictionaryTracks.size).toBe(1);
    let latestTrack = originalTrack;
    for (let n = 21; n <= 560; n++) {
      const replacement = entity(n, 5);
      live.entities = { "20": replacement };
      world.updateEntity(live, ready, replacement);
      expect(() => world.resolveTrack(latestTrack)).toThrow(expect.objectContaining({ code: "TRACK_LOST" }));
      latestTrack = world.trackFor(replacement)!;
      expect(world.resolveTrack(latestTrack)).toBe(replacement);
    }
    expect((world as any).dictionaryTracks.size).toBe(1);
    expect((world as any).tracks.size).toBeLessThanOrEqual(513);
    expect(() => world.resolveTrack(originalTrack)).toThrow(expect.objectContaining({ code: "TRACK_UNKNOWN" }));
    expect(world.frame(live, ready).entities.map((entry: any) => entry.trackId)).toEqual([latestTrack]);
    world.reset("respawn");
    expect(() => world.resolveTrack(latestTrack)).toThrow(expect.objectContaining({ code: "WORLD_CHANGED" }));
    expect(world.frame(live, ready).entities).toEqual([]);
    expect((world as any).dictionaryTracks.size).toBe(0);
  });

});
