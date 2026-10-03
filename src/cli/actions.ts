import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { CliHandlers, SessionInput } from "./handlers.js";
import { CliError, type ErrorCode, sessionNotFound } from "../output/errors.js";
import { daemonRequest, loadSessionForClient } from "../daemon/client.js";
import { runDaemon } from "../daemon/server.js";
import { spawnSessionDaemon } from "../daemon/spawn.js";
import { listSessions, readSession, removeSession, toPublicSession } from "../session/store.js";

function appendEventTypes(params: URLSearchParams, types: readonly string[]): void {
  for (const type of types) {
    params.append("type", type);
  }
}

function context(input: SessionInput): { runtimeId?: string; worldEpoch?: number } {
  return {
    ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
    ...(input.worldEpoch !== undefined ? { worldEpoch: input.worldEpoch } : {}),
  };
}

export function createCliHandlers(entryPoint = fileURLToPath(import.meta.url)): CliHandlers {
  return {
    async startSession(input) {
      const existing = await readSession(input.session);
      if (existing) {
        let daemonIsHealthy = false;
        try {
          await daemonRequest(existing, "/status", { signal: AbortSignal.timeout(1500) });
          daemonIsHealthy = true;
        } catch {
          // A live PID is not sufficient: stale records can point at an unrelated reused PID.
        }
        if (daemonIsHealthy) {
          throw new CliError(
            "SESSION_ALREADY_RUNNING",
            `Session '${input.session}' is already running.`,
            "Use 'mc-agent session status' or stop it before starting a new session.",
            1,
          );
        }
        await removeSession(input.session);
      }

      const { controlPort } = await spawnSessionDaemon(input, entryPoint);
      return {
        session: input.session,
        host: input.host,
        port: input.port,
        username: input.username,
        auth: input.auth,
        controlPort,
      };
    },

    async sessionStatus(input) {
      const record = await loadSessionForClient(input.session);
      const status = await daemonRequest(record, "/status");
      return { ...toPublicSession(record), status };
    },

    async listSessions() {
      const sessions = await listSessions();
      return { sessions: sessions.map(toPublicSession) };
    },

    async stopSession(input) {
      const record = await loadSessionForClient(input.session);
      await daemonRequest(record, "/stop", { method: "POST", body: JSON.stringify(context(input)) });
      return { session: input.session, stopped: true };
    },

    async observeFrame(input) {
      const record = await loadSessionForClient(input.session);
      const params = new URLSearchParams({ maxEntities: String(input.maxEntities), radius: String(input.radius) });
      if (input.since) params.set("since", input.since);
      for (const track of input.tracks) params.append("track", track);
      return daemonRequest(record, `/frame?${params}`);
    },

    async debugEvents(input) {
      const record = await loadSessionForClient(input.session);
      const params = new URLSearchParams();
      if (input.id) params.set("id", input.id);
      return daemonRequest(record, `/debug/events${params.size ? `?${params}` : ""}`);
    },

    async actionStatus(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, `/actions/${encodeURIComponent(input.action)}`);
    },

    async actionCancel(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, `/actions/${encodeURIComponent(input.action)}/cancel`, { method: "POST", body: JSON.stringify(context(input)) });
    },

    async lookTrack(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/look/track", { method: "POST", body: JSON.stringify({ ...context(input), track: input.track }) });
    },

    async observeEvents(input) {
      const record = await loadSessionForClient(input.session);
      const params = new URLSearchParams({ since: String(input.since), limit: String(input.limit) });
      appendEventTypes(params, input.types);
      return daemonRequest(record, `/events?${params.toString()}`);
    },

    async observeWatch(input) {
      const record = await loadSessionForClient(input.session);
      const params = new URLSearchParams({ since: String(input.since) });
      appendEventTypes(params, input.types);
      const endpoint = input.track ? "/sample" : "/watch";
      if (input.track) {
        params.delete("since");
        params.set("track", input.track);
        params.set("fields", (input.fields ?? ["position"]).join(","));
        params.set("rate", String(input.rate ?? 2));
      }
      const response = await fetch(`http://127.0.0.1:${record.controlPort}${endpoint}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${record.token}` },
      });
      if (!response.ok) {
        let payload: { code?: unknown; error?: unknown; message?: unknown; remediation?: unknown; details?: Record<string, unknown> } = {};
        try { payload = await response.json(); } catch { /* Preserve a useful fallback for non-JSON transport failures. */ }
        const knownCodes: ErrorCode[] = ["BAD_INPUT", "DAEMON_ERROR", "TRACK_UNKNOWN", "TRACK_LOST", "WORLD_CHANGED", "RUNTIME_MISMATCH", "NOT_READY", "STREAM_OVERFLOW"];
        const code = knownCodes.includes(payload.code as ErrorCode) ? payload.code as ErrorCode : "DAEMON_ERROR";
        const message = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : "Unable to watch daemon events.";
        throw new CliError(code, message, typeof payload.remediation === "string" ? payload.remediation : "Observe a fresh frame and retry with current handles.", code === "BAD_INPUT" ? 3 : 1, payload.details);
      }
      if (!response.body) {
        throw new CliError("DAEMON_ERROR", "Daemon stream has no response body.", "Inspect session status and retry.", 1);
      }
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (!process.stdout.write(Buffer.from(value))) await once(process.stdout, "drain");
      }
    },

    async sendChat(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/chat", { method: "POST", body: JSON.stringify({ ...context(input), message: input.message, allowCommand: input.allowCommand }) });
    },

    async sendWhisper(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/chat/whisper", { method: "POST", body: JSON.stringify({ ...context(input), username: input.username, message: input.message }) });
    },

    async tabComplete(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/chat/tab-complete", {
        method: "POST",
        body: JSON.stringify({ ...context(input),
          text: input.text,
          assumeCommand: input.assumeCommand,
          sendBlockInSight: input.sendBlockInSight,
          timeout: input.timeout,
        }),
      });
    },

    async botPosition(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/bot/position");
    },

    async botInventory(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/bot/inventory");
    },

    async botPlayers(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/bot/players");
    },

    async botEntities(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, `/bot/entities?radius=${input.radius}&limit=${input.limit}`);
    },

    async botTablist(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/bot/tablist");
    },

    async botScoreboards(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/bot/scoreboards");
    },

    async botTeams(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/bot/teams");
    },

    async botControls(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/bot/controls");
    },

    async controlTap(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/control/tap", {
        method: "POST",
        body: JSON.stringify({ ...context(input), state: input.state, durationMs: input.durationMs }),
      });
    },

    async controlSet(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/control/set", {
        method: "POST",
        body: JSON.stringify({ ...context(input), state: input.state, value: input.value }),
      });
    },

    async controlClear(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/control/clear", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async lookAt(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/look/at", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z }),
      });
    },

    async look(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/look/yaw-pitch", {
        method: "POST",
        body: JSON.stringify({ ...context(input), yaw: input.yaw, pitch: input.pitch, force: input.force }),
      });
    },

    async worldBlock(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, `/world/block?x=${input.x}&y=${input.y}&z=${input.z}`);
    },

    async worldBlockInfo(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, `/world/block-info?x=${input.x}&y=${input.y}&z=${input.z}`);
    },

    async worldBlockInSight(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, `/world/block-in-sight?maxSteps=${input.maxSteps}&vectorLength=${input.vectorLength}`);
    },

    async worldBlockAtCursor(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, `/world/block-at-cursor?maxDistance=${input.maxDistance}`);
    },

    async worldFindBlocks(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(
        record,
        `/world/find-blocks?name=${encodeURIComponent(input.name)}&radius=${input.radius}&count=${input.count}`,
      );
    },

    async navigateGoto(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/navigate/goto", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z, range: input.range }),
      });
    },

    async navigateFollow(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/navigate/follow", {
        method: "POST",
        body: JSON.stringify({ ...context(input), track: input.track, range: input.range }),
      });
    },

    async navigateStop(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/navigate/stop", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async navigateStatus(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/navigate/status");
    },

    async navigateConfigure(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/navigate/configure", {
        method: "POST",
        body: JSON.stringify({ ...context(input),
          allowDig: input.allowDig,
          allowSprinting: input.allowSprinting,
          allowParkour: input.allowParkour,
          canOpenDoors: input.canOpenDoors,
          maxDropDown: input.maxDropDown,
          searchRadius: input.searchRadius,
          thinkTimeout: input.thinkTimeout,
          tickTimeout: input.tickTimeout,
        }),
      });
    },

    async collectItem(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/collect/item", {
        method: "POST",
        body: JSON.stringify({ ...context(input), track: input.track, range: input.range }),
      });
    },

    async inventoryEquip(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/inventory/equip", {
        method: "POST",
        body: JSON.stringify({ ...context(input), item: input.item, destination: input.destination }),
      });
    },

    async inventoryUnequip(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/inventory/unequip", {
        method: "POST",
        body: JSON.stringify({ ...context(input), destination: input.destination }),
      });
    },

    async inventoryQuickBar(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/inventory/quickbar", {
        method: "POST",
        body: JSON.stringify({ ...context(input), slot: input.slot }),
      });
    },

    async inventoryToss(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/inventory/toss", {
        method: "POST",
        body: JSON.stringify({ ...context(input), item: input.item, count: input.count }),
      });
    },

    async inventoryConsume(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/inventory/consume", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async inventoryFish(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/inventory/fish", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async inventoryActivateItem(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/inventory/activate-item", {
        method: "POST",
        body: JSON.stringify({ ...context(input), offhand: input.offhand }),
      });
    },

    async inventoryDeactivateItem(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/inventory/deactivate-item", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async inventoryRecipes(input) {
      const record = await loadSessionForClient(input.session);
      const table =
        input.tableX === undefined
          ? ""
          : `&tableX=${input.tableX}&tableY=${input.tableY ?? 0}&tableZ=${input.tableZ ?? 0}`;
      return daemonRequest(record, `/inventory/recipes?item=${encodeURIComponent(input.item)}&count=${input.count}${table}`);
    },

    async inventoryCraft(input) {
      const record = await loadSessionForClient(input.session);
      const table =
        input.tableX === undefined
          ? undefined
          : { x: input.tableX, y: input.tableY ?? 0, z: input.tableZ ?? 0 };
      return daemonRequest(record, "/inventory/craft", {
        method: "POST",
        body: JSON.stringify({ ...context(input), item: input.item, count: input.count, table, recipeIndex: input.recipeIndex, recipeId: input.recipeId }),
      });
    },

    async worldDig(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/dig", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z }),
      });
    },

    async worldStopDigging(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/stop-digging", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async worldPlace(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/place", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z, face: input.face, item: input.item }),
      });
    },

    async worldPlaceEntity(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/place-entity", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z, face: input.face, item: input.item }),
      });
    },

    async worldActivate(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/activate", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z }),
      });
    },

    async worldUpdateSign(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/update-sign", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z, text: input.text, back: input.back }),
      });
    },

    async worldSleep(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/sleep", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z }),
      });
    },

    async worldWake(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/wake", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async worldElytraFly(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/world/elytra-fly", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async windowOpenBlock(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/window/open-block", {
        method: "POST",
        body: JSON.stringify({ ...context(input), x: input.x, y: input.y, z: input.z }),
      });
    },

    async windowOpenEntity(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/window/open-entity", {
        method: "POST",
        body: JSON.stringify({ ...context(input), track: input.track }),
      });
    },

    async windowStatus(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/window/status");
    },

    async windowDeposit(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/window/deposit", {
        method: "POST",
        body: JSON.stringify({ ...context(input), item: input.item, count: input.count }),
      });
    },

    async windowWithdraw(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/window/withdraw", {
        method: "POST",
        body: JSON.stringify({ ...context(input), item: input.item, count: input.count }),
      });
    },

    async windowClick(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/window/click", {
        method: "POST",
        body: JSON.stringify({ ...context(input), slot: input.slot, mouseButton: input.mouseButton, mode: input.mode }),
      });
    },

    async windowClose(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/window/close", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async entityActivate(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/entity/activate", { method: "POST", body: JSON.stringify({ ...context(input), track: input.track }) });
    },

    async entityFind(input) {
      const record = await loadSessionForClient(input.session);
      const params = new URLSearchParams({
        radius: String(input.radius),
        limit: String(input.limit),
        includePlayers: String(input.includePlayers),
        includePassive: String(input.includePassive),
      });
      if (input.name) params.set("name", input.name);
      if (input.type) params.set("type", input.type);
      return daemonRequest(record, `/entity/find?${params.toString()}`);
    },

    async entityUseOn(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/entity/use-on", { method: "POST", body: JSON.stringify({ ...context(input), track: input.track }) });
    },

    async entityAttack(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/entity/attack", {
        method: "POST",
        body: JSON.stringify({ ...context(input), track: input.track, allowPlayers: input.allowPlayers, allowPassive: input.allowPassive }),
      });
    },

    async entitySwingArm(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/entity/swing-arm", {
        method: "POST",
        body: JSON.stringify({ ...context(input), hand: input.hand, showHand: input.showHand }),
      });
    },

    async entityMount(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/entity/mount", { method: "POST", body: JSON.stringify({ ...context(input), track: input.track }) });
    },

    async entityDismount(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/entity/dismount", { method: "POST", body: JSON.stringify(context(input)) });
    },

    async entityMoveVehicle(input) {
      const record = await loadSessionForClient(input.session);
      return daemonRequest(record, "/entity/move-vehicle", {
        method: "POST",
        body: JSON.stringify({ ...context(input), left: input.left, forward: input.forward }),
      });
    },

    async daemonRun(input) {
      const token = process.env.MC_AGENT_CONTROL_TOKEN;
      if (!token) {
        throw new CliError("BAD_INPUT", "Missing daemon token.", "Start daemons through 'mc-agent session start'.", 3);
      }
      await runDaemon({ ...input, token });
      return { session: input.session, running: true };
    },
  };
}
