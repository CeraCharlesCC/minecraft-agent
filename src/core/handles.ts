import { badInput } from "../output/errors.js";

export type HandleKind = "p" | "e" | "a" | "f" | "s" | "m";
export interface RuntimeHandle { runtimeId: string; kind: HandleKind; sequence: number }

/** The final base64 digit has four zero padding bits; all 128 identity bits survive. */
export const RUNTIME_TAG_PATTERN = "[A-Za-z0-9_-]{21}[AQgw]";
export const HANDLE_PATTERN = `${RUNTIME_TAG_PATTERN}:(?:s0|[peafsm][1-9a-z][0-9a-z]{0,10})`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tagPattern = new RegExp(`^${RUNTIME_TAG_PATTERN}$`);
const handlePattern = new RegExp(`^(${RUNTIME_TAG_PATTERN}):([peafsm])(0|[1-9a-z][0-9a-z]{0,10})$`);

export function encodeRuntimeTag(runtimeId: string): string {
  if (typeof runtimeId !== "string" || !uuidPattern.test(runtimeId)) throw badInput("Invalid runtime identity.");
  return Buffer.from(runtimeId.replaceAll("-", ""), "hex").toString("base64url");
}

export function decodeRuntimeTag(tag: string): string {
  if (typeof tag !== "string" || !tagPattern.test(tag)) throw badInput("Invalid runtime tag.");
  const bytes = Buffer.from(tag, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== tag) throw badInput("Invalid runtime tag.");
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function decodeSequence(value: string, allowZero = false): number {
  if (!/^(?:0|[1-9a-z][0-9a-z]{0,10})$/.test(value)) throw badInput("Invalid handle sequence.");
  const sequence = Number.parseInt(value, 36);
  if (!Number.isSafeInteger(sequence) || sequence < (allowZero ? 0 : 1) || sequence.toString(36) !== value) {
    throw badInput("Invalid handle sequence.");
  }
  return sequence;
}

export function encodeHandle(runtimeId: string, kind: HandleKind, sequence: number): string {
  if (!/^[peafsm]$/.test(kind) || !Number.isSafeInteger(sequence) || sequence < (kind === "s" ? 0 : 1)) {
    throw badInput("Invalid runtime handle.");
  }
  return `${encodeRuntimeTag(runtimeId)}:${kind}${sequence.toString(36)}`;
}

export function decodeHandle(handle: string, kind?: HandleKind | readonly HandleKind[]): RuntimeHandle {
  const match = typeof handle === "string" ? handlePattern.exec(handle) : null;
  if (!match) throw badInput("Invalid runtime handle.");
  const actualKind = match[2] as HandleKind;
  if (kind !== undefined && !(Array.isArray(kind) ? kind.includes(actualKind) : kind === actualKind)) {
    throw badInput("Invalid handle type.");
  }
  const runtimeId = decodeRuntimeTag(match[1]!), sequence = decodeSequence(match[3]!, actualKind === "s");
  if (encodeHandle(runtimeId, actualKind, sequence) !== handle) throw badInput("Invalid runtime handle.");
  return { runtimeId, kind: actualKind, sequence };
}

export function isHandle(value: unknown, kind?: HandleKind | readonly HandleKind[]): value is string {
  if (typeof value !== "string") return false;
  try { decodeHandle(value, kind); return true; } catch { return false; }
}
