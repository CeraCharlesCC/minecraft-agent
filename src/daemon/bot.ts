import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { createBot } from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { EventStore, detachData } from "../core/events.js";
import { WorldModel, FrameOptions, projectItem, projectEntity } from "../core/world.js";
import { CanonicalChat } from "../core/chat.js";
import { ActionManager, ActionResource } from "../core/actions.js";
import { decodeActionContext } from "../core/context.js";
import { CliError, commandBlocked, contextRequired } from "../output/errors.js";

const { goals, Movements, pathfinder } = pathfinderPackage;

type PathfinderMovements = InstanceType<typeof Movements>;
type PathfinderGoal = InstanceType<(typeof goals)["GoalNear"]> | InstanceType<(typeof goals)["GoalFollow"]>;

export interface BotOptions {
  host: string;
  port: number;
  username: string;
  auth: string;
  version?: string;
  autoReconnect?: boolean;
  reconnectMaxAttempts?: number;
  reconnectBackoff?: number;
}

export interface EnsureReadyOptions {
  timeout?: number;
  maxAttempts?: number;
  backoff?: number;
}

type ConnectionError = { code: string; message: string; occurredAt: string; generation: number };
const transientTransportCodes = new Set(["EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"]);
const terminalAuthCodes = new Set(["EAUTH", "AUTHENTICATION_FAILED", "INVALID_CREDENTIALS", "UNAUTHORIZED"]);

type MineflayerBot = EventEmitter & {
  _client?: { write(name: string, params: unknown): unknown };
  username?: string;
  entity?: MineflayerEntity;
  entities?: Record<string, MineflayerEntity>;
  players?: Record<string, { username?: string; entity?: MineflayerEntity }>;
  tablist?: unknown;
  scoreboards?: Record<string, unknown>;
  scoreboard?: Record<string, unknown>;
  teams?: Record<string, unknown>;
  teamMap?: Record<string, unknown>;
  game?: { dimension?: string };
  health?: number;
  food?: number;
  foodSaturation?: number;
  oxygenLevel?: number;
  experience?: unknown;
  time?: unknown;
  isRaining?: boolean;
  thunderState?: number;
  quickBarSlot?: number;
  isSleeping?: boolean;
  usingHeldItem?: boolean;
  controlState?: Record<string, boolean>;
  heldItem?: { name: string; displayName?: string } | null;
  currentWindow?: MineflayerWindow | null;
  inventory?: { items(): MineflayerItem[] };
  registry?: {
    blocksByName?: Record<string, { id: number }>;
    blocksArray?: unknown[];
    itemsByName?: Record<string, { id: number }>;
    entitiesByName?: Record<string, { category?: string }>;
  };
  world?: unknown;
  chat(message: string): void;
  whisper?(username: string, message: string): void;
  tabComplete?(text: string, assumeCommand?: boolean, sendBlockInSight?: boolean, timeout?: number): Promise<string[]>;
  quit(reason?: string): void;
  loadPlugin?(plugin: (bot: unknown) => void): void;
  setControlState(state: string, value: boolean): void;
  clearControlStates?(): void;
  lookAt(position: Vec3): Promise<void> | void;
  look?(yaw: number, pitch: number, force?: boolean): Promise<void>;
  blockAt?(position: Vec3): MineflayerBlock | null;
  blockInSight?(maxSteps: number, vectorLength: number): MineflayerBlock | null;
  blockAtCursor?(maxDistance?: number): MineflayerBlock | null;
  findBlock?(options: { matching: number | number[] | ((block: MineflayerBlock) => boolean); maxDistance: number }): MineflayerBlock | null;
  findBlocks?(options: { matching: number | number[] | ((block: MineflayerBlock) => boolean); maxDistance: number; count: number }): Vec3[];
  canDigBlock?(block: MineflayerBlock): boolean;
  digTime?(block: MineflayerBlock): number;
  equip?(item: MineflayerItem | number, destination: string | null): Promise<void>;
  unequip?(destination: string | null): Promise<void>;
  toss?(itemType: number, metadata: number | null, count: number | null): Promise<void>;
  consume?(): Promise<void>;
  fish?(): Promise<void>;
  activateItem?(offhand?: boolean): void;
  deactivateItem?(): void;
  dig?(block: MineflayerBlock, forceLook?: boolean | "ignore"): Promise<void>;
  stopDigging?(): void;
  placeBlock?(referenceBlock: MineflayerBlock, faceVector: Vec3): Promise<void>;
  placeEntity?(referenceBlock: MineflayerBlock, faceVector: Vec3): Promise<MineflayerEntity>;
  activateBlock?(block: MineflayerBlock): Promise<void>;
  updateSign?(block: MineflayerBlock, text: string, back?: boolean): void;
  activateEntity?(entity: MineflayerEntity): Promise<void>;
  useOn?(entity: MineflayerEntity): void;
  attack?(entity: MineflayerEntity): void;
  swingArm?(hand: "left" | "right" | undefined, showHand?: boolean): void;
  mount?(entity: MineflayerEntity): void;
  dismount?(): void;
  moveVehicle?(left: number, forward: number): void;
  setQuickBarSlot?(slot: number): void;
  sleep?(bedBlock: MineflayerBlock): Promise<void>;
  wake?(): Promise<void>;
  elytraFly?(): Promise<void>;
  recipesFor?(itemType: number, metadata: number | null, minResultCount: number | null, craftingTable: MineflayerBlock | boolean | null): unknown[];
  craft?(recipe: unknown, count?: number, craftingTable?: MineflayerBlock): Promise<void>;
  openContainer?(target: MineflayerBlock | MineflayerEntity, direction?: Vec3, cursorPos?: Vec3): Promise<MineflayerWindow>;
  clickWindow?(slot: number, mouseButton: number, mode: number): Promise<void>;
  closeWindow?(window: MineflayerWindow): void;
  pathfinder?: {
    thinkTimeout?: number;
    tickTimeout?: number;
    searchRadius?: number;
    readonly movements?: PathfinderMovements;
    setMovements(movements: PathfinderMovements): void;
    goto(goal: PathfinderGoal): Promise<void>;
    setGoal(goal: PathfinderGoal | null, dynamic?: boolean): void;
    stop(): void;
    isMoving(): boolean;
    isMining(): boolean;
    isBuilding(): boolean;
  };
};

export type CreateBotFn = (options: Record<string, unknown>) => MineflayerBot;

type MineflayerItem = { name: string; count: number; slot: number; displayName?: string };
type MineflayerBlock = {
  name: string;
  displayName?: string;
  type: number;
  stateId?: number;
  metadata?: number;
  position: Vec3;
  getProperties?(): Record<string, unknown>;
};
type MineflayerEntity = { uuid?: string; velocity?: { x: number; y: number; z: number }; onGround?: boolean; id?: number; username?: string; name?: string; type?: string; position?: { x: number; y: number; z: number } };
type MineflayerWindow = {
  slots?: Array<MineflayerItem | null>;
  id?: number;
  type?: string;
  title?: unknown;
  inventoryStart?: number;
  inventoryEnd?: number;
  hotbarStart?: number;
  hotbarEnd?: number;
  close?(): void;
  deposit?(itemType: number, metadata: number | null, count: number | null): Promise<void>;
  withdraw?(itemType: number, metadata: number | null, count: number | null): Promise<void>;
  containerItems?(): MineflayerItem[];
  items?(): MineflayerItem[];
};
type NavigationMovementConfig = {
  canDig?: boolean;
  canPlace?: boolean;
  allowSprinting?: boolean;
  allowParkour?: boolean;
  canOpenDoors?: boolean;
  maxDropDown?: number;
};

const passiveEntityNames = new Set([
  "allay",
  "armadillo",
  "axolotl",
  "bat",
  "bee",
  "camel",
  "cat",
  "chicken",
  "cod",
  "cow",
  "donkey",
  "fox",
  "frog",
  "glow_squid",
  "goat",
  "happy_ghast",
  "horse",
  "iron_golem",
  "llama",
  "mooshroom",
  "mule",
  "ocelot",
  "panda",
  "parrot",
  "pig",
  "rabbit",
  "salmon",
  "sheep",
  "sniffer",
  "snow_golem",
  "squid",
  "strider",
  "tadpole",
  "tropical_fish",
  "turtle",
  "villager",
  "wandering_trader",
]);

function distance(a?: { x: number; y: number; z: number }, b?: { x: number; y: number; z: number }): number | undefined {
  if (!a || !b) {
    return undefined;
  }
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function serializePosition(position?: { x: number; y: number; z: number }) {
  return position ? { x: position.x, y: position.y, z: position.z } : undefined;
}

function serializeItem(item: MineflayerItem | null | undefined) {
  return item ? projectItem(item) : undefined;
}

function serializeBlock(block: MineflayerBlock | null | undefined) {
  return block
    ? {
        name: block.name,
        displayName: block.displayName,
        properties: Object.fromEntries(Object.entries(block.getProperties?.() ?? {}).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))),
        position: serializePosition(block.position),
      }
    : undefined;
}


function chatText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const component = value as { text?: unknown; toString?: () => string };
    if (typeof component.text === "string") return component.text;
    if (component.toString && component.toString !== Object.prototype.toString) return component.toString();
  }
  return undefined;
}

function projectScoreboard(record: unknown) {
  if (!record || typeof record !== "object") return undefined;
  const value = record as Record<string, unknown>;
  return { ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(chatText(value.title) !== undefined ? { title: chatText(value.title) } : {}),
    ...(Array.isArray(value.items) ? { items: value.items.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      return [{ ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.value === "number" && Number.isFinite(item.value) ? { value: item.value } : {}),
        ...(chatText(item.displayName) !== undefined ? { displayName: chatText(item.displayName) } : {}) }];
    }) } : {}),
  };
}

function projectTeam(record: unknown) {
  if (!record || typeof record !== "object") return undefined;
  const value = record as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of ["name", "prefix", "suffix"]) {
    const text = chatText(value[field]);
    if (text !== undefined) result[field] = text;
  }
  for (const field of ["team", "color", "nameTagVisibility", "collisionRule"]) if (typeof value[field] === "string") result[field] = value[field];
  if (typeof value.friendlyFire === "boolean" || typeof value.friendlyFire === "number") result.friendlyFire = value.friendlyFire;
  if (Array.isArray(value.members)) result.members = value.members.filter((member) => typeof member === "string");
  return result;
}

function serializeWindow(window: MineflayerWindow | null | undefined) {
  if (!window) {
    return undefined;
  }
  const indexed = Array.isArray(window.slots);
  const items = indexed ? window.slots : typeof window.containerItems === "function" ? window.containerItems() : typeof window.items === "function" ? window.items() : undefined;
  return {
    type: window.type,
    title: typeof window.title?.toString === "function" ? window.title.toString() : window.title,
    inventoryStart: window.inventoryStart,
    inventoryEnd: window.inventoryEnd,
    hotbarStart: window.hotbarStart,
    hotbarEnd: window.hotbarEnd,
    ...(items ? { slots: items.flatMap((item, slot) => item ? [{ ...serializeItem(item), ...(indexed ? { slot } : {}) }] : []),
      ...(indexed ? { slotCount: items.length } : {}) } : { unknownFields: ["/slots"] }),
  };
}

function faceVector(face: string): Vec3 {
  switch (face) {
    case "down":
      return new Vec3(0, -1, 0);
    case "north":
      return new Vec3(0, 0, -1);
    case "south":
      return new Vec3(0, 0, 1);
    case "west":
      return new Vec3(-1, 0, 0);
    case "east":
      return new Vec3(1, 0, 0);
    case "up":
    default:
      return new Vec3(0, 1, 0);
  }
}

function recipeStringField(recipe: unknown, field: string): string | undefined {
  if (!recipe || typeof recipe !== "object") {
    return undefined;
  }
  const value = (recipe as Record<string, unknown>)[field];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

export class BotController {
  private bot?: MineflayerBot;
  private connected = false;
  private spawned = false;
  private lastError?: string;
  private connectionEnded = false;
  private lastDisconnectReason?: string;
  private lastConnectionError?: ConnectionError;
  private stopping = false;
  private generation = 0;
  private terminalFailure = false;
  private authentication: "unknown" | "intervention_required" | "authenticated" | "rejected" = "unknown";
  private readonly lifecycle = new EventEmitter();
  private readonly botListeners: Array<{ bot: MineflayerBot; event: string; listener: (...args: any[]) => void }> = [];
  private readonly transitions: Array<{ state: string; at: string; generation: number; reason?: string }> = [];
  private recovery?: Promise<ReturnType<BotController["recoveryResult"]>>;
  private incident?: { deadline: number; maxAttempts: number; consumed: number };
  private readySince?: number;
  private retryState = { active: false, automatic: false, attempts: 0, maxAttempts: 0, nextRetryAt: undefined as string | undefined };
  private readonly controlState: Record<string, boolean> = {};
  readonly world: WorldModel;
  readonly actions: ActionManager;
  private chatReceiver?: CanonicalChat;
  private lookTracking?: { track: string; action: string };
  private lookBusy = false;
  private lifecycleReset = false;
  private readonly execution = new AsyncLocalStorage<{ action: string; worldEpoch: number; target?: string; binding?: unknown }>();
  private readonly pendingWindowListeners = new Set<() => void>();
  private readonly navigationMovementConfig: NavigationMovementConfig = { canDig: false, canPlace: false };
  private readonly placementDefaults = new WeakMap<PathfinderMovements, { blocks: number[]; towers: boolean }>();

  constructor(
    private readonly options: BotOptions,
    private readonly events: EventStore,
    private readonly createBotFn: CreateBotFn = createBot as unknown as CreateBotFn,
  ) {
    this.world = new WorldModel(events);
    this.actions = new ActionManager(events);
    this.world.onTrackLost = (track) => this.actions.failTarget(track);
    this.world.onWorldReset = (reason) => this.invalidateWorld(reason);
  }

  start(): void {
    this.assertNotStopping();
    this.leaveReady();
    if (this.bot) {
      this.connected = false;
      this.spawned = false;
      if (!this.lifecycleReset) this.world.reset("RECONNECT");
      this.lifecycleReset = true;
      this.disposeBot();
    }
    const generation = ++this.generation;
    this.connectionEnded = false;
    this.lastDisconnectReason = undefined;
    this.lastError = undefined;
    this.terminalFailure = false;
    this.authentication = "unknown";
    const current = () => generation === this.generation && !this.stopping;
    const bot = this.createBotFn({
      host: this.options.host, port: this.options.port, username: this.options.username,
      auth: this.options.auth, version: this.options.version,
      // Evidence comes from the auth adapter itself, never from log text.
      onMsaCode: (challenge: { message?: string }) => {
        if (!current()) return;
        this.authentication = "intervention_required";
        if (typeof challenge?.message === "string") console.log(challenge.message);
        this.transition("authentication_pending");
      },
    });
    this.bot = bot;
    const on = (event: string, listener: (...args: any[]) => void, prepend = false) => {
      const guarded = (...args: any[]) => { if (current()) listener(...args); };
      this.botListeners.push({ bot, event, listener: guarded });
      if (prepend) bot.prependListener(event, guarded); else bot.on(event, guarded);
    };
    bot.loadPlugin?.(pathfinder as unknown as (bot: unknown) => void);
    if (typeof bot.lookAt === "function") this.initializeBotMethods();
    else on("inject_allowed", () => this.initializeBotMethods());
    on("login", () => {
      if (this.connectionEnded) return;
      this.lastError = undefined;
      this.lastConnectionError = undefined;
      this.connected = true;
      this.spawned = false;
      this.authentication = "authenticated";
      this.transition("waiting_for_spawn");
      this.events.add({ type: "connection.login", text: "Bot logged in." });
    });
    on("spawn", () => {
      if (this.connectionEnded) return;
      this.lastError = undefined;
      if (this.spawned) this.world.reset("RESPAWN");
      this.connected = true;
      this.spawned = true;
      this.readySince ??= Date.now();
      this.lifecycleReset = false;
      this.transition("ready");
      this.events.add({ type: "connection.ready", text: "Bot spawned." });
      this.world.syncBindings(bot, this.observationContext());
      this.world.observeHealth(bot, this.observationContext());
    });
    const disconnected = (reason: string, terminal = false) => {
      this.leaveReady();
      const wasEnded = this.connectionEnded;
      this.connectionEnded = true;
      if (terminal) this.lastDisconnectReason = reason;
      else this.lastDisconnectReason ??= reason;
      this.terminalFailure ||= terminal;
      this.connected = false;
      this.spawned = false;
      if (!this.lifecycleReset) this.world.reset(reason);
      this.lifecycleReset = true;
      this.chatReceiver?.dispose();
      this.transition("disconnected", this.lastDisconnectReason);
      this.events.add({ type: "connection.disconnected", reason });
      if (!wasEnded) this.maybeAutoReconnect();
    };
    on("end", (reason) => disconnected(String(reason ?? "DISCONNECTED")));
    on("kicked", (reason) => disconnected(`KICKED: ${typeof reason === "string" ? reason : JSON.stringify(detachData(reason)) ?? "DISCONNECTED"}`, true));
    on("error", (error) => {
      this.recordConnectionError(error);
      if (terminalAuthCodes.has(this.lastConnectionError!.code)) {
        this.authentication = "rejected";
        this.terminalFailure = true;
      }
      this.events.add({ type: "connection.error", text: this.lastError, error: this.lastConnectionError });
      disconnected(this.lastConnectionError!.code, terminalAuthCodes.has(this.lastConnectionError!.code));
    });
    on("death", () => {
      this.leaveReady();
      this.spawned = false;
      this.world.reset("DEATH");
      this.lifecycleReset = true;
      this.transition("waiting_for_spawn");
      this.events.add({ type: "self.died" });
    });
    on("respawn", () => {
      this.leaveReady();
      if (!this.lifecycleReset) this.world.reset("RESPAWN");
      this.spawned = false;
      this.lifecycleReset = true;
      this.transition("waiting_for_spawn");
    });
    on("health", () => this.world.observeHealth(bot, this.observationContext()));
    on("game", () => this.checkWorld());
    for (const name of ["entitySpawn", "entityMoved", "entityUpdate"])
      on(name, (entity) => { this.world.updateEntity(bot, this.observationContext(), entity); this.updateLookTracking(); });
    on("move", () => { this.world.updateProximity(bot, this.observationContext()); this.updateLookTracking(); });
    for (const name of ["playerJoined", "playerLeft"])
      on(name, () => this.world.syncPlayers(bot, this.connected));
    on("physicsTick", () => { this.checkWorld(); this.checkActionTargets(); this.world.flushProximity(bot, this.observationContext()); this.updateLookTracking(); }, true);
    on("entityGone", (entity) => this.world.invalidate(entity, "lost"));
    on("entityDead", (entity) => this.world.invalidate(entity, "dead"));
    this.chatReceiver = new CanonicalChat(this.events, (sender, uuid) => this.world.playerIdentity(sender, uuid));
    this.chatReceiver.attach(bot);
    this.transition("connecting");
  }

  private recordConnectionError(error: unknown) {
    const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code : "UNKNOWN";
    this.lastError = error instanceof Error ? error.message : String(error);
    this.lastConnectionError = { code, message: this.lastError, occurredAt: new Date().toISOString(), generation: this.generation };
  }

  private transition(state: string, reason?: string) {
    this.transitions.push({ state, at: new Date().toISOString(), generation: this.generation, ...(reason ? { reason } : {}) });
    if (this.transitions.length > 32) this.transitions.shift();
    this.lifecycle.emit("change");
  }

  private disposeBot() {
    const bot = this.bot;
    if (!bot) return;
    ++this.generation;
    this.chatReceiver?.dispose();
    this.chatReceiver = undefined;
    for (const { bot: source, event, listener } of this.botListeners.splice(0)) source.off(event, listener);
    // A retired protocol adapter can still deliver an error while quit drains.
    // This listener has no controller/world access and avoids unhandled errors.
    bot.on("error", () => {});
    this.lookBusy = false;
    try { bot.quit(this.stopping ? "mc-agent session stop" : "mc-agent reconnect"); }
    catch (error) { this.recordConnectionError(error); }
    this.bot = undefined;
  }

  private initializeBotMethods() {
    const bot = this.requireBot();
    const generation = this.generation;
    this.configurePathfinderMovements();
    this.guardActionPackets();
    // Mineflayer's block/entity operations await lookAt before sending packets.
    // Guard that continuation so replacement, target loss, or reset cannot send
    // the operation after its owner has already terminated.
    const originalLookAt = bot.lookAt.bind(bot);
    bot.lookAt = (position) => {
      const verify = this.continuationGuard(["look"]);
      const result = originalLookAt(position);
      if (result && typeof result.then === "function") {
        const guarded = result.then(() => { verify(); });
        // Pathfinder launches turns without awaiting them. Observe rejection
        // while preserving the rejected promise for operations that do await it.
        void guarded.catch(() => {});
        return guarded;
      }
      verify();
    };
    // Some Mineflayer container adapters launch activation without awaiting it.
    // Observe rejection on that promise as well as returning it to direct callers.
    for (const name of ["activateBlock", "activateEntity"] as const) {
      const original = bot[name];
      if (!original) continue;
      (bot as any)[name] = (...args: unknown[]) => {
        const action = this.execution.getStore()?.action;
        const result = (original as Function).apply(bot, args);
        Promise.resolve(result).catch((error) => { if (action) this.actions.fail(action, error); });
        return result;
      };
    }
    // Pathfinder's equip().then(...) callbacks run outside action ALS. Bind those
    // reactions to their originating movement owner, rather than a future owner.
    const originalEquip = bot.equip;
    if (originalEquip) bot.equip = (item, destination) => {
      const context = this.execution.getStore();
      const owner = context?.action ?? this.actions.owner("movement");
      const action = owner ? this.actions.get(owner) : undefined;
      const result = originalEquip.call(bot, item, destination);
      if (!action || !(action.kind.startsWith("navigate.") || action.kind === "collect.item")) return result;
      const execution = context ?? { action: action.action, worldEpoch: action.worldEpoch, target: action.target,
        binding: action.target ? this.world.resolveTrack(action.target) : undefined };
      const verify = this.continuationGuard(["movement", "look"]);
      const bound = Promise.resolve(result).then(value => value);
      const then = bound.then.bind(bound);
      bound.then = ((fulfilled: ((value: void) => unknown) | undefined | null, rejected: ((error: unknown) => unknown) | undefined | null) =>
        this.execution.run(execution, () => then(value => {
          if (bot !== this.bot || generation !== this.generation) throw commandBlocked("Connection changed during navigation equipment preparation.", "Observe a fresh frame.");
          verify();
          return fulfilled ? fulfilled(value) : value;
        }, rejected))) as typeof bound.then;
      return bound;
    };
    // Pathfinder performs terrain work from physics callbacks, outside action ALS.
    // Enforce the movement policy again at the actual physical method boundary.
    for (const [name, permission] of [["dig", "canDig"], ["placeBlock", "canPlace"]] as const) {
      const original = bot[name];
      if (!original) continue;
      (bot as any)[name] = (...args: unknown[]) => {
        try {
          if (bot !== this.bot || generation !== this.generation) throw commandBlocked("Connection changed before terrain modification.", "Observe a fresh frame.");
          this.checkWorld();
          this.checkActionTargets();
          const context = this.execution.getStore();
          const owner = context?.action ?? this.actions.owner("movement");
          const action = owner ? this.actions.get(owner) : undefined;
          if (!action || action.state !== "running") throw commandBlocked("Terrain modification has no active action owner.", "Start an explicit terrain action or authorized navigation.");
          if (action.worldEpoch !== this.world.worldEpoch) throw new CliError("WORLD_CHANGED", "World changed before terrain modification.", "Observe a fresh frame.");
          const navigation = action.kind.startsWith("navigate.") || action.kind === "collect.item";
          if (navigation && this.navigationMovementConfig[permission] !== true) {
            const error = new CliError("NAVIGATION_FAILED", "Navigation attempted an unauthorized terrain change.",
              "Choose another route or explicitly enable the required navigation permission.", 1,
              { reason: "TERRAIN_MODIFICATION_BLOCKED", operation: name,
                policy: { canDig: this.navigationMovementConfig.canDig === true, canPlace: this.navigationMovementConfig.canPlace === true } });
            this.actions.fail(action.action, error);
            throw error;
          }
          if (!navigation && action.kind !== (name === "dig" ? "world.dig" : "world.place")) throw commandBlocked("This action does not own terrain modification.", "Use an explicit terrain action.");
          if (navigation && this.actions.owner("movement") !== action.action) throw commandBlocked("Navigation was replaced before terrain modification.", "Inspect current actions.");
          const binding = action.target ? this.world.resolveTrack(action.target) : undefined;
          return this.execution.run({ action: action.action, worldEpoch: action.worldEpoch, target: action.target, binding },
            () => (original as Function).apply(bot, args));
        } catch (error) {
          const rejected = Promise.reject(error);
          void rejected.catch(() => {});
          return rejected;
        }
      };
    }
  }

  status(options: { detail?: "compact" | "full" } = {}) {
    this.flushChat();
    const connection = this.connectionStatus();
    return {
      ready: connection.ready,
      connection,
      ...(this.connected && typeof this.bot?.username === "string" && /^[A-Za-z0-9_]{1,16}$/.test(this.bot.username) ? { username: this.bot.username } : {}),
      ...(options.detail === "full" ? {
        host: this.options.host, port: this.options.port, auth: this.options.auth,
        ...(this.options.version ? { version: this.options.version } : {}),
      } : {}),
    };
  }

  frame(options: FrameOptions = {}) {
    this.flushChat();
    return this.world.frame(this.bot, this.observationContext(), options);
  }

  flushChat() { this.chatReceiver?.flush(); }

  sample(track: string, fields: string[]) {
    this.checkWorld();
    const entity = this.world.resolveTrack(track) as MineflayerEntity;
    const values: Record<string, unknown> = {};
    if (fields.includes("position")) values.position = serializePosition(entity.position);
    if (fields.includes("velocity")) values.velocity = serializePosition(entity.velocity);
    if (fields.includes("status")) values.status = "loaded";
    return { type: "track.sample", trackId: track, values };
  }

  validateContext(input: { runtimeId?: unknown; worldEpoch?: unknown; context?: unknown }, requireReady = true) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new CliError("BAD_INPUT", "Action body must be an object.", "Send runtimeId and worldEpoch from a frame.", 3);
    }
    if (input.context === undefined && input.runtimeId === undefined && input.worldEpoch === undefined) {
      throw contextRequired();
    }
    let runtimeId = input.runtimeId, worldEpoch = input.worldEpoch;
    if (input.context !== undefined) {
      if (typeof input.context !== "string") throw new CliError("BAD_INPUT", "Invalid action context.", "Copy context from a current observation.", 3);
      const decoded = decodeActionContext(input.context);
      if ((runtimeId !== undefined && runtimeId !== decoded.runtimeId) || (worldEpoch !== undefined && worldEpoch !== decoded.worldEpoch)) {
        throw new CliError("BAD_INPUT", "Context conflicts with runtimeId or worldEpoch.", "Use one consistent observation context.", 3);
      }
      runtimeId = decoded.runtimeId; worldEpoch = decoded.worldEpoch;
    }
    this.checkWorld();
    if (typeof runtimeId !== "string" || !runtimeId || !Number.isSafeInteger(worldEpoch) || (worldEpoch as number) < 0) {
      throw new CliError("BAD_INPUT", "Actions require an observation context.",
        "Observe a frame or find entities and pass --context, or --runtime and --world-epoch.", 3);
    }
    const connection = this.connectionStatus();
    if (runtimeId !== this.world.runtimeId) {
      throw new CliError("RUNTIME_MISMATCH", "Action belongs to another runtime.", "Observe a fresh frame.", 1,
        { reason: "RUNTIME_MISMATCH" });
    }
    if (worldEpoch !== this.world.worldEpoch) {
      throw new CliError("WORLD_CHANGED", "World context has changed.", "Observe a fresh frame.", 1,
        { reason: "WORLD_CHANGED", connection });
    }
    this.assertNotStopping();
    if (requireReady && (!this.connected || !this.spawned)) {
      throw new CliError("NOT_READY", "Bot has no ready world context.", "Observe a fresh frame after the connection is ready.", 1, connection);
    }
  }

  runAction(kind: string, resources: ActionResource[], run: () => unknown | Promise<unknown>,
    target?: string, continuous = false) {
    if (target) this.getRequiredEntity(target);
    const expected = { runtimeId: this.world.runtimeId, worldEpoch: this.world.worldEpoch };
    return this.actions.start(kind, expected.worldEpoch, resources, {
      target, continuous, run: () => {
        this.validateContext(expected);
        const binding = target ? this.getRequiredEntity(target) : undefined;
        const action = this.actions.owner(resources[0]);
        return action ? this.execution.run({ action, worldEpoch: expected.worldEpoch, target, binding }, run) : run();
      },
      stop: () => this.stopResources(resources),
    });
  }

  followTrack(track: string, range: number) {
    this.getRequiredEntity(track);
    return this.runAction("navigate.follow", ["movement", "look"], () => {
      this.configurePathfinderMovements();
      const target = this.getRequiredEntity(track);
      this.requirePathfinder().setGoal(new goals.GoalFollow(target as never, range), true);
      return { range };
    }, track, true);
  }

  trackLook(track: string) {
    this.getRequiredEntity(track);
    const action = this.runAction("look.track", ["look"], () => undefined, track, true);
    this.lookTracking = { track, action: action.action };
    this.updateLookTracking();
    return action;
  }

  private observationContext() {
    const controls = () => {
      const observed = this.bot?.controlState;
      return observed && typeof observed === "object" && !Array.isArray(observed)
        ? { ...observed, ...this.controlState } : undefined;
    };
    return { connected: this.connected, spawned: this.spawned,
      controls: controls(), getActions: () => this.actions.observation(),
      getControls: controls,
      getReadiness: () => ({ connected: this.connected, spawned: this.spawned }),
      getConnectionStatus: () => this.connectionStatus() };
  }

  connectionStatus() {
    const state = this.stopping ? "stopping" : this.connectionEnded ? "disconnected" : this.connected
      ? this.spawned ? "ready" : "waiting_for_spawn" : this.lastError ? "error" : "connecting";
    const ready = this.connected && this.spawned && !this.stopping;
    const code = this.authentication === "intervention_required" ? "AUTHENTICATION_REQUIRED"
      : this.authentication === "rejected" ? "AUTHENTICATION_REJECTED"
      : this.terminalFailure ? "SERVER_REJECTED" : this.publicConnectionCode()
      ?? (this.connectionEnded ? "DISCONNECTED" : undefined);
    const message = code === "AUTHENTICATION_REQUIRED" ? "Authentication requires operator intervention."
      : code === "AUTHENTICATION_REJECTED" ? "Authentication was rejected."
      : code === "SERVER_REJECTED" ? "The server rejected the connection."
      : code ? "The game connection is unavailable." : undefined;
    const exhausted = this.incident && (this.incident.consumed >= this.incident.maxAttempts || Date.now() >= this.incident.deadline);
    const recoveryState = this.terminalFailure || this.authentication === "intervention_required" ? "intervention_required"
      : this.retryState.active ? "recovering" : exhausted ? "exhausted"
      : this.options.autoReconnect ? "intervention_required" : "disabled";
    return { state, ready,
      ...(!ready && code ? { cause: { code, message: message! } } : {}),
      ...(!ready && !this.stopping ? { recovery: { state: recoveryState,
        ...(this.incident ? { attempts: this.retryState.attempts, maxAttempts: this.incident.maxAttempts } : {}) } } : {}),
    };
  }

  private connectionDetails() {
    return { ...this.connectionStatus(), connected: this.connected, spawned: this.spawned,
      stopping: this.stopping, terminalFailure: this.terminalFailure,
      authentication: { state: this.authentication },
      ...(this.lastDisconnectReason ? { reason: this.safeDisconnectReason() } : {}),
      ...(this.lastConnectionError ? { lastError: { ...this.lastConnectionError, code: this.publicConnectionCode(), message: "The game connection is unavailable." } } : {}),
    };
  }

  private publicConnectionCode() {
    const code = this.lastConnectionError?.code;
    return code === undefined ? undefined : transientTransportCodes.has(code) || terminalAuthCodes.has(code) ? code : "CONNECTION_ERROR";
  }

  private safeDisconnectReason() {
    return this.terminalFailure ? "SERVER_REJECTED" : this.stopping ? "STOPPED" : this.publicConnectionCode() ?? "DISCONNECTED";
  }

  diagnose() {
    return { apiVersion: 3, daemonResponsive: true,
      ready: this.connectionStatus().ready, connection: this.connectionDetails(),
      ...(this.lastConnectionError ? { lastError: { ...this.lastConnectionError, code: this.publicConnectionCode(), message: "The game connection is unavailable." } } : {}),
      transitions: this.transitions.map(({ state, at, generation, reason }) => ({ state, at, generation, ...(reason ? { reason: this.safeDisconnectReason() } : {}) })),
      retry: { ...this.retryState, enabled: this.options.autoReconnect === true },
      recommendedOperation: this.stopping ? "wait-for-stop" : this.connectionStatus().ready ? "observe-frame"
        : this.authentication === "intervention_required" ? "complete-authentication"
        : this.terminalFailure ? "resolve-terminal-failure" : "ensure-ready" };
  }

  private leaveReady() {
    if (this.readySince !== undefined && Date.now() - this.readySince >= 30_000) {
      this.incident = undefined;
      this.retryState.attempts = 0;
    }
    this.readySince = undefined;
  }

  assertNotStopping() {
    if (this.stopping) throw new CliError("COMMAND_BLOCKED", "Session is stopping.", "Wait for shutdown completion before starting a new session.");
  }

  private recoveryResult(timedOut = false, attempts = this.retryState.attempts, attemptLimitReached = false) {
    return { ...this.diagnose(), timedOut, attempts, attemptLimitReached };
  }

  ensureReady(input: EnsureReadyOptions = {}) {
    this.assertNotStopping();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CliError("BAD_INPUT", "Recovery options must be an object.", "Provide timeout, maxAttempts, and backoff in milliseconds.", 3);
    const timeout = input.timeout ?? 10_000;
    const maxAttempts = input.maxAttempts ?? 3;
    const backoff = input.backoff ?? 250;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 ||
        !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 ||
        !Number.isSafeInteger(backoff) || backoff < 0 || backoff > 30_000)
      throw new CliError("BAD_INPUT", "Recovery timeout must be 1-120000ms, maxAttempts 1-10, and backoff 0-30000ms.", "Choose bounded recovery options.", 3);
    if (this.connectionStatus().ready) {
      if (!this.recovery) { this.incident = undefined; this.retryState.attempts = 0; }
      return Promise.resolve(this.recoveryResult());
    }
    // This explicit operator operation may rearm an exhausted incident.
    return this.beginRecovery(timeout, maxAttempts, backoff, false);
  }

  private beginRecovery(timeout: number, maxAttempts: number, backoff: number, automatic: boolean) {
    if (!this.recovery) {
      if (!automatic || !this.incident) {
        this.incident = { deadline: Date.now() + timeout, maxAttempts, consumed: 0 };
        this.retryState.attempts = 0;
      }
      const incident = this.incident!;
      if (this.stopping || this.terminalFailure || incident.consumed >= incident.maxAttempts || Date.now() >= incident.deadline) {
        return Promise.resolve(this.recoveryResult(Date.now() >= incident.deadline, this.retryState.attempts, incident.consumed >= incident.maxAttempts));
      }
      this.retryState = { ...this.retryState, active: true, automatic, maxAttempts: incident.maxAttempts, nextRetryAt: undefined };
      const flight = this.recover(backoff, incident);
      this.recovery = flight;
      void flight.finally(() => {
        if (this.recovery === flight) this.recovery = undefined;
        this.retryState.active = false;
        this.retryState.nextRetryAt = undefined;
        // A disconnect may race with a just-settled successful flight.
        if (!this.connectionStatus().ready) this.maybeAutoReconnect();
      }).catch(() => {});
    }
    return this.withRecoveryDeadline(this.recovery, timeout);
  }

  private async recover(backoff: number, incident: { deadline: number; maxAttempts: number; consumed: number }) {
    const deadline = incident.deadline;
    while (incident.consumed < incident.maxAttempts && Date.now() < deadline) {
      if (this.connectionStatus().ready || this.stopping || this.terminalFailure ||
          (this.retryState.automatic && this.connectionEnded && this.lastConnectionError && !transientTransportCodes.has(this.lastConnectionError.code))) break;
      if (this.authentication === "intervention_required" && this.bot && !this.connectionEnded) {
        // Preserve the current login attempt while the operator completes its challenge.
        while (!this.stopping && !this.connectionEnded && !this.connectionStatus().ready && Date.now() < deadline)
          await this.waitForLifecycle(deadline - Date.now());
        break;
      }
      const attempt = incident.consumed++;
      if (!this.bot || this.connectionEnded || attempt > 0) {
        if (attempt > 0 || this.connectionEnded) {
          const delay = Math.min(backoff * 2 ** Math.max(0, attempt - 1), 30_000, Math.max(0, deadline - Date.now()));
          this.retryState.nextRetryAt = new Date(Date.now() + delay).toISOString();
          await this.waitForLifecycle(delay, true);
          this.retryState.nextRetryAt = undefined;
          if (this.connectionStatus().ready) break;
          if (this.stopping || Date.now() >= deadline || this.terminalFailure ||
              this.authentication === "intervention_required" ||
              (this.retryState.automatic && this.lastConnectionError && !transientTransportCodes.has(this.lastConnectionError.code))) break;
        }
        try { this.start(); }
        catch (error) {
          this.recordConnectionError(error);
          this.connectionEnded = true;
          this.terminalFailure = terminalAuthCodes.has(this.lastConnectionError!.code);
          if (this.terminalFailure) this.authentication = "rejected";
          this.transition("error");
        }
        this.retryState.attempts++;
      }
      // A pending initial startup also consumes a bounded wait slice.
      const remaining = incident.maxAttempts - incident.consumed + 1;
      const sliceDeadline = Math.min(deadline, Date.now() + Math.max(1, Math.floor((deadline - Date.now()) / remaining)));
      while (!this.stopping && !this.connectionEnded && !this.connectionStatus().ready && Date.now() < sliceDeadline) {
        await this.waitForLifecycle(sliceDeadline - Date.now());
      }
      if (this.connectionStatus().ready || this.stopping || this.terminalFailure) break;
    }
    this.retryState.active = false;
    this.retryState.nextRetryAt = undefined;
    const failed = !this.connectionStatus().ready && !this.stopping && !this.terminalFailure;
    return this.recoveryResult(failed && Date.now() >= deadline, this.retryState.attempts,
      failed && incident.consumed >= incident.maxAttempts && this.authentication !== "intervention_required");
  }

  private waitForLifecycle(timeout: number, delayOnly = false) {
    if (this.stopping || timeout <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.lifecycle.off("change", changed); resolve(); };
      const changed = () => { if (!delayOnly || this.stopping || this.terminalFailure || this.connectionStatus().ready || this.authentication === "intervention_required") done(); };
      const timer = setTimeout(done, timeout);
      this.lifecycle.on("change", changed);
    });
  }

  private withRecoveryDeadline(flight: Promise<ReturnType<BotController["recoveryResult"]>>, timeout: number) {
    return new Promise<ReturnType<BotController["recoveryResult"]>>((resolve, reject) => {
      const timer = setTimeout(() => resolve(this.recoveryResult(true)), timeout);
      flight.then((result) => { clearTimeout(timer); resolve(result); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  private maybeAutoReconnect() {
    const eligible = () => !this.stopping && this.options.autoReconnect === true && !this.recovery && !this.terminalFailure &&
      this.authentication !== "intervention_required" && !this.connectionStatus().ready &&
      this.lastConnectionError?.generation === this.generation && transientTransportCodes.has(this.lastConnectionError.code) &&
      (!this.incident || (this.incident.consumed < this.incident.maxAttempts && Date.now() < this.incident.deadline));
    if (!eligible()) return;
    // Defer until the error/kick/end burst is fully classified.
    queueMicrotask(() => {
      if (!eligible()) return;
      try {
        void this.beginRecovery(30_000, this.options.reconnectMaxAttempts ?? 3,
          this.options.reconnectBackoff ?? 250, true).catch(() => {});
      } catch (error) {
        this.recordConnectionError(error);
        this.transition("error");
      }
    });
  }

  private checkWorld() {
    if (this.bot) this.world.checkWorld(this.bot, this.observationContext());
  }

  private checkActionTargets() {
    const owners = new Set((["movement", "look", "item", "window"] as ActionResource[]).map((resource) => this.actions.owner(resource)).filter((id): id is string => Boolean(id)));
    for (const owner of owners) {
      const action = this.actions.get(owner);
      if (!action.target) continue;
      try { this.world.resolveTrack(action.target); }
      catch (error) { this.actions.fail(owner, error); }
    }
  }

  private invalidateWorld(reason: string) {
    if (reason === "dimension_changed") { this.leaveReady(); this.spawned = false; }
    this.actions.failAll(reason);
    this.stopResources(["movement", "look", "item", "window"]);
    if (this.bot) {
      // Mineflayer packet handlers fetch self through this dictionary; respawn
      // does not perform the login-time assignment of bot.entity again.
      const self = this.bot.entity;
      this.bot.entities = self?.id === undefined ? {} : { [self.id]: self };
      for (const player of Object.values(this.bot.players ?? {})) player.entity = undefined;
      this.bot.currentWindow = null;
    }
  }

  private stopResources(resources: ActionResource[]) {
    this.execution.exit(() => this.clearResources(resources));
  }

  private clearResources(resources: ActionResource[]) {
    if (resources.includes("movement")) {
      this.bot?.pathfinder?.setGoal(null);
      this.bot?.pathfinder?.stop();
      this.bot?.clearControlStates?.();
      for (const key of Object.keys(this.controlState)) delete this.controlState[key];
    }
    if (resources.includes("look")) this.lookTracking = undefined;
    if (resources.includes("item")) {
      this.bot?.stopDigging?.();
      this.bot?.deactivateItem?.();
    }
    if (resources.includes("window")) {
      for (const cleanup of this.pendingWindowListeners) cleanup();
      this.pendingWindowListeners.clear();
      const window = this.bot?.currentWindow;
      if (window?.close) window.close();
      else if (window) this.bot?.closeWindow?.(window);
    }
  }

  private guardActionPackets() {
    const bot = this.bot;
    const generation = this.generation;
    const client = bot?._client;
    if (!client) return;
    const write = client.write.bind(client);
    const mutations = new Set(["use_entity", "block_place", "block_dig", "window_click", "held_item_slot",
      "arm_animation", "entity_action", "use_item", "vehicle_move", "steer_vehicle", "update_sign", "close_window"]);
    client.write = (name, params) => {
      if (bot !== this.bot || generation !== this.generation) return;
      const context = this.execution.getStore();
      if (context && mutations.has(name)) {
        // AsyncLocalStorage follows Mineflayer's internal promises and timers.
        // Already-sent operations remain server-owned, but a stale continuation
        // may not send the next operation after cancellation or rebinding.
        try {
          this.checkWorld();
          if (this.actions.get(context.action).state !== "running") return;
          if (context.worldEpoch !== this.world.worldEpoch) {
            this.actions.fail(context.action, new CliError("WORLD_CHANGED", "World changed before packet submission.", "Observe a fresh frame."));
            return;
          }
          if (context.target && this.world.resolveTrack(context.target) !== context.binding) {
            this.actions.fail(context.action, new CliError("TRACK_LOST", "Target binding changed before packet submission.", "Observe a fresh frame."));
            return;
          }
        } catch (error) { this.actions.fail(context.action, error); return; }
      }
      return write(name, params);
    };
  }

  private updateLookTracking() {
    const tracking = this.lookTracking;
    if (!tracking || this.lookBusy) return;
    try {
      this.checkWorld();
      const entity = this.world.resolveTrack(tracking.track) as MineflayerEntity;
      if (!entity.position) throw new CliError("TRACK_LOST", "Target has no current position.", "Observe a fresh frame.");
      this.lookBusy = true;
      const generation = this.generation;
      Promise.resolve(this.requireBot().lookAt(new Vec3(entity.position.x, entity.position.y, entity.position.z)))
        .catch((error) => this.actions.fail(tracking.action, error))
        .finally(() => { if (generation === this.generation) this.lookBusy = false; });
    } catch (error) { this.actions.fail(tracking.action, error); }
  }

  sendChat(message: string, allowCommand = false): void {
    if (message.startsWith("/") && !allowCommand) throw commandBlocked("Refusing to send a server command as chat.", "Pass --allow-command with explicit authorization.");
    this.requireBot().chat(message);
  }

  sendWhisper(username: string, message: string): void {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new CliError("BAD_INPUT", "Invalid whisper username.", "Use a Minecraft username.", 3);
    this.requireMethod("whisper").call(this.requireBot(), username, message);
  }

  async tabComplete(text: string, assumeCommand: boolean, sendBlockInSight: boolean, timeout: number) {
    const matches = await this.requireMethod("tabComplete").call(this.requireBot(), text, assumeCommand, sendBlockInSight, timeout);
    return { matches };
  }

  position() {
    if (!this.connectionStatus().ready) return { known: false };
    const bot = this.requireBot();
    const position = serializePosition(bot.entity?.position);
    return { known: position !== undefined, ...(position ? { position } : {}),
      ...(bot.game?.dimension !== undefined ? { dimension: bot.game.dimension } : {}) };
  }

  inventory() {
    if (!this.connectionStatus().ready) return { known: false };
    const bot = this.requireBot();
    if (!bot.inventory) return { known: false };
    return {
      known: true,
      items: bot.inventory.items().map(serializeItem),
      ...(bot.heldItem ? { heldItem: projectItem(bot.heldItem) } : {}),
      ...(bot.quickBarSlot !== undefined ? { quickBarSlot: bot.quickBarSlot } : {}),
      ...(!("heldItem" in bot) ? { unknownFields: ["/heldItem"] } : {}),
    };
  }

  players() {
    if (!this.connectionStatus().ready) return { known: false };
    const bot = this.requireBot();
    if (!bot.players) return { known: false };
    const origin = bot.entity?.position;
    return { known: true,
      players: Object.entries(bot.players).map(([username, player]) => ({
        username: player.username ?? username,
        ...(player.entity?.position ? { position: serializePosition(player.entity.position), distance: distance(origin, player.entity.position) } : {}),
      })),
    };
  }

  entities(radius = 32, limit = 50) {
    return this.findEntities({ radius, limit });
  }

  findEntities(input: {
    name?: string;
    type?: string;
    types?: string[];
    radius?: number;
    limit?: number;
    includePlayers?: boolean;
    includePassive?: boolean;
  }) {
    this.flushChat();
    return this.world.searchLoaded(this.bot, this.observationContext(), input);
  }

  tablist() {
    if (!this.connectionStatus().ready) return { known: false };
    const tablist = this.requireBot().tablist as { header?: unknown; footer?: unknown } | undefined;
    return { tablist: tablist ? { header: chatText(tablist.header), footer: chatText(tablist.footer) } : undefined };
  }

  scoreboards() {
    if (!this.connectionStatus().ready) return { known: false };
    const bot = this.requireBot();
    const positions = bot.scoreboard ?? {};
    return { scoreboards: bot.scoreboards ? Object.fromEntries(Object.entries(bot.scoreboards).map(([name, record]) => [name, projectScoreboard(record)])) : undefined,
      scoreboard: Object.fromEntries(["list", "sidebar", "belowName"].flatMap((position, index) => {
        const board = projectScoreboard(positions[position] ?? positions[index]);
        return board ? [[position, board]] : [];
      })) };
  }

  teams() {
    if (!this.connectionStatus().ready) return { known: false };
    const bot = this.requireBot();
    return { teams: bot.teams ? Object.fromEntries(Object.entries(bot.teams).map(([name, record]) => [name, projectTeam(record)])) : undefined,
      teamMap: Object.fromEntries(Object.entries(bot.teamMap ?? {}).flatMap(([member, record]) => {
        const value = record && typeof record === "object" ? record as Record<string, unknown> : undefined;
        const name = typeof record === "string" ? record : typeof value?.team === "string" ? value.team
          : Object.entries(bot.teams ?? {}).find(([, team]) => team === record)?.[0];
        return name === undefined ? [] : [[member, name]];
      })) };
  }

  controls() {
    if (!this.connectionStatus().ready) return { known: false };
    const bot = this.requireBot();
    if (!bot.controlState) return { known: false };
    return { known: true, controls: Object.entries({ ...bot.controlState, ...this.controlState }).filter(([, value]) => value === true).map(([name]) => name) };
  }

  blockAt(x: number, y: number, z: number) {
    if (!this.connectionStatus().ready) return { known: false };
    const block = this.requireMethod("blockAt").call(this.requireBot(), new Vec3(x, y, z)) as MineflayerBlock | null;
    return { known: block !== null, block: serializeBlock(block) };
  }

  blockInSight(maxSteps: number, vectorLength: number) {
    if (!this.connectionStatus().ready) return { known: false };
    const block = this.requireMethod("blockInSight").call(this.requireBot(), maxSteps, vectorLength) as MineflayerBlock | null;
    return { known: block !== null, block: serializeBlock(block) };
  }

  blockAtCursor(maxDistance: number) {
    if (!this.connectionStatus().ready) return { known: false };
    const block = this.requireMethod("blockAtCursor").call(this.requireBot(), maxDistance) as MineflayerBlock | null;
    return { known: block !== null, block: serializeBlock(block) };
  }

  findBlocks(name: string, radius: number, count: number) {
    if (!this.connectionStatus().ready) return { known: false };
    const bot = this.requireBot();
    const blockType = this.blockType(name);
    const positions = this.requireMethod("findBlocks").call(bot, { matching: blockType, maxDistance: radius, count }) as Vec3[];
    return {
      blocks: positions.map((position) => ({ name, position: serializePosition(position) })),
    };
  }

  blockInfo(x: number, y: number, z: number) {
    if (!this.connectionStatus().ready) return { known: false };
    const bot = this.requireBot();
    const block = this.getRequiredBlock(x, y, z);
    return {
      block: serializeBlock(block),
      canDig: bot.canDigBlock?.(block),
      digTimeMs: bot.digTime?.(block),
    };
  }

  async tap(state: string, durationMs: number): Promise<void> {
    const bot = this.requireBot();
    const owner = this.actions.owner("movement");
    const epoch = this.world.worldEpoch;
    bot.setControlState(state, true);
    this.controlState[state] = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    } finally {
      if (epoch === this.world.worldEpoch && owner === this.actions.owner("movement")) {
        bot.setControlState(state, false);
        this.controlState[state] = false;
      }
    }
  }

  setControl(state: string, value: boolean) {
    this.requireBot().setControlState(state, value);
    this.controlState[state] = value;
    return { state, value };
  }

  clearControls() {
    this.requireMethod("clearControlStates").call(this.requireBot());
    for (const state of Object.keys(this.controlState)) {
      delete this.controlState[state];
    }
    return { cleared: true };
  }

  async lookAt(x: number, y: number, z: number): Promise<void> {
    await this.requireBot().lookAt(new Vec3(x, y, z));
  }

  async look(yaw: number, pitch: number, force: boolean): Promise<{ looked: true; yaw: number; pitch: number; force: boolean }> {
    await this.requireMethod("look").call(this.requireBot(), yaw, pitch, force);
    return { looked: true, yaw, pitch, force };
  }

  async goto(x: number, y: number, z: number, range: number) {
    return this.navigateNear(x, y, z, range);
  }

  private async navigateNear(x: number, y: number, z: number, range: number) {
    const expected = { runtimeId: this.world.runtimeId, worldEpoch: this.world.worldEpoch };
    this.validateContext(expected);
    const bot = this.requireBot();
    const movements = this.configurePathfinderMovements();
    const pathfinder = this.requirePathfinder();
    const goal = new goals.GoalNear(x, y, z, range);
    const verify = this.continuationGuard(["movement", "look"]);
    let pathStatus: string | undefined;
    const onUpdate = (result: { status?: unknown }) => {
      if (typeof result?.status === "string") pathStatus = result.status;
    };
    const atGoal = () => {
      const position = bot.entity?.position;
      if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return false;
      const node = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
      // Match pathfinder's node height when standing on a partial solid block.
      const block = bot.blockAt?.(node);
      if (position.y - node.y > 0.001 && bot.entity?.onGround && block && movements && !movements.emptyBlocks.has(block.type)) node.y += 1;
      // GoalNear only reads coordinates; supply the declared Move shape as well.
      return goal.isEnd(Object.assign(node, { remainingBlocks: 0, cost: 0, toBreak: [], toPlace: [], parkour: false, hash: `${node.x},${node.y},${node.z}` }));
    };
    const details = (reason: string) => ({ reason, pathStatus,
      goal: { x: goal.x, y: goal.y, z: goal.z, range },
      position: serializePosition(bot.entity?.position),
      policy: { canDig: this.navigationMovementConfig.canDig === true, canPlace: this.navigationMovementConfig.canPlace === true },
      searchRadius: pathfinder.searchRadius, thinkTimeout: pathfinder.thinkTimeout });
    const result = (completionReason: "within_range" | "already_within_range") => ({
      completionReason, goal: { x, y, z, range },
      finalPosition: serializePosition(bot.entity?.position)!,
      distanceToGoal: distance(bot.entity?.position, { x, y, z })!,
    });
    if (atGoal()) { verify(); this.validateContext(expected); return result("already_within_range"); }
    bot.on("path_update", onUpdate);
    try {
      try { await pathfinder.goto(goal); }
      catch (error) {
        verify();
        this.validateContext(expected);
        if (error instanceof CliError) throw error;
        const namedReason = error instanceof Error ? error.name : "Unknown";
        const reason = pathStatus === "noPath" || namedReason === "NoPath" ? "NO_PATH"
          : pathStatus === "timeout" || namedReason === "Timeout" ? "TIMEOUT"
          : namedReason === "PathStopped" ? "PATH_STOPPED" : namedReason === "GoalChanged" ? "GOAL_CHANGED" : "PATHFINDER_ERROR";
        throw new CliError("NAVIGATION_FAILED", error instanceof Error ? error.message : String(error),
          "Observe the current position and nearby terrain, then choose a reachable goal or explicitly adjust navigation policy.", 1, details(reason));
      }
      verify();
      this.validateContext(expected);
      if (pathStatus === "noPath" || pathStatus === "timeout" || !atGoal()) {
        const reason = pathStatus === "noPath" ? "NO_PATH" : pathStatus === "timeout" ? "TIMEOUT" : "GOAL_NOT_REACHED";
        throw new CliError("NAVIGATION_FAILED", "Pathfinder stopped without reaching the goal.",
          "Observe the current position and nearby terrain; no digging or placement permission is granted automatically.", 1, details(reason));
      }
      return result("within_range");
    } finally { bot.off("path_update", onUpdate); }
  }

  follow(player: string, range: number): { following: string; range: number; targetPosition?: { x: number; y: number; z: number } } {
    const bot = this.requireBot();
    const target = bot.players?.[player]?.entity;
    if (!target) {
      throw new CliError("COMMAND_BLOCKED", `Player '${player}' is not visible.`, "Observe the current game state and choose a valid operation.");
    }
    this.configurePathfinderMovements();
    this.requirePathfinder().setGoal(new goals.GoalFollow(target as never, range), true);
    return { following: player, range, targetPosition: serializePosition(target.position) };
  }

  stopNavigation() {
    const pathfinder = this.requirePathfinder();
    pathfinder.setGoal(null);
    pathfinder.stop();
    return { stopped: true };
  }

  navigationStatus() {
    const pathfinder = this.requirePathfinder();
    return {
      moving: pathfinder.isMoving(),
      mining: pathfinder.isMining(),
      building: pathfinder.isBuilding(),
    };
  }

  configureNavigation(input: {
    allowDig?: boolean;
    allowPlace?: boolean;
    allowSprinting?: boolean;
    allowParkour?: boolean;
    canOpenDoors?: boolean;
    maxDropDown?: number;
    searchRadius?: number;
    thinkTimeout?: number;
    tickTimeout?: number;
  }) {
    const pathfinder = this.requirePathfinder();
    if (input.allowDig !== undefined) this.navigationMovementConfig.canDig = input.allowDig;
    if (input.allowPlace !== undefined) this.navigationMovementConfig.canPlace = input.allowPlace;
    if (input.allowSprinting !== undefined) this.navigationMovementConfig.allowSprinting = input.allowSprinting;
    if (input.allowParkour !== undefined) this.navigationMovementConfig.allowParkour = input.allowParkour;
    if (input.canOpenDoors !== undefined) this.navigationMovementConfig.canOpenDoors = input.canOpenDoors;
    if (input.maxDropDown !== undefined) this.navigationMovementConfig.maxDropDown = input.maxDropDown;
    const movements = this.configurePathfinderMovements();
    if (input.searchRadius !== undefined) pathfinder.searchRadius = input.searchRadius;
    if (input.thinkTimeout !== undefined) pathfinder.thinkTimeout = input.thinkTimeout;
    if (input.tickTimeout !== undefined) pathfinder.tickTimeout = input.tickTimeout;
    return {
      configured: true,
      searchRadius: pathfinder.searchRadius,
      thinkTimeout: pathfinder.thinkTimeout,
      tickTimeout: pathfinder.tickTimeout,
      movements: movements
        ? {
            canDig: movements.canDig,
            canPlace: this.navigationMovementConfig.canPlace === true,
            allowSprinting: movements.allowSprinting,
            allowParkour: movements.allowParkour,
            canOpenDoors: movements.canOpenDoors,
            maxDropDown: movements.maxDropDown,
          }
        : undefined,
    };
  }

  async collectItem(id: number | string, range: number) {
    const entity = this.getRequiredEntity(id);
    const position = entity.position;
    if (!position) {
      throw new CliError("COMMAND_BLOCKED", `Entity '${id}' has no position.`, "Observe the current game state and choose a valid operation.");
    }
    await this.navigateNear(position.x, position.y, position.z, range);
    return { collectedTarget: this.publicEntity(entity), inventory: this.inventory() };
  }

  async equip(itemName: string, destination: string): Promise<{ equipped: string; destination: string; heldItem?: { name: string; displayName?: string } }> {
    const bot = this.requireBot();
    const item = bot.inventory?.items().find((candidate) => candidate.name === itemName || candidate.displayName === itemName);
    if (!item) {
      throw new CliError("COMMAND_BLOCKED", `Item '${itemName}' is not in inventory.`, "Observe the current game state and choose a valid operation.");
    }
    await this.requireMethod("equip").call(bot, item, destination);
    return { equipped: item.name, destination, heldItem: bot.heldItem ? { name: bot.heldItem.name, displayName: bot.heldItem.displayName } : undefined };
  }

  async unequip(destination: string): Promise<{ unequipped: true; destination: string }> {
    await this.requireMethod("unequip").call(this.requireBot(), destination);
    return { unequipped: true, destination };
  }

  setQuickBarSlot(slot: number) {
    this.requireMethod("setQuickBarSlot").call(this.requireBot(), slot);
    return { quickBarSlot: slot };
  }

  async toss(itemName: string, count: number): Promise<{ tossed: string; count: number }> {
    const itemType = this.itemType(itemName);
    await this.requireMethod("toss").call(this.requireBot(), itemType, null, count);
    return { tossed: itemName, count };
  }

  async consume(): Promise<{ consumed: true }> {
    const bot = this.requireBot();
    if (!bot.heldItem) {
      throw new CliError("COMMAND_BLOCKED", "No held item is equipped to consume.", "Observe the current game state and choose a valid operation.");
    }
    await this.requireMethod("consume").call(bot);
    return { consumed: true };
  }

  async fish(): Promise<{ fished: true }> {
    const bot = this.requireBot();
    if (bot.heldItem?.name !== "fishing_rod") {
      throw new CliError("COMMAND_BLOCKED", "A fishing_rod must be equipped before fishing.", "Observe the current game state and choose a valid operation.");
    }
    await this.requireMethod("fish").call(bot);
    return { fished: true };
  }

  activateItem(offhand: boolean) {
    this.requireMethod("activateItem").call(this.requireBot(), offhand);
    return { activated: true, offhand };
  }

  deactivateItem() {
    this.requireMethod("deactivateItem").call(this.requireBot());
    return { deactivated: true };
  }

  recipes(itemName: string, count: number, table?: { x: number; y: number; z: number }) {
    const itemType = this.itemType(itemName);
    const craftingTable = table ? this.getRequiredBlock(table.x, table.y, table.z) : null;
    const recipes = this.requireMethod("recipesFor").call(this.requireBot(), itemType, null, count, craftingTable) as unknown[];
    return { item: itemName, recipes: recipes.map((recipe, index) => {
      const value = recipe && typeof recipe === "object" ? recipe as Record<string, unknown> : {};
      const ingredient = (entry: unknown): unknown => {
        if (Array.isArray(entry)) return entry.map(ingredient);
        if (!entry || typeof entry !== "object") return entry === null ? null : undefined;
        const item = entry as Record<string, unknown>;
        return { ...(typeof item.id === "number" ? { type: item.id } : {}),
          ...(typeof item.metadata === "number" ? { metadata: item.metadata } : {}),
          ...(typeof item.count === "number" ? { count: item.count } : {}),
          ...(typeof item.name === "string" ? { name: item.name } : {}) };
      };
      return { index, ...(this.recipeId(recipe) ? { id: this.recipeId(recipe) } : {}),
        result: ingredient(value.result),
        ...(Array.isArray(value.ingredients) ? { ingredients: value.ingredients.map(ingredient) } : {}),
        ...(Array.isArray(value.inShape) ? { inShape: value.inShape.map(ingredient) } : {}),
        ...(typeof value.requiresTable === "boolean" ? { requiresTable: value.requiresTable } : {}),
      };
    }) };
  }

  async craft(
    itemName: string,
    count: number,
    table?: { x: number; y: number; z: number },
    recipeIndex?: number,
    recipeId?: string,
  ): Promise<{
    crafted: string;
    count: number;
    requestedCount: number;
    craftCount: number;
    expectedResultCount: number;
    recipeIndex: number;
    recipeId?: string;
  }> {
    const itemType = this.itemType(itemName);
    const craftingTable = table ? this.getRequiredBlock(table.x, table.y, table.z) : undefined;
    const recipes = this.requireMethod("recipesFor").call(this.requireBot(), itemType, null, count, craftingTable ?? null) as unknown[];
    const selected = this.selectRecipe(recipes, recipeIndex, recipeId);
    const recipe = recipes[selected.index];
    if (!recipe) {
      throw new CliError("COMMAND_BLOCKED", `No recipe found for '${itemName}'.`, "Observe the current game state and choose a valid operation.");
    }
    const resultCount = this.recipeResultCount(recipe);
    const craftCount = Math.ceil(count / resultCount);
    const expectedResultCount = craftCount * resultCount;
    await this.requireMethod("craft").call(this.requireBot(), recipe, craftCount, craftingTable);
    return {
      crafted: itemName,
      count,
      requestedCount: count,
      craftCount,
      expectedResultCount,
      recipeIndex: selected.index,
      recipeId: selected.id,
    };
  }

  async dig(x: number, y: number, z: number): Promise<{ dug: true; block: ReturnType<typeof serializeBlock> }> {
    const block = this.getRequiredBlock(x, y, z);
    await this.requireMethod("dig").call(this.requireBot(), block, true);
    return { dug: true, block: serializeBlock(block) };
  }

  stopDigging() {
    this.requireMethod("stopDigging").call(this.requireBot());
    return { stopped: true };
  }

  async place(x: number, y: number, z: number, face: string, itemName?: string): Promise<{ placed: true; referenceBlock: ReturnType<typeof serializeBlock>; face: string }> {
    const verify = this.continuationGuard(["item", "look"]);
    if (itemName) {
      await this.equip(itemName, "hand");
    }
    verify();
    const block = this.getRequiredBlock(x, y, z);
    await this.requireMethod("placeBlock").call(this.requireBot(), block, faceVector(face));
    return { placed: true, referenceBlock: serializeBlock(block), face };
  }

  async placeEntity(x: number, y: number, z: number, face: string, itemName?: string) {
    const verify = this.continuationGuard(["item", "look"]);
    if (itemName) {
      await this.equip(itemName, "hand");
    }
    verify();
    const block = this.getRequiredBlock(x, y, z);
    const entity = await this.requireMethod("placeEntity").call(this.requireBot(), block, faceVector(face));
    return { placed: true, entity: this.publicEntity(entity), referenceBlock: serializeBlock(block), face };
  }

  async activate(x: number, y: number, z: number): Promise<{ activated: true; block: ReturnType<typeof serializeBlock> }> {
    const block = this.getRequiredBlock(x, y, z);
    await this.requireMethod("activateBlock").call(this.requireBot(), block);
    return { activated: true, block: serializeBlock(block) };
  }

  updateSign(x: number, y: number, z: number, text: string, back: boolean) {
    const block = this.getRequiredBlock(x, y, z);
    this.requireMethod("updateSign").call(this.requireBot(), block, text, back);
    return { updated: true, block: serializeBlock(block), back };
  }

  async sleep(x: number, y: number, z: number) {
    const block = this.getRequiredBlock(x, y, z);
    await this.requireMethod("sleep").call(this.requireBot(), block);
    return { sleeping: true, block: serializeBlock(block) };
  }

  async wake() {
    await this.requireMethod("wake").call(this.requireBot());
    return { awake: true };
  }

  async elytraFly() {
    await this.requireMethod("elytraFly").call(this.requireBot());
    return { flying: true };
  }

  async openWindowAt(x: number, y: number, z: number) {
    const verify = this.continuationGuard(["window"]);
    const block = this.getRequiredBlock(x, y, z);
    const window = await this.openContainerObserved(block);
    try { verify(); } catch (error) { window.close?.(); throw error; }
    return { opened: true, block: serializeBlock(block), window: serializeWindow(window) };
  }

  async openEntityWindow(id: number | string) {
    const verify = this.continuationGuard(["window"]);
    const entity = this.getRequiredEntity(id);
    const window = await this.openContainerObserved(entity);
    try { verify(); if (typeof id === "string") this.getRequiredEntity(id); }
    catch (error) { window.close?.(); throw error; }
    return { opened: true, entity: this.publicEntity(entity), window: serializeWindow(window) };
  }

  windowStatus() {
    if (!this.connectionStatus().ready || !("currentWindow" in this.requireBot())) return { known: false };
    return { known: true, ...(this.bot?.currentWindow ? { window: serializeWindow(this.bot.currentWindow) } : {}) };
  }

  async windowDeposit(itemName: string, count: number) {
    const window = this.requireWindow();
    if (!window.deposit) {
      throw new CliError("COMMAND_BLOCKED", "Current window does not support deposit.", "Observe the current game state and choose a valid operation.");
    }
    await window.deposit(this.itemType(itemName), null, count);
    return { deposited: itemName, count, window: serializeWindow(window) };
  }

  async windowWithdraw(itemName: string, count: number) {
    const window = this.requireWindow();
    if (!window.withdraw) {
      throw new CliError("COMMAND_BLOCKED", "Current window does not support withdraw.", "Observe the current game state and choose a valid operation.");
    }
    await window.withdraw(this.itemType(itemName), null, count);
    return { withdrew: itemName, count, window: serializeWindow(window) };
  }

  async windowClick(slot: number, mouseButton: number, mode: number) {
    const window = this.requireWindow();
    await this.requireMethod("clickWindow").call(this.requireBot(), slot, mouseButton, mode);
    return { clicked: true, slot, mouseButton, mode, window: serializeWindow(this.requireBot().currentWindow ?? window) };
  }

  closeWindow() {
    const window = this.requireWindow();
    if (window.close) {
      window.close();
    } else {
      this.requireMethod("closeWindow").call(this.requireBot(), window);
    }
    return { closed: true };
  }

  async activateEntity(id: number | string) {
    const entity = this.getRequiredEntity(id);
    await this.requireMethod("activateEntity").call(this.requireBot(), entity);
    return { activated: true, entity: this.publicEntity(entity) };
  }

  useOnEntity(id: number | string) {
    const entity = this.getRequiredEntity(id);
    this.requireMethod("useOn").call(this.requireBot(), entity);
    return { usedOn: true, entity: this.publicEntity(entity) };
  }

  attackEntity(id: number | string, options: { allowPlayers?: boolean; allowPassive?: boolean } = {}) {
    const entity = this.getRequiredEntity(id);
    this.assertAttackAllowed(entity, options);
    this.requireMethod("attack").call(this.requireBot(), entity);
    return { attacked: true, entity: this.publicEntity(entity) };
  }

  swingArm(hand: "left" | "right", showHand: boolean) {
    this.requireMethod("swingArm").call(this.requireBot(), hand, showHand);
    return { swung: true, hand, showHand };
  }

  mountEntity(id: number | string) {
    const entity = this.getRequiredEntity(id);
    this.requireMethod("mount").call(this.requireBot(), entity);
    return { mounted: true, entity: this.publicEntity(entity) };
  }

  dismount() {
    this.requireMethod("dismount").call(this.requireBot());
    return { dismounted: true };
  }

  moveVehicle(left: number, forward: number) {
    this.requireMethod("moveVehicle").call(this.requireBot(), left, forward);
    return { moved: true, left, forward };
  }

  stop(): void {
    if (this.stopping) return;
    this.leaveReady();
    this.stopping = true;
    this.connectionEnded = true;
    this.lastDisconnectReason = "STOPPED";
    this.connected = false;
    this.spawned = false;
    try { this.world.reset("STOPPED"); }
    catch (error) { this.recordConnectionError(error); }
    finally {
      this.lifecycleReset = true;
      this.transition("stopping", "STOPPED");
      this.disposeBot();
    }
  }

  private publicEntity(entity: MineflayerEntity) {
    const name = entity.type === "player" || entity.username ? "player" : entity.name?.replace(/^minecraft:/, "");
    return projectEntity({ trackId: this.world.trackFor(entity), status: "loaded",
      type: name && /^[a-z][a-z0-9_]*$/.test(name) ? `minecraft:${name}` : undefined,
      name: entity.name, username: entity.username, position: entity.position,
      distance: distance(this.bot?.entity?.position, entity.position),
    });
  }

  private requireBot(): MineflayerBot {
    if (!this.bot) {
      throw new CliError("NOT_READY", "Bot is not started.", "Observe the current game state and choose a valid operation.");
    }
    return this.bot;
  }

  private continuationGuard(resources: ActionResource[]): () => void {
    const epoch = this.world.worldEpoch;
    const owners = resources.map((resource) => this.actions.owner(resource));
    return () => {
      this.checkWorld();
      this.checkActionTargets();
      if (epoch !== this.world.worldEpoch) throw new CliError("WORLD_CHANGED", "World changed during action.", "Observe a fresh frame.");
      if (resources.some((resource, index) => owners[index] !== this.actions.owner(resource))) {
        throw new CliError("COMMAND_BLOCKED", "Action was replaced or cancelled.", "Inspect current actions.");
      }
    };
  }

  private async openContainerObserved(target: MineflayerBlock | MineflayerEntity): Promise<MineflayerWindow> {
    const bot = this.requireBot();
    const before = new Set(bot.rawListeners("windowOpen"));
    const result = this.requireMethod("openContainer").call(bot, target);
    const added = bot.rawListeners("windowOpen").filter((listener) => !before.has(listener));
    const cleanup = () => { for (const listener of added) bot.removeListener("windowOpen", listener); };
    this.pendingWindowListeners.add(cleanup);
    try { return await result; }
    finally { cleanup(); this.pendingWindowListeners.delete(cleanup); }
  }

  private requirePathfinder(): NonNullable<MineflayerBot["pathfinder"]> {
    const bot = this.requireBot();
    if (!bot.pathfinder) {
      throw new CliError("COMMAND_BLOCKED", "Pathfinder is not available.", "Observe the current game state and choose a valid operation.");
    }
    return bot.pathfinder;
  }

  private requireMethod<T extends keyof MineflayerBot>(name: T): NonNullable<MineflayerBot[T]> {
    const method = this.requireBot()[name];
    if (typeof method !== "function") {
      throw new CliError("COMMAND_BLOCKED", `Bot method '${String(name)}' is not available.`, "Observe the current game state and choose a valid operation.");
    }
    return method as NonNullable<MineflayerBot[T]>;
  }

  private getRequiredBlock(x: number, y: number, z: number): MineflayerBlock {
    const block = this.requireMethod("blockAt").call(this.requireBot(), new Vec3(x, y, z)) as MineflayerBlock | null;
    if (!block) {
      throw new CliError("COMMAND_BLOCKED", `No loaded block at ${x}, ${y}, ${z}.`, "Observe the current game state and choose a valid operation.");
    }
    return block;
  }

  private blockType(name: string): number {
    const block = this.requireBot().registry?.blocksByName?.[name];
    if (!block) {
      throw new CliError("BAD_INPUT", `Unknown block '${name}' for this Minecraft version.`, "Observe the current game state and choose a valid operation.");
    }
    return block.id;
  }

  private itemType(name: string): number {
    const item = this.requireBot().registry?.itemsByName?.[name];
    if (!item) {
      throw new CliError("BAD_INPUT", `Unknown item '${name}' for this Minecraft version.`, "Observe the current game state and choose a valid operation.");
    }
    return item.id;
  }

  private findInventoryItem(name: string, excludeSlot?: number): MineflayerItem {
    const item = this.requireBot()
      .inventory?.items()
      .find((candidate) => candidate.slot !== excludeSlot && (candidate.name === name || candidate.displayName === name));
    if (!item) {
      throw new CliError("COMMAND_BLOCKED", `Item '${name}' is not in inventory.`, "Observe the current game state and choose a valid operation.");
    }
    return item;
  }

  private getRequiredEntity(id: number | string): MineflayerEntity {
    if (typeof id === "string") {
      this.checkWorld();
      return this.world.resolveTrack(id) as MineflayerEntity;
    }
    const entity = this.requireBot().entities?.[String(id)];
    if (!entity) {
      throw new CliError("COMMAND_BLOCKED", `Entity '${id}' is not visible.`, "Observe the current game state and choose a valid operation.");
    }
    return entity;
  }

  private requireWindow(): MineflayerWindow {
    const window = this.requireBot().currentWindow;
    if (!window) {
      throw new CliError("COMMAND_BLOCKED", "No window is currently open.", "Observe the current game state and choose a valid operation.");
    }
    return window;
  }

  private selectRecipe(recipes: unknown[], recipeIndex?: number, recipeId?: string): { index: number; id?: string } {
    if (recipeIndex !== undefined && recipeId !== undefined) {
      throw new CliError("BAD_INPUT", "Choose either recipeIndex or recipeId, not both.", "Observe the current game state and choose a valid operation.");
    }
    if (recipeId !== undefined) {
      const index = recipes.findIndex((recipe) => this.recipeId(recipe) === recipeId);
      if (index < 0) {
        throw new CliError("BAD_INPUT", `No recipe with id '${recipeId}' was found.`, "Observe the current game state and choose a valid operation.");
      }
      return { index, id: recipeId };
    }
    const index = recipeIndex ?? 0;
    if (index < 0 || index >= recipes.length) {
      throw new CliError("BAD_INPUT", `Recipe index ${index} is out of range.`, "Observe the current game state and choose a valid operation.");
    }
    return { index, id: this.recipeId(recipes[index]) };
  }

  private recipeId(recipe: unknown): string | undefined {
    const direct = recipeStringField(recipe, "id") ?? recipeStringField(recipe, "name");
    if (direct) {
      return direct;
    }
    if (recipe && typeof recipe === "object") {
      const result = (recipe as Record<string, unknown>).result;
      return recipeStringField(result, "id") ?? recipeStringField(result, "name");
    }
    return undefined;
  }

  private recipeResultCount(recipe: unknown): number {
    if (!recipe || typeof recipe !== "object") {
      return 1;
    }
    const result = (recipe as Record<string, unknown>).result;
    if (!result || typeof result !== "object") {
      return 1;
    }
    const count = (result as Record<string, unknown>).count;
    return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 1;
  }

  private isPlayerEntity(entity: MineflayerEntity): boolean {
    return entity.type === "player" || Boolean(entity.username);
  }

  private isPassiveEntity(entity: MineflayerEntity): boolean {
    if (!entity.name) {
      return false;
    }
    const category = this.requireBot().registry?.entitiesByName?.[entity.name]?.category;
    return category?.toLowerCase().includes("passive") === true || passiveEntityNames.has(entity.name);
  }

  private assertAttackAllowed(entity: MineflayerEntity, options: { allowPlayers?: boolean; allowPassive?: boolean }): void {
    if (this.isPlayerEntity(entity) && !options.allowPlayers) {
      throw commandBlocked("Refusing to attack a player without allowPlayers.", "Only pass --allow-players when authorized.");
    }
    if (this.isPassiveEntity(entity) && !options.allowPassive) {
      throw commandBlocked("Refusing to attack a passive mob without allowPassive.", "Only pass --allow-passive when authorized.");
    }
  }

  private configurePathfinderMovements(): PathfinderMovements | undefined {
    const bot = this.requireBot();
    if (!bot.pathfinder) {
      return undefined;
    }
    const movements = bot.pathfinder.movements ?? this.createPathfinderMovements(bot);
    if (!movements) {
      return undefined;
    }
    this.applyNavigationMovementConfig(movements);
    bot.pathfinder.setMovements(movements);
    return movements;
  }

  private createPathfinderMovements(bot: MineflayerBot): PathfinderMovements | undefined {
    if (!bot.registry?.blocksByName || !bot.registry.blocksArray || !bot.registry.itemsByName) {
      return undefined;
    }
    return new Movements(bot as never);
  }

  private applyNavigationMovementConfig(movements: PathfinderMovements): void {
    if (this.navigationMovementConfig.canDig !== undefined) movements.canDig = this.navigationMovementConfig.canDig;
    if (!this.placementDefaults.has(movements)) {
      this.placementDefaults.set(movements, { blocks: [...(movements.scafoldingBlocks ?? [])], towers: movements.allow1by1towers });
    }
    const defaults = this.placementDefaults.get(movements)!;
    movements.scafoldingBlocks = this.navigationMovementConfig.canPlace ? [...defaults.blocks] : [];
    movements.allow1by1towers = this.navigationMovementConfig.canPlace ? defaults.towers : false;
    if (this.navigationMovementConfig.allowSprinting !== undefined) movements.allowSprinting = this.navigationMovementConfig.allowSprinting;
    if (this.navigationMovementConfig.allowParkour !== undefined) movements.allowParkour = this.navigationMovementConfig.allowParkour;
    if (this.navigationMovementConfig.canOpenDoors !== undefined) movements.canOpenDoors = this.navigationMovementConfig.canOpenDoors;
    if (this.navigationMovementConfig.maxDropDown !== undefined) movements.maxDropDown = this.navigationMovementConfig.maxDropDown;
  }
}
