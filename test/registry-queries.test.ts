import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";

function fixture() {
  const item = { name: "stone", displayName: "Stone", count: 4, slot: 36 };
  const recipe = { id: "stone", result: { count: 1 } };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: { stone: { id: 1 } }, itemsByName: { stone: { id: 1 } } },
    inventory: { items: () => [item] },
    chat: vi.fn(), quit: vi.fn(), setControlState: vi.fn(), lookAt: vi.fn(), equip: vi.fn(), toss: vi.fn(),
    findBlocks: vi.fn(() => [new Vec3(1, 64, 1)]), recipesFor: vi.fn(() => [recipe]), craft: vi.fn(),
    currentWindow: { deposit: vi.fn(), withdraw: vi.fn(), close: vi.fn() },
    blockAt: vi.fn<(position: Vec3) => { name: string; type: number; position: Vec3 } | null | undefined>(() => undefined),
  });
  const equip = bot.equip;
  const controller = new BotController({ host: "localhost", port: 25565, username: "bot", auth: "offline" }, new EventStore(), () => bot);
  controller.start(); bot.emit("spawn");
  return { bot, controller, item, recipe, equip };
}

describe("registry identifier aliases at block and inventory query boundaries", () => {
  it("finds the same block and echoes canonical names", () => {
    const { bot, controller } = fixture();
    for (const name of ["minecraft:stone", "stone"]) {
      expect(controller.findBlocks(name, 16, 4)).toEqual({ blocks: [{ name: "stone", position: { x: 1, y: 64, z: 1 } }] });
      expect(bot.findBlocks).toHaveBeenLastCalledWith({ matching: 1, maxDistance: 16, count: 4 });
    }
    expect(controller.blockAt(0, 64, 0)).toEqual({ known: false });
    controller.stop();
  });

  it("inspects a loaded block with available dig facts and reports unavailable coverage consistently", () => {
    const { bot, controller } = fixture();
    const block = { name: "stone", type: 1, position: new Vec3(1, 64, 2) };
    bot.blockAt.mockReturnValue(block);
    Object.assign(bot, { canDigBlock: () => true, digTime: () => 250 });
    expect(controller.blockAt(1, 64, 2)).toMatchObject({ known: true, block: { name: "stone", position: { x: 1, y: 64, z: 2 } }, canDig: true, digTimeMs: 250 });
    Object.assign(bot, { canDigBlock: undefined, digTime: undefined });
    const basic = controller.blockAt(1, 64, 2);
    expect(basic).toMatchObject({ known: true, block: { name: "stone" } });
    expect(basic).not.toHaveProperty("canDig"); expect(basic).not.toHaveProperty("digTimeMs");
    bot.blockAt.mockReturnValue(null);
    expect(controller.blockAt(1, 64, 2)).toEqual({ known: false });
    bot.blockAt.mockReturnValue(undefined);
    expect(controller.blockAt(1, 64, 2)).toEqual({ known: false });
    controller.stop();
    expect(controller.blockAt(1, 64, 2)).toEqual({ known: false });
  });

  it("normalizes inventory selection, recipes, crafting, toss and container transfers", async () => {
    const { bot, controller, item, recipe, equip } = fixture();
    expect(await controller.equip("minecraft:stone", "hand")).toMatchObject({ equipped: "stone" });
    expect(equip).toHaveBeenLastCalledWith(item, "hand");
    expect(await controller.equip("Stone", "hand")).toMatchObject({ equipped: "stone" });
    expect(equip).toHaveBeenLastCalledWith(item, "hand");
    for (const name of ["minecraft:stone", "stone"]) {
      expect(controller.recipes(name, 1)).toEqual({ item: "stone", recipes: [{ index: 0, id: "stone", result: { count: 1 } }] });
      expect(bot.recipesFor).toHaveBeenLastCalledWith(1, null, 1, null);
    }
    expect(await controller.craft("minecraft:stone", 1)).toMatchObject({ crafted: "stone" });
    expect(bot.craft).toHaveBeenLastCalledWith(recipe, 1, undefined);
    expect(await controller.toss("minecraft:stone", 1)).toEqual({ tossed: "stone", count: 1 });
    expect(bot.toss).toHaveBeenLastCalledWith(1, null, 1);
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
