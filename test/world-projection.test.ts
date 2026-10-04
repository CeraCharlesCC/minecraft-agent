import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/events.js";
import { encodeHandle } from "../src/core/handles.js";
import { WorldModel, projectItem, projectWindow } from "../src/core/world.js";
import { createRequire } from "node:module";

const ready = { connected: true, spawned: true };
function fixture() {
  return { username: "Agent", game: { dimension: "overworld" }, health: 20, food: 20, oxygenLevel: 20,
    foodSaturation: 5, experience: { level: 0, points: 0, progress: 0 }, quickBarSlot: 0, heldItem: null as unknown, vehicle: null as unknown,
    entity: { id: 0, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: false, equipment: Array(6).fill(null) },
    controlState: { forward: false, jump: false }, players: { HiddenOnline: { username: "HiddenOnline" } },
    entities: {} as Record<string, any>, inventory: { slots: Array(46).fill(null) }, currentWindow: null as unknown };
}
function comparable(frame: any) {
  const { frame: _frame, eventCursor: _cursor, observedAt: _time, stateRevision: _revision, ...state } = frame;
  return state;
}
function apply(base: any, response: any) {
  if (response.type === "full") return structuredClone(response);
  const state = structuredClone(base);
  const { entities, ...changed } = response.delta.changed;
  Object.assign(state, changed);
  for (const pointer of response.delta.unset) {
    const key = pointer.slice(1).replaceAll("~1", "/").replaceAll("~0", "~");
    delete state[key];
  }
  const tracks = new Map<string, any>(state.entities.map((entity: any) => [entity.trackId, entity]));
  for (const entity of entities) tracks.set(entity.trackId, entity);
  for (const entity of response.delta.removed) tracks.delete(entity.trackId);
  state.entities = response.delta.entityOrder ? response.delta.entityOrder.map((track: string) => tracks.get(track)) : [...tracks.values()];
  for (const key of ["context", "frame", "eventCursor", "observedAt", "stateRevision"]) if (Object.hasOwn(response, key)) state[key] = response[key];
  return state;
}

describe("v3 public world projection", () => {
  it("keeps gameplay facts and known empty values within the compact frame size budget", () => {
    const frame = new WorldModel(new EventStore()).frame(fixture(), ready);
    expect(frame.self).toEqual({ position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20,
      oxygenLevel: 20, onGround: false, quickBarSlot: 0, equipment: {}, controls: [] });
    expect(frame.inventory).toEqual({ known: true, slotCount: 46, slots: [] });
    for (const key of ["runtimeId", "worldEpoch", "stateRevision", "observedAt", "players", "navigation", "window", "unknownFields"]) expect(frame).not.toHaveProperty(key);
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(Math.floor(1137 * 0.65));
  });

  it("shares window metadata, actionable indices and selected stack across observations and action results", () => {
    const bot = fixture(), world = new WorldModel(new EventStore());
    const window = { id: 3, type: "minecraft:chest", title: { toString: () => "Supplies" }, inventoryStart: 27, inventoryEnd: 63,
      hotbarStart: 54, hotbarEnd: 63, slots: [null, { name: "apple", count: 2, slot: 99 }], selectedItem: { name: "stone", count: 3, nbt: { private: true } } };
    bot.currentWindow = window;
    for (const detail of ["compact", "full"] as const) {
      const observed = world.frame(bot, ready, { detail }).window;
      const expected = { id: 3, type: "minecraft:chest", known: true, title: "Supplies", inventoryStart: 27, inventoryEnd: 63,
        hotbarStart: 54, hotbarEnd: 63, slotCount: 2, slots: [{ name: "apple", count: 2, slot: 1 }], selectedItem: { name: "stone", count: 3 } };
      expect(observed).toEqual(expected);
      expect(projectWindow(window, detail)).toEqual(expected);
      expect(observed.selectedItem).not.toHaveProperty("nbt");
    }
    expect(projectWindow({ id: 4 })).toEqual({ id: 4, known: false });
    expect(projectWindow({ items: () => [{ name: "apple", count: 1, slot: 37 }] })).toEqual({ known: true, slots: [{ name: "apple", count: 1, slot: 37 }] });
  });

  it("observes current vehicle through a loaded track and distinguishes unacquired state", () => {
    const bot = fixture(), world = new WorldModel(new EventStore());
    const vehicle = { id: 7, name: "boat", type: "object", position: { x: 2, y: 64, z: 0 } };
    bot.entities[7] = vehicle; bot.vehicle = vehicle;
    for (const detail of ["compact", "full"] as const) {
      const frame = world.frame(bot, ready, { detail });
      expect(frame.self.vehicle).toEqual({ trackId: world.trackFor(vehicle) });
      expect(frame.unknownFields ?? []).not.toContain("/self/vehicle");
    }
    bot.vehicle = null;
    const unmounted = world.frame(bot, ready);
    expect(unmounted.self).not.toHaveProperty("vehicle");
    expect(unmounted.unknownFields ?? []).not.toContain("/self/vehicle");
    bot.vehicle = vehicle;
    delete bot.entities[7];
    const unloaded = world.frame(bot, ready);
    expect(unloaded.self).not.toHaveProperty("vehicle");
    expect(unloaded.unknownFields).toContain("/self/vehicle");
    for (const unavailable of [undefined, { id: 9 }]) {
      bot.vehicle = unavailable;
      const unknown = world.frame(bot, ready);
      expect(unknown.self).not.toHaveProperty("vehicle");
      expect(unknown.unknownFields).toContain("/self/vehicle");
    }
  });

  it("includes pathfinder movement, mining and building state in full frame deltas", () => {
    const bot = Object.assign(fixture(), { pathfinder: { isMoving: () => true, isMining: () => mining, isBuilding: () => building } });
    let mining = false, building = false;
    const world = new WorldModel(new EventStore()), frame = world.frame(bot, ready, { detail: "full" });
    expect(frame.navigation).toEqual({ moving: true, mining: false, building: false, goal: null });
    mining = true;
    const digging = world.frame(bot, ready, { detail: "full", since: frame.frame });
    expect(digging.delta.changed.navigation).toEqual({ moving: true, mining: true, building: false, goal: null });
    building = true;
    expect(world.frame(bot, ready, { detail: "full", since: digging.frame }).delta.changed.navigation.building).toBe(true);
  });

  it("retains useful item distinctions while rejecting raw metadata in either detail level", () => {
    const item = { name: "diamond_sword", count: 1, slot: 36, type: 700, metadata: 0, customName: "Edge",
      durabilityUsed: 12, maxDurability: 1561, enchants: [{ name: "sharpness", lvl: 4, hidden: "raw" }], nbt: { secret: "hidden" }, components: [{ raw: "hidden" }] };
    for (const detail of ["compact", "full"] as const) {
      expect(projectItem(item, detail)).toEqual({ name: "diamond_sword", count: 1, slot: 36, type: 700, metadata: 0,
        customName: "Edge", durabilityUsed: 12, maxDurability: 1561, enchants: [{ name: "sharpness", lvl: 4 }] });
    }
    const world = new WorldModel(new EventStore()), bot = fixture();
    bot.heldItem = item; bot.entity.equipment[5] = item; bot.inventory.slots[36] = item;
    const frame = world.frame(bot, ready, { detail: "full" });
    expect(JSON.stringify(frame)).not.toContain("hidden");
    expect(frame.self.equipment[5].customName).toBe("Edge");
    item.durabilityUsed = 13;
    expect(frame.self.heldItem.durabilityUsed).toBe(12);
  });

  it("projects real Prismarine item getters for legacy NBT and modern components", () => {
    const require = createRequire(import.meta.url);
    for (const version of ["1.20.4", "1.21.4"]) {
      const registry = require("prismarine-registry")(version), Item = require("prismarine-item")(registry);
      const item = new Item(registry.itemsByName.diamond_sword.id, 1, 0);
      item.customName = version === "1.20.4" ? JSON.stringify({ text: "Edge", extra: [{ text: " of Dawn", hoverEvent: { contents: "private raw" } }] })
        : { type: "compound", value: { text: { type: "string", value: "Edge" }, extra: { type: "list", value: { type: "compound", value: [{ text: { type: "string", value: " of Dawn" }, secret: { type: "string", value: "private raw" } }] } } } };
      item.durabilityUsed = 12;
      if (item.componentMap) item.componentMap.set("enchantments", { data: [{ name: "sharpness", lvl: 4 }] });
      else item.enchants = [{ name: "sharpness", lvl: 4 }];
      const projected = projectItem(item);
      expect(projected).toMatchObject({ name: "diamond_sword", customName: "Edge of Dawn", durabilityUsed: 12, maxDurability: 1561, enchants: [{ name: "sharpness", lvl: 4 }] });
      expect(JSON.stringify(projected)).not.toContain("private raw");
      const bot = fixture(); bot.heldItem = item; bot.inventory.slots[36] = item;
      const frame = new WorldModel(new EventStore()).frame(bot, ready);
      expect(frame.self.heldItem.customName).toBe("Edge of Dawn");
      expect(frame.inventory.slots[0].durabilityUsed).toBe(12);
      if (item.componentMap) {
        item.componentMap.set("enchantments", { data: { enchantments: [{ id: 16, level: 4, secret: "private raw" }], showTooltip: true } });
        expect(projectItem(item)?.enchants).toEqual([{ id: 16, level: 4 }]);
      }
    }
  });

  it("distinguishes unavailable data, known empty data, and unready stale state", () => {
    const world = new WorldModel(new EventStore()), bot = fixture();
    const unavailable = { ...bot, heldItem: undefined, currentWindow: undefined, controlState: undefined,
      inventory: undefined, entity: { ...bot.entity, equipment: undefined } };
    const frame = world.frame(unavailable, ready);
    expect(frame.unknownFields).toEqual(["/self/heldItem", "/self/equipment", "/self/controls", "/window"]);
    expect(frame.inventory).toEqual({ known: false });
    expect(frame.self).not.toHaveProperty("controls");
    expect(frame.self).not.toHaveProperty("equipment");
    const stale = world.frame({ ...bot, heldItem: { name: "stone", count: 1 }, currentWindow: { id: 1, slots: [] } }, { connected: false, spawned: false });
    expect(stale.self).toEqual({}); expect(stale.inventory).toEqual({ known: false });
    expect(stale).not.toHaveProperty("window"); expect(stale).not.toHaveProperty("unknownFields");
    const observed = world.frame(bot, ready);
    expect(observed.self.controls).toEqual([]); expect(observed.self.equipment).toEqual({});
    expect(observed).not.toHaveProperty("unknownFields");
  });

  it("reconstructs deletion, clearing, ordering and entity removals with top-level replacement deltas", () => {
    const world = new WorldModel(new EventStore()), bot = fixture();
    const first = world.frame(bot, ready);
    bot.heldItem = { name: "apple", count: 1 }; bot.entity.equipment[5] = bot.heldItem;
    bot.controlState.forward = true; bot.inventory.slots[36] = bot.heldItem;
    bot.currentWindow = { id: 1, type: "chest", slots: [{ name: "stone", count: 2 }] };
    bot.entities[1] = { id: 1, name: "cow", type: "mob", position: { x: 10, y: 64, z: 0 } };
    bot.entities[2] = { id: 2, name: "cow", type: "mob", position: { x: 11, y: 64, z: 0 } };
    const occupied = world.frame(bot, ready, { since: first.frame });
    let rebuilt = apply(first, occupied);
    expect(comparable(rebuilt)).toEqual(comparable(world.frame(bot, ready)));
    bot.entities[2].position.x = 1;
    const reordered = world.frame(bot, ready, { since: occupied.frame });
    rebuilt = apply(rebuilt, reordered);
    expect(reordered.delta.entityOrder).toHaveLength(2);
    expect(comparable(rebuilt)).toEqual(comparable(world.frame(bot, ready)));
    bot.heldItem = null; bot.entity.equipment.fill(null); bot.controlState.forward = false;
    bot.inventory.slots.fill(null); bot.currentWindow = null;
    world.invalidate(bot.entities[1], "dead"); bot.entities[2].position.x = 100;
    const cleared = world.frame(bot, ready, { since: reordered.frame });
    expect(cleared.delta.unset).toContain("/window");
    expect(cleared.delta.changed.self).not.toHaveProperty("heldItem");
    expect(cleared.delta.changed.self.controls).toEqual([]);
    expect(cleared.delta.changed.inventory.slots).toEqual([]);
    expect(cleared.delta.removed.map((entity: any) => entity.status).sort()).toEqual(["dead", "omitted"]);
    rebuilt = apply(rebuilt, cleared);
    expect(comparable(rebuilt)).toEqual(comparable(world.frame(bot, ready)));
  });

  it("compares only projected facts and explicitly removes availability information", () => {
    const world = new WorldModel(new EventStore()), bot = fixture();
    const first = world.frame({ ...bot, heldItem: undefined }, ready);
    const next = world.frame(bot, ready, { since: first.frame });
    expect(next.delta.unset).toEqual(["/unknownFields"]);
    const unchanged = world.frame({ ...bot, foodSaturation: 10, experience: { level: 99 }, players: {} }, ready, { since: next.frame });
    expect(unchanged.delta.changed).toEqual({ entities: [] });
  });

  it("falls back to compact full snapshots and retains cross-runtime rejection", () => {
    const world = new WorldModel(new EventStore()), bot = fixture();
    const first = world.frame(bot, ready, { detail: "full" });
    for (let n = 0; n < 33; n++) world.frame(bot, ready);
    const expired = world.frame(bot, ready, { detail: "full", since: first.frame });
    expect(expired).toMatchObject({ type: "full", reset: { reason: "BASELINE_EXPIRED" } });
    expect(expired).not.toHaveProperty("runtimeId"); expect(expired).not.toHaveProperty("navigation");
    const continued = world.frame(bot, ready, { since: expired.frame });
    expect(continued.delta.unset).toContain("/reset");
    expect(comparable(apply(expired, continued))).toEqual(comparable(world.frame(bot, ready)));
    const changed = world.frame(bot, ready, { since: expired.frame, radius: 20 });
    expect(changed).toMatchObject({ type: "full", reset: { reason: "PROJECTION_CHANGED" } });
    world.reset("respawn");
    expect(world.frame(bot, ready, { since: changed.frame, radius: 20 })).toMatchObject({ type: "full", reset: { reason: "WORLD_CHANGED" } });
    expect(() => world.frame(bot, ready, { since: encodeHandle("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "f", 1) })).toThrow(expect.objectContaining({ code: "RUNTIME_MISMATCH" }));
  });

  it("projects the action manager's selection without repeating action results or diagnostics", () => {
    const world = new WorldModel(new EventStore()), bot = fixture();
    const actions = Array.from({ length: 12 }, (_, index) => ({ action: encodeHandle(world.runtimeId, "a", index + 1), kind: "navigate.goto", state: "completed", result: { completionReason: "within_range" }, runtimeId: world.runtimeId, startedAt: "private", error: { code: "NAVIGATION_FAILED", message: "private" } }));
    actions.push({ ...actions[0], state: "running" });
    const selection = [actions[12], actions[11]];
    const frame = world.frame(bot, { ...ready, actions: selection });
    expect(frame.actions).toHaveLength(2);
    expect(frame.actions[0].state).toBe("running");
    expect(JSON.stringify(frame.actions)).not.toContain("private");
    expect(JSON.stringify(frame.actions)).not.toContain("completionReason");
    // WorldModel owns public fields, not a second action history policy.
    expect(world.frame(bot, { ...ready, actions }).actions).toHaveLength(13);
  });
});
