import { detachData, EventStore } from "./events.js";
import { badInput, CliError } from "../output/errors.js";

export type ActionResource = "movement" | "look" | "item" | "window";
export interface RuntimeAction {
  action: string;
  runtimeId: string;
  worldEpoch: number;
  kind: string;
  target?: string;
  state: "running" | "completed" | "failed" | "cancelled";
  reason?: string;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export type ActionWaitResult = RuntimeAction & { timedOut: boolean };

/** Owns physical resources until settlement; terminal records are never resurrected. */
export class ActionManager {
  private nextId = 1;
  private readonly records = new Map<string, RuntimeAction>();
  private readonly owners = new Map<ActionResource, string>();
  private readonly cleanup = new Map<string, () => void>();
  private readonly terminalOrder: string[] = [];
  private readonly waiters = new Map<string, Set<(record: RuntimeAction) => void>>();

  constructor(private readonly events: EventStore, private readonly historyLimit = 256) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 0) throw badInput("Action history limit must be a nonnegative integer.");
  }

  start(kind: string, worldEpoch: number, resources: ActionResource[], options: {
    target?: string; stop?: () => void; run?: () => unknown | Promise<unknown>; continuous?: boolean;
  } = {}): RuntimeAction {
    this.cancelResources(resources, "REPLACED");
    const record: RuntimeAction = {
      action: `${this.events.runtimeId}:a${this.nextId++}`, runtimeId: this.events.runtimeId,
      worldEpoch, kind, target: options.target, state: "running", startedAt: new Date().toISOString(),
    };
    this.records.set(record.action, record);
    for (const resource of resources) this.owners.set(resource, record.action);
    if (options.stop) this.cleanup.set(record.action, options.stop);
    this.events.add({ type: "action.started", action: record.action, kind, target: record.target });
    // Work starts now so binding validation is adjacent to the Mineflayer call.
    try {
      const result = options.run?.();
      if (options.continuous) {
        Promise.resolve(result).catch((error) => this.fail(record.action, error));
      } else {
        Promise.resolve(result)
          .then((value) => this.finish(record.action, "completed", undefined, value))
          .catch((error) => this.fail(record.action, error));
      }
    } catch (error) {
      this.fail(record.action, error);
    }
    this.prune();
    return detachData(record);
  }

  get(id: string): RuntimeAction {
    if (!id.startsWith(`${this.events.runtimeId}:`)) {
      throw new CliError("RUNTIME_MISMATCH", "Action belongs to another runtime.", "Observe a fresh frame.", 1,
        { runtimeId: this.events.runtimeId, action: id });
    }
    const record = this.records.get(id);
    if (!record) throw new CliError("ACTION_UNKNOWN", "Action is unknown or expired.", "Observe current actions.", 1, { action: id });
    return detachData(record);
  }

  /** Waiting observes settlement; its deadline never cancels the underlying work. */
  wait(id: string, timeout = 5000, signal?: AbortSignal): Promise<ActionWaitResult> {
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 30000) {
      throw badInput("Action wait timeout must be an integer between 0 and 30000 milliseconds.");
    }
    const current = this.get(id);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Action wait aborted."));
    if (current.state !== "running" || timeout === 0) {
      return Promise.resolve({ ...current, timedOut: current.state === "running" });
    }
    return new Promise((resolve, reject) => {
      const subscribers = this.waiters.get(id) ?? new Set<(record: RuntimeAction) => void>();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        subscribers.delete(settled);
        if (subscribers.size === 0) this.waiters.delete(id);
      };
      const settled = (record: RuntimeAction) => {
        cleanup();
        resolve({ ...detachData(record), timedOut: false });
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Action wait aborted."));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ...this.get(id), timedOut: true });
      }, timeout);
      subscribers.add(settled);
      this.waiters.set(id, subscribers);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  list(): RuntimeAction[] {
    return [...this.records.values()].map((record) => detachData(record));
  }

  /** Frames retain all running targets and only the eight latest settlements. */
  observation(): (Omit<RuntimeAction, "result" | "error"> & { error?: { code: string } })[] {
    const recent = new Set(this.terminalOrder.slice(-8));
    return [...this.records.values()]
      .filter((record) => record.state === "running" || recent.has(record.action))
      .map(({ result: _result, error, ...summary }) => detachData({
        ...summary, ...(error ? { error: { code: error.code } } : {}),
      }));
  }

  owner(resource: ActionResource): string | undefined { return this.owners.get(resource); }

  cancel(id: string, reason = "CANCELLED"): RuntimeAction {
    this.get(id);
    const record = this.records.get(id)!;
    this.finish(id, "cancelled", reason);
    return detachData(record);
  }

  cancelResources(resources: ActionResource[], reason = "REPLACED"): void {
    for (const id of new Set(resources.map((resource) => this.owners.get(resource)).filter((id): id is string => Boolean(id)))) {
      this.finish(id, "cancelled", reason);
    }
  }

  failTarget(track: string): void {
    for (const record of this.records.values()) {
      if (record.state === "running" && record.target === track) {
        this.fail(record.action, new CliError("TRACK_LOST", "Action target left observation.", "Observe before starting a new action.", 1, { trackId: track }));
      }
    }
  }

  failAll(reason: string): void {
    for (const record of this.records.values()) {
      if (record.state === "running") this.fail(record.action,
        new CliError("WORLD_CHANGED", `Action stopped: ${reason}.`, "Observe a fresh frame.", 1, { reason }));
    }
  }

  fail(id: string, error: unknown): void {
    const record = this.records.get(id);
    if (!record || record.state !== "running") return;
    const navigationFailure = error instanceof Error && /pathfinder|path to goal|no path|goal/i.test(error.message);
    record.error = { code: error instanceof CliError ? error.code : navigationFailure ? "NAVIGATION_FAILED" : "DAEMON_ERROR",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof CliError && error.details ? { details: detachData(error.details) } : {}) };
    this.finish(id, "failed", record.error.code);
  }

  private finish(id: string, state: RuntimeAction["state"], reason?: string, result?: unknown): void {
    const record = this.records.get(id);
    if (!record || record.state !== "running") return;
    const detachedResult = result === undefined ? undefined : detachData(result);
    record.state = state;
    record.reason = reason;
    record.finishedAt = new Date().toISOString();
    if (result !== undefined) record.result = detachedResult;
    const stop = this.cleanup.get(id);
    this.cleanup.delete(id);
    // Release before cleanup because stop() may synchronously emit callbacks.
    for (const [resource, owner] of this.owners) if (owner === id) this.owners.delete(resource);
    if (state !== "completed") {
      try { stop?.(); } catch { /* Preserve authoritative termination even if transport has gone. */ }
    }
    this.events.add({ type: `action.${state}`, action: id, kind: record.kind, target: record.target, reason, error: record.error });
    for (const waiter of [...(this.waiters.get(id) ?? [])]) waiter(record);
    this.terminalOrder.push(id);
    this.prune();
  }

  private prune(): void {
    // Retain by settlement order: an old, long-running action just cancelled is
    // newer history than a short action that already finished in the meantime.
    while (this.terminalOrder.length > this.historyLimit) this.records.delete(this.terminalOrder.shift()!);
  }
}
