import { badInput } from "../output/errors.js";
import { decodeRuntimeTag, decodeSequence, encodeRuntimeTag, RUNTIME_TAG_PATTERN } from "./handles.js";

export interface ActionContext { runtimeId: string; worldEpoch: number }

const contextPattern = new RegExp(`^c2\\.(${RUNTIME_TAG_PATTERN})\\.([1-9a-z][0-9a-z]{0,10})$`);

/** A convenience encoding of runtime/epoch, independent of frame retention. */
export function encodeActionContext(runtimeId: string, worldEpoch: number): string {
  if (!Number.isSafeInteger(worldEpoch) || worldEpoch < 1) throw badInput("Invalid action world epoch.");
  return `c2.${encodeRuntimeTag(runtimeId)}.${worldEpoch.toString(36)}`;
}

export function decodeActionContext(token: string): ActionContext {
  const invalid = () => badInput("Invalid action context. Use context from a frame or entity search.");
  const match = typeof token === "string" ? contextPattern.exec(token) : null;
  if (!match) throw invalid();
  try {
    const runtimeId = decodeRuntimeTag(match[1]!), worldEpoch = decodeSequence(match[2]!);
    if (encodeActionContext(runtimeId, worldEpoch) !== token) throw invalid();
    return { runtimeId, worldEpoch };
  } catch { throw invalid(); }
}
