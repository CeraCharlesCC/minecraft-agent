import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { BotOptions, BotController, CreateBotFn } from "./bot.js";
import { CliError, badInput, daemonIncompatible, publicError } from "../output/errors.js";
import { API_VERSION, API_VERSION_HEADER } from "./client.js";
import { validateSurroundingsOptions } from "../core/surroundings-input.js";
import { ActionResource, RuntimeAction, projectAction } from "../core/actions.js";
import { EventStore, projectEvent, eventMatchesFilter, resolveEventFilter } from "../core/events.js";
import { readSession, removeSession, SessionRecord, writeSession } from "../session/store.js";

export interface DaemonOptions extends BotOptions {
  session: string;
  controlPort: number;
  token: string;
  createBotFn?: CreateBotFn;
  exitOnStop?: boolean;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(payload);
}

const controlNames = new Set(["forward", "back", "left", "right", "jump", "sprint", "sneak"]);
const physicalRoutes = new Set([
  "/navigate/goto", "/navigate/follow", "/navigate/stop", "/collect/item",
  "/control/tap", "/control/set", "/control/clear", "/look/at", "/look/yaw-pitch", "/look/track",
  "/inventory/equip", "/inventory/unequip", "/inventory/quickbar", "/inventory/toss", "/inventory/consume",
  "/inventory/fish", "/inventory/activate-item", "/inventory/deactivate-item", "/inventory/craft",
  "/world/dig", "/world/stop-digging", "/world/place", "/world/place-entity", "/world/activate", "/world/update-sign",
  "/world/sleep", "/world/wake", "/world/elytra-fly", "/window/open-block", "/window/open-entity",
  "/window/deposit", "/window/withdraw", "/window/click", "/window/close", "/entity/activate", "/entity/use-on",
  "/entity/attack", "/entity/mount", "/entity/dismount", "/entity/swing-arm", "/entity/move-vehicle",
]);

/** Bound both userland queue and Node's socket buffer for stalled consumers. */
function boundedStream(response: ServerResponse) {
  const queue: string[] = [];
  let blocked = false;
  let closed = false;
  const overflow = () => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    response.end(`${JSON.stringify({ type: "stream.overflow", code: "STREAM_OVERFLOW", message: "Event stream overflowed; reconnect using the last received cursor." })}\n`);
  };
  response.on("close", () => { closed = true; queue.length = 0; });
  response.on("drain", () => {
    blocked = false;
    while (!closed && queue.length && !blocked) blocked = !response.write(queue.shift()!);
  });
  return { overflow, get closed() { return closed; }, async drain() {
    if (!blocked || closed) return;
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); response.off("drain", finish); response.off("close", finish); resolve(); };
      const timer = setTimeout(() => { overflow(); finish(); }, 5000);
      timer.unref();
      response.once("drain", finish);
      response.once("close", finish);
    });
  }, write(value: unknown) {
    if (closed) return;
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > 65536 || response.writableLength > 65536 || queue.length >= 128) { overflow(); return; }
    if (blocked) queue.push(line);
    else blocked = !response.write(line);
  } };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    /* v8 ignore next -- Node HTTP request chunks are Buffers in supported runtimes; keep the fallback for defensive compatibility. */
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function eventTypesFromSearch(url: URL): string[] {
  return url.searchParams
    .getAll("type")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNavigationFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("pathfinder") || normalized.includes("path to goal") || normalized.includes("no path") || normalized.includes("goal");
}

function daemonErrorResponse(error: unknown) {
  if (error instanceof CliError) return { statusCode: error.code === "BAD_INPUT" || error.code === "CONTEXT_REQUIRED" ? 400 : 409,
    body: publicError(error) };
  if (error instanceof SyntaxError) return { statusCode: 400, body: publicError(badInput("Invalid JSON body.")) };
  const code = isNavigationFailure(errorMessage(error)) ? "NAVIGATION_FAILED" : "DAEMON_ERROR";
  return { statusCode: code === "NAVIGATION_FAILED" ? 409 : 500,
    body: publicError(new CliError(code, "Daemon operation failed.", "Inspect daemon diagnostics.")) };
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const events = new EventStore();
  const controller = new BotController(options, events, options.createBotFn);
  const stopLogging = events.subscribe((event) => {
    if (!event.type.startsWith("connection.")) return;
    console.log(JSON.stringify({ timestamp: event.timestamp, session: options.session, type: event.type,
      text: event.text, reason: event.reason, connection: controller.connectionStatus() }));
  });
  controller.start();

  const activeStreams = new Set<ServerResponse>();
  let shuttingDown = false;
  let shutdown: Promise<void> | undefined;
  let stopAcceptance: Promise<void> | undefined;
  let stopPersistenceError: { code: string; message: string } | undefined;
  let record: SessionRecord;
  const server = createServer(async (request, response) => {
    response.setHeader(API_VERSION_HEADER, API_VERSION);
    let includeObservation = false;
    const observation = () => {
      if (!includeObservation) return {};
      try { return { observation: controller.frame({ detail: "compact" }) }; }
      catch (error) { return { observationError: daemonErrorResponse(error).body }; }
    };
    const sendResult = (result: object) => {
      if (!response.destroyed) sendJson(response, 200, { ...result, ...observation() });
    };
    const responseOptions = (body: Record<string, unknown>) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw badInput("Action body must be an object.");
      if (body.observe !== undefined && typeof body.observe !== "boolean") throw badInput("observe must be a boolean.");
      includeObservation = body.observe !== false;
      if (body.wait !== undefined && (typeof body.wait !== "number" || !Number.isSafeInteger(body.wait) || body.wait < 0 || body.wait > 30000)) {
        throw badInput("Action wait timeout must be an integer between 0 and 30000 milliseconds.");
      }
      return body.wait as number | undefined;
    };
    const waitAction = async (action: string, timeout: number) => {
      const abort = new AbortController();
      const close = () => { if (!response.writableEnded) abort.abort(); };
      response.on("close", close);
      try { return await controller.actions.wait(action, timeout, abort.signal); }
      finally { response.off("close", close); }
    };
    const sendAction = async (action: RuntimeAction, timeout?: number, continuous = false) => {
      const result = timeout !== undefined && !continuous ? await waitAction(action.action, timeout) : action;
      sendResult(projectAction(result));
    };
    try {
      if (!isAuthorized(request, options.token)) {
        sendJson(response, 401, { code: "DAEMON_ERROR", message: "Unauthorized daemon request." });
        return;
      }
      const requestApiVersion = request.headers[API_VERSION_HEADER.toLowerCase()];
      if (requestApiVersion !== API_VERSION) {
        throw daemonIncompatible(options.session, { actualApiVersion: requestApiVersion ?? null });
      }

      /* v8 ignore next -- Incoming HTTP requests always provide a URL; fallback is defensive. */
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/status") {
        sendJson(response, 200, controller.status({ detail: url.searchParams.get("detail") === "full" ? "full" : "compact" }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/diagnose") {
        sendJson(response, 200, controller.diagnose());
        return;
      }
      if (request.method === "POST" && url.pathname === "/ensure-ready") {
        controller.assertNotStopping();
        const input = await readJson(request);
        sendJson(response, 200, await controller.ensureReady(input as never));
        return;
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        stopAcceptance ??= (async () => {
          shuttingDown = true;
          controller.stop();
          // Acceptance includes an atomically persisted stopping marker.
          try { await writeSession({ ...record, stopping: true }); }
          catch (error) {
            stopPersistenceError = { code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN", message: errorMessage(error) };
            console.error("Unable to persist daemon stopping state:", stopPersistenceError);
          }
        })();
        await stopAcceptance;
        sendJson(response, 200, { stopping: true, stopped: false, ...(stopPersistenceError ? { persistenceError: { code: stopPersistenceError.code } } : {}) });
        shutdown ??= (async () => {
          if (!response.writableFinished && !response.destroyed) await new Promise<void>((resolve) => {
            const done = () => { response.off("finish", done); response.off("close", done); resolve(); };
            response.once("finish", done);
            response.once("close", done);
          });
          for (const stream of activeStreams) stream.end();
          await new Promise<void>((resolve) => {
            const forceClose = setTimeout(() => server.closeAllConnections(), 1000);
            forceClose.unref();
            server.close(() => { clearTimeout(forceClose); resolve(); });
            server.closeIdleConnections();
          });
          stopLogging();
          try {
            const current = await readSession(options.session);
            if (current?.token === options.token && current.runtimeId === controller.world.runtimeId) await removeSession(options.session);
          } finally {
            // Disk failures must not strand a stopped controller in a live process.
            if (options.exitOnStop ?? true) process.exit(0);
          }
        })();
        void shutdown.catch((error) => { console.error("Daemon shutdown failed:", errorMessage(error)); });
        return;
      }
      if (shuttingDown && request.method === "POST") controller.assertNotStopping();

      if (request.method === "GET" && ["/watch", "/sample"].includes(url.pathname)) {
        if (activeStreams.size >= 32) throw new CliError("STREAM_OVERFLOW", "Subscriber limit reached.", "Close an existing stream before reconnecting.");
        activeStreams.add(response);
        response.on("close", () => activeStreams.delete(response));
      }
      if (request.method === "GET" && url.pathname === "/surroundings") {
        const detail = url.searchParams.get("detail");
        if (detail !== null && !["true", "false"].includes(detail)) throw badInput("Surroundings detail must be true or false.");
        const bounds = url.searchParams.get("bounds");
        sendJson(response, 200, controller.surroundings(validateSurroundingsOptions({
          range: Number(url.searchParams.get("range") ?? "32"), detail: detail === "true",
          ...(bounds === null ? {} : { bounds: JSON.parse(bounds) }),
        })));
        return;
      }
      if (request.method === "GET" && url.pathname === "/frame") {
        sendJson(response, 200, controller.frame({
          since: url.searchParams.get("since") ?? undefined,
          maxEntities: Number(url.searchParams.get("maxEntities") ?? "12"),
          radius: Number(url.searchParams.get("radius") ?? "64"),
          detail: (url.searchParams.get("detail") ?? "compact") as "compact" | "full",
          tracks: url.searchParams.getAll("track").flatMap((value) => value.split(",")),
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/debug/events") {
        sendJson(response, 200, { runtimeId: events.runtimeId, records: events.getDebug(url.searchParams.get("id") ?? undefined) });
        return;
      }
      controller.flushChat();
      const since = url.searchParams.get("since") ?? "0";
      const eventSince = since === "now" ? events.getCursor() : since;
      if (request.method === "GET" && url.pathname === "/events") {
        sendJson(response, 200, events.query(eventSince,
          Number(url.searchParams.get("limit") ?? "50"), eventTypesFromSearch(url), url.searchParams.get("profile") ?? "all"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/watch") {
        const types = eventTypesFromSearch(url);
        const filter = resolveEventFilter(url.searchParams.get("profile") ?? "all", types);
        let replay = events.query(eventSince, 1000, types, filter.profile);
        const excludeSelfValue = url.searchParams.get("excludeSelf");
        if (excludeSelfValue !== null && !["true", "false"].includes(excludeSelfValue)) throw badInput("excludeSelf must be true or false.");
        const excludeSelf = excludeSelfValue === "true";
        const include = (event: { type: string; [field: string]: unknown }) =>
          eventMatchesFilter(event, filter) && (!excludeSelf || !controller.isOwnChat(event));
        const initialReplay = replay;
        const backlog = replay.events.filter(include);
        while (replay.nextCursor !== replay.latestCursor) {
          replay = events.query(replay.nextCursor, 1000, types, filter.profile);
          backlog.push(...replay.events.filter(include));
        }
        const stream = boundedStream(response);
        let starting = true;
        const live: typeof backlog = [];
        const unsubscribe = events.subscribe((event) => {
          if (!include(event)) return;
          if (stream.closed) { unsubscribe(); return; }
          if (!starting) stream.write(projectEvent(event));
          else if (live.length < 128) live.push(projectEvent(event));
          else { stream.overflow(); unsubscribe(); }
        });
        response.on("close", unsubscribe);
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.flushHeaders();
        stream.write({ type: "events.replay", ...initialReplay, events: undefined, ...(excludeSelf ? { excludeSelf: true } : {}) });
        for (const event of backlog) {
          if (stream.closed) break;
          stream.write(event);
          await stream.drain();
        }
        while (live.length && !stream.closed) {
          stream.write(live.shift());
          await stream.drain();
        }
        starting = false;
        if (stream.closed) unsubscribe();
        return;
      }
      if (request.method === "GET" && url.pathname === "/sample") {
        const track = url.searchParams.get("track") ?? "";
        const fields = (url.searchParams.get("fields") ?? "position").split(",");
        const rate = Number(url.searchParams.get("rate") ?? "2");
        if (!Number.isFinite(rate) || rate < 0.1 || rate > 10 || fields.length === 0 ||
          fields.some((field) => !["position", "velocity", "status"].includes(field))) throw badInput("Invalid sampling rate or fields.");
        const initial = controller.sample(track, fields);
        const stream = boundedStream(response);
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.flushHeaders();
        stream.write(initial);
        const timer = setInterval(() => {
          if (stream.closed) { clearInterval(timer); return; }
          try { stream.write(controller.sample(track, fields)); }
          catch (error) {
            stream.write({ type: "track.error", ...daemonErrorResponse(error).body });
            clearInterval(timer);
            response.end();
          }
        }, 1000 / rate);
        timer.unref();
        response.on("close", () => clearInterval(timer));
        return;
      }
      const actionWaitRoute = /^\/actions\/([^/]+)\/wait$/.exec(url.pathname);
      if (request.method === "GET" && actionWaitRoute) {
        const observe = url.searchParams.get("observe");
        if (observe !== null && !["true", "false"].includes(observe)) throw badInput("observe must be true or false.");
        includeObservation = observe !== "false";
        const result = await waitAction(decodeURIComponent(actionWaitRoute[1]), Number(url.searchParams.get("timeout") ?? "5000"));
        sendResult(projectAction(result));
        return;
      }
      const actionRoute = /^\/actions\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      if (actionRoute && ((request.method === "GET" && !actionRoute[2]) || (request.method === "POST" && actionRoute[2]))) {
        const action = decodeURIComponent(actionRoute[1]);
        if (request.method === "POST") {
          const body = await readJson(request);
          if (!body || typeof body !== "object" || Array.isArray(body)) throw badInput("Action body must be an object.");
          responseOptions(body as Record<string, unknown>);
          controller.validateContext(body as never, false);
        }
        sendResult(projectAction(request.method === "GET" ? controller.actions.get(action) : controller.actions.cancel(action)));
        return;
      }
      if (request.method === "POST" && physicalRoutes.has(url.pathname)) {
        const input = await readJson(request);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw badInput("Action body must be an object.");
        const body = input as Record<string, unknown>;
        const wait = responseOptions(body);
        controller.validateContext(body);
        const path = url.pathname;
        const track = () => {
          if (typeof body.track !== "string" || !body.track) throw badInput("Entity actions require a runtime-scoped track.");
          return body.track;
        };
        const num = (name: string, fallback?: number) => {
          const value = body[name] ?? fallback;
          if (typeof value !== "number" || !Number.isFinite(value)) throw badInput(`Invalid ${name}.`);
          return value;
        };
        const integer = (name: string, min: number, max: number, fallback?: number) => {
          const value = num(name, fallback);
          if (!Number.isInteger(value) || value < min || value > max) throw badInput(`Invalid ${name}.`);
          return value;
        };
        const text = (name: string, fallback?: string) => {
          const value = body[name] ?? fallback;
          if (typeof value !== "string" || !value) throw badInput(`Invalid ${name}.`);
          return value;
        };
        const coordinates = () => [num("x"), num("y"), num("z")] as const;
        const range = (fallback: number, max = 32) => {
          const value = num("range", fallback);
          if (value <= 0 || value > max) throw badInput("Range is out of bounds.");
          return value;
        };
        if (path === "/navigate/follow") {
          await sendAction(controller.followTrack(track(), range(2)), wait, true); return;
        }
        if (path === "/look/track") {
          await sendAction(controller.trackLook(track()), wait, true); return;
        }
        if (["/navigate/stop", "/control/clear"].includes(path)) {
          controller.actions.cancelResources(["movement", "look"], "STOPPED");
          sendResult(path === "/navigate/stop" ? controller.stopNavigation() : controller.clearControls()); return;
        }
        if (path === "/world/stop-digging") {
          controller.actions.cancelResources(["item"], "STOPPED"); sendResult(controller.stopDigging()); return;
        }
        if (path === "/inventory/deactivate-item") {
          controller.actions.cancelResources(["item"], "STOPPED"); sendResult(controller.deactivateItem()); return;
        }
        let run: () => unknown | Promise<unknown>;
        let target: string | undefined;
        let resources: ActionResource[] = [];
        let continuous = false;
        switch (path) {
          case "/navigate/goto": { const [x,y,z] = coordinates(), r = range(1); resources = ["movement", "look"]; run = () => controller.goto(x,y,z,r); break; }
          case "/collect/item": { target = track(); const r = range(1,8); resources = ["movement", "look"]; run = () => controller.collectItem(target!,r); break; }
          case "/control/tap": { const state = text("state"), ms = integer("durationMs",1,30000,500); if (!controlNames.has(state) || ms < 1 || ms > 30000) throw badInput("Invalid control or duration."); resources = ["movement"]; run = () => controller.tap(state,ms); break; }
          case "/control/set": { const state = text("state"); if (!controlNames.has(state) || typeof body.value !== "boolean") throw badInput("Invalid control."); resources = ["movement"]; continuous = body.value; run = () => controller.setControl(state, body.value as boolean); break; }
          case "/look/at": { const [x,y,z] = coordinates(); resources = ["look"]; run = () => controller.lookAt(x,y,z); break; }
          case "/look/yaw-pitch": { const yaw = num("yaw"), pitch = num("pitch"); resources = ["look"]; run = () => controller.look(yaw,pitch, Boolean(body.force)); break; }
          case "/inventory/equip": { const item = text("item"), dest = text("destination","hand"); resources = ["item", "window"]; run = () => controller.equip(item,dest); break; }
          case "/inventory/unequip": { const dest = text("destination","hand"); resources = ["item", "window"]; run = () => controller.unequip(dest); break; }
          case "/inventory/quickbar": { const slot = num("slot"); if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw badInput("Invalid quickbar slot."); resources = ["item"]; run = () => controller.setQuickBarSlot(slot); break; }
          case "/inventory/toss": { const item = text("item"), count = integer("count",1,64,1); resources = ["item", "window"]; run = () => controller.toss(item,count); break; }
          case "/inventory/consume": resources = ["item"]; run = () => controller.consume(); break;
          case "/inventory/fish": resources = ["item"]; run = () => controller.fish(); break;
          case "/inventory/activate-item": resources = ["item"]; continuous = true; run = () => controller.activateItem(Boolean(body.offhand)); break;
          case "/inventory/craft": { const item = text("item"), count = integer("count",1,64,1); resources = ["item", "window"]; run = () => controller.craft(item,count,body.table as never,body.recipeIndex as never,body.recipeId as never); break; }
          case "/world/dig": { const [x,y,z] = coordinates(); resources = ["movement", "look", "item"]; run = () => controller.dig(x,y,z); break; }
          case "/world/place": { const [x,y,z] = coordinates(), face = text("face","up"); if (!["up","down","north","south","east","west"].includes(face)) throw badInput("Invalid face."); resources = ["look", "item"]; run = () => controller.place(x,y,z,face,body.item as string | undefined); break; }
          case "/world/place-entity": { const [x,y,z] = coordinates(), face = text("face","up"); if (!["up","down","north","south","east","west"].includes(face)) throw badInput("Invalid face."); resources = ["look", "item"]; run = () => controller.placeEntity(x,y,z,face,body.item as string | undefined); break; }
          case "/world/activate": { const [x,y,z] = coordinates(); resources = ["look", "item", "window"]; run = () => controller.activate(x,y,z); break; }
          case "/world/update-sign": { const [x,y,z] = coordinates(), sign = body.text; if (typeof sign !== "string") throw badInput("Invalid text."); resources = ["item"]; run = () => controller.updateSign(x,y,z,sign,Boolean(body.back)); break; }
          case "/world/sleep": { const [x,y,z] = coordinates(); resources = ["movement", "look"]; run = () => controller.sleep(x,y,z); break; }
          case "/world/wake": resources = ["movement"]; run = () => controller.wake(); break;
          case "/world/elytra-fly": resources = ["movement"]; run = () => controller.elytraFly(); break;
          case "/window/open-block": { const [x,y,z] = coordinates(); resources = ["window", "look"]; run = () => controller.openWindowAt(x,y,z); break; }
          case "/window/open-entity": target = track(); resources = ["window", "look"]; run = () => controller.openEntityWindow(target!); break;
          case "/window/deposit": { const item = text("item"), count = integer("count",1,2304,1); resources = ["window", "item"]; run = () => controller.windowDeposit(item,count); break; }
          case "/window/withdraw": { const item = text("item"), count = integer("count",1,2304,1); resources = ["window", "item"]; run = () => controller.windowWithdraw(item,count); break; }
          case "/window/click": { const slot = integer("slot",0,4096), button = integer("mouseButton",0,1,0), mode = integer("mode",0,6,0); resources = ["window", "item"]; run = () => controller.windowClick(slot,button,mode); break; }
          case "/window/close": resources = ["window"]; run = () => controller.closeWindow(); break;
          case "/entity/activate": target = track(); resources = ["look", "item"]; run = () => controller.activateEntity(target!); break;
          case "/entity/use-on": target = track(); resources = ["look", "item"]; run = () => controller.useOnEntity(target!); break;
          case "/entity/attack": target = track(); resources = ["look", "item"]; run = () => controller.attackEntity(target!, {allowPlayers: body.allowPlayers === true, allowPassive: body.allowPassive === true}); break;
          case "/entity/mount": target = track(); resources = ["movement", "look"]; run = () => controller.mountEntity(target!); break;
          case "/entity/dismount": resources = ["movement"]; run = () => controller.dismount(); break;
          case "/entity/swing-arm": resources = ["item"]; run = () => controller.swingArm((body.hand ?? "right") as "left"|"right", Boolean(body.showHand ?? true)); break;
          case "/entity/move-vehicle": { const left = num("left"), forward = num("forward"); if (Math.abs(left)>1 || Math.abs(forward)>1) throw badInput("Invalid vehicle controls."); resources = ["movement"]; run = () => controller.moveVehicle(left,forward); break; }
          default: throw badInput("Unknown action.");
        }
        await sendAction(controller.runAction(path.slice(1).replaceAll("/","."), resources, run, target, continuous), wait, continuous);
        return;
      }

      if (request.method === "POST" && url.pathname === "/chat") {
        const body = (await readJson(request)) as { message?: string; allowCommand?: boolean };
        controller.sendChat(String(body.message ?? ""), body.allowCommand === true);
        sendJson(response, 200, { sent: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/chat/whisper") {
        const body = (await readJson(request)) as { username?: string; message?: string };
        controller.sendWhisper(String(body.username ?? ""), String(body.message ?? ""));
        sendJson(response, 200, { sent: true, username: body.username });
        return;
      }

      if (request.method === "POST" && url.pathname === "/chat/tab-complete") {
        const body = (await readJson(request)) as { text?: string; assumeCommand?: boolean; sendBlockInSight?: boolean; timeout?: number };
        sendJson(
          response,
          200,
          await controller.tabComplete(
            String(body.text ?? ""),
            Boolean(body.assumeCommand ?? false),
            Boolean(body.sendBlockInSight ?? false),
            Number(body.timeout ?? 5000),
          ),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/bot/position") {
        sendJson(response, 200, controller.position());
        return;
      }

      if (request.method === "GET" && url.pathname === "/bot/inventory") {
        sendJson(response, 200, controller.inventory());
        return;
      }

      if (request.method === "GET" && url.pathname === "/bot/players") {
        sendJson(response, 200, controller.players());
        return;
      }

      if (request.method === "GET" && url.pathname === "/bot/entities") {
        const radius = Number(url.searchParams.get("radius") ?? "32");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        sendJson(response, 200, controller.entities(radius, limit));
        return;
      }

      if (request.method === "GET" && url.pathname === "/bot/tablist") {
        sendJson(response, 200, controller.tablist());
        return;
      }

      if (request.method === "GET" && url.pathname === "/bot/scoreboards") {
        sendJson(response, 200, controller.scoreboards());
        return;
      }

      if (request.method === "GET" && url.pathname === "/bot/teams") {
        sendJson(response, 200, controller.teams());
        return;
      }

      if (request.method === "GET" && url.pathname === "/bot/controls") {
        sendJson(response, 200, controller.controls());
        return;
      }

      if (request.method === "GET" && url.pathname === "/world/block") {
        const x = Number(url.searchParams.get("x"));
        const y = Number(url.searchParams.get("y"));
        const z = Number(url.searchParams.get("z"));
        sendJson(response, 200, controller.blockAt(x, y, z));
        return;
      }

      if (request.method === "GET" && url.pathname === "/world/block-info") {
        const x = Number(url.searchParams.get("x"));
        const y = Number(url.searchParams.get("y"));
        const z = Number(url.searchParams.get("z"));
        sendJson(response, 200, controller.blockInfo(x, y, z));
        return;
      }

      if (request.method === "GET" && url.pathname === "/world/block-in-sight") {
        const maxSteps = Number(url.searchParams.get("maxSteps") ?? "256");
        const vectorLength = Number(url.searchParams.get("vectorLength") ?? "5");
        sendJson(response, 200, controller.blockInSight(maxSteps, vectorLength));
        return;
      }

      if (request.method === "GET" && url.pathname === "/world/block-at-cursor") {
        const maxDistance = Number(url.searchParams.get("maxDistance") ?? "5");
        sendJson(response, 200, controller.blockAtCursor(maxDistance));
        return;
      }

      if (request.method === "GET" && url.pathname === "/world/find-blocks") {
        const name = String(url.searchParams.get("name") ?? "");
        const radius = Number(url.searchParams.get("radius") ?? "32");
        const count = Number(url.searchParams.get("count") ?? "10");
        sendJson(response, 200, controller.findBlocks(name, radius, count));
        return;
      }

      if (request.method === "GET" && url.pathname === "/navigate/status") {
        sendJson(response, 200, controller.navigationStatus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/navigate/configure") {
        const body = (await readJson(request)) as {
          allowDig?: boolean;
          allowPlace?: boolean;
          allowSprinting?: boolean;
          allowParkour?: boolean;
          canOpenDoors?: boolean;
          maxDropDown?: number;
          searchRadius?: number;
          thinkTimeout?: number;
          tickTimeout?: number;
        };
        responseOptions(body as Record<string, unknown>);
        controller.validateContext(body as never);
        for (const key of ["allowDig", "allowPlace", "allowSprinting", "allowParkour", "canOpenDoors"] as const) {
          if (body[key] !== undefined && typeof body[key] !== "boolean") throw badInput(`Invalid ${key}.`);
        }
        for (const key of ["maxDropDown", "searchRadius", "thinkTimeout", "tickTimeout"] as const) {
          if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key]! < (key === "searchRadius" ? -1 : key === "maxDropDown" ? 0 : 1))) throw badInput(`Invalid ${key}.`);
        }
        sendResult(controller.configureNavigation(body));
        return;
      }

      if (request.method === "GET" && url.pathname === "/inventory/recipes") {
        const item = String(url.searchParams.get("item") ?? "");
        const count = Number(url.searchParams.get("count") ?? "1");
        const table = url.searchParams.has("tableX")
          ? {
              x: Number(url.searchParams.get("tableX")),
              y: Number(url.searchParams.get("tableY")),
              z: Number(url.searchParams.get("tableZ")),
            }
          : undefined;
        sendJson(response, 200, controller.recipes(item, count, table));
        return;
      }

      if (request.method === "GET" && url.pathname === "/window/status") {
        sendJson(response, 200, controller.windowStatus());
        return;
      }

      if (request.method === "GET" && url.pathname === "/entity/inspect") {
        const track = url.searchParams.get("track");
        if (!track) throw badInput("Entity inspection requires a runtime-scoped track.");
        sendJson(response, 200, controller.entityInspect(track));
        return;
      }

      if (request.method === "GET" && url.pathname === "/entity/find") {
        sendJson(
          response,
          200,
          controller.findEntities({
            name: url.searchParams.get("name") ?? undefined,
            type: url.searchParams.get("type") ?? undefined,
            types: url.searchParams.has("types") ? url.searchParams.getAll("types").flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean) : undefined,
            radius: Number(url.searchParams.get("radius") ?? "32"),
            limit: Number(url.searchParams.get("limit") ?? "50"),
            includePlayers: url.searchParams.get("includePlayers") === "true",
            includePassive: url.searchParams.get("includePassive") === "true",
          }),
        );
        return;
      }

      sendJson(response, 404, { code: "BAD_INPUT", message: "Unknown daemon route." });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (!(error instanceof CliError) && !(error instanceof SyntaxError)) console.error("Daemon request failed:", error);
      const { statusCode, body } = daemonErrorResponse(error);
      sendJson(response, statusCode, { ...body, ...observation() });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.controlPort, "127.0.0.1", resolve);
  });

  record = {
    session: options.session,
    pid: process.pid,
    controlPort: options.controlPort,
    token: options.token,
    host: options.host,
    port: options.port,
    username: options.username,
    auth: options.auth,
    version: options.version,
    startedAt: new Date().toISOString(),
    runtimeId: controller.world.runtimeId,
    stopping: false,
  };
  await writeSession(record);
}
