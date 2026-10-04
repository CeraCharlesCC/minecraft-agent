/** Synthetic comparison against the checked-in v2 implementation; no server connection. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventStore } from "../src/core/events.js";
import { WorldModel } from "../src/core/world.js";
import { projectAction } from "../src/core/actions.js";
import { encodeHandle } from "../src/core/handles.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineRevision = process.argv[2] ?? "b34c2668c4e37d92407b0e5049069cdc5a3a0c5f";
const runtime = "12345678-1234-4234-9234-123456789abc", ready = { connected: true, spawned: true };
const scratch = mkdtempSync(join(tmpdir(), "mc-agent-v3-measure-"));
let tokenize: ((text: string) => number) | undefined, tokenizer: string | undefined;
for (const name of ["js-tiktoken", "tiktoken"]) {
  try {
    const module = await import(name), encoding = module.get_encoding("o200k_base");
    tokenize = (text) => encoding.encode(text).length;
    tokenizer = `${name}:o200k_base`;
    break;
  } catch { /* Report tokenizer availability without installing a dependency. */ }
}

function fixture() {
  return { username: "Agent", game: { dimension: "overworld" }, health: 20, food: 20, oxygenLevel: 20,
    foodSaturation: 5, experience: { level: 0, points: 0, progress: 0 }, quickBarSlot: 0, heldItem: null as unknown,
    entity: { id: 0, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, equipment: Array(6).fill(null) },
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    players: {}, entities: {} as Record<string, any>, inventory: { slots: Array(46).fill(null) }, currentWindow: null as unknown };
}
function bytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value)); }
const rows: Record<string, unknown>[] = [];
function record(name: string, before: unknown, after: unknown) {
  const v2Bytes = bytes(before), v3Bytes = bytes(after);
  rows.push({ fixture: name, v2Bytes, v3Bytes, reductionPercent: Math.round((1 - v3Bytes / v2Bytes) * 1000) / 10,
    ...(tokenize ? { v2Tokens: tokenize(JSON.stringify(before)), v3Tokens: tokenize(JSON.stringify(after)) } : {}) });
}

try {
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
  symlinkSync(join(repository, "node_modules"), join(scratch, "node_modules"), "dir");
  for (const path of ["src/core/world.ts", "src/core/events.ts", "src/core/context.ts", "src/output/errors.ts"]) {
    const target = join(scratch, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync("git", ["show", `${baselineRevision}:${path}`], { cwd: repository }));
  }
  const legacyWorld = await import(pathToFileURL(join(scratch, "src/core/world.ts")).href);
  const legacyEvents = await import(pathToFileURL(join(scratch, "src/core/events.ts")).href);
  function worlds() {
    const oldEvents = new legacyEvents.EventStore(), newEvents = new EventStore();
    Object.defineProperty(oldEvents, "runtimeId", { value: runtime });
    Object.defineProperty(newEvents, "runtimeId", { value: runtime });
    return [new legacyWorld.WorldModel(oldEvents), new WorldModel(newEvents)] as const;
  }
  for (const name of ["empty_world", "normal_inventory", "12_entities", "target_kept", "unready"] as const) {
    const bot = fixture(), [oldWorld, newWorld] = worlds();
    if (name === "normal_inventory") for (const [slot, item, count] of [[36, "stone", 64], [37, "bread", 8], [38, "iron_pickaxe", 1]] as const) bot.inventory.slots[slot] = { name: item, count, slot };
    if (name === "12_entities" || name === "target_kept") for (let n = 1; n <= 12; n++) bot.entities[n] = { id: n, name: "cow", type: "mob", position: { x: n, y: 64, z: 0 } };
    const context = name === "unready" ? { connected: false, spawned: false } : ready;
    if (name === "target_kept") {
      const oldTarget = oldWorld.frame(bot, context).entities[11].trackId, newTarget = newWorld.frame(bot, context).entities[11].trackId;
      record(name, oldWorld.frame(bot, { ...context, actions: [{ action: `${runtime}:a1`, kind: "entity.follow", state: "running", target: oldTarget }] }, { maxEntities: 0 }),
        newWorld.frame(bot, { ...context, actions: [{ action: encodeHandle(runtime, "a", 1), kind: "entity.follow", state: "running", target: newTarget }] }, { maxEntities: 0 }));
    } else record(name, oldWorld.frame(bot, context), newWorld.frame(bot, context));
  }
  const bot = fixture(), [oldWorld, newWorld] = worlds();
  const oldBase = oldWorld.frame(bot, ready), newBase = newWorld.frame(bot, ready);
  bot.entity.position.x = 1;
  record("position_delta", oldWorld.frame(bot, ready, { since: oldBase.frame }), newWorld.frame(bot, ready, { since: newBase.frame }));
  const result = { completionReason: "within_range", goal: { x: 10, y: 64, z: 5, range: 1 }, finalPosition: { x: 9.5, y: 64, z: 5.5 }, distanceToGoal: Math.SQRT1_2 };
  // v2 goto settled with void: its smaller output did not contain arrival evidence.
  const action = { action: `${runtime}:a1`, runtimeId: runtime, worldEpoch: 1, kind: "navigate.goto", state: "completed" as const,
    startedAt: "2026-10-04T00:00:00.000Z", finishedAt: "2026-10-04T00:00:01.000Z", timedOut: false };
  record("navigation_success", action, projectAction({ ...action, result, action: encodeHandle(runtime, "a", 1) }));
  console.log(JSON.stringify({ baselineRevision, measurement: "UTF-8 bytes of direct responses; synthetic fixtures, no server or latency claim",
    tokenizer: tokenizer ?? "unavailable: no installed js-tiktoken or tiktoken; token counts omitted", rows }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
