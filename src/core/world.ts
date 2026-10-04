import { EventStore } from "./events.js";
import { CliError, badInput } from "../output/errors.js";
import { encodeActionContext } from "./context.js";
import { decodeHandle, encodeHandle } from "./handles.js";
import { observedEntityPosition } from "./entity-observation.js";
import { normalizeRegistryName } from "./registry.js";
import { API_VERSION } from "./protocol.js";

export interface ObservationContext {
  connected: boolean;
  spawned: boolean;
  controls?: Record<string, boolean>;
  actions?: unknown[];
  /** Read authoritative actions after reconciliation may have failed an old binding. */
  getActions?: () => unknown[];
  getControls?: () => Record<string, boolean> | undefined;
  /** Lifecycle callbacks can change readiness during reconciliation. */
  getReadiness?: () => { connected: boolean; spawned: boolean };
  getConnectionStatus?: () => { state: string; ready?: boolean; reason?: string; cause?: { code: string; message: string }; recovery?: { state: string; attempts?: number; maxAttempts?: number }; lastError?: string | { code: string; message: string; occurredAt: string; generation: number }; remediation?: string };
}

export interface ProjectionOptions {
  detail?: "compact" | "full";
  since?: string;
  maxEntities?: number;
  radius?: number;
  tracks?: string[];
}
export type FrameOptions = ProjectionOptions;
export interface EntitySearchOptions {
  name?: string; type?: string; types?: string[]; radius?: number; limit?: number;
}

type Point = { x: number; y: number; z: number };
type Entity = {
  id?: number; uuid?: string; type?: string; name?: string; username?: string;
  displayName?: string; kind?: string; class?: string; position?: Point; velocity?: Point;
  yaw?: number; pitch?: number; height?: number; width?: number; onGround?: boolean;
  equipment?: unknown[];
};
type LiveBot = {
  username?: string; entity?: Entity; entities?: Record<string, Entity>;
  players?: Record<string, { username?: string; uuid?: string; entity?: Entity; [key: string]: unknown }>;
  game?: { dimension?: unknown }; health?: number; food?: number; foodSaturation?: number;
  oxygenLevel?: number; experience?: unknown; controlState?: Record<string, boolean>;
  inventory?: { items?: () => unknown[]; slots?: unknown[] }; currentWindow?: unknown;
  heldItem?: unknown; quickBarSlot?: number;
  pathfinder?: { goal?: unknown; isMoving?: () => boolean };
  registry?: { entitiesByName?: Record<string, unknown> };
};
interface Track {
  trackId: string; uuid?: string; minecraftEntityId?: number; bindingGeneration: number;
  worldEpoch: number; kind: string; type?: string; class?: string; name?: string; username?: string;
  firstSeen: string; lastObservedAt: string; status: "loaded" | "lost" | "dead";
  position?: Point; velocity?: Point; yaw?: number; pitch?: number; onGround?: boolean;
  entity?: Entity; nearby?: boolean; proximityAt?: number;
}
export interface WorldFrame {
  type: "full"; context: string; frame: string; eventCursor: string;
  runtimeId?: string; worldEpoch?: number; observedAt?: string;
  /** Revision of content observed at frame boundaries, not a physical tick counter. */
  stateRevision?: number; connection: unknown; dimension?: unknown;
  self: unknown; players?: unknown[]; entities: Record<string, unknown>[];
  inventory: unknown; window?: unknown; actions: unknown[]; navigation?: unknown;
  projection: unknown; unknownFields?: string[];
  reset?: { reason: "BASELINE_EXPIRED" | "WORLD_CHANGED" | "PROJECTION_CHANGED" };
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
export function entitySpecies(entity: Entity, registry?: LiveBot["registry"]): string | undefined {
  const name = entity.type === "player" || entity.username ? "player" : entity.name?.replace(/^minecraft:/, "");
  if (!name || name === "unknown" || !/^[a-z][a-z0-9_]*$/.test(name)) return undefined;
  if (name !== "player" && registry?.entitiesByName && !Object.hasOwn(registry.entitiesByName, name) && !Object.hasOwn(registry.entitiesByName, `minecraft:${name}`)) return undefined;
  return `minecraft:${name}`;
}
/** Extract visible custom-name text from chat JSON or typed chat NBT. */
function itemNameText(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (typeof value === "string") {
    if (/^[\s]*[\[{"]/.test(value)) {
      try { return itemNameText(JSON.parse(value), depth + 1); } catch { /* Plain names can begin with JSON punctuation. */ }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const texts = value.map((entry) => itemNameText(entry, depth + 1)).filter((entry): entry is string => entry !== undefined);
    return texts.length ? texts.join("") : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const name = value as Record<string, unknown>;
  if (["string", "compound", "list"].includes(String(name.type))) return itemNameText(name.value, depth + 1);
  const text = itemNameText(name.text, depth + 1);
  const extra = itemNameText(name.extra, depth + 1);
  if (text !== undefined || extra !== undefined) return `${text ?? ""}${extra ?? ""}`;
  const translation = itemNameText(name.translate, depth + 1);
  if (translation !== undefined) {
    const parameters = itemNameText(name.with, depth + 1);
    return `${translation}${parameters ? ` ${parameters}` : ""}`;
  }
  return undefined;
}
/** Public item facts; getters may read NBT, but raw NBT/components never escape. */
export function projectItem(value: unknown, detail: "compact" | "full" = "compact"): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const key of ["name", "displayName"]) {
    try { if (typeof item[key] === "string") result[key] = item[key]; } catch { /* An unsupported getter does not make the whole item unavailable. */ }
  }
  try {
    const customName = itemNameText(item.customName);
    if (customName !== undefined) result.customName = customName;
  } catch { /* An unavailable custom-name getter does not hide other item facts. */ }
  for (const key of ["count", "slot", "type", "metadata", "durabilityUsed", "maxDurability", ...(detail === "full" ? ["stackSize"] : [])]) {
    try { if (typeof item[key] === "number" && Number.isFinite(item[key])) result[key] = item[key]; } catch { /* Unsupported protocol getter. */ }
  }
  try {
    const raw = item.enchants;
    const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).enchantments) ? (raw as { enchantments: unknown[] }).enchantments : undefined;
    if (values) {
      const enchants = values.flatMap((value): Record<string, unknown>[] => {
        if (!value || typeof value !== "object") return [];
        const enchant = value as Record<string, unknown>;
        if (typeof enchant.name === "string" && typeof enchant.lvl === "number" && Number.isFinite(enchant.lvl)) return [{ name: enchant.name, lvl: enchant.lvl }];
        if (Number.isSafeInteger(enchant.id) && Number(enchant.id) >= 0 && Number.isSafeInteger(enchant.level)) return [{ id: enchant.id, level: enchant.level }];
        return [];
      });
      if (enchants.length) result.enchants = enchants;
    }
  } catch { /* Unsupported protocol getter. */ }
  return result;
}

export function projectEntity(value: unknown, detail: "compact" | "full" = "compact"): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entity = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const key of ["trackId", "status", "type", "name", "username", ...(detail === "full" ? ["kind", "class", "uuid"] : [])]) if (typeof entity[key] === "string") result[key] = entity[key];
  if (!Object.hasOwn(result, "type")) result.type = null;
  if (Array.isArray(entity.unknownFields)) result.unknownFields = entity.unknownFields.filter((field) => field === "type" || field === "position");
  for (const key of ["distance", ...(detail === "full" ? ["yaw", "pitch", "height", "width", "minecraftEntityId", "bindingGeneration", "worldEpoch"] : [])]) if (typeof entity[key] === "number" && Number.isFinite(entity[key])) result[key] = entity[key];
  const position = point(entity.position);
  if (position) result.position = position;
  if (detail === "full") {
    const velocity = point(entity.velocity);
    if (velocity) result.velocity = velocity;
    if (typeof entity.onGround === "boolean") result.onGround = entity.onGround;
  }
  return result;
}
function slotObservation(slots: unknown, fallback: unknown, ready: boolean) {
  const indexed = Array.isArray(slots);
  const values = indexed ? slots : Array.isArray(fallback) ? fallback : null;
  return { ready, known: ready && values !== null && (indexed || values.every((item: any) => item && Number.isSafeInteger(item.slot) && item.slot >= 0)), slotCount: ready && indexed ? slots.length : null,
    slots: ready && values ? values.map((item) => item === null ? null : projectItem(item, "full")) : null, indexed };
}
function publicSlots(input: ReturnType<typeof slotObservation>, detail: "compact" | "full" = "compact") {
  if (!input.known) return { known: false };
  const slots: unknown[] = [];
  for (const [index, value] of (input.slots ?? []).entries()) {
    if (!value || typeof value !== "object") continue;
    const slot = input.indexed ? index : (value as Record<string, unknown>).slot;
    // items() without slot numbers cannot establish an actionable slot index.
    if (!Number.isSafeInteger(slot) || Number(slot) < 0) continue;
    slots.push({ ...projectItem(value, detail), slot });
  }
  return { known: true, ...(input.slotCount !== null ? { slotCount: input.slotCount } : {}), slots };
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
  /** Only genuine concurrent UUID collisions need a replacement-owner lookup. */
  private uuidCollisions = new Set<string>();
  private baselines = new Map<string, { signature: string; worldEpoch: number; frame: WorldFrame }>();
  private observed: { runtimeId: string; worldEpoch: number; context: string; observedAt: string; stateRevision: number;
    connection: Record<string, unknown>; dimension: unknown; self: Record<string, unknown>; players: unknown[];
    entities: Record<string, unknown>[]; inventory: ReturnType<typeof slotObservation>; window: unknown;
    actions: unknown[]; navigation: unknown; unknownFields: string[] } | undefined;
  private previousHealth?: number;
  private liveBot?: LiveBot;
  private dictionaryKeys = new WeakMap<object, string>();
  private dictionaryTracks = new Map<string, Track>();
  private pendingProximity = new Set<string>();
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
    this.dictionaryTracks.clear();
    this.pendingProximity.clear();
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
    this.validateRuntime(trackId, ["p", "e"]);
    const track = this.tracks.get(trackId);
    if (!track) throw failure("TRACK_UNKNOWN", `Unknown track '${trackId}'.`, { trackId });
    if (track.worldEpoch !== this.worldEpoch) throw failure("WORLD_CHANGED", `Track '${trackId}' belongs to an earlier world.`, { trackId, expectedWorldEpoch: track.worldEpoch, worldEpoch: this.worldEpoch });
    if (track.status === "loaded" && track.entity && this.liveBot && !this.isLive(track.entity, this.liveBot)) { this.lose(track, "lost"); this.trimLost(); }
    if (track.status === "loaded" && track.entity && track.uuid && verifiedUuid(track.entity.uuid) && track.uuid !== verifiedUuid(track.entity.uuid)) this.lose(track, "lost");
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

  /** Validate the small world context before operations; no snapshot is built here. */
  checkWorld(input: unknown, initialContext: ObservationContext): ObservationContext {
    const bot = (input ?? {}) as LiveBot;
    this.liveBot = bot;
    let context = { ...initialContext, ...initialContext.getReadiness?.() };
    const nextDimension = bot.game?.dimension;
    if (context.connected && this.dimensionKnown && nextDimension !== this.dimension) {
      this.reset("dimension_changed");
      context = { ...context, spawned: false, ...initialContext.getReadiness?.() };
    }
    if (context.connected) { this.dimension = nextDimension; this.dimensionKnown = true; }
    return context;
  }

  /** Synchronize loaded identities at spawn, frame and find boundaries. */
  syncBindings(input: unknown, initialContext: ObservationContext): ObservationContext {
    const bot = (input ?? {}) as LiveBot;
    const context = this.checkWorld(bot, initialContext);
    const ready = context.connected && context.spawned;
    const entries = ready ? Object.entries(bot.entities ?? {}).filter(([, entity]) => entity && !this.invalidated.has(entity)) : [];
    const liveObjects = new Set(entries.map(([, entity]) => entity));
    for (const track of this.tracks.values()) if (track.status === "loaded" && track.entity && !liveObjects.has(track.entity)) this.lose(track, "lost");
    const now = new Date().toISOString();
    for (const [key, entity] of entries) {
      this.setDictionaryKey(entity, key);
      if (entity !== bot.entity) {
        const track = this.bind(entity, now);
        this.dictionaryTracks.set(key, track);
        this.refreshTrack(track, entity, bot, now);
      }
    }
    this.trimLost();
    this.syncPlayers(bot, context.connected);
    return context;
  }

  /** Movement packets touch only their entity and proximity state. */
  updateEntity(input: unknown, initialContext: ObservationContext, value: unknown): void {
    const bot = (input ?? {}) as LiveBot;
    const context = this.checkWorld(bot, initialContext);
    const entity = value as Entity | undefined;
    if (!context.connected || !context.spawned || !entity || entity === bot.entity || this.invalidated.has(entity)) return;
    if (!this.isLive(entity, bot)) { this.invalidate(entity, "lost"); return; }
    const key = this.dictionaryKeys.get(entity)!;
    const previous = this.dictionaryTracks.get(key);
    let retired = false;
    if (previous?.entity && previous.entity !== entity && !this.isLive(previous.entity, bot)) { this.lose(previous, "lost"); retired = true; }
    const uuid = verifiedUuid(entity.uuid);
    const uuidTrack = uuid ? this.tracks.get(this.uuidTracks.get(uuid) ?? "") : undefined;
    if (uuidTrack?.entity && uuidTrack.entity !== entity && !this.isLive(uuidTrack.entity, bot)) { this.lose(uuidTrack, "lost"); retired = true; }
    const now = new Date().toISOString();
    const track = this.bind(entity, now);
    this.dictionaryTracks.set(key, track);
    this.refreshTrack(track, entity, bot, now);
    if (retired) this.trimLost();
  }

  /** Self motion evaluates distances without copying inventory or frame content. */
  updateProximity(input: unknown, initialContext: ObservationContext): void {
    const bot = (input ?? {}) as LiveBot;
    const context = this.checkWorld(bot, initialContext);
    if (!context.connected || !context.spawned) return;
    const origin = observedEntityPosition(bot.entity);
    for (const track of this.tracks.values()) if (track.status === "loaded" && track.entity) {
      if (!this.isLive(track.entity, bot)) { this.lose(track, "lost"); continue; }
      track.position = observedEntityPosition(track.entity);
      this.proximity(track, origin);
    }
    this.trimLost();
  }

  /** Retry only cooldown-suppressed proximity transitions on physics ticks. */
  flushProximity(input: unknown, initialContext: ObservationContext): void {
    if (this.pendingProximity.size === 0) return;
    const bot = (input ?? {}) as LiveBot;
    const context = this.checkWorld(bot, initialContext);
    if (!context.connected || !context.spawned) return;
    const origin = observedEntityPosition(bot.entity);
    let retired = false;
    for (const id of this.pendingProximity) {
      const track = this.tracks.get(id);
      if (!track || track.status !== "loaded" || !track.entity) { this.pendingProximity.delete(id); continue; }
      if (!this.isLive(track.entity, bot)) { this.lose(track, "lost"); retired = true; continue; }
      track.position = observedEntityPosition(track.entity);
      this.proximity(track, origin);
    }
    if (retired) this.trimLost();
  }

  observeHealth(input: unknown, initialContext: ObservationContext): void {
    const bot = (input ?? {}) as LiveBot;
    const context = this.checkWorld(bot, initialContext);
    if (context.connected && context.spawned && typeof bot.health === "number") {
      if (this.previousHealth !== undefined && bot.health < this.previousHealth) this.events.add({ type: "self.damaged", health: bot.health, amount: this.previousHealth - bot.health });
      if (bot.health <= 6 && (this.previousHealth === undefined || this.previousHealth > 6)) this.events.add({ type: "self.health_critical", health: bot.health });
      this.previousHealth = bot.health;
    }
  }

  syncPlayers(input: unknown, connected = true): void {
    const bot = (input ?? {}) as LiveBot;
    if (!connected) return;
    for (const [name, player] of Object.entries(bot.players ?? {})) this.rememberIdentity(player.username ?? name, verifiedUuid(player.uuid ?? player.entity?.uuid));
  }

  private rememberIdentity(username: string, uuid?: string): void {
    const identity = { username, ...(uuid ? { uuid } : {}) };
    this.identities.set(username, identity);
    if (uuid) this.identities.set(uuid, identity);
  }

  private setDictionaryKey(entity: Entity, key: string): void {
    const oldKey = this.dictionaryKeys.get(entity);
    if (oldKey !== undefined && oldKey !== key && this.dictionaryTracks.get(oldKey)?.entity === entity) this.dictionaryTracks.delete(oldKey);
    this.dictionaryKeys.set(entity, key);
  }

  private isLive(entity: Entity, bot: LiveBot): boolean {
    const knownKey = this.dictionaryKeys.get(entity);
    if (knownKey !== undefined) return bot.entities?.[knownKey] === entity && !this.invalidated.has(entity);
    if (entity.id !== undefined && bot.entities?.[entity.id] === entity) {
      this.setDictionaryKey(entity, String(entity.id));
      return !this.invalidated.has(entity);
    }
    // Nonstandard adapters may use dictionary keys other than protocol IDs.
    const entry = Object.entries(bot.entities ?? {}).find(([, candidate]) => candidate === entity);
    if (entry) this.setDictionaryKey(entity, entry[0]);
    return Boolean(entry) && !this.invalidated.has(entity);
  }

  private refreshTrack(track: Track, entity: Entity, bot: LiveBot, now: string): void {
    const uuid = verifiedUuid(entity.uuid);
    if (uuid && !track.uuid) { track.uuid = uuid; this.indexUuid(track); }
    track.kind = entity.type ?? entity.kind ?? track.kind;
    track.class = entity.class ?? entity.kind;
    track.name = entity.name;
    track.username = entity.username;
    track.type = entitySpecies(entity, bot.registry);
    track.position = observedEntityPosition(entity);
    track.velocity = track.position ? point(entity.velocity) : undefined;
    track.yaw = track.position ? entity.yaw : undefined;
    track.pitch = track.position ? entity.pitch : undefined;
    track.onGround = track.position ? entity.onGround : undefined;
    track.lastObservedAt = now;
    if (track.username) this.rememberIdentity(track.username, track.uuid);
    this.proximity(track, observedEntityPosition(bot.entity));
  }

  /** Full content copying/fingerprinting is exclusively an observation boundary. */
  reconcile(input: unknown, initialContext: ObservationContext): void {
    const bot = (input ?? {}) as LiveBot;
    const context = this.syncBindings(bot, initialContext);
    const ready = context.connected && context.spawned;
    const now = new Date().toISOString();
    this.observeHealth(bot, context);
    const nextDimension = copy(bot.game?.dimension);
    const controls = context.getControls?.() ?? context.controls ?? bot.controlState;
    const unknownFields: string[] = [];
    const selfPosition = observedEntityPosition(bot.entity);
    if (ready) {
      const values = { position: selfPosition, yaw: selfPosition ? bot.entity?.yaw : undefined, pitch: selfPosition ? bot.entity?.pitch : undefined,
        health: bot.health, food: bot.food, oxygenLevel: bot.oxygenLevel, quickBarSlot: bot.quickBarSlot,
        heldItem: bot.heldItem, equipment: bot.entity?.equipment, controls };
      for (const [key, value] of Object.entries(values)) {
        const unknown = key === "heldItem" ? value === undefined
          : key === "equipment" ? !Array.isArray(value)
          : key === "controls" ? !value || typeof value !== "object" || Array.isArray(value)
          : key === "position" ? !value : typeof value !== "number" || !Number.isFinite(value);
        if (unknown) unknownFields.push(`/self/${key}`);
      }
      if (bot.currentWindow === undefined) unknownFields.push("/window");
    }
    const players = context.connected ? Object.entries(bot.players ?? {}).map(([name, player]) => {
      const username = player.username ?? name;
      const uuid = verifiedUuid(player.uuid ?? player.entity?.uuid);
      const trackId = player.entity ? this.trackFor(player.entity) : undefined;
      const track = trackId ? this.tracks.get(trackId) : undefined;
      return { username, ...(uuid ? { uuid } : {}), online: true, ...(track?.status === "loaded" ? { trackId } : {}) };
    }) : [];
    const state = {
      connection: { connected: context.connected, spawned: context.spawned, ready, ...context.getConnectionStatus?.() },
      dimension: context.connected ? nextDimension ?? null : null,
      self: ready ? { username: bot.username, position: selfPosition, velocity: selfPosition ? point(bot.entity?.velocity) : undefined, yaw: selfPosition ? bot.entity?.yaw : undefined, pitch: selfPosition ? bot.entity?.pitch : undefined,
        health: bot.health, food: bot.food, foodSaturation: bot.foodSaturation, oxygenLevel: bot.oxygenLevel,
        onGround: selfPosition ? bot.entity?.onGround : undefined, experience: copy(bot.experience), controls: copy(controls), equipment: Array.isArray(bot.entity?.equipment) ? bot.entity.equipment.map((item) => projectItem(item, "full")) : undefined, heldItem: projectItem(bot.heldItem, "full"), quickBarSlot: bot.quickBarSlot } : {},
      players,
      entities: [...this.tracks.values()].map((track) => this.serializeTrack(track)),
      inventory: slotObservation(bot.inventory?.slots, ready ? bot.inventory?.items?.() : undefined, ready),
      window: ready ? this.serializeWindow(bot.currentWindow) : null,
      actions: copy(context.getActions?.() ?? context.actions ?? []),
      navigation: ready ? { moving: bot.pathfinder?.isMoving?.() ?? false, goal: this.serializeGoal(bot.pathfinder?.goal) } : { moving: false, goal: null },
      unknownFields,
    };
    // Observation timestamps are excluded so repeated observations do not invent state changes.
    const stable = copy(state);
    for (const entity of stable.entities) delete entity.lastObservedAt;
    const fingerprint = JSON.stringify(stable);
    if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.revision += 1; }
    this.observed = { ...state, runtimeId: this.runtimeId, worldEpoch: this.worldEpoch, context: encodeActionContext(this.runtimeId, this.worldEpoch), observedAt: now, stateRevision: this.revision };
  }

  /** Search every currently loaded track without allocating or evicting a frame baseline. */
  searchLoaded(bot: unknown, context: ObservationContext, options: EntitySearchOptions = {}) {
    const radius = options.radius ?? 32, limit = options.limit ?? 50;
    if (!Number.isFinite(radius) || radius < 0 || radius > 4096) throw badInput("radius must be between 0 and 4096.");
    if (!Number.isInteger(limit) || limit < 0 || limit > 512) throw badInput("limit must be an integer between 0 and 512.");
    if (options.name !== undefined && (typeof options.name !== "string" || !options.name)) throw badInput("name must be a nonempty string.");
    if (options.type !== undefined && (typeof options.type !== "string" || !options.type)) throw badInput("type must be a nonempty legacy entity category.");
    if (options.type !== undefined && options.types !== undefined) throw badInput("Use either legacy type or canonical types, not both.");
    if (options.types !== undefined && (!Array.isArray(options.types) || options.types.length === 0 || options.types.length > 512 || options.types.some((type) => typeof type !== "string"))) throw badInput("types must list Minecraft species such as player or minecraft:player.");
    const types = options.types?.map((type) => `minecraft:${normalizeRegistryName(type)}`);
    const registry = (bot as LiveBot | undefined)?.registry?.entitiesByName;
    if (registry) for (const type of types ?? []) {
      const name = type.slice("minecraft:".length);
      if (name !== "player" && !Object.hasOwn(registry, name) && !Object.hasOwn(registry, type)) throw badInput(`Unknown entity species '${type}' in the connected server registry.`);
    }
    const readiness = this.syncBindings(bot, context);
    const origin = readiness.connected && readiness.spawned ? observedEntityPosition((bot as LiveBot)?.entity) : undefined;
    const entities = [...this.tracks.values()].filter((track) => track.status === "loaded")
      .filter((entity) => !options.name || entity.name === options.name || entity.username === options.name)
      .filter((entity) => !options.type || entity.kind === options.type)
      .filter((entity) => !types || types.includes(String(entity.type)))
      .map((entity): Record<string, unknown> & { distance?: number } => ({ ...this.serializeTrack(entity), distance: distance(origin, entity.position) }))
      .filter((entity) => entity.distance === undefined || entity.distance <= radius)
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || String(a.trackId).localeCompare(String(b.trackId)))
      .slice(0, limit).map((entity) => this.compactTrack(entity));
    return { context: encodeActionContext(this.runtimeId, this.worldEpoch), connection: this.projectConnection({
      connected: readiness.connected, spawned: readiness.spawned, ready: readiness.connected && readiness.spawned,
      ...readiness.getConnectionStatus?.(),
    }), entities };
  }

  frame(bot: unknown, context: ObservationContext, options: ProjectionOptions = {}): any {
    let projection = this.options(options);
    this.reconcile(bot, context);
    const state = this.observed!;
    let resetReason: "BASELINE_EXPIRED" | "WORLD_CHANGED" | "PROJECTION_CHANGED" | undefined;
    let baseline: { signature: string; worldEpoch: number; frame: WorldFrame } | undefined;
    if (options.since !== undefined) {
      this.validateRuntime(options.since, "f");
      baseline = this.baselines.get(options.since);
      resetReason = !baseline ? "BASELINE_EXPIRED" : baseline.worldEpoch !== this.worldEpoch ? "WORLD_CHANGED"
        : baseline.signature !== this.projectionSignature(projection) ? "PROJECTION_CHANGED" : undefined;
      if (resetReason) projection = { ...projection, detail: "compact" };
    }
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
    // Reserve at most two nearby players (32 blocks) and two items (16 blocks).
    // Even with a full default budget, eight places remain for nearest entities.
    const priority = new Set<string>();
    let budget = projection.maxEntities;
    for (const [type, range] of [["minecraft:player", 32], ["minecraft:item", 16]] as const) {
      const candidates = loaded.filter(({ entity, distance }) => entity.type === type && (distance ?? Infinity) <= Math.min(range, projection.radius) && !preserved.has(String(entity.trackId)));
      for (const candidate of candidates.slice(0, Math.min(2, budget))) priority.add(String(candidate.entity.trackId));
      budget -= Math.min(2, budget, candidates.length);
    }
    const selected: Record<string, unknown>[] = [];
    let ordinary = 0;
    for (const candidate of loaded) {
      if (preserved.has(String(candidate.entity.trackId)) || (priority.has(String(candidate.entity.trackId)) || ((candidate.distance === undefined || candidate.distance <= projection.radius) && ordinary < budget))) {
        selected.push({ ...candidate.entity, distance: candidate.distance, distanceTier: this.tier(candidate.distance) });
        if (!preserved.has(String(candidate.entity.trackId)) && !priority.has(String(candidate.entity.trackId))) ordinary += 1;
      }
    }
    for (const trackId of preserved) {
      const track = this.tracks.get(trackId);
      if (track && track.status !== "loaded") selected.push(this.serializeTrack(track));
    }
    const selectedIds = new Set(selected.map((e) => e.trackId));
    const aggregated: Record<string, number> = {};
    for (const { entity } of loaded) if (!selectedIds.has(entity.trackId)) { const type = typeof entity.type === "string" ? entity.type : "unknown"; aggregated[type] = (aggregated[type] ?? 0) + 1; }
    const compact = projection.detail === "compact";
    const included = selected.filter((entity) => entity.status === "loaded").length;
    const snapshot: WorldFrame = {
      type: "full", context: state.context, frame: encodeHandle(this.runtimeId, "f", this.nextFrame++), eventCursor: this.events.getCursor(),
      connection: this.projectConnection(state.connection),
      ...(state.dimension !== null && state.dimension !== undefined ? { dimension: copy(state.dimension) } : {}),
      self: this.projectSelf(state.self, projection.detail),
      inventory: publicSlots(state.inventory, projection.detail),
      ...(state.window ? { window: this.projectWindow(state.window, projection.detail) } : {}),
      entities: selected.map((entity) => projectEntity(entity, projection.detail)!),
      actions: this.projectActions(state.actions),
      projection: { included, omitted: loaded.length - included, ...(Object.keys(aggregated).length ? { aggregates: aggregated } : {}) },
      ...(state.unknownFields.length ? { unknownFields: [...state.unknownFields] } : {}),
      ...(resetReason ? { reset: { reason: resetReason } } : {}),
      ...(!compact ? { runtimeId: state.runtimeId, worldEpoch: state.worldEpoch, observedAt: state.observedAt,
        stateRevision: state.stateRevision, players: state.players, navigation: state.navigation } : {}),
    };
    const signature = this.projectionSignature(projection);
    let result: unknown = snapshot;
    if (baseline && !resetReason) {
      const changed: Record<string, unknown> = {}, unset: string[] = [];
      for (const key of ["connection", "dimension", "self", "players", "inventory", "window", "actions", "navigation", "projection", "unknownFields", "reset"] as const) {
        if (Object.hasOwn(baseline.frame, key) && !Object.hasOwn(snapshot, key)) unset.push(`/${key}`);
        else if (JSON.stringify(baseline.frame[key]) !== JSON.stringify(snapshot[key])) changed[key] = copy(snapshot[key]);
      }
      const before = new Map(baseline.frame.entities.map((entity) => [entity.trackId, entity]));
      const after = new Map(snapshot.entities.map((entity) => [entity.trackId, entity]));
      const removed = [...before.keys()].filter((id) => !after.has(id)).map((id) => {
        const status = this.tracks.get(String(id))?.status;
        return { trackId: id, status: status === "loaded" ? "omitted" : status ?? "lost" };
      });
      changed.entities = snapshot.entities.filter((entity) => JSON.stringify(entity) !== JSON.stringify(before.get(entity.trackId)));
      const beforeOrder = baseline.frame.entities.map((entity) => entity.trackId), afterOrder = snapshot.entities.map((entity) => entity.trackId);
      result = { type: "delta", context: snapshot.context, frame: snapshot.frame, eventCursor: snapshot.eventCursor,
        ...(!compact ? { runtimeId: snapshot.runtimeId, worldEpoch: snapshot.worldEpoch, observedAt: snapshot.observedAt, stateRevision: snapshot.stateRevision } : {}),
        since: options.since, delta: { changed, unset, removed, ...(JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder) ? { entityOrder: afterOrder } : {}) } };
    }
    this.baselines.set(snapshot.frame, { signature, worldEpoch: this.worldEpoch, frame: copy(snapshot) });
    while (this.baselines.size > this.frameRetention) this.baselines.delete(this.baselines.keys().next().value!);
    return result;
  }

  private options(options: ProjectionOptions): Required<Omit<ProjectionOptions, "since">> {
    const maxEntities = options.maxEntities ?? 12;
    const radius = options.radius ?? 64;
    const detail = options.detail ?? "compact";
    if (detail !== "compact" && detail !== "full") throw badInput("detail must be compact or full.");
    if (!Number.isInteger(maxEntities) || maxEntities < 0 || maxEntities > 512) throw badInput("maxEntities must be an integer between 0 and 512.");
    if (!Number.isFinite(radius) || radius < 0 || radius > 4096) throw badInput("radius must be between 0 and 4096.");
    if (options.tracks && (!Array.isArray(options.tracks) || options.tracks.length > 512 || options.tracks.some((id) => typeof id !== "string"))) throw badInput("tracks must contain at most 512 track IDs.");
    const tracks = [...new Set(options.tracks ?? [])].sort();
    for (const id of tracks) this.validateRuntime(id, ["p", "e"]);
    return { maxEntities, radius, tracks, detail };
  }
  private projectionSignature(projection: Required<Omit<ProjectionOptions, "since">>): string {
    return JSON.stringify({ schema: API_VERSION, ...projection });
  }
  private projectConnection(connection: Record<string, unknown>): Record<string, unknown> {
    const ready = connection.ready === true;
    const result: Record<string, unknown> = { state: typeof connection.state === "string" ? connection.state : ready ? "ready" : connection.connected ? "connecting" : "disconnected", ready };
    if (!ready) {
      const cause = connection.cause as { code?: unknown; message?: unknown } | undefined;
      if (cause && typeof cause.code === "string" && typeof cause.message === "string") result.cause = { code: cause.code, message: cause.message };
      const recovery = connection.recovery as { state?: unknown; attempts?: unknown; maxAttempts?: unknown } | undefined;
      if (recovery && typeof recovery.state === "string") result.recovery = { state: recovery.state,
        ...(typeof recovery.attempts === "number" ? { attempts: recovery.attempts } : {}),
        ...(typeof recovery.maxAttempts === "number" ? { maxAttempts: recovery.maxAttempts } : {}) };
    }
    return result;
  }
  private projectSelf(input: Record<string, unknown>, detail: "compact" | "full"): Record<string, unknown> {
    const self: Record<string, unknown> = {};
    for (const key of ["position", ...(detail === "full" ? ["velocity"] : [])]) {
      const value = point(input[key]);
      if (value) self[key] = value;
    }
    for (const key of ["yaw", "pitch", "health", "food", "oxygenLevel", "quickBarSlot", ...(detail === "full" ? ["foodSaturation"] : [])]) if (typeof input[key] === "number" && Number.isFinite(input[key])) self[key] = input[key];
    if (typeof input.onGround === "boolean") self.onGround = input.onGround;
    if (input.controls && typeof input.controls === "object") self.controls = Object.entries(input.controls).filter(([key, active]) => ["forward", "back", "left", "right", "jump", "sprint", "sneak"].includes(key) && active === true).map(([key]) => key).sort();
    if (Array.isArray(input.equipment)) self.equipment = Object.fromEntries(input.equipment.flatMap((value, slot) => value ? [[String(slot), projectItem(value, detail)]] : []));
    const heldItem = projectItem(input.heldItem, detail);
    if (heldItem) self.heldItem = heldItem;
    if (detail === "full") {
      if (typeof input.username === "string") self.username = input.username;
      if (input.experience && typeof input.experience === "object") self.experience = Object.fromEntries(Object.entries(input.experience).filter(([key, value]) => ["level", "points", "progress"].includes(key) && typeof value === "number" && Number.isFinite(value)));
    }
    return self;
  }
  private projectActions(input: unknown[]): Record<string, unknown>[] {
    const actions = input.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
    return actions.map((action) => {
      const summary: Record<string, unknown> = {};
      for (const key of ["action", "kind", "state", "reason", "target"]) if (typeof action[key] === "string") summary[key] = action[key];
      if (action.error && typeof action.error === "object" && typeof (action.error as Record<string, unknown>).code === "string") summary.error = { code: (action.error as Record<string, unknown>).code };
      return summary;
    });
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
  private validateRuntime(id: string, kind?: "f" | readonly ("p" | "e")[]): void {
    const handle = decodeHandle(id, kind);
    if (handle.runtimeId !== this.runtimeId) throw failure("RUNTIME_MISMATCH", "Handle belongs to another runtime.", { handle: id });
  }
  private bind(entity: Entity, now: string): Track {
    const existing = this.bindings.get(entity);
    const uuid = verifiedUuid(entity.uuid);
    let track = existing ? this.tracks.get(existing) : undefined;
    if (track?.uuid && uuid && track.uuid !== uuid) {
      // New confirmed identity on the same object invalidates old action guards.
      this.lose(track, "lost");
      track = undefined;
    }
    if (!track && uuid) {
      const id = this.uuidTracks.get(uuid);
      const known = id && this.tracks.get(id);
      // Concurrent objects with the same UUID must not steal an active binding.
      if (known && known.status !== "loaded" && known.status !== "dead" && ![...this.tracks.values()].some((candidate) => candidate.status === "loaded" && candidate.uuid === uuid)) track = known;
    }
    if (!track) {
      track = { trackId: encodeHandle(this.runtimeId, entity.type === "player" || entity.username ? "p" : "e", this.nextTrack++), ...(uuid ? { uuid } : {}), bindingGeneration: 0,
        worldEpoch: this.worldEpoch, kind: entity.type ?? entity.kind ?? "entity", class: entity.class ?? entity.kind, name: entity.name, username: entity.username, firstSeen: now, lastObservedAt: now, status: "lost" };
      this.tracks.set(track.trackId, track);
    }
    if (track.entity !== entity || track.status !== "loaded") {
      track.entity = entity; track.minecraftEntityId = entity.id; track.bindingGeneration += 1;
      track.worldEpoch = this.worldEpoch; track.status = "loaded"; track.nearby = false; track.proximityAt = undefined;
      this.bindings.set(entity, track.trackId);
      this.historicalBindings.set(entity, { trackId: track.trackId, bindingGeneration: track.bindingGeneration, worldEpoch: this.worldEpoch });
      this.events.add({ type: "entity.appeared", trackId: track.trackId, worldEpoch: this.worldEpoch });
    }
    this.indexUuid(track);
    return track;
  }
  private indexUuid(track: Track): void {
    if (!track.uuid) return;
    const owner = this.tracks.get(this.uuidTracks.get(track.uuid) ?? "");
    if (owner === track) return;
    if (owner && owner !== track && owner.status === "loaded") { this.uuidCollisions.add(track.uuid); return; }
    this.uuidTracks.set(track.uuid, track.trackId);
  }
  private lose(track: Track, status: "lost" | "dead"): void {
    this.pendingProximity.delete(track.trackId);
    if (track.status !== "loaded" && track.status === status) return;
    if (track.entity) {
      const key = this.dictionaryKeys.get(track.entity);
      if (key !== undefined && this.dictionaryTracks.get(key) === track) this.dictionaryTracks.delete(key);
      this.bindings.delete(track.entity);
    }
    track.entity = undefined; track.position = undefined; track.velocity = undefined; track.yaw = undefined; track.pitch = undefined; track.onGround = undefined;
    track.status = status; track.bindingGeneration += 1; track.nearby = undefined;
    if (track.uuid && this.uuidTracks.get(track.uuid) === track.trackId && this.uuidCollisions.has(track.uuid)) {
      const active = [...this.tracks.values()].filter((candidate) => candidate.uuid === track.uuid && candidate.status === "loaded");
      if (active[0]) this.uuidTracks.set(track.uuid, active[0].trackId);
      if (active.length <= 1) this.uuidCollisions.delete(track.uuid);
    }
    this.events.add({ type: status === "dead" ? "entity.dead" : "entity.lost", trackId: track.trackId, worldEpoch: this.worldEpoch });
    this.onTrackLost?.(track.trackId);
  }
  private proximity(track: Track, selfPosition?: Point): void {
    const d = distance(selfPosition, track.position);
    if (d === undefined) { this.pendingProximity.delete(track.trackId); return; }
    const desired = track.nearby ? d <= 20 : d <= 16;
    if (desired === track.nearby) { this.pendingProximity.delete(track.trackId); return; }
    const now = Date.now();
    if (track.proximityAt !== undefined && now - track.proximityAt < 1000) {
      this.pendingProximity.add(track.trackId);
      return;
    }
    this.pendingProximity.delete(track.trackId);
    track.nearby = desired; track.proximityAt = now;
    this.events.add({ type: desired ? "entity.entered_nearby" : "entity.left_nearby", trackId: track.trackId, distance: d });
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
    const unknownFields = track.status === "loaded" ? [...(!track.type ? ["type"] : []), ...(!track.position ? ["position"] : [])] : [];
    return copy({ ...snapshot, type: track.type ?? null, ...(unknownFields.length ? { unknownFields } : {}) });
  }
  private compactTrack(track: Record<string, unknown>): Record<string, unknown> & { trackId: string } {
    return projectEntity(track) as Record<string, unknown> & { trackId: string };
  }
  private projectWindow(input: unknown, detail: "compact" | "full"): unknown {
    if (!input || typeof input !== "object") return undefined;
    const window = input as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const key of ["id", "inventoryStart", "inventoryEnd"]) if (typeof window[key] === "number" && Number.isFinite(window[key])) result[key] = window[key];
    for (const key of ["type", "title"]) if (typeof window[key] === "string") result[key] = window[key];
    const selectedItem = projectItem(window.selectedItem, detail);
    return { ...result, ...publicSlots(window.observation as ReturnType<typeof slotObservation>, detail), ...(selectedItem ? { selectedItem } : {}) };
  }
  private serializeWindow(input: unknown): unknown {
    if (!input || typeof input !== "object") return null;
    const window = input as Record<string, unknown>;
    const fallback = typeof window.items === "function" ? window.items.call(window) : typeof window.containerItems === "function" ? window.containerItems.call(window) : undefined;
    return { id: window.id, type: window.type, title: typeof window.title === "string" ? window.title : undefined, observation: slotObservation(window.slots, fallback, true), inventoryStart: window.inventoryStart, inventoryEnd: window.inventoryEnd, selectedItem: projectItem(window.selectedItem, "full") };
  }
}
