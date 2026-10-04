import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { installEntityObservation, observedEntityPosition } from "../src/core/entity-observation.js";
import { WorldModel } from "../src/core/world.js";
import { EventStore } from "../src/core/events.js";

const require = createRequire(import.meta.url);
const ready = { connected: true, spawned: true };
const UUID = "12345678-1234-1234-1234-123456789abc";
const OTHER_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function livePlugin(version = "1.20.4") {
  const registry = require("prismarine-registry")(version);
  const bot: any = Object.assign(new EventEmitter(), { registry, version, supportFeature: registry.supportFeature,
    username: "Agent", game: { dimension: "overworld" }, players: {}, inventory: { slots: [] }, health: 20 });
  bot._client = Object.assign(new EventEmitter(), { username: bot.username, write() {} });
  require("mineflayer/lib/plugins/entities.js")(bot);
  // Use the same resulting position semantics as physics without starting its timer.
  bot._client.on("position", (packet: any) => {
    const flags = typeof packet.flags === "number" ? packet.flags : (packet.flags.x ? 1 : 0) | (packet.flags.y ? 2 : 0) | (packet.flags.z ? 4 : 0);
    for (const [axis, bit] of [["x", 1], ["y", 2], ["z", 4]] as const) bot.entity.position[axis] = (flags & bit ? bot.entity.position[axis] : 0) + packet[axis];
  });
  installEntityObservation(bot);
  bot._client.emit("login", { entityId: 0 });
  bot._client.emit("position", { x: 0, y: 64, z: 0, flags: 0 });
  bot.emit("spawn");
  const events = new EventStore(), world = new WorldModel(events);
  for (const event of ["entitySpawn", "entityMoved", "entityUpdate", "entitySleep"]) bot.on(event, (entity: unknown) => world.updateEntity(bot, ready, entity));
  return { bot, world, events };
}
function metadata(bot: any, id = 7) {
  bot._client.emit("entity_metadata", { entityId: id, metadata: [{ key: 0, type: "byte", value: 0 }] });
}
function spawn(bot: any, id = 7, uuid = UUID, name = "cow", position = { x: 3, y: 64, z: 0 }) {
  bot._client.emit("spawn_entity", { entityId: id, objectUUID: uuid, type: bot.registry.entitiesByName[name].id,
    ...position, yaw: 0, pitch: 0 });
}

describe("entity observation provenance and late identity", () => {
  it("keeps metadata placeholders visible but positionless through relative-only packets", () => {
    const { bot, world, events } = livePlugin();
    metadata(bot);
    const first = world.frame(bot, ready);
    expect(first.entities).toHaveLength(1);
    expect(first.entities[0]).toMatchObject({ type: null, unknownFields: ["type", "position"] });
    expect(first.entities[0]).not.toHaveProperty("position");
    expect(first.entities[0]).not.toHaveProperty("distance");
    bot._client.emit("rel_entity_move", { entityId: 7, dX: 4096, dY: 0, dZ: 0 });
    bot._client.emit("entity_move_look", { entityId: 7, dX: 4096, dY: 0, dZ: 0, yaw: 0, pitch: 0 });
    expect(observedEntityPosition(bot.entities[7])).toBeUndefined();
    expect(world.frame(bot, ready, { since: first.frame }).delta.changed.entities).toEqual([]);
    expect(events.query(0).events.some((event: any) => event.type === "entity.entered_nearby")).toBe(false);
    spawn(bot);
    const restored = world.frame(bot, ready, { since: first.frame }).delta.changed.entities[0];
    expect(restored).toMatchObject({ trackId: first.entities[0].trackId, type: "minecraft:cow", name: "cow", position: { x: 3, y: 64, z: 0 }, distance: 3 });
    expect(restored).not.toHaveProperty("unknownFields");
    expect(world.frame(bot, ready, { maxEntities: 0 }).projection.aggregates).toEqual({ "minecraft:cow": 1 });
    expect(world.searchLoaded(bot, ready, { name: "cow", type: "animal", types: undefined }).entities).toHaveLength(1);
    expect(world.searchLoaded(bot, ready, { types: ["cow"] }).entities).toEqual(world.searchLoaded(bot, ready, { types: ["minecraft:cow"] }).entities);
    const full = world.frame(bot, ready, { detail: "full" }).entities[0];
    expect(full).toMatchObject({ kind: "animal", uuid: UUID.replaceAll("-", "") });
    delete bot.entities[7]; world.frame(bot, ready);
    spawn(bot, 17);
    expect(world.frame(bot, ready).entities[0].trackId).toBe(first.entities[0].trackId);
  });

  it.each(["entity_teleport", "sync_entity_position"])("accepts %s as absolute evidence before the synchronous movement observer", packet => {
    const { bot, world } = livePlugin(packet === "sync_entity_position" ? "1.21.4" : "1.20.4");
    // No spawn: this packet itself creates the Prismarine entity.
    bot._client.emit(packet, { entityId: 7, x: 4, y: 64, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0 });
    expect(world.searchLoaded(bot, ready).entities[0]).toMatchObject({ type: null, position: { x: 4, y: 64, z: 0 }, distance: 4, unknownFields: ["type"] });
    bot._client.emit("rel_entity_move", { entityId: 7, dX: 4096, dY: 0, dZ: 0 });
    expect(observedEntityPosition(bot.entities[7])).toEqual({ x: 5, y: 64, z: 0 });
  });

  it("accepts a real zero position and never publishes minecraft:unknown", () => {
    const { bot, world } = livePlugin();
    spawn(bot, 7, UUID, "cow", { x: 0, y: 0, z: 0 });
    expect(observedEntityPosition(bot.entities[7])).toEqual({ x: 0, y: 0, z: 0 });
    bot._client.emit("spawn_entity", { entityId: 8, objectUUID: OTHER_UUID, type: 999999, x: 1, y: 64, z: 0, yaw: 0, pitch: 0 });
    const entity = world.searchLoaded(bot, ready).entities.find((value: any) => value.name === "unknown");
    expect(entity).toMatchObject({ type: null, unknownFields: ["type"] });
    expect(world.frame(bot, ready, { maxEntities: 0 }).projection.aggregates).toMatchObject({ unknown: 1 });
  });

  it("refreshes late player identity without changing the track handle", () => {
    const { bot, world } = livePlugin();
    metadata(bot);
    const track = world.frame(bot, ready).entities[0].trackId;
    Object.assign(bot.entities[7], { type: "player", name: "player", username: "Alex", uuid: UUID });
    bot._client.emit("entity_teleport", { entityId: 7, x: 2, y: 64, z: 0, yaw: 0, pitch: 0 });
    expect(world.frame(bot, ready, { detail: "full" }).entities[0]).toMatchObject({ trackId: track, name: "player", username: "Alex", kind: "player", uuid: UUID.replaceAll("-", "") });
    expect(world.playerIdentity(UUID)).toMatchObject({ username: "Alex", trackId: track });
  });

  it("invalidates a confirmed UUID change immediately, including before a new frame", () => {
    const { bot, world } = livePlugin();
    spawn(bot);
    const old = world.frame(bot, ready).entities[0].trackId;
    const lost = vi.fn(); world.onTrackLost = lost;
    bot.entities[7].uuid = OTHER_UUID;
    expect(() => world.resolveTrack(old)).toThrow(expect.objectContaining({ code: "TRACK_LOST" }));
    expect(lost).toHaveBeenCalledWith(old);
    const replacement = world.frame(bot, ready).entities[0].trackId;
    expect(replacement).not.toBe(old);
    expect(world.resolveTrack(replacement)).toBe(bot.entities[7]);
  });

  it("does not let initial or late UUID collisions steal another active binding", () => {
    const { bot, world } = livePlugin();
    spawn(bot);
    const primary = world.frame(bot, ready).entities[0].trackId;
    spawn(bot, 8);
    const secondary = world.trackFor(bot.entities[8]);
    expect(secondary).not.toBe(primary);
    expect(world.resolveTrack(primary)).toBe(bot.entities[7]);
    metadata(bot, 9);
    const late = world.trackFor(bot.entities[9]);
    spawn(bot, 9);
    expect(world.trackFor(bot.entities[9])).toBe(late);
    expect(world.resolveTrack(primary)).toBe(bot.entities[7]);
    // The primary still owns the UUID index when concurrent collision objects disappear.
    delete bot.entities[8]; delete bot.entities[9]; world.frame(bot, ready);
    delete bot.entities[7]; world.frame(bot, ready);
    spawn(bot, 10);
    expect(world.trackFor(bot.entities[10])).toBe(primary);
  });

  it("keeps a remaining collision binding active when the primary unloads", () => {
    const { bot, world } = livePlugin();
    spawn(bot); spawn(bot, 8);
    const secondary = world.trackFor(bot.entities[8])!;
    delete bot.entities[7]; world.frame(bot, ready);
    spawn(bot, 9);
    expect(world.trackFor(bot.entities[9])).not.toBe(secondary);
    expect(world.resolveTrack(secondary)).toBe(bot.entities[8]);
    delete bot.entities[9]; world.frame(bot, ready);
    delete bot.entities[8]; world.frame(bot, ready);
    spawn(bot, 10);
    expect(world.trackFor(bot.entities[10])).toBe(secondary);
  });

  it("retains explicit plain adapter observations but distrusts adapterless Prismarine defaults", () => {
    const Entity = require("prismarine-entity")("1.20.4");
    const placeholder = new Entity(1);
    placeholder.position.set(12, 64, 0); // Could have arisen from relative-only packets.
    expect(observedEntityPosition(placeholder)).toBeUndefined();
    expect(observedEntityPosition({ position: { x: 0, y: 0, z: 0 } })).toEqual({ x: 0, y: 0, z: 0 });
    const bot: any = new EventEmitter(); bot._client = new EventEmitter();
    const cleanup = installEntityObservation(bot);
    expect(installEntityObservation(bot)).toBe(cleanup);
    cleanup();
    expect(bot.listenerCount("entitySpawn")).toBe(0);
    expect(bot._client.listenerCount("entity_teleport")).toBe(0);
  });

  it.each(["legacy", "modern"])("requires actual self position evidence through %s flags, including health-before-position", format => {
    const { bot, world } = livePlugin();
    const flags = (mask: number) => format === "legacy" ? mask : { x: Boolean(mask & 1), y: Boolean(mask & 2), z: Boolean(mask & 4) };
    bot.emit("respawn");
    bot.entity.position.set(0, 0, 0);
    bot.emit("spawn");
    expect(observedEntityPosition(bot.entity)).toBeUndefined();
    expect(world.frame(bot, ready).self).not.toHaveProperty("position");
    bot._client.emit("position", { x: 1, y: 2, z: 3, flags: flags(7) });
    expect(observedEntityPosition(bot.entity)).toBeUndefined();
    bot._client.emit("position", { x: 4, y: 1, z: 1, flags: flags(6) });
    expect(observedEntityPosition(bot.entity)).toBeUndefined();
    bot._client.emit("position", { x: 1, y: 64, z: 0, flags: flags(1) });
    expect(observedEntityPosition(bot.entity)).toEqual({ x: 5, y: 64, z: 0 });
    bot.emit("death"); bot.emit("spawn");
    expect(observedEntityPosition(bot.entity)).toBeUndefined();
  });

  it("handles createBot installation before Mineflayer's asynchronous plugin injection", () => {
    const registry = require("prismarine-registry")("1.20.4");
    const bot: any = Object.assign(new EventEmitter(), { registry, version: "1.20.4", supportFeature: registry.supportFeature, players: {} });
    bot._client = Object.assign(new EventEmitter(), { write() {} });
    // The real plugin loader is registered before installEntityObservation.
    bot.once("inject_allowed", () => require("mineflayer/lib/plugins/entities.js")(bot));
    installEntityObservation(bot);
    bot.on("entityMoved", (entity: any) => expect(observedEntityPosition(entity)).toEqual(entity.id === 7 ? { x: 4, y: 64, z: 0 } : undefined));
    bot.emit("inject_allowed");
    bot._client.emit("entity_teleport", { entityId: 7, x: 4, y: 64, z: 0, yaw: 0, pitch: 0 });
    metadata(bot, 8);
    bot._client.emit("rel_entity_move", { entityId: 8, dX: 4096, dY: 0, dZ: 0 });
    expect(observedEntityPosition(bot.entities[8])).toBeUndefined();
  });
});
