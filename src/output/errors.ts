import { ZodError } from "zod";

export type ErrorCode =
  | "BAD_INPUT"
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
    `Session '${session}' is running a daemon incompatible with API v2.`,
    `Stop it with 'mc-agent session stop --session ${session}', then start it again with the current CLI and the same connection options. Existing daemons keep their old code after an upgrade; retrying the observation will not fix this.`,
    1,
    { session, expectedApiVersion: 2, ...details },
  );
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
