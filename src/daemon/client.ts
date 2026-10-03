import { CliError, type ErrorCode, daemonIncompatible, sessionNotFound } from "../output/errors.js";
import { readSession, SessionRecord } from "../session/store.js";

const daemonErrorCodes = new Set<ErrorCode>(["BAD_INPUT", "COMMAND_BLOCKED", "DAEMON_ERROR", "DAEMON_TIMEOUT", "DAEMON_INCOMPATIBLE", "NAVIGATION_FAILED", "TRACK_UNKNOWN", "TRACK_LOST", "WORLD_CHANGED", "RUNTIME_MISMATCH", "FRAME_RESET_REQUIRED", "NOT_READY", "ACTION_UNKNOWN", "STREAM_OVERFLOW"]);
const defaultTimeoutMs = 5000;

export function daemonErrorCode(value: unknown): ErrorCode {
  return typeof value === "string" && daemonErrorCodes.has(value as ErrorCode) ? (value as ErrorCode) : "DAEMON_ERROR";
}

async function withRequestTimeout<T>(
  record: SessionRecord,
  path: string,
  init: RequestInit,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // Explicit waits and recovery calls already supply their own deadlines.
  const controller = init.signal ? undefined : new AbortController();
  const signal = init.signal ?? controller!.signal;
  const timer = controller ? setTimeout(() => controller.abort(new DOMException("Daemon request timed out.", "TimeoutError")), defaultTimeoutMs) : undefined;
  try {
    return await request(signal);
  } catch (error) {
    if (signal.aborted && signal.reason?.name === "TimeoutError") {
      const method = (init.method ?? "GET").toUpperCase();
      throw new CliError("DAEMON_TIMEOUT", `Daemon request '${path}' timed out.`,
        "Inspect session health and observe current state before deciding whether to retry. A timed out operation may already have executed; do not automatically resend it.", 1,
        { session: record.session, path, method, timeoutMs: controller ? defaultTimeoutMs : null,
          responseConfirmed: false, ...(method !== "GET" && method !== "HEAD" ? { outcome: "unknown", mayHaveExecuted: true } : {}) });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fetchDaemon(record: SessionRecord, path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${record.controlPort}${path}`, {
    ...init,
    signal,
    headers: {
      Authorization: `Bearer ${record.token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

export async function daemonStreamRequest(record: SessionRecord, path: string): Promise<Response> {
  // The subscription has no lifetime deadline once its response headers arrive.
  return withRequestTimeout(record, path, {}, async signal => {
    const response = await fetchDaemon(record, path, {}, signal);
    if (response.ok) return response;
    // Error responses are finite JSON; keep their body read within the startup deadline.
    const body = await response.text();
    return new Response(body || null, { status: response.status, statusText: response.statusText, headers: response.headers });
  });
}

function daemonErrorExitCode(code: ErrorCode): number {
  return code === "BAD_INPUT" ? 3 : 1;
}

export async function loadSessionForClient(session: string): Promise<SessionRecord> {
  const record = await readSession(session);
  if (!record) {
    throw sessionNotFound(session);
  }
  return record;
}

export async function daemonRequest<T>(
  record: SessionRecord,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { response, text } = await withRequestTimeout(record, path, init, async signal => {
    const response = await fetchDaemon(record, path, init, signal);
    const text = await response.text();
    return { response, text };
  });
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const errorBody = body as { code?: unknown; error?: unknown; message?: unknown; remediation?: unknown; details?: Record<string, unknown> };
    if (response.status === 404 && errorBody.code === undefined) {
      throw daemonIncompatible(record.session, { path: path.split("?")[0], httpStatus: response.status });
    }
    const code = daemonErrorCode(errorBody.code);
    const message =
      typeof errorBody.error === "string"
        ? errorBody.error
        : typeof errorBody.message === "string"
          ? errorBody.message
          : `Daemon returned HTTP ${response.status}.`;
    const remediation =
      typeof errorBody.remediation === "string"
        ? errorBody.remediation
        : "Inspect session status and the daemon log; restart the session daemon only if it is unhealthy.";
    throw new CliError(code, message, remediation, daemonErrorExitCode(code), errorBody.details);
  }
  return body as T;
}
