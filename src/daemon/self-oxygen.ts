type MetadataPacket = { entityId?: number; metadata?: Array<{ key?: number; value?: unknown }> };
type OxygenBot = {
  oxygenLevel?: number;
  entity?: { id?: number; name?: string };
  registry?: { entitiesByName?: Record<string, { metadataKeys?: string[] }> };
  supportFeature?: (feature: string) => boolean;
  _client?: {
    prependListener?: (event: string, listener: (packet: MetadataPacket) => void) => unknown;
    off?: (event: string, listener: (packet: MetadataPacket) => void) => unknown;
  };
};

/** Own one normalized self fact; upstream breath setters cannot copy another entity's air. */
export function installSelfOxygen(input: unknown): { reset(): void; dispose(): void } {
  const bot = input as OxygenBot;
  const client = bot._client;
  const descriptor = Object.getOwnPropertyDescriptor(bot, "oxygenLevel");
  if (!client?.prependListener || !client.off || descriptor?.configurable === false) {
    return { reset() {}, dispose() {} };
  }
  let oxygen: number | undefined;
  const observe = (packet: MetadataPacket) => {
    const self = bot.entity;
    if (!self || !Number.isSafeInteger(self.id) || packet.entityId !== self.id || !Array.isArray(packet.metadata)) return;
    const keys = bot.registry?.entitiesByName?.[self.name ?? "player"]?.metadataKeys;
    const modern = bot.supportFeature?.("mcDataHasEntityMetadata") ?? Array.isArray(keys);
    const airIndex = modern ? keys?.indexOf("air_supply") : 1;
    if (airIndex === undefined || airIndex < 0) return;
    const air = packet.metadata.find(entry => entry.key === airIndex)?.value;
    if (typeof air === "number" && Number.isFinite(air)) oxygen = Math.round(air / 15);
  };
  Object.defineProperty(bot, "oxygenLevel", {
    configurable: true, enumerable: true,
    get: () => oxygen,
    // Mineflayer 4.37.1's metadata plugin writes air for *every* entity.
    // The self-only packet adapter above is the authority, including legacy versions.
    set: () => {},
  });
  client.prependListener("entity_metadata", observe);
  let disposed = false;
  return {
    reset() { oxygen = undefined; },
    dispose() {
      if (disposed) return;
      disposed = true;
      client.off!("entity_metadata", observe);
      if (descriptor) Object.defineProperty(bot, "oxygenLevel", descriptor);
      else delete bot.oxygenLevel;
    },
  };
}
