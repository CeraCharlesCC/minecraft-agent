import { readlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface SessionRecord {
  session: string;
  pid: number;
  pidNamespace?: string;
  controlPort: number;
  token: string;
  host: string;
  port: number;
  username: string;
  auth: string;
  version?: string;
  startedAt: string;
  runtimeId?: string;
  stopping?: boolean;
}

export interface PublicSessionRecord {
  session: string;
  pid?: number;
  controlPort?: number;
  host?: string;
  port?: number;
  auth?: string;
  version?: string;
  startedAt?: string;
  alive: boolean;
}

const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{5,}$/;

export function getStateDir(): string {
  return process.env.MC_AGENT_STATE_DIR ?? join(homedir(), ".minecraft-agent", "sessions");
}

/** Opt in only for a workspace shared by trusted local users. */
export function sharedState(): boolean {
  const value = process.env.MC_AGENT_SHARED_STATE;
  if (value === undefined || /^(false|0)$/i.test(value)) return false;
  if (/^(true|1)$/i.test(value)) return true;
  throw new Error("MC_AGENT_SHARED_STATE must be true or false.");
}

export function stateFileMode(): number { return sharedState() ? 0o660 : 0o600; }

export async function ensureStateDirectory(directory: string): Promise<void> {
  const mode = sharedState() ? 0o2770 : 0o700;
  await mkdir(directory, { recursive: true, mode });
  if (sharedState()) {
    if (((await stat(directory)).mode & 0o7777) !== mode) await chmod(directory, mode);
  } else { await chmodBestEffort(directory, mode); }
}

export function pidNamespace(): string | undefined {
  try { return readlinkSync("/proc/self/ns/pid"); } catch { return undefined; }
}

export function samePidNamespace(record: SessionRecord): boolean {
  const current = pidNamespace();
  return !record.pidNamespace || !current || record.pidNamespace === current;
}

/** A foreign namespace cannot prove that the recorded process has exited. */
export function isSessionProcessAlive(record: SessionRecord): boolean {
  return !samePidNamespace(record) || isProcessAlive(record.pid);
}

export function createSessionToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 32) {
    throw new Error("Session token must contain at least 32 random bytes.");
  }
  return randomBytes(bytes).toString("base64url");
}

export function validateSessionName(session: string): string {
  if (!SESSION_NAME_PATTERN.test(session)) {
    throw new Error("Session names must be 1-64 characters and contain only letters, numbers, dot, underscore, or hyphen.");
  }
  return session;
}

export function sessionFilePath(session: string, stateDir = getStateDir()): string {
  const root = resolve(stateDir);
  const file = resolve(root, `${encodeURIComponent(validateSessionName(session))}.json`);
  const pathFromRoot = relative(root, file);

  /* v8 ignore next 3 -- session names are validated and encoded before path resolution; this is a defense-in-depth guard. */
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("Session path escaped the session state directory.");
  }

  return file;
}

export async function writeSession(record: SessionRecord, stateDir = getStateDir()): Promise<void> {
  validateSessionName(record.session);
  assertToken(record.token);

  await ensureStateDirectory(stateDir);
  const destination = sessionFilePath(record.session, stateDir);
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
  const stored = { ...record, pidNamespace: record.pidNamespace ?? pidNamespace() };
  const mode = stateFileMode();
  try {
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode });
    await chmodBestEffort(temporary, mode);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  await chmodBestEffort(destination, mode);
}

export async function readSession(
  session: string,
  stateDir = getStateDir(),
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<SessionRecord | undefined> {
  try {
    const raw = await readFile(sessionFilePath(session, stateDir), "utf8");
    const record = JSON.parse(raw) as SessionRecord;
    validateSessionName(record.session);
    assertToken(record.token);

    if (samePidNamespace(record) && !alive(record.pid)) {
      await removeSession(record.session, stateDir);
      return undefined;
    }

    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function removeSession(session: string, stateDir = getStateDir()): Promise<void> {
  await rm(sessionFilePath(session, stateDir), { force: true });
}

export async function listSessions(stateDir = getStateDir(), alive: (pid: number) => boolean = isProcessAlive): Promise<SessionRecord[]> {
  try {
    const files = await readdir(stateDir);
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => readSession(decodeURIComponent(file.slice(0, -".json".length)), stateDir, alive)),
    );
    return records
      .filter((record): record is SessionRecord => Boolean(record))
      .sort((a, b) => a.session.localeCompare(b.session));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function toPublicSession(record: SessionRecord, detail: "compact" | "full" = "compact"): PublicSessionRecord {
  return {
    session: record.session,
    alive: isSessionProcessAlive(record),
    ...(detail === "full" ? { pid: record.pid, controlPort: record.controlPort,
      host: record.host, port: record.port, auth: record.auth,
      ...(record.version !== undefined ? { version: record.version } : {}), startedAt: record.startedAt } : {}),
  };
}

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Session token is missing or too weak for local daemon authentication.");
  }
}

async function chmodBestEffort(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // POSIX modes are best-effort on some Windows file systems.
  }
}
