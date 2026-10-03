import type { EventEmitter } from "node:events";
import { detachData, EventStore } from "./events.js";

export interface ChatSender {
  username?: string;
  uuid?: string;
  trackId?: string;
}

export type ResolveChatSender = (username?: string, uuid?: string) => ChatSender | undefined;
type Callback = "message" | "chat" | "whisper";
type Channel = "player" | "whisper" | "server" | "game_info" | "control";
type Attribution = "verified" | "structured" | "pattern" | "unknown";
const translationLayouts: Record<string, { sender?: number; content: number; recipient?: number; team?: number; direction?: "incoming" | "outgoing" }> = {
  "commands.message.display.incoming": { sender: 0, content: 1, direction: "incoming" },
  "commands.message.display.outgoing": { recipient: 0, content: 1, direction: "outgoing" },
  "chat.type.text": { sender: 0, content: 1 },
  "chat.type.announcement": { sender: 0, content: 1 },
  "chat.type.emote": { sender: 0, content: 1 },
  "chat.type.team.text": { team: 0, sender: 1, content: 2, direction: "incoming" },
  "chat.type.team.sent": { team: 0, sender: 1, content: 2, direction: "outgoing" },
};

interface Receipt {
  object?: object;
  callbacks: Set<Callback>;
  messageId: string;
  receivedAt: string;
  text: string;
  originalText?: string;
  control?: string;
  channel: Channel;
  sender: ChatSender;
  attribution: Attribution;
  structuredLayout?: boolean;
  direction?: "incoming" | "outgoing";
  recipient?: ChatSender;
  team?: string;
  verified?: boolean;
  raw: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  const component = record(value);
  if (!component) return String(value);
  if (typeof component.toString === "function" && component.toString !== Object.prototype.toString) {
    try { return String(component.toString.call(value)); } catch { /* Fall back to detached structured data. */ }
  }
  if (typeof component.text === "string") return component.text + (Array.isArray(component.extra) ? component.extra.map(text).join("") : "");
  return JSON.stringify(detachData(value));
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.test(value) ? value.toLowerCase() : undefined;
}

/** Read literal component data before a ChatMessage renderer removes formatting. */
function literalText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(literalText);
    return parts.every(part => part !== undefined) ? parts.join("") : undefined;
  }
  const component = record(value);
  if (!component || component.translate !== undefined || typeof component.text !== "string") return undefined;
  const extra = component.extra === undefined ? "" : literalText(component.extra);
  return extra === undefined ? undefined : component.text + extra;
}

const xaeroFairplayPayload = "§f§a§i§r§x§a§e§r§o";

/**
 * Mineflayer emits message -> messagestr -> its legacy chat/whisper patterns.
 * One receipt joins these callbacks by their exact ChatMessage object, with an
 * occurrence queue so reusing that object for another incoming packet stays valid.
 * Deferred publication also supports adapters that emit chat before message.
 */
export class CanonicalChat {
  private bot?: EventEmitter;
  private readonly byObject = new WeakMap<object, Receipt[]>();
  private readonly pending = new Set<Receipt>();
  private readonly onMessage = (message: unknown, position?: string, sender?: unknown, verified?: boolean): void => {
    const receipt = this.receive("message", message);
    receipt.raw.message = detachData(message);
    receipt.raw.position = position;
    receipt.raw.sender = sender;
    receipt.raw.verified = verified;
    if (literalText(message) === xaeroFairplayPayload) {
      receipt.channel = "control";
      receipt.control = "xaero.fairplay";
      receipt.text = xaeroFairplayPayload;
      receipt.attribution = "unknown";
      return;
    }
    receipt.originalText = text(message);
    const metadata = record(message);
    const translation = typeof metadata?.translate === "string" ? metadata.translate : undefined;
    const parts = Array.isArray(metadata?.with) ? metadata.with : [];
    const senderUuid = uuid(sender);
    if (senderUuid) receipt.sender.uuid = senderUuid;
    if (typeof sender === "string" && !senderUuid) receipt.sender.username ??= sender;
    if (typeof verified === "boolean") receipt.verified = verified;
    const layout = translation ? translationLayouts[translation] : undefined;
    if (layout && parts[layout.content] !== undefined) {
      receipt.structuredLayout = true;
      receipt.channel = translation?.startsWith("commands.message.display.") ? "whisper" : "player";
      receipt.text = text(parts[layout.content]);
      receipt.direction = layout.direction;
      if (layout.team !== undefined) receipt.team = text(parts[layout.team]);
      if (layout.sender !== undefined) receipt.sender.username = text(parts[layout.sender]);
      if (layout.recipient !== undefined) {
        receipt.recipient = { username: text(parts[layout.recipient]) };
        const self = this.bot as (EventEmitter & { username?: string; entity?: { uuid?: string } }) | undefined;
        const selfUuid = uuid(self?.entity?.uuid) ?? senderUuid;
        receipt.sender = { ...(self?.username ? { username: self.username } : {}), ...(selfUuid ? { uuid: selfUuid } : {}) };
      }
      receipt.attribution = receipt.sender.uuid && verified === true ? "verified" : "structured";
      return;
    }
    if (receipt.callbacks.has("whisper") || receipt.callbacks.has("chat")) {
      if (senderUuid) receipt.attribution = verified === true ? "verified" : "structured";
      return;
    }
    receipt.text = text(message);
    if (translation?.startsWith("chat.type.") || position === "chat") {
      receipt.channel = "player";
      if (senderUuid) receipt.attribution = verified === true ? "verified" : "structured";
    } else {
      receipt.channel = position === "game_info" ? "game_info" : "server";
      receipt.attribution = "unknown";
    }
  };
  private readonly onChat = (sender: string, message: string, translate?: unknown, json?: unknown): void => {
    this.classify("chat", sender, message, translate, json);
  };
  private readonly onWhisper = (sender: string, message: string, translate?: unknown, json?: unknown): void => {
    this.classify("whisper", sender, message, translate, json);
  };

  constructor(private readonly events: EventStore, private readonly resolveSender?: ResolveChatSender) {}

  attach(bot: EventEmitter): void {
    this.dispose();
    this.bot = bot;
    bot.on("message", this.onMessage);
    bot.on("chat", this.onChat);
    bot.on("whisper", this.onWhisper);
  }

  /** Flush before a coherent observation boundary so received messages precede its cursor. */
  flush(): void {
    for (const receipt of [...this.pending]) this.publish(receipt);
  }

  dispose(): void {
    this.flush();
    this.bot?.off("message", this.onMessage);
    this.bot?.off("chat", this.onChat);
    this.bot?.off("whisper", this.onWhisper);
    this.bot = undefined;
  }

  private classify(callback: "chat" | "whisper", sender: string, message: string, translate: unknown, json: unknown): void {
    const receipt = this.receive(callback, json);
    receipt.raw[callback] = detachData({ sender, message, translate, json });
    if (receipt.structuredLayout || receipt.control) return;
    receipt.originalText ??= literalText(json) ?? String(message);
    // A whisper pattern wins over a broad player-chat pattern for the same receipt.
    if (callback === "chat" && receipt.callbacks.has("whisper")) return;
    receipt.channel = callback === "whisper" ? "whisper" : "player";
    receipt.text = String(message);
    receipt.sender.username = sender;
    receipt.attribution = receipt.sender.uuid ? (receipt.verified === true ? "verified" : "structured") : "pattern";
  }

  private receive(callback: Callback, payload: unknown): Receipt {
    const object = record(payload);
    const existing = object ? this.byObject.get(object) : undefined;
    // The newest occurrence is the active packet dispatch. Older completed
    // occurrences may still await microtask publication when an object is reused.
    const latest = existing?.[existing.length - 1];
    // Multiple legacy patterns can classify one anchored message. The message
    // callback, rather than a second classification callback, starts a new packet.
    let receipt = callback !== "message" && latest?.callbacks.has("message")
      ? latest
      : existing?.slice().reverse().find(candidate => !candidate.callbacks.has(callback));
    if (!receipt) {
      receipt = {
        object,
        callbacks: new Set(),
        messageId: this.events.allocateMessageId(),
        receivedAt: new Date().toISOString(),
        text: "",
        channel: "server",
        sender: {},
        attribution: "unknown",
        raw: {},
      };
      if (object) {
        const queue = existing ?? [];
        queue.push(receipt);
        this.byObject.set(object, queue);
      }
      this.pending.add(receipt);
      const queued = receipt;
      queueMicrotask(() => this.publish(queued));
    }
    receipt.callbacks.add(callback);
    return receipt;
  }

  private publish(receipt: Receipt): void {
    if (!this.pending.delete(receipt)) return;
    if (receipt.object) {
      const queue = this.byObject.get(receipt.object)!;
      const index = queue.indexOf(receipt);
      if (index !== -1) queue.splice(index, 1);
      if (!queue.length) this.byObject.delete(receipt.object);
    }
    const resolved = this.resolveSender?.(receipt.sender.username, receipt.sender.uuid);
    const sender = { ...resolved, ...receipt.sender,
      ...(receipt.sender.uuid && resolved?.username ? { username: resolved.username } : {}) };
    const recipient = receipt.recipient ? { ...this.resolveSender?.(receipt.recipient.username, receipt.recipient.uuid), ...receipt.recipient } : undefined;
    const unverified = (receipt.channel === "player" || receipt.channel === "whisper") &&
      receipt.attribution !== "verified" && receipt.attribution !== "structured";
    const eventType = receipt.control ? "server.control" : unverified ? "chat.unverified" :
      receipt.channel === "player" ? "chat.player" : receipt.channel === "whisper" ? "chat.whisper" : "server.message";
    this.events.add({
      type: eventType,
      timestamp: receipt.receivedAt,
      messageId: receipt.messageId,
      receivedAt: receipt.receivedAt,
      text: receipt.text,
      channel: unverified ? "unverified" : receipt.channel,
      ...(unverified ? { claimedChannel: receipt.channel, candidateSenderIdentity: sender,
        ...(sender.username ? { candidateSender: sender.username } : {}) } : {
        ...(sender.username ? { sender: sender.username } : {}), senderIdentity: sender,
      }),
      ...(receipt.control ? { control: receipt.control } : {}),
      ...(receipt.originalText === undefined ? {} : { originalText: receipt.originalText }),
      ...(receipt.direction ? { direction: receipt.direction } : {}),
      ...(recipient ? { recipientIdentity: recipient } : {}),
      ...(receipt.team === undefined ? {} : { team: receipt.team }),
      attribution: receipt.attribution,
      provenance: { attribution: receipt.attribution, callbacks: [...receipt.callbacks],
        ...(receipt.raw.position === undefined ? {} : { position: receipt.raw.position }),
        ...(typeof record(receipt.raw.message)?.translate === "string" ? { translation: record(receipt.raw.message)!.translate } : {}) },
      ...(receipt.verified === undefined ? {} : { verified: receipt.verified }),
      raw: receipt.raw,
    });
  }
}
