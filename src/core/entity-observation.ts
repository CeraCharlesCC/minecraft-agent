import type { EventEmitter } from "node:events";

type Point = { x: number; y: number; z: number };
type Entity = { id?: number; position?: unknown };
type Bot = EventEmitter & { _client?: EventEmitter; entity?: Entity; entities?: Record<string, Entity> };
const absolutePositions = new WeakSet<object>();
const selfAxes = new WeakMap<object, number>();
const installations = new WeakMap<object, () => void>();

/** A world reset invalidates self's acquired coordinates even without a raw lifecycle event. */
export function resetEntityObservation(input: unknown): void {
  const self = (input as Bot | undefined)?.entity;
  if (self && typeof self === "object") { absolutePositions.delete(self); selfAxes.delete(self); }
}

/** Constructor defaults and relative movement do not establish an absolute position. */
export function observedEntityPosition(value: unknown): Point | undefined {
  if (!value || typeof value !== "object") return undefined;
  // Plain objects are explicit adapter/test observations. Prismarine Entity is a
  // class instance whose constructor always supplies an unobserved (0, 0, 0).
  const prototype = Object.getPrototypeOf(value);
  if (!absolutePositions.has(value) && prototype !== Object.prototype && prototype !== null) return undefined;
  const position = (value as Entity).position as Point | undefined;
  return position && [position.x, position.y, position.z].every(Number.isFinite)
    ? { x: position.x, y: position.y, z: position.z } : undefined;
}

/** Install immediately after createBot, before runtime event consumers. */
export function installEntityObservation(input: unknown): () => void {
  if (!input || typeof input !== "object") return () => {};
  const previous = installations.get(input);
  if (previous) return previous;
  const bot = input as Bot;
  if (typeof bot.prependListener !== "function") return () => {};
  const removals: (() => void)[] = [];
  let packetRemovals: (() => void)[] = [];
  let absoluteId: number | undefined;
  const listen = (emitter: EventEmitter, event: string, listener: (...args: any[]) => void, prepend = true) => {
    if (prepend) emitter.prependListener(event, listener); else emitter.on(event, listener);
    removals.push(() => emitter.removeListener(event, listener));
  };
  const markSpawn = (entity: Entity) => {
    // Mineflayer's self entitySpawn follows health, which may precede position.
    if (entity && typeof entity === "object" && entity !== bot.entity) absolutePositions.add(entity);
  };
  const markAbsolute = (entity: Entity) => {
    if (entity && entity.id === absoluteId && absoluteId !== undefined) {
      absolutePositions.add(entity);
      if (entity === bot.entity) selfAxes.set(entity, 7);
    }
  };
  listen(bot, "entitySpawn", markSpawn);
  listen(bot, "entityMoved", markAbsolute);
  listen(bot, "entitySleep", markAbsolute);
  const resetSelf = () => resetEntityObservation(bot);
  listen(bot, "death", resetSelf);
  listen(bot, "respawn", resetSelf);
  listen(bot, "end", resetSelf);
  // These are the installed Mineflayer entities plugin's absolute update paths.
  // Packet evidence precedes its handler, which can create a placeholder and
  // emit an event synchronously before an ordinary packet listener would run.
  const installPacketListeners = () => {
    for (const remove of packetRemovals) remove();
    packetRemovals = [];
    if (!bot._client || typeof bot._client.prependListener !== "function") return;
    const selfStart = removals.length;
    listen(bot._client, "position", (packet: any) => {
      if (!bot.entity || ![packet.x, packet.y, packet.z].every(Number.isFinite)) return;
      const flags = packet.flags;
      if (typeof flags !== "number" && (!flags || typeof flags !== "object")) return;
      const relative = typeof flags === "number" ? flags & 7 : (flags.x ? 1 : 0) | (flags.y ? 2 : 0) | (flags.z ? 4 : 0);
      const acquired = (selfAxes.get(bot.entity) ?? 0) | (7 & ~relative);
      selfAxes.set(bot.entity, acquired);
      if (acquired === 7) absolutePositions.add(bot.entity);
    });
    packetRemovals.push(...removals.splice(selfStart));
    for (const event of ["entity_teleport", "sync_entity_position", "bed"]) {
      const start = removals.length;
      listen(bot._client, event, (packet: any) => {
        const location = event === "bed" ? packet.location : packet;
        absoluteId = Number.isSafeInteger(packet.entityId) && location && [location.x, location.y, location.z].every(Number.isFinite) ? packet.entityId : undefined;
      });
      listen(bot._client, event, () => { absoluteId = undefined; }, false);
      packetRemovals.push(...removals.splice(start));
    }
  };
  installPacketListeners();
  // createBot returns before the built-in plugins are injected. Its plugin
  // loader handles this event first; reinstallation moves cleanup after their
  // handlers, without delaying the early evidence listener or consumers.
  listen(bot, "inject_allowed", installPacketListeners, false);
  const cleanup = () => {
    for (const remove of removals) remove();
    for (const remove of packetRemovals) remove();
    installations.delete(input);
  };
  installations.set(input, cleanup);
  return cleanup;
}
