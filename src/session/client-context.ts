import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeActionContext } from "../core/context.js";
import { badInput, CliError } from "../output/errors.js";
import { getStateDir, isProcessAlive, validateSessionName } from "./store.js";

interface SavedContext { version: 1; context: string; revision: string }

export function resolveClientId(value: unknown = process.env.MC_AGENT_CLIENT_ID): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.length || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw badInput("Client ID must contain 1-128 characters without control characters.");
  }
  return value;
}

export function resolveStrictContext(flag?: boolean): boolean {
  if (flag) return true;
  const setting = process.env.MC_AGENT_STRICT_CONTEXT;
  if (setting === undefined || /^(0|false)$/i.test(setting)) return false;
  if (/^(1|true)$/i.test(setting)) return true;
  throw badInput("MC_AGENT_STRICT_CONTEXT must be 1, 0, true, or false.");
}

export function clientContextDirectory(clientId: string, session: string, stateDir = getStateDir()): string {
  resolveClientId(clientId);
  validateSessionName(session);
  const scope = createHash("sha256").update(JSON.stringify([clientId, session])).digest("hex");
  return join(stateDir, "clients", scope);
}

async function readSaved(directory: string): Promise<SavedContext | undefined> {
  try {
    const saved = JSON.parse(await readFile(join(directory, "context.json"), "utf8")) as SavedContext;
    if (saved.version !== 1 || typeof saved.revision !== "string") throw new Error("Invalid client context state");
    decodeActionContext(saved.context);
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw badInput("Saved client context is invalid. Observe a fresh frame after removing this client's context state.");
  }
}

export interface ClientContextLease {
  context?: string;
  remember(observation: unknown): Promise<"runtime_changed" | "world_changed" | undefined>;
  release(): Promise<void>;
}

/** Atomic tickets refuse overlap without queues. Dead-process tickets never replay work. */
export async function acquireClientContext(clientId: string, session: string, stateDir = getStateDir()): Promise<ClientContextLease> {
  const directory = clientContextDirectory(clientId, session, stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ticket = `lease-${process.pid}-${randomUUID()}`;
  const ticketPath = join(directory, ticket);
  await mkdir(ticketPath, { mode: 0o700 });
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await rm(ticketPath, { recursive: true, force: true });
  };
  try {
    for (const entry of await readdir(directory)) {
      const match = /^lease-(\d+)-/.exec(entry);
      if (!match || entry === ticket) continue;
      if (!isProcessAlive(Number(match[1]))) {
        await rm(join(directory, entry), { recursive: true, force: true });
        continue;
      }
      throw new CliError("CLIENT_BUSY", "This client/session already has a command in progress.",
        "Wait for that command to finish, or use a separate client ID or explicit action context.", 3);
    }
    let saved = await readSaved(directory);
    return {
      context: saved?.context,
      release,
      async remember(observation) {
        if (released) return undefined;
        const value = observation as { context?: unknown; connection?: { ready?: unknown } } | null;
        if (!value || typeof value.context !== "string" || value.connection?.ready !== true) return undefined;
        const next = decodeActionContext(value.context);
        const previous = saved ? decodeActionContext(saved.context) : undefined;
        const reason = previous && previous.runtimeId !== next.runtimeId ? "runtime_changed" as const
          : previous && previous.worldEpoch !== next.worldEpoch ? "world_changed" as const : undefined;
        const current = await readSaved(directory);
        if (released || current?.revision !== saved?.revision) return undefined;
        const replacement: SavedContext = { version: 1, context: value.context, revision: randomUUID() };
        const temporary = join(directory, `${replacement.revision}.tmp`);
        try {
          await writeFile(temporary, `${JSON.stringify(replacement)}\n`, { mode: 0o600, flag: "wx" });
          if (released) return undefined;
          await rename(temporary, join(directory, "context.json"));
          saved = replacement;
        } finally { await rm(temporary, { force: true }); }
        return reason;
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
