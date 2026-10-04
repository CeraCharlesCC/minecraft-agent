import { ZodError } from "zod";

export type ErrorCode =
  | "BAD_INPUT"
  | "CONTEXT_REQUIRED"
  | "SESSION_NOT_FOUND"
  | "SESSION_ALREADY_RUNNING"
  | "COMMAND_BLOCKED"
  | "DAEMON_ERROR"
  | "DAEMON_TIMEOUT"
  | "DAEMON_INCOMPATIBLE"
  | "NAVIGATION_FAILED"
  | "TRACK_UNKNOWN"
  | "TRACK_LOST"
  | "WORLD_CHANGED"
  | "RUNTIME_MISMATCH"
  | "FRAME_RESET_REQUIRED"
  | "NOT_READY"
  | "ACTION_UNKNOWN"
  | "STREAM_OVERFLOW"
  | "UNKNOWN_ERROR";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly remediation: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, remediation: string, exitCode = 1, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.remediation = remediation;
    this.details = details;
  }
}

export function badInput(message: string, remediation = "Check the command help and retry."): CliError {
  return new CliError("BAD_INPUT", message, remediation, 3);
}

export function commandBlocked(message: string, remediation: string): CliError {
  return new CliError("COMMAND_BLOCKED", message, remediation, 3);
}

export function sessionNotFound(session: string): CliError {
  return new CliError(
    "SESSION_NOT_FOUND",
    `Session '${session}' is not running.`,
    "Start it with 'mc-agent session start --session <name>'.",
    4,
  );
}

export function daemonIncompatible(session: string, details: Record<string, unknown> = {}): CliError {
  return new CliError(
    "DAEMON_INCOMPATIBLE",
    `Session '${session}' is running a daemon incompatible with API v3.`,
    `Stop it with 'mc-agent session stop --session ${session}', then start it again with the current CLI and the same connection options. Existing daemons keep their old code after an upgrade; retrying the observation will not fix this.`,
    1,
    { session, expectedApiVersion: 3, ...details },
  );
}

export function contextRequired(): CliError {
  return new CliError("CONTEXT_REQUIRED", "Pass context from observe frame or entity find.", "Pass context from observe frame or entity find.", 3);
}

/** Public errors carry only facts needed to choose the next operation. */
export function projectErrorDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["action", "track", "trackId", "session", "outcome", "mayHaveExecuted", "responseConfirmed", "timedOut", "timeoutMs", "expectedApiVersion", "actualApiVersion", "httpStatus", "pathStatus", "distanceToGoal", "reachedGoal", "outcomeUnknown"]) {
    const value = details[key];
    if (typeof value === "boolean" || typeof value === "number" || value === null ||
      (typeof value === "string" && value.length <= 128 && !value.includes("@"))) result[key] = value;
  }
  const reasons = new Set(["noPath", "timeout", "goal_not_reached", "world_changed", "disconnected", "death", "respawn", "dimension_changed", "target_lost", "already_within_range", "within_range", "cancelled", "replaced", "NO_PATH", "TIMEOUT", "GOAL_NOT_REACHED", "TERRAIN_MODIFICATION_BLOCKED", "PATH_STOPPED", "GOAL_CHANGED", "PATHFINDER_ERROR", "TRACK_LOST", "WORLD_CHANGED", "REPLACED", "CANCELLED"]);
  if (typeof details.reason === "string" && reasons.has(details.reason)) result.reason = details.reason;
  for (const key of ["goal", "position", "finalPosition", "target"]) {
    const value = details[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const point: Record<string, number> = {};
    for (const field of ["x", "y", "z", "range"]) {
      const entry = (value as Record<string, unknown>)[field];
      if (typeof entry === "number" && Number.isFinite(entry)) point[field] = entry;
    }
    if (Object.keys(point).length) result[key] = point;
  }
  return Object.keys(result).length ? result : undefined;
}

export function publicError(error: CliError): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
  const generic: Partial<Record<ErrorCode, string>> = {
    CONTEXT_REQUIRED: "Pass context from observe frame or entity find.",
    DAEMON_ERROR: "The operation failed. Inspect operational diagnostics for the cause.",
    UNKNOWN_ERROR: "The operation failed. Inspect operational diagnostics for the cause.",
    NAVIGATION_FAILED: "Navigation did not reach the goal.",
    NOT_READY: "Bot has no ready world context.",
    WORLD_CHANGED: "World context has changed. Observe a fresh frame.",
    RUNTIME_MISMATCH: "The handle belongs to another runtime.",
    TRACK_UNKNOWN: "Target track is unknown or expired.",
    TRACK_LOST: "Target is no longer available.",
    ACTION_UNKNOWN: "Action is unknown or expired.",
    FRAME_RESET_REQUIRED: "A fresh full frame is required.",
    DAEMON_TIMEOUT: "The daemon request timed out; its outcome may be unknown.",
  };
  const details = projectErrorDetails(error.details);
  return { code: error.code, message: generic[error.code] ?? error.message, ...(details ? { details } : {}) };
}

export function normalizeError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof ZodError) {
    return badInput(
      error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; "),
    );
  }

  if (error instanceof Error) {
    return new CliError("UNKNOWN_ERROR", error.message, "Inspect stderr logs, then retry or file a bug.", 1);
  }

  return new CliError("UNKNOWN_ERROR", "Unknown error.", "Retry with --output json for details.", 1);
}
