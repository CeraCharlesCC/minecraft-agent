import { Vec3 } from "vec3";
import { createBlockRayIterator, type Shape } from "./ray-query.js";
import { validateSurroundingsOptions, type SurroundingsInput } from "../core/surroundings-input.js";

export type Triple = [number, number, number];
export type Face = "west" | "east" | "down" | "up" | "north" | "south";
export type SurroundingsPose = { position: { x: number; y: number; z: number }; height: number };
export type SurroundingsBlock = { name: string; shapes?: Shape[]; getProperties?: () => Record<string, unknown> };
export type SurroundingsWorld = { getBlock(position: Vec3): SurroundingsBlock | null | undefined };
export type SurroundingsOptions = SurroundingsInput & {
  maxRays?: number; maxBlockLookups?: number; maxVoxelVisits?: number; maxOutputBytes?: number; maxTransparentLayers?: number;
};
export type SurfacePatch = { material: number; face: Face; min: Triple; max: Triple };
export type ObservedBlock = { position: Triple; material: number; faces: Face[]; shapes?: { bounds: Shape; faces: Face[] }[] };
const CUBE: Shape = [0, 0, 0, 1, 1, 1];
export const DEFAULT_SURROUNDINGS_OUTPUT_BYTES = 65536;
const FACES: Face[] = ["west", "east", "down", "up", "north", "south"];
const AIR = new Set(["air", "cave_air", "void_air"]);
const PARTIAL = /(?:_slab|_stairs|_fence|_fence_gate|_wall|_door|_trapdoor|_pane|_carpet|_bed|_pressure_plate|_button|_head|_skull)$|^(?:iron_bars|snow|farmland|dirt_path|soul_sand|chest|trapped_chest|ender_chest|anvil|chipped_anvil|damaged_anvil|hopper|cauldron|water_cauldron|lava_cauldron|powder_snow_cauldron|cake|cactus|brewing_stand|enchanting_table|lectern|stonecutter|daylight_detector|sea_pickle|turtle_egg|candle|scaffolding)$/;
export const SURROUNDINGS_VISIBILITY_POLICY = {
  id: "scene-surfaces-v1",
  opaque: "Non-air blocks terminate rays at scene-shape hits; bedrock and barrier use full cubes.",
  transparent: "Glass, stained glass, glass panes and water retain foreground hits and continue, bounded per ray.",
  partial: "Supported partial blocks use registry boxes clipped to their voxel (fence/wall collision height is not visual height); snow uses layers/8.",
  fallback: "Unsupported non-air blocks use a conservative opaque full cube, including collisionless decorations; light transmission is not visibility.",
  water: "Water uses a full voxel approximation, including flowing water.",
  unknown: "Unloaded or malformed block data terminates a ray as unknown.",
  patches: "Inclusive block bounds group sampled faces only, without asserting visibility of every point or walkability.",
};

function limit(value: number | undefined, fallback: number, cap: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > cap) throw new Error(`${name} must be an integer from 1 to ${cap}`);
  return value;
}
function sceneShapes(block: SurroundingsBlock): { shapes: Shape[]; transparent: boolean; fallback: boolean } | null {
  if (typeof block.name !== "string") return null;
  if (AIR.has(block.name)) return { shapes: [], transparent: false, fallback: false };
  const transparent = block.name === "water" || block.name === "glass" || block.name === "glass_pane" || /_stained_glass(?:_pane)?$/.test(block.name);
  if (block.name === "water" || block.name === "bedrock" || block.name === "barrier" || (transparent && !block.name.endsWith("_pane"))) return { shapes: [CUBE], transparent, fallback: false };
  if (block.name === "snow") {
    const layers = Number(block.getProperties?.().layers ?? 1);
    return Number.isInteger(layers) && layers >= 1 && layers <= 8 ? { shapes: [[0, 0, 0, 1, layers / 8, 1]], transparent: false, fallback: false } : null;
  }
  if (PARTIAL.test(block.name)) {
    if (!Array.isArray(block.shapes) || !block.shapes.every(validShape)) return null;
    // Open gates and other intentionally empty supported shapes permit passage.
    return { shapes: block.shapes.map(shape => shape.map(v => Math.min(1, v)) as Shape).filter(validShape), transparent, fallback: false };
  }
  const fullCube = block.shapes?.length === 1 && block.shapes[0].every((value, i) => value === CUBE[i]);
  return { shapes: [CUBE], transparent, fallback: !fullCube };
}
function validShape(shape: unknown): shape is Shape {
  return Array.isArray(shape) && shape.length === 6 && shape.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2) && shape[0] < shape[3] && shape[1] < shape[4] && shape[2] < shape[5];
}

/** Slab intersection handles parallel axes and an eye inside a shape without backward hits. */
function shapeHit(origin: Vec3, direction: Vec3, offset: Vec3, shape: Shape, range: number): { distance: number; face: Face } | null {
  const local = [origin.x - offset.x, origin.y - offset.y, origin.z - offset.z];
  const dir = [direction.x, direction.y, direction.z];
  let entry = -Infinity, exit = Infinity;
  let enterFace: Face = "west", exitFace: Face = "east";
  for (let axis = 0; axis < 3; axis++) {
    if (dir[axis] === 0) { if (local[axis] < shape[axis] || local[axis] > shape[axis + 3]) return null; continue; }
    const a = (shape[axis] - local[axis]) / dir[axis], b = (shape[axis + 3] - local[axis]) / dir[axis];
    const near = Math.min(a, b), far = Math.max(a, b);
    if (near > entry) { entry = near; enterFace = FACES[axis * 2 + (dir[axis] > 0 ? 0 : 1)]; }
    if (far < exit) { exit = far; exitFace = FACES[axis * 2 + (dir[axis] > 0 ? 1 : 0)]; }
    if (entry > exit) return null;
  }
  const distance = entry >= 0 ? entry : exit;
  return distance >= 0 && distance <= range ? { distance, face: entry >= 0 ? enterFace : exitFace } : null;
}
function key(position: Triple): string { return position.join(","); }
function axisOf(face: Face): number { return face === "west" || face === "east" ? 0 : face === "down" || face === "up" ? 1 : 2; }
function comparePosition(a: Triple, b: Triple): number { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }

/** Rectangles include only observed cells; deterministic growth cannot bridge holes. */
export function compressSurfaces(blocks: ObservedBlock[]): SurfacePatch[] {
  const groups = new Map<string, { material: number; face: Face; plane: number; cells: Triple[] }>();
  for (const block of blocks) for (const face of block.faces) {
    const plane = block.position[axisOf(face)], groupKey = `${block.material}:${face}:${plane}`;
    let group = groups.get(groupKey);
    if (!group) groups.set(groupKey, group = { material: block.material, face, plane, cells: [] });
    group.cells.push(block.position);
  }
  const patches: SurfacePatch[] = [];
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const axis = axisOf(group.face), axes = [0, 1, 2].filter(a => a !== axis);
    const cells = new Set(group.cells.map(p => `${p[axes[0]]},${p[axes[1]]}`));
    for (const p of [...group.cells].sort((a, b) => a[axes[0]] - b[axes[0]] || a[axes[1]] - b[axes[1]])) {
      const u = p[axes[0]], v = p[axes[1]];
      if (!cells.has(`${u},${v}`)) continue;
      let endU = u, endV = v;
      while (cells.has(`${endU + 1},${v}`)) endU++;
      while (true) {
        let complete = true;
        for (let i = u; i <= endU; i++) if (!cells.has(`${i},${endV + 1}`)) { complete = false; break; }
        if (!complete) break;
        endV++;
      }
      for (let i = u; i <= endU; i++) for (let j = v; j <= endV; j++) cells.delete(`${i},${j}`);
      const min = [...p] as Triple, max = [...p] as Triple;
      min[axes[0]] = u; min[axes[1]] = v; max[axes[0]] = endU; max[axes[1]] = endV;
      patches.push({ material: group.material, face: group.face, min, max });
    }
  }
  return patches;
}

function* directions(count: number, focus: { min: Triple; max: Triple } | undefined, origin: Triple, eye: Vec3): Generator<Vec3> {
  // Cardinal directions retain immediate floors, walls and ceilings; the remaining samples cover the sphere uniformly.
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) yield new Vec3(x, y, z);
  const focused = focus ? Math.min(Math.floor(count / 2), (focus.max[0] - focus.min[0] + 1) * (focus.max[1] - focus.min[1] + 1) * (focus.max[2] - focus.min[2] + 1)) : 0;
  if (focus) {
    const volume = (focus.max[0] - focus.min[0] + 1) * (focus.max[1] - focus.min[1] + 1) * (focus.max[2] - focus.min[2] + 1);
    const sizeZ = focus.max[2] - focus.min[2] + 1, sizeY = focus.max[1] - focus.min[1] + 1;
    for (let i = 0; i < focused; i++) {
      const index = Math.floor(i * volume / focused), z = focus.min[2] + index % sizeZ, y = focus.min[1] + Math.floor(index / sizeZ) % sizeY, x = focus.min[0] + Math.floor(index / (sizeZ * sizeY));
      const target = new Vec3(origin[0] + x + 0.5, origin[1] + y + 0.5, origin[2] + z + 0.5).minus(eye);
      yield target.norm() > 0 ? target.normalize() : new Vec3(0, 1, 0);
    }
  }
  const spherical = count - 6 - focused;
  for (let i = 0; i < spherical; i++) {
    const y = 1 - 2 * (i + 0.5) / spherical, radius = Math.sqrt(1 - y * y), angle = i * Math.PI * (3 - Math.sqrt(5));
    yield new Vec3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  }
}

type Candidate = { kind: "patch"; value: SurfacePatch } | { kind: "block"; value: ObservedBlock };
function orderedCandidates(candidates: Candidate[], eyeOffset: Triple): Candidate[] {
  const position = (c: Candidate): Triple => c.kind === "block" ? c.value.position : c.value.min.map((v, i) => Math.max(v, Math.min(c.value.max[i], eyeOffset[i]))) as Triple;
  const distance = (c: Candidate) => position(c).reduce((sum, v, i) => sum + (v + 0.5 - eyeOffset[i]) ** 2, 0);
  candidates.sort((a, b) => distance(a) - distance(b) || a.value.material - b.value.material || comparePosition(position(a), position(b)));
  const near: Candidate[] = [], sectors: Candidate[][] = Array.from({ length: 6 }, () => []);
  for (const candidate of candidates) {
    if (distance(candidate) <= 16) { near.push(candidate); continue; }
    const delta = position(candidate).map((v, i) => v + 0.5 - eyeOffset[i]);
    const axis = delta.reduce((best, v, i) => Math.abs(v) > Math.abs(delta[best]) ? i : best, 0);
    sectors[axis * 2 + (delta[axis] >= 0 ? 1 : 0)].push(candidate);
  }
  // A first record of each material gets a turn before repetitions in each direction.
  for (const sector of sectors) {
    const seen = new Set<number>(), first: Candidate[] = [], rest: Candidate[] = [];
    for (const c of sector) { if (seen.has(c.value.material)) rest.push(c); else { seen.add(c.value.material); first.push(c); } }
    sector.splice(0, sector.length, ...first, ...rest);
  }
  const result = [...near], cursors = sectors.map(() => 0);
  while (sectors.some((sector, i) => cursors[i] < sector.length)) for (let i = 0; i < sectors.length; i++) if (cursors[i] < sectors[i].length) result.push(sectors[i][cursors[i]++]);
  return result;
}

export function scanSurroundings(world: SurroundingsWorld, pose: SurroundingsPose, options: SurroundingsOptions = {}) {
  const publicOptions = validateSurroundingsOptions({ range: options.range, detail: options.detail, bounds: options.bounds });
  const range = publicOptions.range ?? 32;
  if (!Number.isFinite(range) || range <= 0 || range > 32) throw new Error("range must be greater than 0 and at most 32");
  if (!pose || !pose.position || ![pose.position.x, pose.position.y, pose.position.z, pose.height].every(Number.isFinite) || pose.height <= 0) throw new Error("A finite position and positive eye height are required");
  const bounds = publicOptions.bounds;
  if (bounds && (![bounds.min, bounds.max].every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isInteger)) || bounds.min.some((v, i) => v > bounds.max[i]))) throw new Error("bounds require ordered integer min and max triples");
  const raysPlanned = limit(options.maxRays, Math.max(512, Math.ceil(range * range * 32)), 65536, "maxRays");
  const maxBlockLookups = limit(options.maxBlockLookups, 163840, 262144, "maxBlockLookups");
  const maxVoxelVisits = limit(options.maxVoxelVisits, 1800000, 3000000, "maxVoxelVisits");
  const maxOutputBytes = limit(options.maxOutputBytes, DEFAULT_SURROUNDINGS_OUTPUT_BYTES, 1048576, "maxOutputBytes");
  if (maxOutputBytes < 2048) throw new Error("maxOutputBytes must be at least 2048 to retain scan metadata");
  const maxTransparentLayers = limit(options.maxTransparentLayers, 4, 16, "maxTransparentLayers");
  const blockOrigin: Triple = [Math.floor(pose.position.x), Math.floor(pose.position.y), Math.floor(pose.position.z)];
  const eye = new Vec3(pose.position.x, pose.position.y + pose.height, pose.position.z), eyeOrigin: Triple = [eye.x, eye.y, eye.z];
  const cache = new Map<string, (NonNullable<ReturnType<typeof sceneShapes>> & { name: string }) | null>(), observed = new Map<string, { name: string; position: Triple; faces: Set<Face>; shapes: Map<string, { bounds: Shape; faces: Set<Face> }> }>();
  let raysCast = 0, blockLookups = 0, voxelVisits = 0, unknownRays = 0, rangeRays = 0, opaqueRays = 0, layerLimitRays = 0, workLimitRays = 0, fallbackBlocks = 0;
  let workLimit: "blockLookups" | "voxelVisits" | null = null;
  const unknownBoundaries = new Map<string, Triple>();
  const sampleCount = Math.max(6, raysPlanned);
  const focus = bounds ? {
    min: bounds.min.map((v, i) => Math.max(v, Math.floor(eyeOrigin[i] - range) - blockOrigin[i])) as Triple,
    max: bounds.max.map((v, i) => Math.min(v, Math.floor(eyeOrigin[i] + range) - blockOrigin[i])) as Triple,
  } : undefined;
  const reachableFocus = focus && focus.min.every((v, i) => v <= focus.max[i]) ? focus : undefined;
  for (const direction of directions(sampleCount, reachableFocus, blockOrigin, eye)) {
    if (raysCast >= raysPlanned || workLimit) break;
    raysCast++;
    const iterator = createBlockRayIterator(eye, direction, range);
    let voxel: { x: number; y: number; z: number } | null = eye.floored(), layers = 0, stopped = false;
    while (voxel) {
      if (voxelVisits >= maxVoxelVisits) { workLimit = "voxelVisits"; workLimitRays++; stopped = true; break; }
      voxelVisits++;
      const absolute: Triple = [voxel.x, voxel.y, voxel.z], cacheKey = key(absolute);
      let scene = cache.get(cacheKey);
      if (scene === undefined && !cache.has(cacheKey)) {
        if (blockLookups >= maxBlockLookups) { workLimit = "blockLookups"; workLimitRays++; stopped = true; break; }
        const block = world.getBlock(new Vec3(...absolute)); blockLookups++;
        const geometry = block == null ? null : sceneShapes(block);
        scene = geometry ? { ...geometry, name: block!.name } : null; cache.set(cacheKey, scene);
        if (scene?.fallback) fallbackBlocks++;
      }
      if (!scene) {
        unknownRays++; stopped = true;
        const relative = absolute.map((v, i) => v - blockOrigin[i]) as Triple;
        unknownBoundaries.set(cacheKey, relative); break;
      }
      const offset = new Vec3(...absolute);
      let closest: { distance: number; face: Face; shape: Shape } | undefined;
      const insideOpaque = !scene.transparent && scene.shapes.some(s => eye.x - offset.x > s[0] && eye.x - offset.x < s[3] && eye.y - offset.y > s[1] && eye.y - offset.y < s[4] && eye.z - offset.z > s[2] && eye.z - offset.z < s[5]);
      for (const shape of scene.shapes) {
        const hit = shapeHit(eye, direction, offset, shape, range);
        if (hit && (!closest || hit.distance < closest.distance)) closest = { ...hit, shape };
      }
      if (closest) {
        const relative = absolute.map((v, i) => v - blockOrigin[i]) as Triple;
        if (!bounds || relative.every((v, i) => v >= bounds.min[i] && v <= bounds.max[i])) {
          let block = observed.get(cacheKey);
          if (!block) observed.set(cacheKey, block = { name: scene.name, position: relative, faces: new Set(), shapes: new Map() });
          if (closest.shape.every((v, i) => v === CUBE[i])) block.faces.add(closest.face);
          else {
            const shapeKey = closest.shape.join(",");
            let shape = block.shapes.get(shapeKey);
            if (!shape) block.shapes.set(shapeKey, shape = { bounds: [...closest.shape], faces: new Set() });
            shape.faces.add(closest.face);
          }
        }
        if (!scene.transparent) { opaqueRays++; stopped = true; break; }
        layers++;
        if (layers >= maxTransparentLayers) { layerLimitRays++; stopped = true; break; }
      }
      if (insideOpaque) { opaqueRays++; stopped = true; break; }
      voxel = iterator.next();
    }
    if (!stopped) rangeRays++;
  }
  const palette = [...new Set([...observed.values()].map(b => b.name))].sort();
  const materialIds = new Map(palette.map((name, i) => [name, i]));
  const blocks: ObservedBlock[] = [...observed.values()].sort((a, b) => comparePosition(a.position, b.position)).map(b => ({ position: b.position, material: materialIds.get(b.name)!, faces: FACES.filter(f => b.faces.has(f)), ...(b.shapes.size ? { shapes: [...b.shapes.values()].sort((a, b) => a.bounds.join(",").localeCompare(b.bounds.join(","))).map(s => ({ bounds: s.bounds, faces: FACES.filter(f => s.faces.has(f)) })) } : {}) }));
  const patches = compressSurfaces(blocks), partialBlocks = blocks.filter(b => b.shapes).map(b => ({ ...b, faces: [] as Face[] }));
  const candidates: Candidate[] = options.detail ? blocks.map(value => ({ kind: "block", value })) : [...patches.map(value => ({ kind: "patch" as const, value })), ...partialBlocks.map(value => ({ kind: "block" as const, value }))];
  const selected: Candidate[] = [];
  const output = {
    blockOrigin, eyeOrigin, range, ...(bounds ? { bounds } : {}), representation: options.detail ? "blocks" as const : "patches" as const, palette,
    blocks: options.detail ? [] as ObservedBlock[] : undefined,
    patches: options.detail ? undefined : [] as SurfacePatch[],
    partialBlocks: options.detail ? undefined : [] as ObservedBlock[],
    visibilityPolicy: SURROUNDINGS_VISIBILITY_POLICY,
    sampling: { method: "cardinal+fibonacci-sphere", raysPlanned, raysCast, focused: Boolean(bounds), quality: "finite samples; small or distant features may be missed", complete: raysCast === raysPlanned && !workLimit },
    coverage: { opaqueRays, rangeRays, unknownRays, layerLimitRays, workLimitRays, unknownBoundarySample: [...unknownBoundaries.values()].sort(comparePosition).slice(0, 16), unknownBoundaryCells: unknownBoundaries.size, unknownBoundarySampleTruncated: unknownBoundaries.size > 16, observedBlocks: blocks.length, observedPatches: patches.length, fallbackBlocks, incomplete: true, missingMeans: "unobserved, never air", walkability: "not assessed" },
    budget: { maxRays: raysPlanned, maxBlockLookups, blockLookups, cacheEntries: cache.size, maxVoxelVisits, voxelVisits, maxTransparentLayers, maxOutputBytes, outputBytes: 0, workLimit, outputTruncated: false, omittedRecords: 0, retainedRecords: 0, omittedPatches: 0, omittedBlocks: 0 },
  };
  // Reserve variable-size counters; selection cost is the actual JSON record size, not a token estimate.
  output.palette = [];
  const selectedMaterials = new Set<number>();
  while (Buffer.byteLength(JSON.stringify(output)) + 128 > maxOutputBytes && output.coverage.unknownBoundarySample.length) {
    output.coverage.unknownBoundarySample.pop();
    output.coverage.unknownBoundarySampleTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(output)) + 128 > maxOutputBytes) throw new Error("maxOutputBytes is too small for required scan metadata");
  let bytes = Buffer.byteLength(JSON.stringify(output)) + 128;
  for (const candidate of orderedCandidates(candidates, eyeOrigin.map((v, i) => v - blockOrigin[i]) as Triple)) {
    const cost = Buffer.byteLength(JSON.stringify(candidate.value)) + 1 + (selectedMaterials.has(candidate.value.material) ? 0 : Buffer.byteLength(JSON.stringify(palette[candidate.value.material])) + 1);
    if (bytes + cost > maxOutputBytes) continue;
    selected.push(candidate); selectedMaterials.add(candidate.value.material); bytes += cost;
  }
  const retainedMaterialIds = [...selectedMaterials].sort((a, b) => a - b);
  output.palette = retainedMaterialIds.map(id => palette[id]);
  const remap = new Map(retainedMaterialIds.map((id, i) => [id, i]));
  for (const candidate of selected) candidate.value = { ...candidate.value, material: remap.get(candidate.value.material)! };
  if (options.detail) output.blocks = selected.map(c => c.value as ObservedBlock);
  else { output.patches = selected.filter(c => c.kind === "patch").map(c => c.value as SurfacePatch); output.partialBlocks = selected.filter(c => c.kind === "block").map(c => c.value as ObservedBlock); }
  output.budget.retainedRecords = selected.length;
  output.budget.omittedRecords = candidates.length - selected.length;
  output.budget.outputTruncated = output.budget.omittedRecords > 0;
  output.budget.omittedPatches = options.detail ? 0 : patches.length - output.patches!.length;
  output.budget.omittedBlocks = options.detail ? blocks.length - output.blocks!.length : partialBlocks.length - output.partialBlocks!.length;
  // Account for the outputBytes field itself until its digit count stabilizes.
  for (let i = 0; i < 3; i++) output.budget.outputBytes = Buffer.byteLength(JSON.stringify(output));
  return output;
}
