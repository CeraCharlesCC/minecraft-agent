import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { installEntityObservation } from "../src/core/entity-observation.js";
import { EventStore } from "../src/core/events.js";
import { WorldModel, observedDroppedItem } from "../src/core/world.js";

const require = createRequire(import.meta.url);
const ready = { connected: true, spawned: true };
const UUID = "12345678-1234-1234-1234-123456789abc";
function fixture(version: string, species = "armor_stand") {
  const registry = require("prismarine-registry")(version);
  const bot: any = Object.assign(new EventEmitter(), { registry, version, supportFeature: registry.supportFeature,
    username: "Agent", game: { dimension: "overworld" }, players: {}, inventory: { slots: [] }, health: 20 });
  bot._client = Object.assign(new EventEmitter(), { username: bot.username, write() {} });
  require("mineflayer/lib/plugins/entities.js")(bot);
  installEntityObservation(bot);
  bot._client.emit("login", { entityId: 0 });
  const world = new WorldModel(new EventStore());
  for (const event of ["entitySpawn", "entityUpdate"]) bot.on(event, (entity: unknown) => world.updateEntity(bot, ready, entity));
  const spawn = (id = 7) => bot._client.emit("spawn_entity", { entityId: id, objectUUID: UUID,
    type: registry.entitiesByName[species].id, x: 3, y: 64, z: 0, yaw: 0, pitch: 0 });
  spawn();
  const metadata = (key: number, value: unknown) => bot._client.emit("entity_metadata", { entityId: 7, metadata: [{ key, value, type: key === 2 ? "optional_component" : "item_stack" }] });
  const name = (text: string) => version === "1.20.4" ? JSON.stringify({ text, extra: [{ text: " label", hoverEvent: { action: "show_text", contents: { text: "private name data" } } }] })
    : { type: "compound", value: { text: { type: "string", value: text }, extra: { type: "list", value: { type: "compound", value: [{ text: { type: "string", value: " label" }, secret: { type: "string", value: "private name data" } }] } } } };
  return { bot, world, metadata, name, spawn, registry, track: world.trackFor(bot.entities[7])! };
}

describe("dropped stack adapter", () => {
  it("rejects unavailable, malformed and unidentifiable getters", () => {
    for (const getDroppedItem of [undefined, () => undefined, () => null, () => ({}), () => ({ secret: "raw" }),
      () => ({ name: "diamond", count: 0 }), () => ({ name: "diamond", count: NaN }), () => { throw new Error("unreceived metadata"); }]) {
      expect(observedDroppedItem({ getDroppedItem })).toBeUndefined();
    }
  });
});

describe.each(["1.20.4", "1.21.4"])("entity meaning and inspect (%s)", version => {
  it("preserves JSON-looking visible names after the chat adapter rendered them", () => {
    const { bot, world, metadata } = fixture(version);
    const label = '{"text":"literal label"}';
    metadata(2, version === "1.20.4" ? JSON.stringify({ text: label })
      : { type: "compound", value: { text: { type: "string", value: label } } });
    expect(world.frame(bot, ready).entities[0].customName).toBe(label);
  });

  it("automatically observes received custom names and clears known name removal", () => {
    const { bot, world, metadata, name, track } = fixture(version);
    const initial = world.frame(bot, ready);
    expect(initial.entities[0].unknownFields).toContain("customName");
    metadata(2, name("ShopChest"));
    const named = world.frame(bot, ready, { since: initial.frame });
    expect(named.delta.changed.entities[0].customName).toBe("ShopChest label");
    expect(named.delta.changed.entities[0]).not.toHaveProperty("unknownFields");
    expect(world.searchLoaded(bot, ready).entities[0].customName).toBe("ShopChest label");
    expect(world.inspect(bot, ready, track).entity.customName).toBe("ShopChest label");
    expect(JSON.stringify(named)).not.toContain("private name data");
    metadata(2, null);
    const removed = world.frame(bot, ready, { since: named.frame });
    expect(removed.delta.changed.entities[0]).not.toHaveProperty("customName");
    expect(removed.delta.changed.entities[0]).not.toHaveProperty("unknownFields");
    expect(removed.delta.changed.entities[0]).toEqual(world.frame(bot, ready).entities[0]);
    expect(named.delta.changed.entities[0].customName).toBe("ShopChest label");
    expect(initial.entities[0]).not.toHaveProperty("customName");
  });

  it("projects the actual dropped stack and tracks count changes without raw data", () => {
    const { bot, world, metadata, name, registry, track } = fixture(version, "item");
    const Item = require("prismarine-item")(registry);
    const first = world.frame(bot, ready);
    expect(first.entities[0].unknownFields).toContain("item");
    const item = new Item(registry.itemsByName.diamond.id, 3, 0);
    item.customName = name("Payment");
    if (item.componentMap) item.components = [...item.componentMap.values()];
    metadata(registry.supportFeature("metadataIxOfItem"), Item.toNotch(item));
    const observed = world.frame(bot, ready, { since: first.frame });
    expect(observed.delta.changed.entities[0].item).toMatchObject({ name: "diamond", count: 3, customName: "Payment label" });
    expect(observedDroppedItem(bot.entities[7])).toMatchObject({ name: "diamond", count: 3 });
    expect(world.inspect(bot, ready, track).entity.item).toMatchObject({ name: "diamond", count: 3 });
    expect(JSON.stringify(observed)).not.toContain("private name data");
    expect(observed.delta.changed.entities[0]).not.toHaveProperty("metadata");
    item.count = 5;
    metadata(registry.supportFeature("metadataIxOfItem"), Item.toNotch(item));
    const updated = world.frame(bot, ready, { since: observed.frame });
    expect(updated.delta.changed.entities[0].item.count).toBe(5);
    expect(observed.delta.changed.entities[0].item.count).toBe(3);
    expect(first.entities[0]).not.toHaveProperty("item");
  });

  it("returns one curated entity, keeps equipment out of frames, and detaches results", () => {
    const { bot, world, metadata, name, registry, track } = fixture(version);
    const Item = require("prismarine-item")(registry);
    const sword = new Item(registry.itemsByName.diamond_sword.id, 1, 0);
    sword.customName = name("Blade");
    bot.entities[7].equipment[0] = sword;
    metadata(2, name("Vendor"));
    const frame = world.frame(bot, ready, { detail: "full" });
    const result = world.inspect(bot, ready, track);
    expect(result.context).toBe(frame.context);
    expect(result.connection).toEqual(frame.connection);
    expect(result.entity).toMatchObject({ trackId: track, type: "minecraft:armor_stand", customName: "Vendor label", position: { x: 3, y: 64, z: 0 } });
    expect(result.entity.equipment).toMatchObject({ 0: { name: "diamond_sword", customName: "Blade label" } });
    expect(result.entity.unknownFields).toContain("equipment");
    expect(frame.entities[0]).not.toHaveProperty("equipment");
    expect(world.searchLoaded(bot, ready).entities[0]).not.toHaveProperty("equipment");
    expect(result.entity).not.toHaveProperty("metadata");
    expect(result.entity).not.toHaveProperty("passengers");
    for (const field of ["uuid", "minecraftEntityId", "bindingGeneration", "worldEpoch", "firstSeen", "lastObservedAt"])
      expect(result.entity).not.toHaveProperty(field);
    sword.count = 2;
    expect(result.entity.equipment).toMatchObject({ 0: { count: 1 } });
    expect(world.inspect(bot, ready, track).entity.equipment).toMatchObject({ 0: { count: 2 } });
    delete bot.entities[7].equipment;
    expect(world.inspect(bot, ready, track).entity.unknownFields).toContain("equipment");
    bot.entities[7].equipment = [];
    expect(world.inspect(bot, ready, track).entity.equipment).toEqual({});
  });

  it("rejects lost bindings and does not retain old name/stack after reload", () => {
    const { bot, world, metadata, name, registry, track, spawn } = fixture(version, "item");
    const Item = require("prismarine-item")(registry);
    metadata(2, name("Old"));
    metadata(registry.supportFeature("metadataIxOfItem"), Item.toNotch(new Item(registry.itemsByName.diamond.id, 2, 0)));
    const inspected = world.inspect(bot, ready, track);
    delete bot.entities[7];
    expect(() => world.inspect(bot, ready, track)).toThrow(expect.objectContaining({ code: "TRACK_LOST" }));
    const lost = world.frame(bot, ready, { tracks: [track] }).entities[0];
    expect(lost.status).toBe("lost");
    expect(lost).not.toHaveProperty("customName");
    expect(lost).not.toHaveProperty("item");
    spawn(17);
    const reloaded = world.inspect(bot, ready, track).entity;
    expect(reloaded.unknownFields).toEqual(["customName", "item", "equipment"]);
    expect(reloaded).not.toHaveProperty("customName");
    expect(reloaded).not.toHaveProperty("item");
    expect(inspected.entity.item).toMatchObject({ count: 2 });
    expect(() => world.inspect(bot, { connected: false, spawned: false }, track)).toThrow(expect.objectContaining({ code: "TRACK_LOST" }));
  });
});
