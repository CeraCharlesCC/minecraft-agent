import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/events.js";
import { WorldModel } from "../src/core/world.js";
import { installSelfOxygen } from "../src/daemon/self-oxygen.js";

const require = createRequire(import.meta.url);
function installedBot(version: string, installBeforePlugins: boolean) {
  const registry = require("prismarine-registry")(version);
  const bot: any = Object.assign(new EventEmitter(), {
    registry, supportFeature: registry.supportFeature, version,
    _client: Object.assign(new EventEmitter(), { username: "Agent", write() {} }),
  });
  const oxygen = installBeforePlugins ? installSelfOxygen(bot) : undefined;
  require("mineflayer/lib/plugins/entities.js")(bot, {});
  require("mineflayer/lib/plugins/breath.js")(bot, {});
  const adapter = oxygen ?? installSelfOxygen(bot);
  bot._client.emit("login", { entityId: 1 });
  const Entity = require("prismarine-entity")(registry);
  bot.entities[2] = Object.assign(new Entity(2), { name: "cow", type: "mob" });
  const airIndex = registry.supportFeature("mcDataHasEntityMetadata")
    ? registry.entitiesByName.player.metadataKeys.indexOf("air_supply") : 1;
  function metadata(entityId: number, value: unknown) {
    bot._client.emit("entity_metadata", { entityId, metadata: [{ key: airIndex, type: "varint", value }] });
  }
  return { bot, adapter, metadata };
}

describe("self-only oxygen adapter with installed Mineflayer plugins", () => {
  it.each(["1.12.2", "1.20.4", "1.21.1", "1.21.5", "1.21.11"])("keeps %s oxygen sourced from self across resets", version => {
    const { bot, adapter, metadata } = installedBot(version, true);
    const frame = () => new WorldModel(new EventStore()).frame(bot, { connected: true, spawned: true });
    metadata(2, 75);
    expect(bot.oxygenLevel).toBeUndefined();
    expect(frame().unknownFields).toContain("/self/oxygenLevel");
    metadata(1, 300);
    expect(bot.oxygenLevel).toBe(20);
    const duringBreath: unknown[] = [];
    bot.on("breath", () => duringBreath.push(bot.oxygenLevel));
    metadata(2, 75);
    expect(bot.oxygenLevel).toBe(20);
    // Observe self packets too: versions that emit no breath event for other
    // entities still exercise the value exposed synchronously to subscribers.
    metadata(1, 300);
    expect(duringBreath.length).toBeGreaterThan(0);
    expect(duringBreath).toEqual(Array(duringBreath.length).fill(20));
    expect(frame().self.oxygenLevel).toBe(20);
    metadata(1, 150);
    expect(frame().self.oxygenLevel).toBe(10);
    adapter.reset();
    metadata(2, 300);
    expect(bot.oxygenLevel).toBeUndefined();
    metadata(1, 285);
    expect(bot.oxygenLevel).toBe(19);
    adapter.dispose();
    adapter.dispose();
    expect(bot).not.toHaveProperty("oxygenLevel");
    metadata(1, 150);
    expect(bot.oxygenLevel).toBe(10);
  });

  it("also works when installed after plugins and does not manufacture finite values", () => {
    const { bot, adapter, metadata } = installedBot("1.21.5", false);
    metadata(1, NaN);
    metadata(2, 150);
    expect(bot.oxygenLevel).toBeUndefined();
    metadata(1, 300);
    metadata(1, "bad");
    expect(bot.oxygenLevel).toBe(20);
    adapter.dispose();
  });
});
