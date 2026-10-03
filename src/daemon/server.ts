import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { BotOptions, BotController, CreateBotFn } from "./bot.js";
import { CliError, badInput } from "../output/errors.js";
import { ActionResource } from "../core/actions.js";
import { EventStore } from "../core/events.js";
import { removeSession, SessionRecord, writeSession } from "../session/store.js";

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
    response.end(`${JSON.stringify({ type: "stream.overflow", code: "STREAM_OVERFLOW", remediation: "Reconnect using the last received event cursor; inspect replay gaps." })}\n`);
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

function eventMatchesTypes(event: { type: string }, types: readonly string[]): boolean {
  return types.length === 0 || types.includes(event.type);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNavigationFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("pathfinder") || normalized.includes("path to goal") || normalized.includes("no path") || normalized.includes("goal");
}

function daemonErrorResponse(error: unknown) {
  if (error instanceof CliError) return { statusCode: error.code === "BAD_INPUT" ? 400 : 409,
    body: { error: error.message, code: error.code, remediation: error.remediation, ...(error.details ? { details: error.details } : {}) } };
  if (error instanceof SyntaxError) return { statusCode: 400, body: { error: "Invalid JSON body.", code: "BAD_INPUT", remediation: "Send a JSON object." } };
  const message = errorMessage(error);
  if (isNavigationFailure(message)) {
    return {
      statusCode: 409,
      body: {
        error: message,
        code: "NAVIGATION_FAILED",
        remediation: "Inspect bot position, nearby blocks, and navigate status; then try a closer reachable goal or adjust pathfinder configuration.",
      },
    };
  }
  return {
    statusCode: 500,
    body: {
      error: message,
      code: "DAEMON_ERROR",
      remediation: "Inspect session status and the daemon log; restart the session daemon only if it is unhealthy.",
    },
  };
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const events = new EventStore();
  const controller = new BotController(options, events, options.createBotFn);
  controller.start();

  const activeStreams = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    try {
      if (!isAuthorized(request, options.token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      /* v8 ignore next -- Incoming HTTP requests always provide a URL; fallback is defensive. */
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/status") {
        sendJson(response, 200, controller.status());
        return;
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        sendJson(response, 200, { stopped: true });
        controller.stop();
        void removeSession(options.session).finally(() => {
          for (const stream of activeStreams) stream.end();
          server.close();
          if (options.exitOnStop ?? true) {
            process.exit(0);
          }
        });
        return;
      }

      if (request.method === "GET" && ["/watch", "/sample"].includes(url.pathname)) {
        if (activeStreams.size >= 32) throw new CliError("STREAM_OVERFLOW", "Subscriber limit reached.", "Close an existing stream before reconnecting.");
        activeStreams.add(response);
        response.on("close", () => activeStreams.delete(response));
      }
      if (request.method === "GET" && url.pathname === "/frame") {
        sendJson(response, 200, controller.frame({
          since: url.searchParams.get("since") ?? undefined,
          maxEntities: Number(url.searchParams.get("maxEntities") ?? "50"),
          radius: Number(url.searchParams.get("radius") ?? "64"),
          tracks: url.searchParams.getAll("track").flatMap((value) => value.split(",")),
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/debug/events") {
        sendJson(response, 200, { runtimeId: events.runtimeId, records: events.getDebug(url.searchParams.get("id") ?? undefined) });
        return;
      }
      controller.flushChat();
      if (request.method === "GET" && url.pathname === "/events") {
        sendJson(response, 200, events.query(url.searchParams.get("since") ?? "0",
          Number(url.searchParams.get("limit") ?? "50"), eventTypesFromSearch(url)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/watch") {
        const types = eventTypesFromSearch(url);
        let replay = events.query(url.searchParams.get("since") ?? "0", 1000, types);
        const initialReplay = replay;
        const backlog = [...replay.events];
        while (replay.nextCursor !== replay.latestCursor) {
          replay = events.query(replay.nextCursor, 1000, types);
          backlog.push(...replay.events);
        }
        const stream = boundedStream(response);
        let starting = true;
        const live: typeof backlog = [];
        const unsubscribe = events.subscribe((event) => {
          if (!eventMatchesTypes(event, types)) return;
          if (stream.closed) { unsubscribe(); return; }
          if (!starting) stream.write(event);
          else if (live.length < 128) live.push(event);
          else { stream.overflow(); unsubscribe(); }
        });
        response.on("close", unsubscribe);
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.flushHeaders();
        stream.write({ type: "events.replay", ...initialReplay, events: undefined });
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
      const actionRoute = /^\/actions\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      if (actionRoute && ((request.method === "GET" && !actionRoute[2]) || (request.method === "POST" && actionRoute[2]))) {
        const action = decodeURIComponent(actionRoute[1]);
        if (request.method === "POST") controller.validateContext((await readJson(request)) as never, false);
        sendJson(response, 200, request.method === "GET" ? controller.actions.get(action) : controller.actions.cancel(action));
        return;
      }
      if (request.method === "POST" && physicalRoutes.has(url.pathname)) {
        const input = await readJson(request);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw badInput("Action body must be an object.");
        const body = input as Record<string, unknown>;
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
          sendJson(response, 200, controller.followTrack(track(), range(2))); return;
        }
        if (path === "/look/track") {
          sendJson(response, 200, controller.trackLook(track())); return;
        }
        if (["/navigate/stop", "/control/clear"].includes(path)) {
          controller.actions.cancelResources(["movement", "look"], "STOPPED");
          sendJson(response, 200, path === "/navigate/stop" ? controller.stopNavigation() : controller.clearControls()); return;
        }
        if (path === "/world/stop-digging") {
          controller.actions.cancelResources(["item"], "STOPPED"); sendJson(response, 200, controller.stopDigging()); return;
        }
        if (path === "/inventory/deactivate-item") {
          controller.actions.cancelResources(["item"], "STOPPED"); sendJson(response, 200, controller.deactivateItem()); return;
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
        sendJson(response, 200, controller.runAction(path.slice(1).replaceAll("/","."), resources, run, target, continuous));
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
          allowSprinting?: boolean;
          allowParkour?: boolean;
          canOpenDoors?: boolean;
          maxDropDown?: number;
          searchRadius?: number;
          thinkTimeout?: number;
          tickTimeout?: number;
        };
        controller.validateContext(body as never);
        sendJson(response, 200, controller.configureNavigation(body));
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

      if (request.method === "GET" && url.pathname === "/entity/find") {
        sendJson(
          response,
          200,
          controller.findEntities({
            name: url.searchParams.get("name") ?? undefined,
            type: url.searchParams.get("type") ?? undefined,
            radius: Number(url.searchParams.get("radius") ?? "32"),
            limit: Number(url.searchParams.get("limit") ?? "50"),
            includePlayers: url.searchParams.get("includePlayers") === "true",
            includePassive: url.searchParams.get("includePassive") === "true",
          }),
        );
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const { statusCode, body } = daemonErrorResponse(error);
      sendJson(response, statusCode, body);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.controlPort, "127.0.0.1", resolve);
  });

  const record: SessionRecord = {
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
  };
  await writeSession(record);
}
