import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import { describe, expect, it } from "vitest";
import { compressSurfaces, scanSurroundings, type ObservedBlock, type SurroundingsBlock, type SurroundingsOptions } from "../src/daemon/surroundings.js";
const CUBE: [number, number, number, number, number, number] = [0, 0, 0, 1, 1, 1];
const air = { name: "air", shapes: [] };
const pose = { position: { x: 0.5, y: 0, z: 0.5 }, height: 1.5 };
const block = (name = "stone"): SurroundingsBlock => ({ name, shapes: [CUBE] });
const world = (at: (p: Vec3) => SurroundingsBlock | null) => ({ getBlock: at });
const scan = (at: (p: Vec3) => SurroundingsBlock | null, options: SurroundingsOptions = {}) => scanSurroundings(world(at), pose, { range: 8, maxRays: 4096, maxOutputBytes: 1048576, ...options });
function expand(result: ReturnType<typeof scanSurroundings>): string[] {
  const records = new Set<string>();
  for (const p of result.patches ?? []) for (let x = p.min[0]; x <= p.max[0]; x++) for (let y = p.min[1]; y <= p.max[1]; y++) for (let z = p.min[2]; z <= p.max[2]; z++) records.add(`${x},${y},${z}:${result.palette[p.material]}:${p.face}`);
  for (const b of result.blocks ?? result.partialBlocks ?? []) {
    for (const f of b.faces) records.add(`${b.position.join(",")}:${result.palette[b.material]}:${f}`);
    for (const s of b.shapes ?? []) for (const f of s.faces) records.add(`${b.position.join(",")}:${result.palette[b.material]}:${s.bounds.join(",")}:${f}`);
  }
  return [...records].sort();
}

describe("synthetic bounded surroundings surfaces", () => {
  it.each(["stone", "bedrock", "barrier"])("never observes behind terminating %s and filters after occlusion", name => {
    const at = (p: Vec3) => p.x === 2 ? block(name) : p.x === 4 ? block("raw_iron_block") : air;
    const result = scan(at);
    expect(result.palette).toContain(name);
    expect(result.palette).not.toContain("raw_iron_block");
    expect(scan(at, { bounds: { min: [4, -2, -2], max: [4, 4, 2] } }).palette).toEqual([]);
  });

  it("retains glass and water foreground layers and explicitly bounds further observation", () => {
    const at = (p: Vec3) => p.x === 1 ? block("glass") : p.x === 2 ? block("water") : p.x === 3 ? block("raw_iron_block") : air;
    expect(scan(at).palette).toEqual(["glass", "raw_iron_block", "water"]);
    const limited = scan(at, { maxTransparentLayers: 2 });
    expect(limited.palette).toEqual(["glass", "water"]);
    expect(limited.coverage.layerLimitRays).toBeGreaterThan(0);
  });

  it("terminates unloaded coverage and exposes bounded unknown samples", () => {
    const result = scan(p => p.x === 2 ? null : p.x === 4 ? block("raw_iron_block") : air);
    expect(result.palette).not.toContain("raw_iron_block");
    expect(result.coverage.unknownRays).toBeGreaterThan(0);
    expect(result.coverage.unknownBoundaryCells).toBeGreaterThan(16);
    expect(result.coverage.unknownBoundarySample).toHaveLength(16);
    expect(result.coverage.unknownBoundarySampleTruncated).toBe(true);
  });

  it("uses shape-aware slabs and permits sight through their open upper halves", () => {
    const result = scan(p => p.x === 2 && p.y === 1 ? { name: "stone_slab", shapes: [[0, 0, 0, 1, 0.25, 1]] } : p.x === 4 ? block("raw_iron_block") : air);
    expect(result.palette).toContain("raw_iron_block");
    expect(result.partialBlocks!.some(b => result.palette[b.material] === "stone_slab")).toBe(true);
    expect(result.patches!.some(p => result.palette[p.material] === "stone_slab")).toBe(false);
    expect(expand(result)).toEqual(expand(scan(p => p.x === 2 && p.y === 1 ? { name: "stone_slab", shapes: [[0, 0, 0, 1, 0.25, 1]] } : p.x === 4 ? block("raw_iron_block") : air, { detail: true })));
  });

  it("treats snow visual layers separately from collisionless decorations and clips fence collision height", () => {
    const require = createRequire(import.meta.url), Block = require("prismarine-block")("1.20.4"), registry = require("prismarine-registry")("1.20.4");
    const snow = Block.fromStateId(registry.blocksByName.snow.defaultState, 0), fence = Block.fromStateId(registry.blocksByName.oak_fence.defaultState, 0);
    const result = scan(p => p.x === 2 && p.y === 1 ? snow : p.x === -2 && p.y === 1 ? fence : air);
    expect(result.coverage.unknownRays).toBe(0);
    const observedSnow = result.partialBlocks!.find(b => result.palette[b.material] === "snow");
    expect(observedSnow!.shapes![0].bounds).toEqual([0, 0, 0, 1, 0.125, 1]);
    const observedFence = result.partialBlocks!.find(b => result.palette[b.material] === "oak_fence");
    expect(observedFence!.shapes!.every(s => s.bounds[4] <= 1)).toBe(true);
    const decoration = scan(p => p.x === 2 ? { name: "torch", shapes: [] } : p.x === 4 ? block("stone") : air);
    expect(decoration.palette).toEqual(["torch"]);
    expect(decoration.coverage.fallbackBlocks).toBeGreaterThan(0);
  });

  it("does not look through the eye-containing opaque volume when the exit exceeds range", () => {
    const result = scan(() => block("stone"), { range: 0.01 });
    expect(result.coverage.opaqueRays).toBe(result.sampling.raysCast);
    expect(result.coverage.rangeRays).toBe(0);
    expect(result.palette).toEqual([]);
  });

  it("preserves floor holes, differing materials, steps and compact/detail sampled content", () => {
    const at = (p: Vec3) => p.y === -1 && !(p.x === 2 && p.z === 2) ? block(p.x === 3 && p.z === 3 ? "raw_iron_block" : "stone") : p.y === 0 && p.x >= 4 && p.z >= 0 ? block("stone") : air;
    const compact = scan(at), detailed = scan(at, { detail: true });
    expect(compact.budget.outputTruncated).toBe(false);
    expect(detailed.budget.outputTruncated).toBe(false);
    expect(expand(compact)).toEqual(expand(detailed));
    expect(expand(compact).some(s => s.startsWith("2,-1,2:"))).toBe(false);
    expect(compact.palette).toContain("raw_iron_block");
    expect(compact.patches!.some(p => p.face === "up" && p.min[1] === 0)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(detailed)));
  });

  it("decomposes rectangles deterministically without filling holes or material exceptions", () => {
    const cells: ObservedBlock[] = [];
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) if (x !== 2 || z !== 2) cells.push({ position: [x, 0, z], material: x === 1 && z === 1 ? 1 : 0, faces: ["up"] });
    expect(compressSurfaces(cells)).toEqual(compressSurfaces([...cells].reverse()));
    const patches = compressSurfaces(cells);
    const result = { palette: ["stone", "iron"], patches } as ReturnType<typeof scanSurroundings>;
    const expected = cells.map(cell => `${cell.position.join(",")}:${cell.material === 1 ? "iron" : "stone"}:up`).sort();
    expect(expand(result)).toEqual(expected);
  });

  it("uses one lookup per voxel, stable world axes, radial hit limits and fixed work caps", () => {
    const seen = new Set<string>();
    const result = scan(p => { expect(seen.has(p.toString())).toBe(false); seen.add(p.toString()); return p.y === -1 ? block() : air; });
    expect(result.budget.blockLookups).toBe(seen.size);
    const rotated = scanSurroundings(world(p => p.y === -1 ? block() : air), { ...pose, yaw: 1.3, pitch: 0.2 } as typeof pose, { range: 8, maxRays: 4096, maxOutputBytes: 1048576 });
    expect(result).toEqual(rotated);
    expect(scan(p => p.x === 2 ? block() : air, { range: 1.49 }).palette).toEqual([]);
    expect(scan(p => p.x === 2 ? block() : air, { range: 1.5 }).palette).toEqual(["stone"]);
    const limited = scan(() => air, { maxBlockLookups: 10 });
    expect(limited.budget.blockLookups).toBe(10);
    expect(limited.budget.workLimit).toBe("blockLookups");
    expect(limited.sampling.complete).toBe(false);
    const voxelLimited = scan(() => air, { maxVoxelVisits: 10 });
    expect(voxelLimited.budget.voxelVisits).toBe(10);
    expect(voxelLimited.budget.workLimit).toBe("voxelVisits");
  });

  it("enforces actual serialized budgets, records output omissions and handles extreme focus bounds", () => {
    const at = (p: Vec3) => p.y === -1 ? block(`stone_${Math.abs(p.x * 100 + p.z)}`) : air;
    const limited = scan(at, { maxOutputBytes: 2048 });
    expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(2048);
    expect(limited.budget.outputBytes).toBe(Buffer.byteLength(JSON.stringify(limited)));
    expect(limited.budget.outputTruncated).toBe(true);
    expect(limited.budget.omittedRecords).toBeGreaterThan(0);
    const extreme = scan(at, { bounds: { min: [-Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER], max: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] } });
    expect(extreme.sampling.raysCast).toBe(4096);
    expect(extreme.palette.length).toBeGreaterThan(0);
    expect(scan(at, { bounds: { min: [Number.MAX_SAFE_INTEGER, 0, 0], max: [Number.MAX_SAFE_INTEGER, 0, 0] } }).palette).toEqual([]);
  });

  it("spreads a constrained output budget across distant directions", () => {
    const result = scan(p => Math.abs(p.x) === 6 || Math.abs(p.y) === 6 || Math.abs(p.z) === 6 ? block(`stone_${p.x}_${p.y}_${p.z}`) : air, { range: 12, maxOutputBytes: 4096 });
    expect(result.budget.outputTruncated).toBe(true);
    expect(new Set(result.patches!.map(p => p.face))).toEqual(new Set(["west", "east", "down", "up", "north", "south"]));
    expect(result.budget.outputBytes).toBeLessThanOrEqual(4096);
  });
});
