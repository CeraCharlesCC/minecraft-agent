import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotController } from "../src/daemon/bot.js";
import { EventStore } from "../src/core/events.js";
import { buildProgram } from "../src/cli/program.js";
import type { CliHandlers } from "../src/cli/handlers.js";
import { validateSurroundingsOptions } from "../src/core/surroundings-input.js";

class Output extends Writable {
  text = "";
  _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString(); done(); }
}
function cli() {
  const observeSurroundings = vi.fn(async () => ({ type: "surroundings" }));
  const stdout = new Output();
  const program = buildProgram({ observeSurroundings } as unknown as CliHandlers, { stdout, stderr: new Output(), isStdoutTty: false });
  program.exitOverride();
  return { observeSurroundings, stdout, run: (...args: string[]) => program.parseAsync(["node", "mc-agent", "observe", "surroundings", ...args]) };
}
function runtime() {
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: { x: -0.25, y: 64, z: 0.5 }, height: 1.6, yaw: 0, pitch: 0 },
    game: { dimension: "overworld" },
    world: { getBlock: vi.fn(() => ({ name: "air", shapes: [] })) },
    chat: vi.fn(), quit: vi.fn(), setControlState: vi.fn(), lookAt: vi.fn(),
  });
  const controller = new BotController({ host: "localhost", port: 25565, username: "Agent", auth: "offline" }, new EventStore(), () => bot);
  controller.start();
  return { bot, controller };
}
afterEach(() => vi.unstubAllEnvs());

describe("surroundings interface", () => {
  it("parses defaults, detail, and inclusive world-axis bounds", async () => {
    vi.stubEnv("MC_AGENT_CLIENT_ID", "");
    delete process.env.MC_AGENT_CLIENT_ID;
    const first = cli();
    await first.run();
    expect(first.observeSurroundings).toHaveBeenCalledWith({ session: "default", range: 32, detail: false });
    const focused = cli();
    await focused.run("--session", "mine", "--range", "12", "--detail", "--bounds=-4,-2,-4:4,5,4");
    expect(focused.observeSurroundings).toHaveBeenCalledWith({ session: "mine", range: 12, detail: true, bounds: { min: [-4, -2, -4], max: [4, 5, 4] } });
  });

  it.each([["--range", "33"], ["--range", "0"], ["--range", "NaN"], ["--bounds", "0,0,0:-1,1,1"], ["--bounds", "0,0:1,1,1"]])("rejects invalid CLI scan options %j", async (...args) => {
    delete process.env.MC_AGENT_CLIENT_ID;
    const subject = cli();
    await expect(subject.run(...args)).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(subject.observeSurroundings).not.toHaveBeenCalled();
  });

  it("requires readiness and known eye height without rotating or mutating the bot", () => {
    const { bot, controller } = runtime();
    try {
      expect(() => controller.surroundings()).toThrow(expect.objectContaining({ code: "NOT_READY" }));
      bot.emit("spawn");
      const lookAt = vi.spyOn(bot, "lookAt");
      const first = controller.surroundings({ range: 2 });
      bot.entity.yaw = 1.9; bot.entity.pitch = -0.6;
      const second = controller.surroundings({ range: 2, bounds: { min: [-1, -1, -1], max: [1, 3, 1] } });
      expect(first).toMatchObject({ type: "surroundings", fresh: true, position: { x: -0.25, y: 64, z: 0.5 }, dimension: "overworld", connection: { ready: true }, blockOrigin: [-1, 64, 0], eyeOrigin: [-0.25, 65.6, 0.5] });
      expect(second.blockOrigin).toEqual(first.blockOrigin);
      expect(second.eyeOrigin).toEqual(first.eyeOrigin);
      expect(second.scanId).not.toBe(first.scanId);
      expect(second.context).toBe(first.context);
      expect(Number.isFinite(Date.parse(first.observedAt))).toBe(true);
      expect(first.budget.outputBytes).toBe(Buffer.byteLength(JSON.stringify(first)));
      expect(first.budget.outputBytes).toBeLessThanOrEqual(first.budget.maxOutputBytes);
      expect(lookAt).not.toHaveBeenCalled();
      expect(controller.frame()).not.toHaveProperty("patches");
      bot.entity.height = NaN;
      expect(() => controller.surroundings()).toThrow(expect.objectContaining({ code: "COMMAND_BLOCKED" }));
    } finally { controller.stop(); }
  });

  it("discards results after a world change during acquisition", () => {
    const { bot, controller } = runtime();
    try {
      bot.emit("spawn");
      bot.world.getBlock.mockImplementationOnce(() => {
        bot.game.dimension = "the_nether";
        return { name: "air", shapes: [] };
      });
      expect(() => controller.surroundings({ range: 1 })).toThrow(expect.objectContaining({ code: "WORLD_CHANGED" }));
    } finally { controller.stop(); }
  });

  it("bounds the full response including context metadata when detailed surfaces overflow", () => {
    const { bot, controller } = runtime();
    Object.assign(bot, { world: { getBlock: (p: { x: number; y: number; z: number }) =>
      p.y <= 63 || p.y >= 76 || Math.abs(p.x) >= 12 || Math.abs(p.z) >= 12
        ? { name: "stone", shapes: [[0, 0, 0, 1, 1, 1]] } : { name: "air", shapes: [] } } });
    try {
      bot.emit("spawn");
      const result = controller.surroundings({ detail: true });
      const bytes = Buffer.byteLength(JSON.stringify(result));
      expect(result.budget.outputTruncated).toBe(true);
      expect(result.budget.omittedBlocks).toBeGreaterThan(0);
      expect(result.budget.outputBytes).toBe(bytes);
      expect(bytes).toBeLessThanOrEqual(result.budget.maxOutputBytes);
    } finally { controller.stop(); }
  });

  it("validates direct callers without accepting internal budget overrides", () => {
    expect(validateSurroundingsOptions({ maxRays: 1000000 })).toEqual({ range: 32, detail: false });
    for (const value of [null, [], { range: Infinity }, { detail: "false" }, { bounds: { min: [0.5, 0, 0], max: [1, 1, 1] } }]) {
      expect(() => validateSurroundingsOptions(value)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
  });
});
