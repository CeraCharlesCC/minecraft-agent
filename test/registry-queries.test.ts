import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

function fixture() {
  const item = { name: "stone", displayName: "Stone", count: 4, slot: 36 };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: { stone: { id: 1 } }, itemsByName: { stone: { id: 1 } } },
    inventory: { items: () => [item] },
    chat: vi.fn(), quit: vi.fn(), setControlState: vi.fn(), lookAt: vi.fn(), equip: vi.fn(), toss: vi.fn(),
    findBlocks: vi.fn(() => [new Vec3(1, 64, 1)]), recipesFor: vi.fn(() => [{ id: "stone", result: { count: 1 } }]), craft: vi.fn(),
    currentWindow: { deposit: vi.fn(), withdraw: vi.fn(), close: vi.fn() },
    blockAt: vi.fn(() => undefined),
  });
  const controller = new BotController({ host: "localhost", port: 25565, username: "bot", auth: "offline" }, new EventStore(), () => bot);
  controller.start(); bot.emit("spawn");
  return { bot, controller };
}

describe("registry identifier aliases at block and inventory query boundaries", () => {
  it("finds the same block and echoes canonical names", () => {
    const { bot, controller } = fixture();
    expect(controller.findBlocks("minecraft:stone", 16, 4)).toEqual(controller.findBlocks("stone", 16, 4));
    expect(controller.findBlocks("minecraft:stone", 16, 4)).toMatchObject({ blocks: [{ name: "stone" }] });
    expect(bot.findBlocks).toHaveBeenCalledWith({ matching: 1, maxDistance: 16, count: 4 });
    expect(controller.blockAt(0, 64, 0)).toEqual({ known: false });
    controller.stop();
  });

  it("normalizes inventory selection, recipes, crafting, toss and container transfers", async () => {
    const { bot, controller } = fixture();
    expect(await controller.equip("minecraft:stone", "hand")).toMatchObject({ equipped: "stone" });
    expect(await controller.equip("Stone", "hand")).toMatchObject({ equipped: "stone" });
    expect(controller.recipes("minecraft:stone", 1)).toEqual(controller.recipes("stone", 1));
    expect(await controller.craft("minecraft:stone", 1)).toMatchObject({ crafted: "stone" });
    expect(await controller.toss("minecraft:stone", 1)).toEqual({ tossed: "stone", count: 1 });
    expect(await controller.windowDeposit("minecraft:stone", 1)).toMatchObject({ deposited: "stone" });
    expect(await controller.windowWithdraw("minecraft:stone", 1)).toMatchObject({ withdrew: "stone" });
    expect(bot.currentWindow.deposit).toHaveBeenCalledWith(1, null, 1);
    expect(bot.currentWindow.withdraw).toHaveBeenCalledWith(1, null, 1);
    controller.stop();
  });

  it.each(["mod:stone", "minecraft:", "minecraft:stone:extra", "unknown", "__proto__", "constructor"])("rejects invalid or unavailable registry name %s", async name => {
    const { controller } = fixture();
    expect(() => controller.findBlocks(name, 16, 4)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    expect(() => controller.recipes(name, 1)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    await expect(controller.toss(name, 1)).rejects.toMatchObject({ code: "BAD_INPUT" });
    if (name.includes(":")) await expect(controller.equip(name, "hand")).rejects.toMatchObject({ code: "BAD_INPUT" });
    controller.stop();
  });
});
