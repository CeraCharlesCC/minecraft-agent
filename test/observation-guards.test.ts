import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

const require = createRequire(import.meta.url);
const UUID = "12345678-1234-1234-1234-123456789abc";

/** Actual entity/health plugins, without a network connection or physics timer. */
function runtime() {
  const registry = require("prismarine-registry")("1.20.4");
  const physicalLook = vi.fn(), packetWrites = vi.fn();
  const bot: any = Object.assign(new EventEmitter(), {
    registry, version: "1.20.4", supportFeature: registry.supportFeature, username: "Agent",
    game: { dimension: "overworld" }, inventory: { slots: [], items: () => [] },
    chat: vi.fn(), quit: vi.fn(), setControlState: vi.fn(), clearControlStates: vi.fn(), getControlState: () => false,
    lookAt: physicalLook,
    pathfinder: { movements: {}, setMovements: vi.fn(), setGoal: vi.fn(), stop: vi.fn(), goto: vi.fn(),
      isMoving: () => false, isMining: () => false, isBuilding: () => false },
    _client: Object.assign(new EventEmitter(), { username: "Agent", write: packetWrites }),
  });
  require("mineflayer/lib/plugins/entities.js")(bot);
  const physicalAttack = vi.spyOn(bot, "attack");
  require("mineflayer/lib/plugins/health.js")(bot, { respawn: false });
  // Apply position packets as physics does, without its asynchronous timer.
  bot._client.on("position", (packet: any) => {
    for (const [axis, bit] of [["x", 1], ["y", 2], ["z", 4]] as const)
      bot.entity.position[axis] = (packet.flags & bit ? bot.entity.position[axis] : 0) + packet[axis];
    bot.emit("move");
  });
  const controller = new BotController({ host: "localhost", port: 25565, username: "Agent", auth: "offline" }, new EventStore(), () => bot);
  controller.start();
  bot._client.emit("login", { entityId: 1 });
  bot._client.emit("update_health", { health: 20, food: 20, foodSaturation: 5 });
  const position = () => bot._client.emit("position", { x: 0, y: 64, z: 0, flags: 0 });
  const spawnCow = () => bot._client.emit("spawn_entity", { entityId: 7, objectUUID: UUID,
    type: registry.entitiesByName.cow.id, x: 3, y: 64, z: 0, yaw: 0, pitch: 0 });
  const air = (entityId: number, value: number) => bot._client.emit("entity_metadata", { entityId,
    metadata: [{ key: registry.entitiesByName.player.metadataKeys.indexOf("air_supply"), type: "varint", value }] });
  return { controller, bot, position, spawnCow, air, physicalLook, physicalAttack, packetWrites };
}

describe("observation provenance at the controller boundary", () => {
  it("keeps health-before-position ready state unknown and blocks physical operations", async () => {
    const { controller, bot, position, spawnCow, physicalLook, physicalAttack, packetWrites } = runtime();
    try {
      expect(controller.connectionStatus().ready).toBe(true);
      const frame = controller.frame({ detail: "full" });
      expect(frame.self).not.toHaveProperty("position");
      expect(frame.self).not.toHaveProperty("onGround");
      expect(frame.unknownFields).toContain("/self/position");
      spawnCow();
      const track = controller.world.trackFor(bot.entities[7])!;
      expect(() => controller.followTrack(track, 1)).toThrow(/absolute position/);
      expect(() => controller.trackLook(track)).toThrow(/absolute position/);
      await expect(controller.lookAt(3, 64, 0)).rejects.toThrow(/absolute position/);
      expect(() => controller.attackEntity(track, { allowPassive: true })).toThrow(/absolute position/);
      expect(physicalLook).not.toHaveBeenCalled(); expect(physicalAttack).not.toHaveBeenCalled();
      position();
      expect(controller.frame().self).toMatchObject({ position: { x: 0, y: 64, z: 0 } });
      expect(controller.actions.get(controller.followTrack(track, 1).action).state).toBe("running");
      expect(controller.attackEntity(track, { allowPassive: true })).toMatchObject({ attacked: true });
      expect(physicalAttack).toHaveBeenCalledExactlyOnceWith(bot.entities[7]);
      expect(packetWrites).toHaveBeenCalledWith("use_entity", expect.objectContaining({ target: 7, mouse: 1 }));
    } finally { controller.stop(); }
  });

  it("retains positionless placeholders and restores the same actionable handle after spawn", () => {
    const { controller, bot, position, spawnCow } = runtime();
    try {
      position();
      bot._client.emit("entity_metadata", { entityId: 7, metadata: [] });
      const first = controller.frame({ detail: "full" }).entities[0];
      expect(first).toMatchObject({ type: null, unknownFields: ["type", "position", "customName"] });
      expect(first).not.toHaveProperty("velocity"); expect(first).not.toHaveProperty("onGround");
      const track = first.trackId as string;
      bot._client.emit("rel_entity_move", { entityId: 7, dX: 4096, dY: 0, dZ: 0 });
      expect(controller.sample(track, ["position", "velocity"])).toMatchObject({ values: {}, unknownFields: ["position", "velocity"] });
      expect(() => controller.followTrack(track, 1)).toThrow(/absolute position/);
      spawnCow();
      expect(controller.frame().entities[0]).toMatchObject({ trackId: track, type: "minecraft:cow", position: { x: 3, y: 64, z: 0 } });
      const follow = controller.followTrack(track, 1);
      bot.entities[7].uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      bot.emit("physicsTick");
      expect(controller.actions.get(follow.action)).toMatchObject({ state: "failed", reason: "TRACK_LOST" });
      expect(() => controller.followTrack(track, 1)).toThrow(/lost/);
    } finally { controller.stop(); }
  });

  it("clears acquired self coordinates and oxygen on an eventless dimension change", () => {
    const { controller, bot, position, air } = runtime();
    try {
      position(); air(1, 300);
      expect(controller.frame().self.oxygenLevel).toBe(20);
      air(7, 75);
      expect(controller.frame().self.oxygenLevel).toBe(20);
      bot.game.dimension = "the_nether";
      expect(controller.frame().connection.ready).toBe(false);
      bot.emit("spawn");
      const reset = controller.frame();
      expect(reset.connection.ready).toBe(true);
      expect(reset.self).not.toHaveProperty("position"); expect(reset.self).not.toHaveProperty("oxygenLevel");
      expect(reset.unknownFields).toContain("/self/oxygenLevel");
      position(); air(1, 150);
      expect(controller.frame().self).toMatchObject({ position: { x: 0, y: 64, z: 0 }, oxygenLevel: 10 });
    } finally { controller.stop(); }
  });
});
