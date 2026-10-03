import { badInput } from "../output/errors.js";

export interface ActionContext { runtimeId: string; worldEpoch: number }

function valid(runtimeId: unknown, worldEpoch: unknown): runtimeId is string {
  return typeof runtimeId === "string" && runtimeId.length > 0 && runtimeId.length <= 256 &&
    Number.isSafeInteger(worldEpoch) && Number(worldEpoch) > 0;
}

/** A convenience encoding of runtime/epoch, independent of frame retention. */
export function encodeActionContext(runtimeId: string, worldEpoch: number): string {
  if (!valid(runtimeId, worldEpoch)) throw badInput("Invalid action runtime or world epoch.");
  return `mcctx1.${Buffer.from(JSON.stringify([runtimeId, worldEpoch]), "utf8").toString("base64url")}`;
}

export function decodeActionContext(token: string): ActionContext {
  if (typeof token !== "string" || !/^mcctx1\.[A-Za-z0-9_-]+$/.test(token) || token.length > 2048) {
    throw badInput("Invalid action context. Use context from a frame or entity search.");
  }
  try {
    const payload = JSON.parse(Buffer.from(token.slice(7), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(payload) || payload.length !== 2 || !valid(payload[0], payload[1])) throw new Error("Invalid payload");
    const [runtimeId, worldEpoch] = payload as [string, number];
    // Reject alternate encodings and malformed base64 rather than silently repairing them.
    if (encodeActionContext(runtimeId, worldEpoch) !== token) throw new Error("Noncanonical payload");
    return { runtimeId, worldEpoch };
  } catch {
    throw badInput("Invalid action context. Use context from a frame or entity search.");
  }
}
