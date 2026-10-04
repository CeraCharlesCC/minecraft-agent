import { Writable } from "node:stream";
import { Command } from "commander";
import { z } from "zod";
import { getSkillContent } from "../core/skills.js";
import { badInput, commandBlocked, contextRequired, normalizeError, publicError } from "../output/errors.js";
import { failure, formatDefaultText, resolveOutputMode, success, writeJson, writeText } from "../output/response.js";
import { decodeActionContext } from "../core/context.js";
import { isHandle } from "../core/handles.js";
import { normalizeRegistryName } from "../core/registry.js";
import { parseSurroundingsBounds, validateSurroundingsOptions } from "../core/surroundings-input.js";
import { CliHandlers } from "./handlers.js";
import { acquireClientContext, resolveClientId, resolveStrictContext, type ClientContextLease } from "../session/client-context.js";

export interface CliIo {
  stdout: Writable;
  stderr: Writable;
  isStdoutTty?: boolean;
}

const sessionSchema = z.object({
  session: z.string().min(1).default("default"),
  context: z.string().min(1).optional(),
  runtimeId: z.string().min(1).optional(),
  worldEpoch: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  wait: z.coerce.number().int().min(0).max(30000).optional(),
  observe: z.boolean().optional(),
});

const physicalSchema = sessionSchema.extend({
  runtimeId: z.string().min(1),
  worldEpoch: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

function collectEventType(value: string, previous: string[] = []): string[] {
  return previous.concat(value);
}

function normalizeEventTypes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

const eventTypesSchema = z.preprocess(normalizeEventTypes, z.array(z.string().min(1)));

const startSchema = sessionSchema.extend({
  detail: z.enum(["compact", "full"]).optional(),
  host: z.string().min(1).default("localhost"),
  port: z.coerce.number().int().positive().max(65535).default(25565),
  username: z.string().min(1).default("AgentBot"),
  auth: z.string().min(1).default("offline"),
  version: z.string().min(1).optional(),
  autoReconnect: z.boolean().optional(),
  reconnectMaxAttempts: z.coerce.number().int().min(1).max(10).optional(),
  reconnectBackoff: z.coerce.number().int().min(0).max(30000).optional(),
});

const scopedHandle = (kinds: string, message: string) => z.string().refine(value => [...kinds].some(kind => isHandle(value, kind as "p" | "e" | "a" | "f" | "s" | "m")), message);
const eventCursorSchema = z.union([z.literal("0"), z.literal(0), z.literal("now"), scopedHandle("s", "Expected a runtime-scoped event cursor, 0, or now")]).default(0).transform(value => value === "0" ? 0 as const : value);
const trackSchema = scopedHandle("pe", "Expected a runtime-scoped track");
const frameSchema = sessionSchema.extend({
  since: scopedHandle("f", "Expected a runtime-scoped frame").optional(),
  detail: z.enum(["compact", "full"]).default("compact"),
  maxEntities: z.coerce.number().int().min(0).max(200).default(12),
  radius: z.coerce.number().positive().max(256).default(64),
  track: z.preprocess(normalizeEventTypes, z.array(trackSchema)),
}).transform(({ track, ...input }) => ({ ...input, tracks: track }));
const actionStopSchema = physicalSchema.extend({
  resource: z.preprocess(value => value === undefined ? undefined : normalizeEventTypes(value),
    z.array(z.enum(["movement", "look", "item", "window"])).min(1).optional()),
}).transform(({ resource, ...input }) => ({ ...input, ...(resource ? { resources: [...new Set(resource)] } : {}) }));
const actionSchema = sessionSchema.extend({
  action: scopedHandle("a", "Expected a runtime-scoped action"),
});
const debugEventsSchema = sessionSchema.extend({
  id: scopedHandle("ms", "Expected a scoped message ID or semantic cursor").optional(),
});

const eventsSchema = sessionSchema.extend({
  profile: z.enum(["all", "agent"]).default("all"),
  since: eventCursorSchema,
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  type: eventTypesSchema,
}).transform(({ type, ...input }) => ({ ...input, types: type }));

const watchSchema = sessionSchema.extend({
  excludeSelf: z.boolean().optional(),
  profile: z.enum(["all", "agent"]).default("all"),
  since: eventCursorSchema,
  type: eventTypesSchema,
  track: trackSchema.optional(),
  fields: z.preprocess(value => value === undefined ? undefined : normalizeEventTypes(value), z.array(z.enum(["position", "velocity", "status"])).min(1).optional()),
  rate: z.coerce.number().min(0.1).max(10).optional(),
}).superRefine((input, context) => {
  if (input.track && (input.type.length || input.since !== 0 || input.profile !== "all" || input.excludeSelf)) {
    context.addIssue({ code: "custom", message: "Target samples cannot use event cursors or type filters" });
  }
  if (!input.track && (input.fields || input.rate !== undefined)) {
    context.addIssue({ code: "custom", message: "--fields and --rate require --track" });
  }
}).transform(({ type, ...input }) => input.track
  ? ({ ...input, types: type, fields: input.fields ?? ["position"], rate: input.rate ?? 2 })
  : ({ ...input, types: type }));

const chatSchema = sessionSchema.extend({
  message: z.string().min(1),
  allowCommand: z.boolean().default(false),
});

const whisperSchema = sessionSchema.extend({
  username: z.string().min(1),
  message: z.string().min(1),
});

const tabCompleteSchema = sessionSchema.extend({
  text: z.string(),
  assumeCommand: z.boolean().default(false),
  sendBlockInSight: z.boolean().default(false),
  timeout: z.coerce.number().int().positive().max(30000).default(5000),
});

const controlTapSchema = physicalSchema.extend({
  state: z.enum(["forward", "back", "left", "right", "jump", "sprint", "sneak"]),
  durationMs: z.coerce.number().int().min(1).max(30000).default(500),
});

const controlSetSchema = physicalSchema.extend({
  state: z.enum(["forward", "back", "left", "right", "jump", "sprint", "sneak"]),
  value: z.boolean().default(true),
});

const lookAtSchema = physicalSchema.extend({
  x: z.coerce.number(),
  y: z.coerce.number(),
  z: z.coerce.number(),
});

const lookSchema = physicalSchema.extend({
  yaw: z.coerce.number(),
  pitch: z.coerce.number(),
  force: z.boolean().default(false),
});

const blockPositionSchema = sessionSchema.extend({
  x: z.coerce.number(),
  y: z.coerce.number(),
  z: z.coerce.number(),
});

const findBlocksSchema = sessionSchema.extend({
  name: z.string().min(1),
  radius: z.coerce.number().positive().max(256).default(32),
  count: z.coerce.number().int().min(1).max(200).default(10),
});

const cursorBlockSchema = sessionSchema.extend({
  maxDistance: z.coerce.number().positive().max(256).default(5),
});

const navigateGotoSchema = blockPositionSchema.extend(physicalSchema.shape).extend({
  range: z.coerce.number().positive().max(32).default(1),
});

const navigateFollowSchema = physicalSchema.extend({
  track: trackSchema,
  range: z.coerce.number().positive().max(32).default(2),
});

const navigateConfigureSchema = physicalSchema.extend({
  allowDig: z.boolean().optional(),
  allowPlace: z.boolean().optional(),
  place: z.boolean().optional(),
  dig: z.boolean().optional(),
  allowSprinting: z.boolean().optional(),
  sprinting: z.boolean().optional(),
  allowParkour: z.boolean().optional(),
  parkour: z.boolean().optional(),
  canOpenDoors: z.boolean().optional(),
  maxDropDown: z.coerce.number().int().min(0).max(256).optional(),
});

const navigateTuningSchema = physicalSchema.extend({
  searchRadius: z.coerce.number().int().min(-1).max(1024).optional(),
  thinkTimeout: z.coerce.number().int().positive().max(60000).optional(),
  tickTimeout: z.coerce.number().int().positive().max(1000).optional(),
});

const collectItemSchema = physicalSchema.extend({
  track: trackSchema,
  range: z.coerce.number().positive().max(8).default(1),
});

const equipSchema = physicalSchema.extend({
  item: z.string().min(1),
  destination: z.string().min(1).default("hand"),
});

const unequipSchema = physicalSchema.extend({
  destination: z.string().min(1).default("hand"),
});

const quickBarSchema = physicalSchema.extend({
  slot: z.coerce.number().int().min(0).max(8),
});

const tossSchema = physicalSchema.extend({
  item: z.string().min(1),
  count: z.coerce.number().int().positive().max(64).default(1),
});

const itemActionSchema = physicalSchema.extend({
  offhand: z.boolean().default(false),
});

const recipeSchema = sessionSchema.extend({
  item: z.string().min(1),
  count: z.coerce.number().int().positive().max(64).default(1),
  tableX: z.coerce.number().optional(),
  tableY: z.coerce.number().optional(),
  tableZ: z.coerce.number().optional(),
  recipeIndex: z.coerce.number().int().min(0).optional(),
  recipeId: z.string().min(1).optional(),
});

const placeBlockSchema = blockPositionSchema.extend(physicalSchema.shape).extend({
  face: z.enum(["up", "down", "north", "south", "west", "east"]).default("up"),
  item: z.string().min(1).optional(),
});

const updateSignSchema = blockPositionSchema.extend(physicalSchema.shape).extend({
  text: z.string(),
  back: z.boolean().default(false),
});

const entitySchema = physicalSchema.extend({
  track: trackSchema,
});

const moveVehicleSchema = physicalSchema.extend({
  left: z.coerce.number().min(-1).max(1).default(0),
  forward: z.coerce.number().min(-1).max(1).default(0),
});

const windowItemSchema = physicalSchema.extend({
  item: z.string().min(1),
  count: z.coerce.number().int().positive().max(2304).default(1),
});

const windowClickSchema = physicalSchema.extend({
  slot: z.coerce.number().int().min(0),
  mouseButton: z.coerce.number().int().min(0).max(1).default(0),
  mode: z.coerce.number().int().min(0).max(6).default(0),
});

const entityFindSchema = sessionSchema.extend({
  name: z.string().min(1).optional(),
  radius: z.coerce.number().positive().max(256).default(32),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  types: z.preprocess(value => value === undefined ? undefined : normalizeEventTypes(value),
    z.array(z.string().transform(name => `minecraft:${normalizeRegistryName(name)}`)).min(1).max(512).optional()),
});

const entityAttackSchema = entitySchema.extend({
  allowPlayers: z.boolean().default(false),
  allowPassive: z.boolean().default(false),
});

const daemonRunSchema = startSchema.extend({
  controlPort: z.coerce.number().int().positive().max(65535),
});

const physicalHandlers = new WeakMap<Command, CliHandlers>();
const waitTimeoutSchema = z.coerce.number().int().min(0).max(30000);

type TextFormatter = (data: unknown) => string;

function getOutputMode(command: Command, io: CliIo) {
  return resolveOutputMode(command.optsWithGlobals().output, io.isStdoutTty);
}

function commandRunner<T>(
  command: Command,
  io: CliIo,
  action: () => Promise<T>,
  formatter: TextFormatter = formatDefaultText,
) {
  return async () => {
    let mode: ReturnType<typeof getOutputMode> | undefined;
    let lease: ClientContextLease | undefined;
    const opts = command.opts();
    const originalContext = { context: opts.context, runtimeId: opts.runtimeId, worldEpoch: opts.worldEpoch, wait: opts.wait };
    try {
      mode = getOutputMode(command, io);
      if (command.getOptionValueSource("observe") === "default") delete opts.observe;
      const handlers = physicalHandlers.get(command);
      const globals = command.optsWithGlobals();
      const clientId = resolveClientId(globals.client ?? process.env.MC_AGENT_CLIENT_ID);
      const strict = resolveStrictContext(globals.strictContext);
      const explicitObservation = (command.parent?.name() === "observe" && ["frame", "surroundings"].includes(command.name())) ||
        (command.parent?.name() === "entity" && ["find", "inspect"].includes(command.name()));
      const explicitContext = opts.context !== undefined || opts.runtimeId !== undefined || opts.worldEpoch !== undefined;
      if (clientId && (explicitObservation || (handlers && !explicitContext && !strict))) {
        lease = await acquireClientContext(clientId, opts.session ?? "default");
      }
      if (handlers) {
        if (!explicitContext && !strict && lease?.context) opts.context = lease.context;
        if (opts.context === undefined && opts.runtimeId === undefined && opts.worldEpoch === undefined) throw contextRequired();
        if (opts.context !== undefined) {
          const decoded = decodeActionContext(opts.context);
          if ((opts.runtimeId !== undefined && opts.runtimeId !== decoded.runtimeId) ||
              (opts.worldEpoch !== undefined && Number(opts.worldEpoch) !== decoded.worldEpoch)) {
            throw badInput("Action context contradicts --runtime or --world-epoch.");
          }
          opts.runtimeId = decoded.runtimeId;
          opts.worldEpoch = decoded.worldEpoch;
        }
        if (opts.wait !== undefined) opts.wait = waitTimeoutSchema.parse(opts.wait === true ? 5000 : opts.wait);
      }
      let data: unknown = await action();
      if (explicitObservation && lease) {
        const reason = await lease.remember(data);
        if (reason && data && typeof data === "object") data = { ...data, contextReset: { reason } };
      }
      if (mode === "json") {
        writeJson(io.stdout, success(data));
      } else {
        writeText(io.stdout, formatter(data));
      }
    } catch (error) {
      const normalized = normalizeError(error);
      const errorMode = mode ?? (command.optsWithGlobals().output === "json" ? "json" : "text");
      if (errorMode === "json") {
        writeJson(io.stdout, failure(normalized));
      } else {
        const projected = publicError(normalized);
        writeText(io.stderr, `${projected.code}: ${projected.message}`);
      }
      throw normalized;
    } finally {
      for (const [key, value] of Object.entries(originalContext)) {
        if (value === undefined) delete opts[key]; else opts[key] = value;
      }
      await lease?.release();
    }
  };
}

function streamingCommandRunner(command: Command, io: CliIo, action: () => Promise<void>) {
  return async () => {
    let mode: ReturnType<typeof getOutputMode> | undefined;
    try {
      mode = getOutputMode(command, io);
      await action();
    } catch (error) {
      const normalized = normalizeError(error);
      const errorMode = mode ?? (command.optsWithGlobals().output === "json" ? "json" : "text");
      if (errorMode === "json") {
        writeJson(io.stdout, failure(normalized));
      } else {
        const projected = publicError(normalized);
        writeText(io.stderr, `${projected.code}: ${projected.message}`);
      }
      throw normalized;
    }
  };
}

export function buildProgram(handlers: CliHandlers, io: CliIo, version = "0.0.0"): Command {
  const program = new Command();

  program
    .name("mc-agent")
    .description("Agent-ready Minecraft bot CLI powered by mineflayer.")
    .version(version)
    .option("--output <mode>", "output mode: json or text")
    .option("--client <id>", "stable client identity (default MC_AGENT_CLIENT_ID)")
    .option("--strict-context", "require explicit action context (or MC_AGENT_STRICT_CONTEXT=1)")
    .showHelpAfterError();

  const session = program.command("session").description("Manage Minecraft bot sessions");

  session
    .command("start")
    .description("Start a long-running Minecraft bot session")
    .option("--session <name>", "session name", "default")
    .option("--host <host>", "Minecraft server host", "localhost")
    .option("--port <port>", "Minecraft server port", "25565")
    .option("--username <name>", "bot username", "AgentBot")
    .option("--auth <mode>", "mineflayer auth mode", "offline")
    .option("--minecraft-version <version>", "Minecraft protocol version")
    .option("--listen", "stream new incoming chat after starting", true)
    .option("--no-listen", "return after startup without streaming chat")
    .option("--auto-reconnect", "automatically reconnect after an unexpected disconnect")
    .option("--no-auto-reconnect", "disable automatic reconnect")
    .option("--detail <detail>", "session output: compact or full operational detail")
    .option("--reconnect-max-attempts <count>", "maximum automatic reconnect attempts (default 3)")
    .option("--reconnect-backoff <ms>", "automatic reconnect backoff in milliseconds (default 250)")
    .action(async (opts, cmd) => {
      await commandRunner(
        cmd, io,
        () => handlers.startSession(startSchema.parse({ ...opts, version: opts.minecraftVersion })),
        (data) => `Started session ${(data as { session?: string }).session ?? "default"}`,
      )();
      if (opts.listen) {
        await streamingCommandRunner(cmd, io, () => handlers.observeWatch({
          session: opts.session, since: "now", profile: "agent",
          types: ["chat.player", "chat.whisper", "chat.unverified"], excludeSelf: true,
        }))();
      }
    });

  session
    .command("status")
    .description("Show a Minecraft bot session status")
    .option("--session <name>", "session name", "default")
    .option("--detail <detail>", "session output: compact or full operational detail")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.sessionStatus(sessionSchema.extend({ detail: z.enum(["compact", "full"]).optional() }).parse(opts)))());

  session
    .command("list")
    .description("List known local Minecraft bot sessions")
    .option("--detail <detail>", "session output: compact or full operational detail")
    .action((opts, cmd) => commandRunner(cmd, io, () => opts.detail === undefined ? handlers.listSessions() : handlers.listSessions(z.object({ detail: z.enum(["compact", "full"]) }).parse(opts)))());

  session
    .command("stop")
    .description("Stop a Minecraft bot session")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.stopSession(sessionSchema.parse(opts)))());

  session.command("ensure-ready").description("Wait for spawn and recover a disconnected session with bounded retries")
    .option("--session <name>", "session name", "default")
    .option("--timeout <ms>", "total readiness timeout (1-120000 ms)", "10000")
    .option("--max-attempts <count>", "maximum connection attempts (1-10)", "3")
    .option("--backoff <ms>", "retry backoff in milliseconds (0-30000)", "250")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.sessionEnsureReady!(sessionSchema.extend({
      timeout: z.coerce.number().int().min(1).max(120000), maxAttempts: z.coerce.number().int().min(1).max(10), backoff: z.coerce.number().int().min(0).max(30000),
    }).parse(opts)))());

  const observe = program.command("observe").description("Observe frames, surroundings, and semantic events");

  observe.command("surroundings")
    .description("Fresh world-aligned scan of sampled visible block surfaces in all directions")
    .option("--session <name>", "session name", "default")
    .option("--range <blocks>", "radial eye-to-surface range (greater than 0, at most 32)", "32")
    .option("--detail", "individual observed blocks and faces instead of merged patches", false)
    .option("--bounds <min:max>", "inclusive world-axis offsets: minX,minY,minZ:maxX,maxY,maxZ")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.observeSurroundings!({
      ...sessionSchema.parse(opts),
      ...validateSurroundingsOptions({ range: Number(opts.range), detail: opts.detail,
        ...(opts.bounds === undefined ? {} : { bounds: parseSurroundingsBounds(opts.bounds) }) }),
    }))());

  observe
    .command("frame")
    .description("Read a coherent local frame or delta from a retained baseline")
    .option("--session <name>", "session name", "default")
    .option("--since <frame>", "runtime-scoped baseline frame; reset when unavailable")
    .option("--detail <mode>", "frame detail: compact or full", "compact")
    .option("--max-entities <count>", "individual entity projection limit (0-200)", "12")
    .option("--radius <blocks>", "entity projection radius", "64")
    .option("--track <track>", "preserve requested tracks; repeat or comma-separate", collectEventType, [])
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.observeFrame!(frameSchema.parse(opts)))());

  observe
    .command("events")
    .description("Replay retained semantic events with scoped cursors and gap detection")
    .option("--session <name>", "session name", "default")
    .option("--since <cursor>", "runtime-scoped cursor, 0 from beginning, or now for new events only", "0")
    .option("--profile <profile>", "event profile: all or agent", "all")
    .option("--limit <count>", "maximum events to return", "50")
    .option("--type <eventType>", "include only this event type; repeat or comma-separate for multiple types", collectEventType, [])
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.observeEvents(eventsSchema.parse(opts)))());

  observe
    .command("watch")
    .description("Watch semantic events or sample a target as newline-delimited JSON")
    .option("--exclude-self", "exclude the bot's own chat and outgoing whispers")
    .option("--session <name>", "session name", "default")
    .option("--since <cursor>", "runtime-scoped cursor, 0 from beginning, or now for new events only", "0")
    .option("--profile <profile>", "event profile: all or agent", "all")
    .option("--type <eventType>", "include only this event type; repeat or comma-separate for multiple types", collectEventType, [])
    .option("--track <track>", "sample a runtime-scoped entity track")
    .option("--fields <fields>", "comma-separated sample fields: position,velocity,status; default position")
    .option("--rate <hz>", "sample rate 0.1-10 Hz; default 2")
    .action((opts, cmd) => streamingCommandRunner(cmd, io, () => handlers.observeWatch(watchSchema.parse(opts)))());

  const chat = program.command("chat").description("Send or receive Minecraft chat");

  chat
    .command("listen")
    .description("Stream new incoming chat as NDJSON; no history or self echoes by default")
    .option("--session <name>", "session name", "default")
    .option("--since <cursor>", "runtime-scoped cursor, 0 from beginning, or now for new events only", "now")
    .option("--include-self", "include the bot's own chat and outgoing whispers")
    .action((opts, cmd) => streamingCommandRunner(cmd, io, () => handlers.observeWatch(watchSchema.parse({
      ...opts, profile: "agent", type: ["chat.player", "chat.whisper", "chat.unverified"], excludeSelf: !opts.includeSelf,
    })))());

  chat
    .command("send")
    .description("Send a chat message from the bot")
    .requiredOption("--message <text>", "chat message to send")
    .option("--session <name>", "session name", "default")
    .option("--allow-command", "allow messages beginning with /", false)
    .action((opts, cmd) =>
      commandRunner(cmd, io, () => {
        const input = chatSchema.parse(opts);
        if (input.message.startsWith("/") && !input.allowCommand) {
          throw commandBlocked("Refusing to send a server command as chat.", "Pass --allow-command if this command is intentional.");
        }
        return handlers.sendChat(input);
      })(),
    );

  chat
    .command("whisper")
    .description("Send a private message where the server supports whispers")
    .requiredOption("--username <name>", "target username")
    .requiredOption("--message <text>", "message to send")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.sendWhisper(whisperSchema.parse(opts)))());

  chat
    .command("tab-complete")
    .description("Ask the server for chat or command completions")
    .requiredOption("--text <text>", "text to complete")
    .option("--assume-command", "assume the text is a command", false)
    .option("--send-block-in-sight", "include block-in-sight context", false)
    .option("--timeout <ms>", "timeout in milliseconds", "5000")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.tabComplete(tabCompleteSchema.parse(opts)))());

  const bot = program.command("bot").description("Inspect Minecraft bot state");

  bot
    .command("players")
    .description("Show online players and their observed positions")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.botPlayers(sessionSchema.parse(opts)))());

  bot
    .command("tablist")
    .description("Show the server tablist")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.botTablist(sessionSchema.parse(opts)))());

  bot
    .command("scoreboards")
    .description("Show scoreboards")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.botScoreboards(sessionSchema.parse(opts)))());

  bot
    .command("teams")
    .description("Show teams")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.botTeams(sessionSchema.parse(opts)))());

  const advanced = new Command("advanced").description("Low-level control and pathfinder tuning");
  program.addCommand(advanced, { hidden: true });

  const control = program.command("control").description("Control Minecraft bot movement");

  control
    .command("tap")
    .description("Set a control state briefly")
    .requiredOption("--state <state>", "forward|back|left|right|jump|sprint|sneak")
    .option("--duration-ms <ms>", "duration in milliseconds", "500")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.controlTap(controlTapSchema.parse(opts)))());

  control
    .command("set")
    .description("Set a control state until changed or cleared")
    .requiredOption("--state <state>", "forward|back|left|right|jump|sprint|sneak")
    .option("--value", "turn the control state on", true)
    .option("--off", "turn the control state off")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => {
      const input = controlSetSchema.parse({ ...opts, value: opts.off ? false : opts.value });
      return handlers.controlSet(input);
    })());

  const look = program.command("look").description("Control bot camera direction");

  look
    .command("at")
    .description("Look at a world coordinate")
    .requiredOption("--x <number>", "x coordinate")
    .requiredOption("--y <number>", "y coordinate")
    .requiredOption("--z <number>", "z coordinate")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.lookAt(lookAtSchema.parse(opts)))());

  advanced
    .command("look")
    .description("Look using raw yaw and pitch radians")
    .requiredOption("--yaw <radians>", "yaw in radians")
    .requiredOption("--pitch <radians>", "pitch in radians")
    .option("--force", "force server-side look update", false)
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.look(lookSchema.parse(opts)))());

  look
    .command("track")
    .description("Continuously look at a verified loaded track")
    .requiredOption("--track <track>", "loaded track from observe frame")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.lookTrack!(entitySchema.parse(opts)))());

  const navigate = program.command("navigate").description("Pathfind through the Minecraft world");

  navigate
    .command("goto")
    .description("Pathfind near a world coordinate")
    .requiredOption("--x <number>", "x coordinate")
    .requiredOption("--y <number>", "y coordinate")
    .requiredOption("--z <number>", "z coordinate")
    .option("--range <blocks>", "acceptable distance from the coordinate", "1")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.navigateGoto(navigateGotoSchema.parse(opts)))());

  navigate
    .command("follow")
    .description("Continuously follow a loaded entity track")
    .requiredOption("--track <track>", "loaded track from observe frame")
    .option("--range <blocks>", "preferred follow distance", "2")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.navigateFollow(navigateFollowSchema.parse(opts)))());

  navigate
    .command("configure")
    .description("Configure pathfinder movement settings")
    .option("--allow-dig", "allow pathfinder to dig")
    .option("--allow-place", "allow pathfinder to place blocks")
    .option("--no-place", "disable pathfinder block placement")
    .option("--no-dig", "disable pathfinder digging")
    .option("--allow-sprinting", "allow pathfinder sprinting")
    .option("--no-sprinting", "disable pathfinder sprinting")
    .option("--allow-parkour", "allow pathfinder parkour")
    .option("--no-parkour", "disable pathfinder parkour")
    .option("--can-open-doors", "allow opening doors")
    .option("--max-drop-down <blocks>", "maximum drop down distance")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => {
      const parsed = navigateConfigureSchema.parse(opts);
      return handlers.navigateConfigure({
          session: parsed.session,
          ...(parsed.context ? { context: parsed.context } : {}),
          ...(parsed.runtimeId ? { runtimeId: parsed.runtimeId } : {}),
          ...(parsed.worldEpoch !== undefined ? { worldEpoch: parsed.worldEpoch } : {}),
          ...(parsed.wait !== undefined ? { wait: parsed.wait } : {}),
          ...(parsed.observe !== undefined ? { observe: parsed.observe } : {}),
          allowPlace: parsed.place === false ? false : parsed.allowPlace,
          allowDig: parsed.dig === false ? false : parsed.allowDig,
          allowSprinting: parsed.sprinting === false ? false : parsed.allowSprinting,
          allowParkour: parsed.parkour === false ? false : parsed.allowParkour,
          canOpenDoors: parsed.canOpenDoors,
          maxDropDown: parsed.maxDropDown,
        });
    })());

  advanced.command("navigate-configure")
    .description("Tune pathfinder search and computation limits")
    .option("--search-radius <blocks>", "pathfinder search radius, -1 for unlimited")
    .option("--think-timeout <ms>", "pathfinder think timeout")
    .option("--tick-timeout <ms>", "pathfinder per-tick timeout")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.navigateTune(navigateTuningSchema.parse(opts)))());

  const collect = program.command("collect").description("Collect visible resources");

  collect
    .command("item")
    .description("Approach a loaded dropped item and confirm this bot's pickup; completion does not guarantee the whole stack")
    .requiredOption("--track <track>", "loaded item track from observe frame")
    .option("--range <blocks>", "approach goal range; pickup still requires confirmation", "1")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.collectItem(collectItemSchema.parse(opts)))());

  const inventory = program.command("inventory").description("Act on bot inventory");

  inventory
    .command("equip")
    .description("Equip an inventory item")
    .requiredOption("--item <name>", "item name, for example dirt or wheat_seeds")
    .option("--destination <slot>", "equipment destination", "hand")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryEquip(equipSchema.parse(opts)))());

  inventory
    .command("unequip")
    .description("Unequip an equipment destination")
    .option("--destination <slot>", "equipment destination", "hand")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryUnequip(unequipSchema.parse(opts)))());

  inventory
    .command("quickbar")
    .description("Select a quickbar slot")
    .requiredOption("--slot <0-8>", "quickbar slot")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryQuickBar(quickBarSchema.parse(opts)))());

  inventory
    .command("toss")
    .description("Drop items by registry name")
    .requiredOption("--item <name>", "item name")
    .option("--count <count>", "number of items", "1")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryToss(tossSchema.parse(opts)))());

  inventory
    .command("consume")
    .description("Consume the currently held item")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryConsume(physicalSchema.parse(opts)))());

  inventory
    .command("fish")
    .description("Use the currently held fishing rod")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryFish(physicalSchema.parse(opts)))());

  inventory
    .command("activate-item")
    .description("Start using the held item")
    .option("--offhand", "use offhand", false)
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryActivateItem(itemActionSchema.parse(opts)))());

  inventory
    .command("recipes")
    .description("List recipes for an item")
    .requiredOption("--item <name>", "item name")
    .option("--count <count>", "minimum result count", "1")
    .option("--table-x <number>", "crafting table x coordinate")
    .option("--table-y <number>", "crafting table y coordinate")
    .option("--table-z <number>", "crafting table z coordinate")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryRecipes(recipeSchema.parse(opts)))());

  inventory
    .command("craft")
    .description("Craft an item using a selected available recipe")
    .requiredOption("--item <name>", "item name")
    .option("--count <count>", "minimum result count", "1")
    .option("--table-x <number>", "crafting table x coordinate")
    .option("--table-y <number>", "crafting table y coordinate")
    .option("--table-z <number>", "crafting table z coordinate")
    .option("--recipe-index <index>", "recipe index from inventory recipes")
    .option("--recipe-id <id>", "recipe id when exposed by mineflayer")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.inventoryCraft(recipeSchema.extend(physicalSchema.shape).parse(opts)))());

  const world = program.command("world").description("Inspect and interact with blocks");

  world
    .command("block")
    .description("Inspect a loaded block and its available dig capabilities")
    .requiredOption("--x <number>", "x coordinate")
    .requiredOption("--y <number>", "y coordinate")
    .requiredOption("--z <number>", "z coordinate")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldBlock(blockPositionSchema.parse(opts)))());

  world
    .command("block-at-cursor")
    .description("Inspect the block at the bot's cursor")
    .option("--max-distance <blocks>", "maximum cursor distance", "5")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldBlockAtCursor(cursorBlockSchema.parse(opts)))());

  world
    .command("find-blocks")
    .description("Find nearby loaded blocks by registry name")
    .requiredOption("--name <name>", "block registry name, for example stone or minecraft:stone")
    .option("--radius <blocks>", "search radius", "32")
    .option("--count <count>", "maximum blocks to return", "10")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldFindBlocks(findBlocksSchema.parse(opts)))());

  world
    .command("dig")
    .description("Dig a loaded block")
    .requiredOption("--x <number>", "x coordinate")
    .requiredOption("--y <number>", "y coordinate")
    .requiredOption("--z <number>", "z coordinate")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldDig(blockPositionSchema.extend(physicalSchema.shape).parse(opts)))());

  world
    .command("place")
    .description("Place the held or named item against a loaded reference block")
    .requiredOption("--x <number>", "reference block x coordinate")
    .requiredOption("--y <number>", "reference block y coordinate")
    .requiredOption("--z <number>", "reference block z coordinate")
    .option("--face <face>", "up|down|north|south|west|east", "up")
    .option("--item <name>", "inventory item to equip before placing")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldPlace(placeBlockSchema.parse(opts)))());

  world
    .command("place-entity")
    .description("Place an entity item, such as a boat, against a loaded reference block")
    .requiredOption("--x <number>", "reference block x coordinate")
    .requiredOption("--y <number>", "reference block y coordinate")
    .requiredOption("--z <number>", "reference block z coordinate")
    .option("--face <face>", "up|down|north|south|west|east", "up")
    .option("--item <name>", "inventory item to equip before placing")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldPlaceEntity(placeBlockSchema.parse(opts)))());

  world
    .command("activate")
    .description("Right-click a loaded block")
    .requiredOption("--x <number>", "x coordinate")
    .requiredOption("--y <number>", "y coordinate")
    .requiredOption("--z <number>", "z coordinate")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldActivate(blockPositionSchema.extend(physicalSchema.shape).parse(opts)))());

  world
    .command("update-sign")
    .description("Update sign text")
    .requiredOption("--x <number>", "x coordinate")
    .requiredOption("--y <number>", "y coordinate")
    .requiredOption("--z <number>", "z coordinate")
    .requiredOption("--text <text>", "sign text")
    .option("--back", "write to the back side", false)
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldUpdateSign(updateSignSchema.parse(opts)))());

  world
    .command("sleep")
    .description("Sleep in a bed block")
    .requiredOption("--x <number>", "bed x coordinate")
    .requiredOption("--y <number>", "bed y coordinate")
    .requiredOption("--z <number>", "bed z coordinate")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldSleep(blockPositionSchema.extend(physicalSchema.shape).parse(opts)))());

  world
    .command("wake")
    .description("Wake from sleep")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldWake(physicalSchema.parse(opts)))());

  world
    .command("elytra-fly")
    .description("Start elytra flight")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.worldElytraFly(physicalSchema.parse(opts)))());

  const window = program.command("window").description("Inspect and transfer through the current container window");

  window
    .command("open-block")
    .description("Open a container-like block")
    .requiredOption("--x <number>", "block x coordinate")
    .requiredOption("--y <number>", "block y coordinate")
    .requiredOption("--z <number>", "block z coordinate")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.windowOpenBlock(blockPositionSchema.extend(physicalSchema.shape).parse(opts)))());

  window
    .command("open-entity")
    .description("Open a visible container-like entity")
    .requiredOption("--track <track>", "loaded track from observe frame")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.windowOpenEntity(entitySchema.parse(opts)))());

  window
    .command("deposit")
    .description("Deposit inventory items into the current window")
    .requiredOption("--item <name>", "item name")
    .option("--count <count>", "item count", "1")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.windowDeposit(windowItemSchema.parse(opts)))());

  window
    .command("withdraw")
    .description("Withdraw items from the current window")
    .requiredOption("--item <name>", "item name")
    .option("--count <count>", "item count", "1")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.windowWithdraw(windowItemSchema.parse(opts)))());

  advanced
    .command("window-click")
    .description("Click a raw window slot")
    .requiredOption("--slot <slot>", "window slot")
    .option("--mouse-button <button>", "mouse button", "0")
    .option("--mode <mode>", "click mode", "0")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.windowClick(windowClickSchema.parse(opts)))());

  window
    .command("close")
    .description("Close the current window")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.windowClose(physicalSchema.parse(opts)))());

  const entity = program.command("entity").description("Interact with visible entities");

  entity
    .command("find")
    .description("Find visible entities with filters")
    .option("--name <name>", "entity name or username")
    .option("--types <species>", "species such as cow or minecraft:cow; repeat or comma-separate", collectEventType)
    .option("--radius <blocks>", "search radius", "32")
    .option("--limit <count>", "maximum entities to return", "50")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.entityFind(entityFindSchema.parse(opts)))());

  entity
    .command("inspect")
    .description("Inspect one loaded entity's name, dropped item and equipment")
    .requiredOption("--track <track>", "loaded entity track from frame or find")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.entityInspect(sessionSchema.extend({ track: trackSchema }).parse(opts)))());

  entity
    .command("interact")
    .description("Right-click a visible entity using the held item")
    .requiredOption("--track <track>", "loaded track from observe frame")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.entityInteract(entitySchema.parse(opts)))());

  entity
    .command("attack")
    .description("Attack a visible entity by track")
    .requiredOption("--track <track>", "loaded track from observe frame")
    .option("--allow-players", "allow attacking player entities", false)
    .option("--allow-passive", "allow attacking passive mobs", false)
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.entityAttack(entityAttackSchema.parse(opts)))());

  entity
    .command("mount")
    .description("Mount a visible entity by track")
    .requiredOption("--track <track>", "loaded track from observe frame")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.entityMount(entitySchema.parse(opts)))());

  entity
    .command("dismount")
    .description("Dismount the current vehicle")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.entityDismount(physicalSchema.parse(opts)))());

  entity
    .command("move-vehicle")
    .description("Move the mounted vehicle")
    .option("--left <number>", "left/right input from -1 to 1", "0")
    .option("--forward <number>", "forward/back input from -1 to 1", "0")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.entityMoveVehicle(moveVehicleSchema.parse(opts)))());

  const action = program.command("action").description("Inspect and stop managed runtime actions");
  action.command("stop")
    .description("Stop actions and controls using selected resources, or all resources")
    .option("--resource <resource>", "movement|look|item|window; repeat or comma-separate", collectEventType)
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.actionStop!(actionStopSchema.parse(opts)))());
  action.command("status")
    .requiredOption("--action <action>", "runtime-scoped action id")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.actionStatus!(actionSchema.parse(opts)))());
  action.command("wait").description("Wait for a managed action to settle; timeout leaves it running")
    .requiredOption("--action <action>", "runtime-scoped action id")
    .option("--session <name>", "session name", "default")
    .option("--timeout <ms>", "wait timeout (0-30000 ms)", "5000")
    .option("--no-observe", "omit the response observation")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.actionWait!(actionSchema.extend({ timeout: waitTimeoutSchema }).parse(opts)))());
  action.command("cancel")
    .requiredOption("--action <action>", "runtime-scoped action id")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.actionCancel!(actionSchema.extend(physicalSchema.shape).parse(opts)))());

  const debug = program.command("debug").description("Raw diagnostics outside the primary agent interface");
  debug.command("session")
    .description("Inspect session readiness and recovery diagnostics")
    .option("--session <name>", "session name", "default")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.debugSession!(sessionSchema.parse(opts)))());
  debug.command("events")
    .description("Read retained raw payloads by scoped message ID or semantic cursor")
    .option("--session <name>", "session name", "default")
    .option("--id <id>", "runtime-scoped message ID or semantic cursor")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.debugEvents!(debugEventsSchema.parse(opts)))());

  const skills = program.command("skills").description("Print mc-agent skill content for AI agents");

  const getSkill = skills
    .command("get")
    .description("Print a bundled skill by name")
    .argument("<name>", "skill name, for example core")
    .option("--full", "include full command reference", false)
    .action((name: string, opts: { full: boolean }) =>
      streamingCommandRunner(getSkill, io, async () => {
        writeText(io.stdout, getSkillContent(name, opts.full));
      })(),
    );

  const daemon = new Command("daemon").description("Internal daemon commands");
  daemon
    .command("run")
    .requiredOption("--control-port <port>", "local control port")
    .option("--session <name>", "session name", "default")
    .option("--host <host>", "Minecraft server host", "localhost")
    .option("--port <port>", "Minecraft server port", "25565")
    .option("--username <name>", "bot username", "AgentBot")
    .option("--auth <mode>", "mineflayer auth mode", "offline")
    .option("--minecraft-version <version>", "Minecraft protocol version")
    .option("--auto-reconnect", "automatically reconnect after an unexpected disconnect")
    .option("--no-auto-reconnect", "disable automatic reconnect")
    .option("--reconnect-max-attempts <count>", "maximum automatic reconnect attempts (default 3)")
    .option("--reconnect-backoff <ms>", "automatic reconnect backoff in milliseconds (default 250)")
    .action((opts, cmd) => commandRunner(cmd, io, () => handlers.daemonRun(daemonRunSchema.parse({ ...opts, version: opts.minecraftVersion })))());
  program.addCommand(daemon, { hidden: true });

  // Every physical mutation carries the context of the observation used to choose it.
  const physicalCommands: Record<string, readonly string[]> = {
    control: ["tap", "set"],
    look: ["at", "track"],
    navigate: ["goto", "follow", "configure"],
    collect: ["item"],
    inventory: ["equip", "unequip", "quickbar", "toss", "consume", "fish", "activate-item", "craft"],
    world: ["dig", "place", "place-entity", "activate", "update-sign", "sleep", "wake", "elytra-fly"],
    window: ["open-block", "open-entity", "deposit", "withdraw", "close"],
    entity: ["interact", "attack", "mount", "dismount", "move-vehicle"],
    action: ["cancel", "stop"],
    advanced: ["look", "window-click", "navigate-configure"],
  };
  for (const group of program.commands) {
    for (const command of group.commands) {
      if (!physicalCommands[group.name()]?.includes(command.name())) continue;
      physicalHandlers.set(command, handlers);
      command.option("--context <context>", "action context token from a frame or entity search");
      command.option("--no-observe", "omit the response observation");
      const immediate = (group.name() === "navigate" && command.name() === "configure") ||
        (group.name() === "advanced" && command.name() === "navigate-configure") ||
        (group.name() === "action" && command.name() === "stop");
      if (!immediate) command.option("--wait [ms]", "bounded daemon wait, default 5000 ms; continuous actions return after start");
      command.option("--runtime <runtimeId>", "expected daemon runtime identity from frame");
      command.option("--world-epoch <epoch>", "expected world context epoch from frame");
      command.hook("preAction", (_command, actionCommand) => {
        const opts = actionCommand.opts();
        opts.runtimeId = opts.runtime;
      });
    }
  }

  return program;
}
