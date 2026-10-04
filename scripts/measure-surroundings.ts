/** Reproducible synthetic scans; no Minecraft server or hidden-surface ground truth. */
import { performance } from "node:perf_hooks";
import { Vec3 } from "vec3";
import { scanSurroundings, type SurroundingsOptions } from "../src/daemon/surroundings.js";

type Point = [number, number, number];
type Fixture = (x: number, y: number, z: number) => string | null;
const airShapes: [] = [], cube: [number, number, number, number, number, number][] = [[0, 0, 0, 1, 1, 1]];
const repetitions = Math.max(1, Math.min(20, Number(process.argv[2]) || 5));
const options = { range: 32 };
const eye: Point = [0.5, 2.5, 0.5];
const scenes: Record<string, Fixture> = {
  open_terrain: (x, y, z) => y <= 0 ? (x === 5 && z === 3 ? "raw_iron_block" : "grass_block") : "air",
  cave: (x, y, z) => {
    if (x === 8 && y === 2 && z === 3) return "raw_iron_block";
    if (y <= 0 || y >= 7 || x <= -11 || x >= 11 || z <= -11 || z >= 11) return "stone";
    if (x >= 3 && x <= 5 && z >= -2 && z <= 2 && y === 1) return "stone";
    return "air";
  },
  cluttered_build: (x, y, z) => {
    if (y <= 0) return (x + z) % 2 === 0 ? "stone" : "deepslate";
    if (x === 3 && z === 2 && y === 2) return "raw_iron_block";
    if (Math.abs(x) >= 15 || Math.abs(z) >= 15 || y >= 8) return "stone";
    if ((x !== 0 || z !== 0) && x % 3 === 0 && z % 3 === 0 && y <= 4) return "oak_planks";
    return "air";
  },
};

function scan(fixture: Fixture, detailed: boolean, origin: Point = eye, limits: SurroundingsOptions = {}) {
  let blockLookups = 0;
  const world = { getBlock(position: Vec3) {
    blockLookups++;
    const name = fixture(position.x, position.y, position.z);
    return name === null ? null : { name, position, shapes: name === "air" ? airShapes : cube };
  } };
  const start = performance.now();
  const result = scanSurroundings(world, { position: { x: origin[0], y: origin[1] - 1.62, z: origin[2] }, height: 1.62 },
    { ...options, ...limits, detail: detailed });
  return { result, milliseconds: performance.now() - start, blockLookups, bytes: Buffer.byteLength(JSON.stringify(result)) };
}

type ScanResult = ReturnType<typeof scan>["result"];
function observedCells(result: ScanResult): Set<string> {
  const cells = new Set<string>();
  for (const block of result.blocks ?? []) {
    if (block.shapes) continue;
    for (const face of block.faces) cells.add(`${block.position.join(",")}:${result.palette[block.material]}:${face}`);
  }
  for (const patch of result.patches ?? []) {
    for (let x = patch.min[0]; x <= patch.max[0]; x++) for (let y = patch.min[1]; y <= patch.max[1]; y++)
      for (let z = patch.min[2]; z <= patch.max[2]; z++) cells.add(`${x},${y},${z}:${result.palette[patch.material]}:${patch.face}`);
  }
  return cells;
}
function sameCells(a: ScanResult, b: ScanResult) {
  const left = observedCells(a), right = observedCells(b);
  return left.size === right.size && [...left].every(cell => right.has(cell));
}
function quantile(values: number[], fraction: number) {
  return Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]! * 100) / 100;
}

const rows = Object.entries(scenes).map(([fixture, blocks]) => {
  scan(blocks, false); // Warm the traversal before reporting latency.
  const runs = Array.from({ length: repetitions }, () => scan(blocks, false));
  const compact = runs[0]!, detail = scan(blocks, true);
  // Compare without output truncation separately; defaults may intentionally omit content.
  const completeCompact = scan(blocks, false, eye, { maxOutputBytes: 1_048_576 });
  const completeDetail = scan(blocks, true, eye, { maxOutputBytes: 1_048_576 });
  const tuning = [8192, 16384].map(maxRays => {
    const runs = Array.from({ length: repetitions }, () => scan(blocks, false, eye, { maxRays }));
    const first = runs[0]!;
    return { maxRays, medianMilliseconds: quantile(runs.map(run => run.milliseconds), 0.5),
      blockLookups: first.blockLookups, bytes: first.bytes, observedBlocks: first.result.coverage.observedBlocks,
      workLimit: first.result.budget.workLimit, outputTruncated: first.result.budget.outputTruncated };
  });
  return { fixture, medianMilliseconds: quantile(runs.map(run => run.milliseconds), 0.5),
    p95Milliseconds: quantile(runs.map(run => run.milliseconds), 0.95), blockLookups: compact.blockLookups,
    compactBytes: compact.bytes, detailBytes: detail.bytes,
    untruncatedCompactBytes: completeCompact.bytes, untruncatedDetailBytes: completeDetail.bytes,
    untruncatedReductionPercent: Math.round((1 - completeCompact.bytes / completeDetail.bytes) * 1000) / 10,
    compactDetailCellsEqual: sameCells(completeCompact.result, completeDetail.result),
    distinctMaterials: compact.result.palette, observedFacesBeforeOutputLimit: observedCells(completeDetail.result).size,
    sampling: compact.result.sampling, coverage: compact.result.coverage, budget: compact.result.budget, tuning };
});

const probes: Record<string, unknown>[] = [];
for (const distance of [4, 8, 16, 24, 30]) for (const alignment of [0.17, 0.5, 0.83]) {
  const origin: Point = [0.5, 2 + alignment, alignment];
  // An oblique direction prevents an added cardinal ray from trivially finding every probe.
  const wallX = Math.floor(distance * Math.cos(0.31)), wallZ = Math.round(distance * Math.sin(0.31));
  const targetZ = wallZ + Math.round(2 * Math.tan(0.31));
  for (const kind of ["contrasting_single_block", "one_block_opening"] as const) for (const maxRays of [2048, 8192, undefined]) {
    const blocks: Fixture = (x, y, z) => {
      if (kind === "contrasting_single_block" && x === wallX && y === 2 && z === wallZ) return "raw_iron_block";
      if (kind === "one_block_opening" && x === wallX + 2 && y === 2 && z === targetZ) return "raw_iron_block";
      if (x === wallX) return kind === "one_block_opening" && y === 2 && z === wallZ ? "air" : "stone";
      return "air";
    };
    const limits = maxRays === undefined ? {} : { maxRays };
    const defaultOutput = scan(blocks, false, origin, limits);
    const beforeOutputLimit = scan(blocks, true, origin, { ...limits, maxOutputBytes: 1_048_576 });
    const hasFeature = (result: ScanResult) => [...result.blocks ?? [], ...result.patches ?? [], ...result.partialBlocks ?? []]
      .some(record => result.palette[record.material] === "raw_iron_block");
    probes.push({ kind, distance, alignment, maxRays: maxRays ?? "default", wallBlock: [wallX, 2, wallZ],
      featureBlock: [kind === "one_block_opening" ? wallX + 2 : wallX, 2, kind === "one_block_opening" ? targetZ : wallZ],
      sampledFeature: hasFeature(beforeOutputLimit.result),
      retainedFeature: hasFeature(defaultOutput.result), blockLookups: defaultOutput.blockLookups,
      sampling: defaultOutput.result.sampling, coverage: defaultOutput.result.coverage, budget: defaultOutput.result.budget });
  }
}

const emptyCalibration = [undefined, { maxBlockLookups: 262144, maxVoxelVisits: 3000000 }].map(limits => {
  const measured = scan(() => "air", false, eye, limits);
  return { limits: limits ?? "default", milliseconds: Math.round(measured.milliseconds * 100) / 100,
    blockLookups: measured.blockLookups, sampling: measured.result.sampling, budget: measured.result.budget };
});
console.log(JSON.stringify({ measurement: "Synthetic loaded voxel worlds; latency is host-dependent; finite sampling misses are expected.",
  repetitions, eyeOrigin: eye, options, rows, probes, emptyCalibration,
  featureSummary: { probes: probes.length, sampled: probes.filter(probe => probe.sampledFeature).length,
    retained: probes.filter(probe => probe.retainedFeature).length,
    byQuality: ["default", 8192, 2048].map(maxRays => {
      const matching = probes.filter(probe => probe.maxRays === maxRays);
      return { maxRays, probes: matching.length, sampled: matching.filter(probe => probe.sampledFeature).length,
        retained: matching.filter(probe => probe.retainedFeature).length,
        workLimited: matching.filter(probe => (probe.budget as ScanResult["budget"]).workLimit).length };
    }),
    misses: probes.filter(probe => !probe.sampledFeature).map(({ kind, distance, alignment, maxRays }) => ({ kind, distance, alignment, maxRays })) } }, null, 2));
