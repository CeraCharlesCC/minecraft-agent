import { badInput } from "../output/errors.js";

/** Minecraft registry keys accept their default namespace, never arbitrary prefixes. */
export function normalizeRegistryName(value: string): string {
  if (typeof value !== "string" || !/^(?:minecraft:)?[a-z][a-z0-9_]*$/.test(value)) {
    throw badInput("Use a Minecraft registry name such as stone or minecraft:stone; other namespaces are unsupported.");
  }
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}
