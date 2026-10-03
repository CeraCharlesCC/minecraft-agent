import { EventStore } from "./events.js";
import { CliError, badInput } from "../output/errors.js";

export interface ObservationContext {
  connected: boolean;
  spawned: boolean;
  controls?: Record<string, boolean>;
  actions?: unknown[];
  /** Read authoritative actions after reconciliation may have failed an old binding. */
  getActions?: () => unknown[];
  getControls?: () => Record<string, boolean>;
  /** Lifecycle callbacks can change readiness during reconciliation. */
  getReadiness?: () => { connected: boolean; spawned: boolean };
}

export interface ProjectionOptions {
  since?: string;
  maxEntities?: number;
  radius?: number;
  tracks?: string[];
}
export type FrameOptions = ProjectionOptions;

type Point = { x: number; y: number; z: number };
type Entity = {
  id?: number; uuid?: string; type?: string; name?: string; username?: string;
  displayName?: string; kind?: string; class?: string; position?: Point; velocity?: Point;
  yaw?: number; pitch?: number; height?: number; width?: number; onGround?: boolean;
};
type LiveBot = {
  username?: string; entity?: Entity; entities?: Record<string, Entity>;
  players?: Record<string, { username?: string; uuid?: string; entity?: Entity; [key: string]: unknown }>;
  game?: { dimension?: unknown }; health?: number; food?: number; foodSaturation?: number;
  oxygenLevel?: number; experience?: unknown; controlState?: Record<string, boolean>;
  inventory?: { items?: () => unknown[]; slots?: unknown[] }; currentWindow?: unknown;
  heldItem?: unknown; quickBarSlot?: number;
  pathfinder?: { goal?: unknown; isMoving?: () => boolean };
};
interface Track {
  trackId: string; uuid?: string; minecraftEntityId?: number; bindingGeneration: number;
  worldEpoch: number; kind: string; class?: string; name?: string; username?: string;
  firstSeen: string; lastObservedAt: string; status: "loaded" | "lost" | "dead";
  position?: Point; velocity?: Point; yaw?: number; pitch?: number; onGround?: boolean;
  entity?: Entity; nearby?: boolean; proximityAt?: number;
}
export interface WorldFrame {
  runtimeId: string; worldEpoch: number; frame: string; observedAt: string;
  stateRevision: number; eventCursor: string; connection: unknown; dimension: unknown;
  self: unknown; players: unknown[]; entities: Record<string, unknown>[];
  inventory: unknown; window: unknown; actions: unknown[]; navigation: unknown;
  projection: unknown;
}

/** Only a protocol UUID is sufficient to reconnect an object after an unload. */
function verifiedUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.replaceAll("-", "").toLowerCase();
  return /^[a-f0-9]{32}$/.test(hex) ? hex : undefined;
}
function point(value: unknown): Point | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Point;
  return [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : undefined;
}
function distance(a?: Point, b?: Point): number | undefined {
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : undefined;
}
/** Detach public data without retaining live Mineflayer objects or cyclic references. */
function copy(value: unknown, seen = new WeakSet<object>(), depth = 0): any {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return typeof value === "bigint" ? value.toString() : value;
  if (depth > 16 || seen.has(value)) return null;
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) result = value.map((entry) => copy(entry, seen, depth + 1));
  else if (value instanceof Date) result = value.toISOString();
  else result = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== "function").map(([k, v]) => [k, copy(v, seen, depth + 1)]));
  seen.delete(value);
  return result;
}
function failure(code: "TRACK_UNKNOWN" | "TRACK_LOST" | "WORLD_CHANGED" | "RUNTIME_MISMATCH" | "FRAME_RESET_REQUIRED", message: string, details: Record<string, unknown> = {}): CliError {
  return new CliError(code, message, "Observe a fresh frame and use a current track or frame handle.", 1, details);
}

/** Observed state lives here; entities are bound by object identity or verified UUID only. */
export class WorldModel {
  readonly runtimeId: string;
  worldEpoch = 1;
  onTrackLost?: (trackId: string) => void;
  onWorldReset?: (reason: string) => void;
  private nextTrack = 1;
  private nextFrame = 1;
  private revision = 0;
  private fingerprint = "";
  private dimension: unknown;
  private dimensionKnown = false;
  private tracks = new Map<string, Track>();
  private bindings = new WeakMap<object, string>();
  private historicalBindings = new WeakMap<object, { trackId: string; bindingGeneration: number; worldEpoch: number }>();
  private invalidated = new WeakSet<object>();
  private identities = new Map<string, { username?: string; uuid?: string }>();
  private uuidTracks = new Map<string, string>();
  private baselines = new Map<string, { signature: string; frame: WorldFrame }>();
  private observed: Omit<WorldFrame, "frame" | "eventCursor" | "projection" | "entities"> & { entities: Record<string, unknown>[] } | undefined;
  private previousHealth?: number;
  private readonly lostRetention = 512;
  private readonly frameRetention = 32;

  constructor(private readonly events: EventStore) { this.runtimeId = events.runtimeId; }

  reset(reason: string): void {
    this.worldEpoch += 1;
    this.onWorldReset?.(reason);
    for (const track of this.tracks.values()) if (track.status === "loaded") {
      if (track.entity) this.invalidated.add(track.entity);
      this.lose(track, "lost");
    }
    this.bindings = new WeakMap();
    // Keep bounded baseline metadata so callers learn that the world changed,
    // while old-epoch frames can never serve as a valid delta baseline.
    this.observed = undefined;
    this.fingerprint = "";
    this.previousHealth = undefined;
    this.dimensionKnown = false;
    this.events.add({ type: "world.reset", worldEpoch: this.worldEpoch, reason });
    this.trimLost();
  }

  trackFor(entity: unknown): string | undefined {
    return entity && typeof entity === "object" ? this.bindings.get(entity) : undefined;
  }

  resolveTrack(trackId: string): any {
    this.validateRuntime(trackId);
    const track = this.tracks.get(trackId);
    if (!track) throw failure("TRACK_UNKNOWN", `Unknown track '${trackId}'.`, { trackId });
    if (track.worldEpoch !== this.worldEpoch) throw failure("WORLD_CHANGED", `Track '${trackId}' belongs to an earlier world.`, { trackId, expectedWorldEpoch: track.worldEpoch, worldEpoch: this.worldEpoch });
    if (track.status !== "loaded" || !track.entity) throw failure("TRACK_LOST", `Track '${trackId}' is ${track.status}.`, { trackId, status: track.status });
    return track.entity;
  }

  invalidate(entity: unknown, status: "lost" | "dead"): void {
    if (entity && typeof entity === "object") this.invalidated.add(entity);
    const historical = entity && typeof entity === "object" ? this.historicalBindings.get(entity) : undefined;
    const id = this.trackFor(entity) ?? historical?.trackId;
    const track = id && this.tracks.get(id);
    const sameBinding = track && (track.entity === entity || (!track.entity && historical &&
      track.bindingGeneration === historical.bindingGeneration + 1 && historical.worldEpoch === this.worldEpoch));
    if (track && sameBinding && track.worldEpoch === this.worldEpoch && !(track.status === "dead" && status === "lost")) this.lose(track, status);
    this.trimLost();
  }

  playerIdentity(usernameOrUuid?: string, senderUuid?: string): { username?: string; uuid?: string; trackId?: string } | undefined {
    const uuid = verifiedUuid(senderUuid ?? usernameOrUuid);
    const identity = uuid ? this.identities.get(uuid) : (usernameOrUuid ? this.identities.get(usernameOrUuid) : undefined);
    if (!identity) return undefined;
    const loaded = [...this.tracks.values()].find((track) => track.status === "loaded" && (identity.uuid ? track.uuid === identity.uuid : track.username === identity.username));
    return copy({ ...identity, ...(loaded ? { trackId: loaded.trackId } : {}) });
  }

  reconcile(input: unknown, initialContext: ObservationContext): void {
    const bot = (input ?? {}) as LiveBot;
    let context = { ...initialContext, ...initialContext.getReadiness?.() };
    const nextDimension = copy(bot.game?.dimension);
    if (context.connected && this.dimensionKnown && JSON.stringify(nextDimension) !== JSON.stringify(this.dimension)) {
      this.reset("dimension_changed");
      // A transition alone provides no evidence of a position in the new world.
      context = { ...context, spawned: false, ...initialContext.getReadiness?.() };
    }
    if (context.connected) { this.dimension = nextDimension; this.dimensionKnown = true; }
    const ready = context.connected && context.spawned;
    const now = new Date().toISOString();
    const active = new Set<string>();
    const entities = ready ? Object.values(bot.entities ?? {}).filter((entity) => entity && !this.invalidated.has(entity)) : [];
    const liveObjects = new Set(entities);
    // Retire absent objects first so an actual UUID can reconnect in this boundary.
    for (const track of this.tracks.values()) if (track.status === "loaded" && track.entity && !liveObjects.has(track.entity)) this.lose(track, "lost");
    for (const entity of entities) {
      if (!entity || entity === bot.entity) continue;
      const track = this.bind(entity, now);
      active.add(track.trackId);
      track.position = point(entity.position);
      track.velocity = point(entity.velocity);
      track.yaw = entity.yaw; track.pitch = entity.pitch; track.onGround = entity.onGround;
      track.lastObservedAt = now;
      this.proximity(track, point(bot.entity?.position));
    }
    for (const track of this.tracks.values()) if (track.status === "loaded" && !active.has(track.trackId)) this.lose(track, "lost");
    this.trimLost();
    const players = context.connected ? Object.entries(bot.players ?? {}).map(([name, player]) => {
      const username = player.username ?? name;
      const uuid = verifiedUuid(player.uuid ?? player.entity?.uuid);
      const identity = { username, ...(uuid ? { uuid } : {}) };
      this.identities.set(username, identity);
      if (uuid) this.identities.set(uuid, identity);
      const trackId = player.entity ? this.trackFor(player.entity) : undefined;
      const track = trackId ? this.tracks.get(trackId) : undefined;
      return { ...identity, online: true, ...(track?.status === "loaded" ? { trackId } : {}) };
    }) : [];
    // UUID identities for loaded players also exist before the tab-list arrives.
    for (const track of this.tracks.values()) if (track.status === "loaded" && track.username) {
      const identity = { username: track.username, ...(track.uuid ? { uuid: track.uuid } : {}) };
      this.identities.set(track.username, identity);
      if (track.uuid) this.identities.set(track.uuid, identity);
    }
    if (ready && typeof bot.health === "number") {
      if (this.previousHealth !== undefined && bot.health < this.previousHealth) this.events.add({ type: "self.damaged", health: bot.health, amount: this.previousHealth - bot.health });
      if (bot.health <= 6 && (this.previousHealth === undefined || this.previousHealth > 6)) this.events.add({ type: "self.health_critical", health: bot.health });
      this.previousHealth = bot.health;
    }
    const state = {
      connection: { connected: context.connected, spawned: context.spawned, ready },
      dimension: context.connected ? nextDimension ?? null : null,
      self: ready ? { username: bot.username, position: point(bot.entity?.position), velocity: point(bot.entity?.velocity), yaw: bot.entity?.yaw, pitch: bot.entity?.pitch,
        health: bot.health, food: bot.food, foodSaturation: bot.foodSaturation, oxygenLevel: bot.oxygenLevel,
        experience: copy(bot.experience), controls: copy(context.getControls?.() ?? context.controls ?? bot.controlState ?? {}), heldItem: copy(bot.heldItem), quickBarSlot: bot.quickBarSlot } : { username: bot.username, controls: {} },
      players,
      entities: [...this.tracks.values()].map((track) => this.serializeTrack(track)),
      inventory: ready ? copy(bot.inventory?.slots ?? bot.inventory?.items?.() ?? []) : [],
      window: ready ? this.serializeWindow(bot.currentWindow) : null,
      actions: copy(context.getActions?.() ?? context.actions ?? []),
      navigation: ready ? { moving: bot.pathfinder?.isMoving?.() ?? false, goal: this.serializeGoal(bot.pathfinder?.goal) } : { moving: false, goal: null },
    };
    // Observation timestamps are excluded so repeated observations do not invent state changes.
    const stable = copy(state);
    for (const entity of stable.entities) delete entity.lastObservedAt;
    const fingerprint = JSON.stringify(stable);
    if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.revision += 1; }
    this.observed = { ...state, runtimeId: this.runtimeId, worldEpoch: this.worldEpoch, observedAt: now, stateRevision: this.revision };
  }

  frame(bot: unknown, context: ObservationContext, options: ProjectionOptions = {}): any {
    const projection = this.options(options);
    this.reconcile(bot, context);
    const state = this.observed!;
    const preserved = new Set(projection.tracks);
    for (const action of state.actions as any[]) {
      if (action?.state !== "running") continue;
      const target = action?.target;
      if (typeof target === "string") preserved.add(target);
      else if (typeof target?.trackId === "string") preserved.add(target.trackId);
      if (typeof action?.trackId === "string") preserved.add(action.trackId);
    }
    const selfPosition = point((state.self as any)?.position);
    const loaded = state.entities.filter((entity) => entity.status === "loaded").map((entity) => ({ entity, distance: distance(selfPosition, point(entity.position)) }));
    loaded.sort((a, b) => this.tier(a.distance) - this.tier(b.distance) || (a.distance ?? Infinity) - (b.distance ?? Infinity) || String(a.entity.trackId).localeCompare(String(b.entity.trackId)));
    const selected: Record<string, unknown>[] = [];
    let ordinary = 0;
    for (const candidate of loaded) {
      if (preserved.has(String(candidate.entity.trackId)) || ((candidate.distance ?? Infinity) <= projection.radius && ordinary < projection.maxEntities)) {
        selected.push({ ...candidate.entity, distance: candidate.distance, distanceTier: this.tier(candidate.distance) });
        if (!preserved.has(String(candidate.entity.trackId))) ordinary += 1;
      }
    }
    for (const trackId of preserved) {
      const track = this.tracks.get(trackId);
      if (track && track.status !== "loaded") selected.push(this.serializeTrack(track));
    }
    const selectedIds = new Set(selected.map((e) => e.trackId));
    const aggregated: Record<string, number> = {};
    for (const { entity } of loaded) if (!selectedIds.has(entity.trackId)) { const kind = String(entity.name ?? entity.class ?? entity.kind); aggregated[kind] = (aggregated[kind] ?? 0) + 1; }
    const snapshot = copy({ ...state, entities: selected, frame: `${this.runtimeId}:f${this.nextFrame++}`, eventCursor: this.events.getCursor(), projection: { ...projection, totalLimit: projection.maxEntities + preserved.size, loaded: loaded.length, included: selected.filter((e) => e.status === "loaded").length, omitted: loaded.length - selected.filter((e) => e.status === "loaded").length, truncated: Object.keys(aggregated).length > 0, aggregates: aggregated, preservedTracks: [...preserved].sort() } }) as WorldFrame;
    const signature = JSON.stringify(projection);
    let result: unknown = snapshot;
    if (options.since) {
      this.validateRuntime(options.since);
      const baseline = this.baselines.get(options.since);
      const reason = !baseline ? "BASELINE_EXPIRED" : baseline.frame.worldEpoch !== this.worldEpoch ? "WORLD_CHANGED" : baseline.signature !== signature ? "PROJECTION_CHANGED" : undefined;
      if (!baseline || reason) throw failure("FRAME_RESET_REQUIRED", "The baseline expired, its projection changed, or its world context reset.", { resetRequired: true, reason, frame: options.since, worldEpoch: this.worldEpoch });
      const changed: Record<string, unknown> = {};
      for (const key of ["connection", "dimension", "self", "players", "inventory", "window", "actions", "navigation", "projection"] as const) if (JSON.stringify(baseline.frame[key]) !== JSON.stringify(snapshot[key])) changed[key] = snapshot[key];
      const before = new Map(baseline.frame.entities.map((entity) => [entity.trackId, entity]));
      const after = new Map(snapshot.entities.map((entity) => [entity.trackId, entity]));
      const removed = [...before.keys()].filter((id) => !after.has(id)).map((id) => {
        const status = this.tracks.get(String(id))?.status;
        return { trackId: id, status: status === "loaded" ? "omitted" : status ?? "lost" };
      });
      const comparable = (entity: Record<string, unknown> | undefined) => entity && Object.fromEntries(Object.entries(entity).filter(([key]) => key !== "lastObservedAt"));
      changed.entities = snapshot.entities.filter((entity) => JSON.stringify(comparable(entity)) !== JSON.stringify(comparable(before.get(entity.trackId))));
      result = { runtimeId: snapshot.runtimeId, worldEpoch: snapshot.worldEpoch, frame: snapshot.frame, observedAt: snapshot.observedAt, stateRevision: snapshot.stateRevision, eventCursor: snapshot.eventCursor, since: options.since, delta: { changed, removed } };
    }
    this.baselines.set(snapshot.frame, { signature, frame: copy(snapshot) });
    while (this.baselines.size > this.frameRetention) this.baselines.delete(this.baselines.keys().next().value!);
    return result;
  }

  private options(options: ProjectionOptions): Required<Omit<ProjectionOptions, "since">> {
    const maxEntities = options.maxEntities ?? 50;
    const radius = options.radius ?? 64;
    if (!Number.isInteger(maxEntities) || maxEntities < 0 || maxEntities > 512) throw badInput("maxEntities must be an integer between 0 and 512.");
    if (!Number.isFinite(radius) || radius < 0 || radius > 4096) throw badInput("radius must be between 0 and 4096.");
    if (options.tracks && (!Array.isArray(options.tracks) || options.tracks.length > 512 || options.tracks.some((id) => typeof id !== "string"))) throw badInput("tracks must contain at most 512 track IDs.");
    const tracks = [...new Set(options.tracks ?? [])].sort();
    for (const id of tracks) this.validateRuntime(id);
    return { maxEntities, radius, tracks };
  }
  private serializeGoal(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object") return null;
    const goal = value as Record<string, unknown>;
    const parameters: Record<string, number> = {};
    // Only scalar goal parameters are public. Entity/world objects and item NBT
    // must never bypass the entity projection through a pathfinder goal.
    for (const key of ["x", "y", "z", "rangeSq", "reach", "entityHeight"]) {
      if (typeof goal[key] === "number" && Number.isFinite(goal[key])) parameters[key] = goal[key];
    }
    const target = this.trackFor(goal.entity);
    return { kind: value.constructor.name, parameters, ...(target ? { target } : {}) };
  }
  private validateRuntime(id: string): void {
    if (typeof id !== "string" || !id.startsWith(`${this.runtimeId}:`)) throw failure("RUNTIME_MISMATCH", `Handle '${id}' belongs to another runtime.`, { handle: id, runtimeId: this.runtimeId });
  }
  private bind(entity: Entity, now: string): Track {
    const existing = this.bindings.get(entity);
    const uuid = verifiedUuid(entity.uuid);
    let track = existing ? this.tracks.get(existing) : undefined;
    if (!track && uuid) {
      const id = this.uuidTracks.get(uuid);
      const known = id && this.tracks.get(id);
      // Concurrent objects with the same UUID must not steal an active binding.
      if (known && known.status !== "loaded" && known.status !== "dead") track = known;
    }
    if (!track) {
      track = { trackId: `${this.runtimeId}:${entity.type === "player" || entity.username ? "p" : "e"}${this.nextTrack++}`, ...(uuid ? { uuid } : {}), bindingGeneration: 0,
        worldEpoch: this.worldEpoch, kind: entity.type ?? entity.kind ?? "entity", class: entity.class ?? entity.kind, name: entity.name, username: entity.username, firstSeen: now, lastObservedAt: now, status: "lost" };
      this.tracks.set(track.trackId, track);
      if (uuid) this.uuidTracks.set(uuid, track.trackId);
    }
    if (track.entity !== entity || track.status !== "loaded") {
      track.entity = entity; track.minecraftEntityId = entity.id; track.bindingGeneration += 1;
      track.worldEpoch = this.worldEpoch; track.status = "loaded"; track.nearby = false; track.proximityAt = undefined;
      this.bindings.set(entity, track.trackId);
      this.historicalBindings.set(entity, { trackId: track.trackId, bindingGeneration: track.bindingGeneration, worldEpoch: this.worldEpoch });
      this.events.add({ type: "entity.appeared", trackId: track.trackId, worldEpoch: this.worldEpoch });
    }
    return track;
  }
  private lose(track: Track, status: "lost" | "dead"): void {
    if (track.status !== "loaded" && track.status === status) return;
    if (track.entity) this.bindings.delete(track.entity);
    track.entity = undefined; track.position = undefined; track.velocity = undefined; track.yaw = undefined; track.pitch = undefined; track.onGround = undefined;
    track.status = status; track.bindingGeneration += 1; track.nearby = undefined;
    this.events.add({ type: status === "dead" ? "entity.dead" : "entity.lost", trackId: track.trackId, worldEpoch: this.worldEpoch });
    this.onTrackLost?.(track.trackId);
  }
  private proximity(track: Track, selfPosition?: Point): void {
    const d = distance(selfPosition, track.position);
    if (d === undefined) return;
    const desired = track.nearby ? d <= 20 : d <= 16;
    const now = Date.now();
    if (desired !== track.nearby && (track.proximityAt === undefined || now - track.proximityAt >= 1000)) {
      track.nearby = desired; track.proximityAt = now;
      this.events.add({ type: desired ? "entity.entered_nearby" : "entity.left_nearby", trackId: track.trackId, distance: d });
    }
  }
  private trimLost(): void {
    const lost = [...this.tracks.values()].filter((track) => track.status !== "loaded");
    for (const track of lost.slice(0, Math.max(0, lost.length - this.lostRetention))) {
      this.tracks.delete(track.trackId);
      if (track.uuid && this.uuidTracks.get(track.uuid) === track.trackId) this.uuidTracks.delete(track.uuid);
    }
  }
  private tier(d?: number): number { return d === undefined ? 3 : d <= 16 ? 0 : d <= 64 ? 1 : 2; }
  private serializeTrack(track: Track): Record<string, unknown> {
    const { entity: _entity, nearby: _nearby, proximityAt: _proximityAt, ...snapshot } = track;
    return copy(snapshot);
  }
  private serializeWindow(input: unknown): unknown {
    if (!input || typeof input !== "object") return null;
    const window = input as Record<string, unknown>;
    const slots = window.slots ?? (typeof window.items === "function" ? window.items.call(window) : typeof window.containerItems === "function" ? window.containerItems.call(window) : []);
    return copy({ id: window.id, type: window.type, title: window.title, slots, inventoryStart: window.inventoryStart, inventoryEnd: window.inventoryEnd, selectedItem: window.selectedItem });
  }
}
