import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import { queryBlockRay } from "../src/daemon/ray-query.js";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

const require = createRequire(import.meta.url);
const World = require("prismarine-world")("1.20.4");
const Chunk = require("prismarine-chunk")("1.20.4");
const registry = require("prismarine-registry")("1.20.4");
const installRayPlugin = require("mineflayer/lib/plugins/ray_trace.js");

function fixture() {
  const world = new World().sync;
  world.setColumn(0, 0, new Chunk());
  const entity = { position: new Vec3(0.5, 64, 3.5), yaw: 0, pitch: 0, height: 1.6 };
  const placeStone = (position: Vec3) => world.setBlockStateId(position, registry.blocksByName.stone.defaultState);
  return { world, entity, placeStone };
}

describe("coverage-aware block ray query with installed world and block shapes", () => {
  it("uses zero angles as valid pose and projects only the public block", () => {
    const { world, entity, placeStone } = fixture();
    placeStone(new Vec3(0, 65, 1));
    const bot = Object.assign(new EventEmitter(), { entity, world, chat: vi.fn(), quit: vi.fn(), setControlState: vi.fn(), lookAt: vi.fn() });
    installRayPlugin(bot);
    expect((bot as any).blockAtCursor(2)).toBeNull();
    const controller = new BotController({ host: "localhost", port: 25565, username: "bot", auth: "offline" }, new EventStore(), () => bot);
    controller.start(); bot.emit("spawn");
    expect(controller.blockAtCursor(2)).toMatchObject({ known: true, block: { name: "stone", position: { x: 0, y: 65, z: 1 } } });
    expect(controller.blockAtCursor(2).block).not.toHaveProperty("shapes");
    expect(controller.blockAtCursor(2).block).not.toHaveProperty("intersect");
    expect(controller.blockInSight(4, 0.5)).toEqual(controller.blockAtCursor(2));
    controller.stop();
    expect(controller.blockAtCursor(2)).toEqual({ known: false });
  });

  it("serializes a known miss explicitly as block:null", () => {
    const { world, entity } = fixture();
    expect(JSON.parse(JSON.stringify(queryBlockRay(world, entity, 2)))).toEqual({ known: true, block: null });
  });

  it("does not skip an unloaded column to report a block beyond it", () => {
    const { world, entity, placeStone } = fixture();
    world.setColumn(2, 0, new Chunk());
    entity.position = new Vec3(0.5, 64, 0.5); entity.yaw = -Math.PI / 2;
    placeStone(new Vec3(32, 65, 0));
    expect(world.raycast(entity.position.offset(0, entity.height, 0), new Vec3(1, 0, 0), 40)?.name).toBe("stone");
    expect(queryBlockRay(world, entity, 40)).toEqual({ known: false });
    expect(queryBlockRay(world, entity, 8)).toEqual({ known: true, block: null });
  });

  it("returns a first hit without requiring loaded coverage behind it", () => {
    const { world, entity, placeStone } = fixture();
    entity.position = new Vec3(0.5, 64, 0.5); entity.yaw = -Math.PI / 2;
    placeStone(new Vec3(3, 65, 0));
    expect(queryBlockRay(world, entity, 40)).toMatchObject({ known: true, block: { name: "stone" } });
  });

  it("does not intersect the far side of a partial shape beyond range", () => {
    const { world, entity } = fixture();
    // This block's shape begins 0.75 along x, beyond the 0.6 ray even though its voxel is visited.
    const shapes: [number, number, number, number, number, number][] = [[0.75, 0, 0, 1, 1, 1]];
    const narrowWorld = { getBlock: (position: Vec3) => ({ shapes: position.x === 1 ? shapes : [] }) };
    entity.position = new Vec3(0.5, 64, 0.5); entity.yaw = -Math.PI / 2;
    expect(queryBlockRay(narrowWorld, entity, 0.6)).toEqual({ known: true, block: null });
    expect(queryBlockRay(narrowWorld, entity, 1.25)).toMatchObject({ known: true, block: { shapes } });
    expect(queryBlockRay(world, { ...entity, yaw: NaN }, 2)).toEqual({ known: false });
  });

  it("rejects unavailable pose, missing shapes, missing world and an unloaded first voxel", () => {
    const { world, entity } = fixture();
    expect(queryBlockRay(world, { ...entity, height: undefined }, 2)).toEqual({ known: false });
    expect(queryBlockRay(undefined, entity, 2)).toEqual({ known: false });
    expect(queryBlockRay({ getBlock: () => ({}) }, entity, 2)).toEqual({ known: false });
    expect(queryBlockRay(world, { ...entity, position: new Vec3(32.5, 64, 0.5) }, 2)).toEqual({ known: false });
  });

  it("keeps forward stair hits when another shape intersects behind the eye", () => {
    const { world, entity } = fixture();
    entity.position = new Vec3(0.5, 63, 0.75); entity.height = 1.5;
    world.setBlockStateId(new Vec3(0, 64, 0), registry.blocksByName.oak_stairs.defaultState);
    expect(queryBlockRay(world, entity, 1)).toMatchObject({ known: true, block: { name: "oak_stairs" } });
  });
});
