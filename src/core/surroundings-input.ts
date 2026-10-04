import { badInput } from "../output/errors.js";

export type BlockOffset = [number, number, number];
export interface SurroundingsInput {
  range?: number;
  detail?: boolean;
  /** Inclusive block offsets in fixed world X/Y/Z, relative to floor(self position). */
  bounds?: { min: BlockOffset; max: BlockOffset };
}

export function validateSurroundingsOptions(value: unknown): SurroundingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badInput("Surroundings options must be an object.");
  const input = value as Record<string, unknown>;
  const range = input.range ?? 32;
  if (typeof range !== "number" || !Number.isFinite(range) || range <= 0 || range > 32) {
    throw badInput("Surroundings range must be greater than 0 and at most 32 blocks.");
  }
  if (input.detail !== undefined && typeof input.detail !== "boolean") throw badInput("Surroundings detail must be a boolean.");
  let bounds: SurroundingsInput["bounds"];
  if (input.bounds !== undefined) {
    const candidate = input.bounds as { min?: unknown; max?: unknown } | null;
    const offset = (item: unknown): item is BlockOffset => Array.isArray(item) && item.length === 3 && item.every(Number.isSafeInteger);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !offset(candidate.min) || !offset(candidate.max) ||
        candidate.min.some((coordinate, index) => coordinate > (candidate.max as BlockOffset)[index]!)) {
      throw badInput("Surroundings bounds require inclusive integer min/max triples with min <= max on each axis.");
    }
    bounds = { min: [...candidate.min], max: [...candidate.max] };
  }
  return { range, detail: input.detail ?? false, ...(bounds ? { bounds } : {}) } as SurroundingsInput;
}

export function parseSurroundingsBounds(value: string): NonNullable<SurroundingsInput["bounds"]> {
  if (!/^-?\d+,-?\d+,-?\d+:-?\d+,-?\d+,-?\d+$/.test(value)) {
    throw badInput("Use --bounds minX,minY,minZ:maxX,maxY,maxZ (world-axis block offsets).");
  }
  const [min, max] = value.split(":").map(part => part!.split(",").map(Number));
  return validateSurroundingsOptions({ bounds: { min, max } }).bounds!;
}
