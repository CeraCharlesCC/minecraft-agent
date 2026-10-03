import { randomUUID } from "node:crypto";
import { badInput, CliError } from "../output/errors.js";

export interface BotEvent {
  id: number;
  cursor: string;
  type: string;
  timestamp: string;
  sender?: string;
  text?: string;
  [field: string]: unknown;
}

export type EventProfile = "all" | "agent";

/** Stable allowlist: new event types require an intentional profile update. */
export const AGENT_EVENT_TYPES: readonly string[] = Object.freeze([
  "chat.player", "chat.whisper", "chat.unverified", "server.message",
  "self.damaged", "self.health_critical", "self.died", "world.reset",
  "connection.login", "connection.ready", "connection.disconnected", "connection.error",
  "action.started", "action.completed", "action.failed", "action.cancelled",
]);

export interface EventFilter {
  profile: EventProfile;
  /** Exact resolved types; empty with unknownTypes=included means every type. */
  types: string[];
  unknownTypes: "included" | "excluded";
}

/** Explicit types narrow a profile. Cursors belong to a fixed profile/filter subscription. */
export function resolveEventFilter(profile: string = "all", types: readonly string[] = []): EventFilter {
  if (profile !== "all" && profile !== "agent") throw badInput("Event profile must be all or agent.");
  const selected = [...new Set(types)];
  return { profile, types: profile === "agent" ? AGENT_EVENT_TYPES.filter(type => !selected.length || selected.includes(type)) : selected,
    unknownTypes: profile === "all" && selected.length === 0 ? "included" : "excluded" };
}

export function eventMatchesFilter(event: { type: string }, filter: EventFilter): boolean {
  return filter.unknownTypes === "included" || filter.types.includes(event.type);
}

export interface EventQuery extends EventFilter {
  events: BotEvent[];
  nextCursor: string;
  latestCursor: string;
  gap: boolean;
  expiredTypes: string[];
}

export interface EventStoreOptions {
  /** Default per-type retention. Important transient events retain four times this. */
  maxEvents?: number;
  /** Exact type overrides, or class overrides such as "chat" and "action". */
  retention?: Record<string, number>;
  debugLimit?: number;
}

export interface DebugEvent {
  cursor: string;
  messageId?: string;
  raw: unknown;
}

/** Copy observable data without keeping Mineflayer objects or executable members. */
export function detachData<T>(value: T): T {
  const seen = new WeakSet<object>();
  const copy = (item: unknown): unknown => {
    if (typeof item === "bigint") return item.toString();
    if (item === null || typeof item !== "object") return typeof item === "function" ? undefined : item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    let result: unknown;
    if (item instanceof Date) result = item.toISOString();
    else if (Buffer.isBuffer(item)) result = { type: "Buffer", data: [...item] };
    else if (Array.isArray(item)) result = item.map(copy);
    else {
      const record: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(item)) {
        if (typeof val !== "function") Object.defineProperty(record, key, { value: copy(val), enumerable: true, writable: true, configurable: true });
      }
      result = record;
    }
    seen.delete(item);
    return result;
  };
  return copy(value) as T;
}

export class EventStore {
  readonly runtimeId = randomUUID();
  private nextId = 1;
  private nextMessageId = 1;
  private readonly eventsByType = new Map<string, BotEvent[]>();
  private readonly evicted = new Map<string, number>();
  private readonly debug: DebugEvent[] = [];
  private readonly subscribers = new Set<(event: BotEvent) => void>();
  private readonly options: Required<EventStoreOptions>;

  constructor(options: number | EventStoreOptions = {}) {
    const configured = typeof options === "number" ? { maxEvents: options } : options;
    this.options = { maxEvents: configured.maxEvents ?? 256, retention: { ...configured.retention }, debugLimit: configured.debugLimit ?? 256 };
    for (const capacity of [this.options.maxEvents, this.options.debugLimit, ...Object.values(this.options.retention)]) {
      if (!Number.isSafeInteger(capacity) || capacity < 0) throw badInput("Event retention must be a nonnegative integer.");
    }
  }

  allocateMessageId(): string {
    return `${this.runtimeId}:m${this.nextMessageId++}`;
  }

  add(event: { type: string; timestamp?: string; [field: string]: unknown }): BotEvent {
    const { raw, ...semantic } = event;
    const id = this.nextId++;
    const stored: BotEvent = {
      ...detachData(semantic),
      type: event.type,
      id,
      cursor: this.cursor(id),
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    const retained = this.eventsByType.get(stored.type) ?? [];
    retained.push(stored);
    const capacity = this.capacity(stored.type);
    while (retained.length > capacity) this.evicted.set(stored.type, retained.shift()!.id);
    this.eventsByType.set(stored.type, retained);
    if (raw !== undefined && this.options.debugLimit > 0) {
      this.debug.push({ cursor: stored.cursor, ...(typeof stored.messageId === "string" ? { messageId: stored.messageId } : {}), raw: detachData(raw) });
      if (this.debug.length > this.options.debugLimit) this.debug.shift();
    }
    for (const subscriber of this.subscribers) {
      try { subscriber(detachData(stored)); }
      catch { this.subscribers.delete(subscriber); }
    }
    return detachData(stored);
  }

  getCursor(): string {
    return this.cursor(this.nextId - 1);
  }

  /** A cursor is a runtime capability; a bare sequence cannot survive a restart safely. */
  query(since: string | number = 0, limit = 50, types: readonly string[] = [], profile: string = "all"): EventQuery {
    const sequence = this.parseCursor(since);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw badInput("Event limit must be between 1 and 1000.");
    const filter = resolveEventFilter(profile, types);
    const expiredTypes = [...this.evicted].filter(([type, highWater]) => highWater > sequence && eventMatchesFilter({ type }, filter)).map(([type]) => type).sort();
    const events: BotEvent[] = [];
    let examined = sequence;
    for (const event of this.ordered()) {
      if (event.id <= sequence) continue;
      examined = event.id;
      if (eventMatchesFilter(event, filter)) events.push(detachData(event));
      if (events.length === limit) break;
    }
    // If the limit was not reached, all retained events and expired holes were examined.
    if (events.length < limit) examined = this.nextId - 1;
    return { ...filter, events, nextCursor: this.cursor(examined), latestCursor: this.getCursor(), gap: expiredTypes.length > 0, expiredTypes };
  }

  /** Compatibility only. Public replay uses query and scoped cursors. */
  list(since: number, limit: number, types: readonly string[] = []): BotEvent[] {
    const filter = types.length ? new Set(types) : undefined;
    return this.ordered().filter(event => event.id > since && (!filter || filter.has(event.type))).slice(0, limit).map(detachData);
  }

  getLastEventId(): number { return this.nextId - 1; }

  getDebug(id?: string | number): DebugEvent[] {
    return this.debug.filter(record => id === undefined || record.messageId === id || record.cursor === id || (typeof id === "number" && record.cursor === this.cursor(id))).map(detachData);
  }

  debugList(id?: string | number): DebugEvent[] { return this.getDebug(id); }

  subscribe(subscriber: (event: BotEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private ordered(): BotEvent[] {
    return [...this.eventsByType.values()].flat().sort((a, b) => a.id - b.id);
  }

  private capacity(type: string): number {
    const category = type.split(".")[0]!;
    const important = type.startsWith("chat.") || type === "server.message" || /(?:failed|cancelled|lost|death|respawn|disconnect|kicked|login|spawn|world)/.test(type);
    return this.options.retention[type] ?? this.options.retention[category] ?? this.options.maxEvents * (important ? 4 : 1);
  }

  private cursor(sequence: number): string { return `${this.runtimeId}:s${sequence}`; }

  private parseCursor(cursor: string | number): number {
    if (cursor === 0 || cursor === "0") return 0;
    if (typeof cursor !== "string") throw badInput("Use a runtime-scoped event cursor, or 0 to start replay.");
    const match = /^(.*):s(\d+)$/.exec(cursor);
    if (!match) throw badInput("Invalid event cursor.");
    if (match[1] !== this.runtimeId) throw new CliError("RUNTIME_MISMATCH", "The event cursor belongs to another runtime.", "Observe a fresh frame and restart replay with cursor 0.", 3, { runtimeId: this.runtimeId, cursor });
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(sequence) || sequence > this.nextId - 1) throw badInput("Event cursor is ahead of this runtime.");
    return sequence;
  }
}
